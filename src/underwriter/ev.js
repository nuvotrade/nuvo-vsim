/**
 * Expected value and its risk-adjusted successor, NEV (§3).
 *
 *   EV  = p_win * W - p_loss * L - C
 *   NEV = EV - lambda1*CVaR - lambda2*GapRisk - lambda3*LiquidityRisk
 *
 * The lambdas are not fudge factors. They are the price NUVO charges itself
 * for accepting risks that an expectation cannot see: the shape of the tail,
 * the possibility of not being able to react, and the cost of being trapped.
 */
import { isNum, mean, quantile } from '../math/stats.js';
import { structureCost, DEFAULT_COSTS } from './costs.js';
import { mid } from '../structures/structure.js';

/**
 * Risk-aversion coefficients.
 *
 * These are constitutional dials, not parameters to be fitted, but they do
 * have to be on the right SCALE or the system is either blind or mute.
 *
 * lambdaCvar is the fraction of expected tail loss NUVO charges against
 * expectation. It must be read against the EV/CVaR ratio of a genuinely
 * well-priced short-vol trade, which sits near 0.15 at 30 DTE. A lambda
 * above that rejects every trade including the good ones — which is not
 * conservatism, it is just a broken instrument. At 0.08 NUVO demands
 * roughly half the available compensation as its risk charge and still
 * has something left to rank.
 *
 * lambdaGap and lambdaLiquidity are set HIGHER per unit than lambdaCvar
 * on purpose. CVaR is risk NUVO chose and can manage; gap risk arrives
 * overnight with no opportunity to react, and liquidity risk is the cost
 * of being unable to leave. Unmanageable risk should be more expensive
 * than managed risk of the same size.
 */
export const DEFAULT_LAMBDAS = Object.freeze({
  lambdaCvar: 0.02,
  lambdaGap: 0.40,
  lambdaLiquidity: 0.40,
  alpha: 0.95,
});

/**
 * Calibration note, recorded because these numbers decide what NUVO trades.
 *
 * Solved empirically (see test/ev.test.js) for the IV/realised ratio at
 * which a 30-DTE short put turns NEV-positive. At these values a flat-IV
 * strike must be paid roughly 1.29x effective realised vol before NUVO
 * will underwrite it. Real chains carry downside skew, so a strike at that
 * moneyness typically trades several vol points above ATM — the bar is
 * demanding but reachable, which is the intended calibration.
 *
 * The dominant charge is gap risk, not CVaR. That is deliberate and it is
 * the correct economics for this business: the diffusive tail is risk NUVO
 * chose and can manage down; the jump tail arrives while the market is
 * closed. Setting lambdaGap below lambdaCvar would invert that and make
 * NUVO most relaxed about the thing most likely to end it.
 */

/**
 * Gap risk: the incremental expected loss attributable to jumps.
 *
 * Measured as the difference in tail loss between the full distribution
 * (which contains jumps) and a diffusion-only counterfactual. This isolates
 * exactly the risk a Black-Scholes view is blind to — the overnight move
 * that takes a position past its stop before there is a chance to act.
 */
export function gapRisk({ structure, dist, diffusionDist, alpha = 0.95 }) {
  if (!diffusionDist) return { value: 0, basis: 'unavailable', note: 'No diffusion counterfactual supplied.' };
  const full = dist.payoffStats(structure.payoff, { alpha });
  const diff = diffusionDist.payoffStats(structure.payoff, { alpha });
  const value = Math.max(0, full.cvar - diff.cvar);
  return {
    value,
    basis: 'jump-vs-diffusion-cvar',
    fullCvar: full.cvar,
    diffusionCvar: diff.cvar,
    /** Share of tail risk that exists only because markets gap. */
    share: full.cvar > 0 ? value / full.cvar : 0,
  };
}

/**
 * Liquidity risk: what it costs to be wrong AND unable to leave cheaply.
 *
 * Scaled by the probability of actually needing to exit early, because a
 * wide spread on a position that expires worthless costs nothing. This is
 * why it uses probTouch-like exposure rather than terminal probability.
 */
export function liquidityRisk({ structure, pNeedExit = 0.35, stressMultiple = 2.5 }) {
  let exitCost = 0;
  for (const leg of structure.legs) {
    const c = leg.contract;
    if (!c || !isNum(c.bid) || !isNum(c.ask)) continue;
    const half = (c.ask - c.bid) / 2;
    // Under stress, spreads widen; assuming today's spread is the exit
    // spread is the mistake that makes defined-risk trades feel safe.
    exitCost += half * stressMultiple * (leg.quantity ?? 0) * (c.multiplier ?? 100);
  }
  return {
    value: exitCost * pNeedExit,
    grossExitCost: exitCost,
    pNeedExit,
    stressMultiple,
  };
}

/**
 * Full expected-value assessment of one structure against one distribution.
 */
export function evaluate({
  structure,
  dist,
  diffusionDist = null,
  costs = DEFAULT_COSTS,
  lambdas = DEFAULT_LAMBDAS,
  pNeedExit = 0.35,
}) {
  const { alpha } = lambdas;
  const stats = dist.payoffStats(structure.payoff, { alpha });
  const cost = structureCost(structure, costs);

  // Gross EV before frictions, then net of them.
  const evGross = stats.ev;
  const ev = evGross - cost.total;

  const gap = gapRisk({ structure, dist, diffusionDist, alpha });
  const liq = liquidityRisk({ structure, pNeedExit });

  const nev = ev
    - lambdas.lambdaCvar * stats.cvar
    - lambdas.lambdaGap * gap.value
    - lambdas.lambdaLiquidity * liq.value;

  // Decompose the win/loss legs the way §3 states them, for the record.
  const wins = stats.pnl.filter((v) => v > 0);
  const losses = stats.pnl.filter((v) => v <= 0);

  return {
    kind: structure.kind,
    underlying: structure.underlying,

    pWin: wins.length / stats.pnl.length,
    pLoss: losses.length / stats.pnl.length,
    avgWin: wins.length ? mean(wins) : 0,
    avgLoss: losses.length ? -mean(losses) : 0,

    evGross,
    costs: cost,
    ev,

    cvar: stats.cvar,
    var: stats.var,
    worstCase: stats.worst,
    sd: stats.sd,
    expectedLoss: stats.expectedLoss,

    gapRisk: gap,
    liquidityRisk: liq,
    lambdas,

    nev,

    /**
     * How much of the gross edge survives frictions and risk charges.
     * A structure retaining under ~30% is being paid mostly to take risk
     * NUVO has decided it does not want.
     */
    edgeRetention: evGross > 0 ? nev / evGross : (nev >= 0 ? 1 : 0),

    distribution: {
      model: dist.model,
      n: dist.n,
      seed: dist.seed,
      p05: quantile(stats.pnl, 0.05),
      p50: quantile(stats.pnl, 0.50),
      p95: quantile(stats.pnl, 0.95),
    },
  };
}

/**
 * Conditional loss given the short strike is breached — the number §3 asks
 * for directly ("What happens if the market moves much farther than
 * expected?"). Separate from CVaR because it is conditioned on the
 * position's own trigger, not on a percentile of the P&L distribution.
 */
export function conditionalLoss({ structure, dist }) {
  if (!isNum(structure.shortStrike)) return { pBreach: NaN, expectedLoss: NaN };
  const breached = dist.samples.filter((s) => s < structure.shortStrike);
  if (!breached.length) return { pBreach: 0, expectedLoss: 0, worstGivenBreach: 0 };
  const pnl = breached.map(structure.payoff);
  return {
    pBreach: breached.length / dist.n,
    expectedLoss: -mean(pnl),
    worstGivenBreach: -Math.min(...pnl),
    expectedTerminalGivenBreach: mean(breached),
    p05GivenBreach: -quantile(pnl, 0.05),
  };
}

export { mid };
