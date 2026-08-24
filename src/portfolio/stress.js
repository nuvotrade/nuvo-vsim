/**
 * Stress testing (§14, §21).
 *
 * A portfolio of individually acceptable positions can still be
 * catastrophic. These scenarios are applied to the WHOLE book at once,
 * with correlation forced toward one — because that is what actually
 * happens in the scenarios that matter.
 */
import { isNum, conditionalVaR, quantile, mean } from '../math/stats.js';

/**
 * Mandated scenario set. These are not forecasts; they are solvency tests.
 * Vol shocks accompany price shocks because a short-vol book loses on both
 * legs simultaneously — modelling the price move alone halves the answer.
 */
export const STRESS_SCENARIOS = Object.freeze([
  { id: 'CALM_DRIFT', priceShock: 0.00, volShock: 0.00, correlationTo: null, note: 'Base case.' },
  { id: 'MILD_SELLOFF', priceShock: -0.05, volShock: 0.30, correlationTo: 0.80 },
  { id: 'CORRECTION', priceShock: -0.10, volShock: 0.60, correlationTo: 0.90 },
  { id: 'CRASH_1987', priceShock: -0.20, volShock: 1.50, correlationTo: 0.95 },
  { id: 'COVID_2020', priceShock: -0.30, volShock: 2.00, correlationTo: 0.97 },
  { id: 'GAP_OPEN', priceShock: -0.12, volShock: 1.00, correlationTo: 0.95, overnight: true,
    note: 'No opportunity to react. The scenario management rules cannot help with.' },
  { id: 'VOL_SPIKE_ONLY', priceShock: -0.02, volShock: 1.20, correlationTo: 0.70 },
  { id: 'MELT_UP', priceShock: +0.12, volShock: -0.30, correlationTo: 0.85,
    note: 'Short calls and covered calls lose here; the book is not symmetric.' },
]);

/**
 * Apply one scenario to a position.
 *
 * `repricer(position, shockedSpot, shockedVol)` returns the position's mark
 * under the shock. Supplied by the caller so this stays independent of any
 * particular pricing model.
 */
export function applyScenario({ positions, scenario, repricer }) {
  let pnl = 0;
  const byPosition = [];
  for (const pos of positions) {
    const shockedSpot = pos.spot * (1 + scenario.priceShock);
    const shockedVol = Math.max(0.01, pos.iv * (1 + scenario.volShock));
    const before = repricer(pos, pos.spot, pos.iv);
    const after = repricer(pos, shockedSpot, shockedVol);
    const delta = after - before;
    pnl += delta;
    byPosition.push({ id: pos.id, underlying: pos.underlying, pnl: delta, shockedSpot, shockedVol });
  }
  return { scenario: scenario.id, pnl, byPosition, note: scenario.note ?? null };
}

/** Run the whole mandated set. */
export function stressTest({ positions, nav, repricer, limits, scenarios = STRESS_SCENARIOS }) {
  const results = scenarios.map((s) => {
    const r = applyScenario({ positions, scenario: s, repricer });
    return { ...r, pctOfNav: nav > 0 ? r.pnl / nav : NaN, scenarioDef: s };
  });
  const worst = results.reduce((a, b) => (b.pnl < a.pnl ? b : a), results[0]);
  const breaches = results.filter((r) => isNum(r.pctOfNav) && -r.pctOfNav > limits.stressScenarioLossPct);
  return {
    results,
    worst,
    worstPctOfNav: worst?.pctOfNav ?? NaN,
    breaches,
    passed: breaches.length === 0,
    limit: limits.stressScenarioLossPct,
  };
}

/**
 * Monte Carlo portfolio loss distribution with a correlated shock factor.
 *
 * Uses a single-factor model: every underlying loads on a common factor
 * plus idiosyncratic noise. Crude, but it captures the one thing that
 * matters here — that the positions are not independent — and it is
 * transparent about how.
 */
export function portfolioLossDistribution({ positions, repricer, rng, paths = 5000, horizonDays = 1, factorLoading = 0.7 }) {
  const pnls = new Array(paths);
  for (let i = 0; i < paths; i += 1) {
    const common = rng.normal();
    let total = 0;
    for (const pos of positions) {
      const idio = rng.normal();
      const z = factorLoading * common + Math.sqrt(1 - factorLoading ** 2) * idio;
      const dailyVol = pos.iv / Math.sqrt(252);
      const move = z * dailyVol * Math.sqrt(horizonDays);
      const shockedSpot = pos.spot * Math.exp(move);
      // Vol rises when price falls — the leverage effect, and the reason a
      // delta-only stress understates a short-put book's loss.
      const shockedVol = Math.max(0.01, pos.iv * (1 - 2.5 * move));
      total += repricer(pos, shockedSpot, shockedVol) - repricer(pos, pos.spot, pos.iv);
    }
    pnls[i] = total;
  }
  return {
    pnls,
    mean: mean(pnls),
    cvar95: conditionalVaR(pnls, 0.95),
    cvar99: conditionalVaR(pnls, 0.99),
    var95: Math.max(0, -quantile(pnls, 0.05)),
    worst: Math.min(...pnls),
    horizonDays,
  };
}

/**
 * Probability of ruin (§1).
 *
 * Estimated by compounding the per-cycle P&L distribution forward. Reported
 * with its own standard error, because a ruin probability quoted without
 * one invites exactly the false precision §4 warns about.
 */
export function ruinProbability({ perCyclePnl, nav, ruinThreshold = 0.5, cycles = 52, trials = 2000, rng }) {
  if (!perCyclePnl.length) return { probability: NaN, sufficient: false };
  let ruined = 0;
  for (let i = 0; i < trials; i += 1) {
    let equity = nav;
    for (let c = 0; c < cycles; c += 1) {
      const draw = perCyclePnl[rng.int(perCyclePnl.length)];
      // Scale P&L to current equity: a smaller account takes smaller risk.
      equity += draw * (equity / nav);
      if (equity <= nav * ruinThreshold) { ruined += 1; break; }
    }
  }
  const p = ruined / trials;
  return {
    probability: p,
    standardError: Math.sqrt((p * (1 - p)) / trials),
    trials,
    cycles,
    ruinThreshold,
    sufficient: perCyclePnl.length >= 30,
    note: perCyclePnl.length < 30
      ? `Estimated from only ${perCyclePnl.length} P&L observations — treat as indicative, not measured.`
      : null,
  };
}
