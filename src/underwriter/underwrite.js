/**
 * Underwriting one candidate (§3).
 *
 * "Every potential position should be treated as an insurance contract."
 *
 * This module answers the six questions in §3 in order and refuses to
 * answer any of them from data it does not have.
 */
import { evaluate, conditionalLoss, DEFAULT_LAMBDAS } from './ev.js';
import { capitalProfile, opportunityAdjusted } from './capital.js';
import {
  probabilitySet, marketProbability, modelProbability,
  calibrationTag, FORECAST_EVENT,
} from './probabilities.js';
import { DEFAULT_COSTS, costRatio } from './costs.js';
import { TIER, violation } from '../constitution/hierarchy.js';
import { contractLiquidity } from '../universe/filters.js';
import { hurdleFor } from '../market/regime.js';
import { isNum } from '../math/stats.js';
import { probTouch, dteToT } from '../math/black_scholes.js';

/**
 * Full underwriting assessment of one structure.
 *
 * Returns a result whose `admissible` flag is governed by constitutional
 * limits, and whose `violations` list explains any refusal at the tier it
 * occurred — so a survival rejection is never confused with a thin edge.
 */
export function underwrite({
  structure,
  dist,
  diffusionDist,
  underlyingState,
  regime,
  limits,
  calibrationStore = null,
  costs = DEFAULT_COSTS,
  lambdas = DEFAULT_LAMBDAS,
  strategyId = null,
}) {
  const violations = [];
  const dte = structure.dte;
  const spot = underlyingState.spot;

  // ── Probability of breach, used to weight liquidity risk honestly ──
  const shortIv = structure.legs.find((l) => l.action === 'SELL')?.contract?.iv;
  const pTouch = isNum(structure.shortStrike) && isNum(shortIv)
    ? probTouch({ spot, strike: structure.shortStrike, vol: shortIv, t: dteToT(dte) })
    : 0.35;

  const evaluation = evaluate({
    structure, dist, diffusionDist, costs, lambdas,
    pNeedExit: isNum(pTouch) ? pTouch : 0.35,
  });
  const capital = capitalProfile({ evaluation, structure, dte, dist });
  const condLoss = conditionalLoss({ structure, dist });

  // ── The three probabilities (§4) ──
  let probabilities = null;
  if (isNum(structure.shortStrike)) {
    probabilities = probabilitySet({
      market: marketProbability({ spot, strike: structure.shortStrike, strikeIv: shortIv, dte }),
      model: modelProbability({ dist, strike: structure.shortStrike }),
      store: calibrationStore,
      // recordOutcome stores terminal and touch forecasts on separate
      // scoreboards. Underwriting must read the same terminal namespace or
      // a model can collect years of evidence and remain UNCALIBRATED.
      tag: calibrationTag(strategyId, FORECAST_EVENT.TERMINAL_BELOW_STRIKE),
    });
  }

  // ── Contract-level liquidity ──
  for (const leg of structure.legs) {
    if (!leg.contract) continue;
    violations.push(...contractLiquidity(leg.contract, limits, { intendedContracts: leg.quantity }));
  }

  // ── Regime permission and its expectancy hurdle (§6) ──
  const { stance, hurdle } = hurdleFor(regime?.regime, structure.kind, limits.minRaroc);
  if (!isNum(hurdle) || hurdle === Infinity) {
    violations.push(violation(TIER.SURVIVAL, 'STRUCTURE_FORBIDDEN',
      `${structure.kind} is forbidden in regime ${regime?.regime ?? 'UNKNOWN'}.`,
      { regime: regime?.regime, structure: structure.kind }));
  }
  if (regime && !regime.confident) {
    violations.push(violation(TIER.TRUTH, 'REGIME_UNCERTAIN',
      `Regime determined from only ${(regime.coverage * 100).toFixed(0)}% of its inputs.`,
      { coverage: regime.coverage }));
  }

  // ── Expectancy floors (§3) ──
  if (!(evaluation.nev > limits.minNev)) {
    violations.push(violation(TIER.EXPECTANCY, 'NEV_NONPOSITIVE',
      `NEV ${evaluation.nev.toFixed(2)} does not exceed ${limits.minNev}.`, { nev: evaluation.nev }));
  }
  if (isNum(capital.raroc) && capital.raroc < hurdle) {
    violations.push(violation(TIER.CAPITAL_EFFICIENCY, 'RAROC_BELOW_HURDLE',
      `RAROC ${(capital.raroc * 100).toFixed(1)}% below the ${stance} hurdle of ${(hurdle * 100).toFixed(1)}%.`,
      { raroc: capital.raroc, hurdle, stance }));
  }
  if (isNum(capital.roc) && capital.roc < limits.minRoc) {
    violations.push(violation(TIER.CAPITAL_EFFICIENCY, 'ROC_LOW',
      `ROC ${(capital.roc * 100).toFixed(2)}% below ${(limits.minRoc * 100).toFixed(2)}%.`,
      { roc: capital.roc }));
  }

  // ── The edge must dominate its own cost estimate ──
  const cRatio = costRatio(structure, costs);
  if (evaluation.costs.total > 0 && evaluation.ev > 0) {
    const multiple = evaluation.ev / evaluation.costs.total;
    if (multiple < limits.minEdgeOverCosts) {
      violations.push(violation(TIER.EXPECTANCY, 'EDGE_THIN_VS_COSTS',
        `Edge is only ${multiple.toFixed(1)}x modelled costs; ${limits.minEdgeOverCosts}x required.`,
        { multiple, costs: evaluation.costs.total }));
    }
  }

  // ── Single-trade survival limit ──
  // Checked here against NAV so a candidate that alone threatens the book
  // is killed before it ever reaches sizing.
  const nav = underlyingState.nav ?? null;
  if (isNum(nav) && nav > 0 && evaluation.cvar / nav > limits.maxSingleTradeCVaRPct) {
    violations.push(violation(TIER.SURVIVAL, 'TRADE_CVAR_EXCESSIVE',
      `Trade CVaR is ${((evaluation.cvar / nav) * 100).toFixed(1)}% of NAV; limit ${(limits.maxSingleTradeCVaRPct * 100).toFixed(1)}%.`,
      { cvar: evaluation.cvar, nav }));
  }

  // ── DTE window (§22) ──
  if (isNum(dte) && (dte < limits.minDte || dte > limits.maxDte)) {
    violations.push(violation(TIER.SURVIVAL, 'DTE_OUT_OF_BAND',
      `${dte} DTE is outside the ${limits.minDte}-${limits.maxDte} operating band.`, { dte }));
  }

  const opportunity = opportunityAdjusted({ capital, dte });
  if (!opportunity.beatsAlternative && isNum(capital.raroc)) {
    violations.push(violation(TIER.CAPITAL_EFFICIENCY, 'BELOW_RISK_FREE',
      `RAROC ${(capital.raroc * 100).toFixed(1)}% does not beat the ${(opportunity.hurdle * 100).toFixed(2)}% alternative.`,
      opportunity));
  }

  return {
    structure,
    underlying: structure.underlying,
    strategyId,
    dte,
    evaluation,
    capital,
    probabilities,
    conditionalLoss: condLoss,
    pTouch,
    costRatio: cRatio,
    stance,
    hurdle,
    opportunity,
    violations: violations.sort((a, b) => a.tier - b.tier),
    admissible: violations.length === 0,
    /** Ranking score. RAROC, not premium (§20). */
    score: isNum(capital.raroc) ? capital.raroc : -Infinity,
  };
}
