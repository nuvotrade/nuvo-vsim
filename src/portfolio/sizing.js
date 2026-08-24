/**
 * Position sizing (§15).
 *
 *   Size = BaseRisk x Q x C x R x D
 *
 * Not "10% per stock", not "one contract each". The multipliers exist so
 * that an unvalidated model gets less capital BECAUSE we do not yet know
 * how good it is — authority over capital is earned, not assumed.
 */
import { clamp, isNum } from '../math/stats.js';
import { CAPITAL_AUTHORITY_FRACTION } from '../constitution/authority.js';

/**
 * Q — opportunity quality, from RAROC relative to the hurdle.
 * Saturating rather than linear: a spectacular RAROC is usually a modelling
 * artefact or a risk not yet understood, so quality caps out.
 */
export function qualityMultiplier(raroc, hurdle) {
  if (!isNum(raroc) || !isNum(hurdle) || hurdle <= 0) return 0;
  const ratio = raroc / hurdle;
  if (ratio <= 1) return 0;
  return clamp(1 - Math.exp(-(ratio - 1) / 1.5), 0, 1);
}

/**
 * C — calibration confidence. Comes straight from the probability set,
 * which is UNCALIBRATED until live evidence accumulates.
 */
export const confidenceMultiplier = (confidence) => clamp(confidence ?? 0.25, 0.05, 1);

/** R — regime multiplier, from the regime engine. */
export const regimeMultiplier = (regime) => clamp(regime?.sizeMultiplier ?? 0, 0, 1.5);

/**
 * D — diversification. Falls as the cluster fills up, reaching zero at the
 * constitutional cap so sizing cannot even propose a breach.
 */
export function diversificationMultiplier({ clusterExposure, clusterLimit, correlation: rho }) {
  if (!isNum(clusterExposure) || !isNum(clusterLimit) || clusterLimit <= 0) return 0;
  const used = clamp(clusterExposure / clusterLimit, 0, 1);
  const room = 1 - used;
  // A highly correlated addition is worth less room than an uncorrelated one.
  const corrPenalty = isNum(rho) ? clamp(1 - Math.max(0, Math.abs(rho) - 0.3) / 0.7, 0.2, 1) : 0.7;
  return clamp(room * corrPenalty, 0, 1);
}

/**
 * Compute the size in contracts.
 *
 * `baseRiskPct` is the fraction of NAV NUVO is willing to put at economic
 * risk in a single fully-qualified position. Every multiplier can only
 * REDUCE it — there is no path by which enthusiasm increases size.
 */
export function sizePosition({
  candidate,
  nav,
  ledger,
  regime,
  clusterExposure,
  clusterCorrelation,
  limits,
  authorityLevel,
  baseRiskPct = 0.02,
}) {
  const Q = qualityMultiplier(candidate.capital.raroc, candidate.hurdle);
  const C = confidenceMultiplier(candidate.probabilities?.confidence);
  const R = regimeMultiplier(regime);
  const D = diversificationMultiplier({
    clusterExposure,
    clusterLimit: nav * limits.maxClusterPct,
    correlation: clusterCorrelation,
  });

  const authorityFraction = CAPITAL_AUTHORITY_FRACTION[authorityLevel] ?? 0;
  const riskBudget = nav * baseRiskPct * Q * C * R * D;

  const perContractRisk = candidate.capital.economicCapital / Math.max(1, candidate.structure.contracts);
  const perContractBp = candidate.structure.buyingPower / Math.max(1, candidate.structure.contracts);

  const deployable = ledger.deployable({ authorityFraction });

  const byRisk = perContractRisk > 0 ? Math.floor(riskBudget / perContractRisk) : 0;
  const byCapital = perContractBp > 0 ? Math.floor(deployable / perContractBp) : Infinity;
  const bySingleName = perContractBp > 0
    ? Math.floor((nav * limits.maxSingleUnderlyingPct) / perContractBp)
    : Infinity;
  const byTradeCvar = perContractRisk > 0
    ? Math.floor((nav * limits.maxSingleTradeCVaRPct) / perContractRisk)
    : Infinity;

  const contracts = Math.max(0, Math.min(byRisk, byCapital, bySingleName, byTradeCvar));

  // Name the binding constraint. When NUVO sizes small, the operator should
  // be able to see whether it was conviction, capital, or a limit.
  const binding = [
    ['risk-budget', byRisk], ['deployable-capital', byCapital],
    ['single-name-limit', bySingleName], ['trade-cvar-limit', byTradeCvar],
  ].filter(([, v]) => isNum(v)).sort((a, b) => a[1] - b[1])[0]?.[0] ?? 'unknown';

  return {
    contracts,
    multipliers: { Q, C, R, D, authorityFraction },
    riskBudget,
    perContractRisk,
    perContractBp,
    deployable,
    caps: { byRisk, byCapital, bySingleName, byTradeCvar },
    binding,
    totalBuyingPower: contracts * perContractBp,
    totalEconomicCapital: contracts * perContractRisk,
    /** Why zero, when it is zero. */
    zeroReason: contracts === 0 ? explainZero({ Q, C, R, D, authorityFraction, deployable }) : null,
  };
}

function explainZero({ Q, C, R, D, authorityFraction, deployable }) {
  if (authorityFraction === 0) return 'Authority level does not permit capital deployment.';
  if (Q === 0) return 'Opportunity quality is zero: RAROC does not exceed the regime hurdle.';
  if (R === 0) return 'Regime multiplier is zero.';
  if (D === 0) return 'Correlated cluster is already at its constitutional limit.';
  if (deployable <= 0) return 'No deployable capital remains.';
  if (C <= 0.1) return 'Model confidence is too low to justify any size.';
  return 'Risk budget is smaller than one contract.';
}
