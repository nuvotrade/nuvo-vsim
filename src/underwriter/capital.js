/**
 * Capital consumption (§3).
 *
 * Two different denominators, because they answer two different questions:
 *
 *   Buying Power     — what the BROKER locks up. Governs how many positions
 *                      NUVO can hold at once.
 *   Economic Capital — what the RISK actually consumes. Governs whether the
 *                      position deserves to exist at all.
 *
 * A CSP and a bull put spread on the same thesis can have wildly different
 * buying power and similar economic capital, or vice versa. Ranking on
 * either one alone produces a systematically distorted book.
 */
import { isNum } from '../math/stats.js';

/**
 * Economic capital: the capital that must stand behind this position to
 * survive its own tail at the chosen confidence.
 *
 * Uses CVaR rather than max loss. Max loss on a CSP is the strike going to
 * zero, which is true but useless for allocation — reserving against it
 * would let NUVO hold about three positions. CVaR reserves against the
 * severity actually expected in the bad tail, with a floor so that
 * defined-risk structures cannot claim near-zero capital.
 */
export function economicCapital({ evaluation, structure, floorFraction = 0.25 }) {
  const cvar = evaluation.cvar;
  if (!isNum(cvar)) return NaN;
  // Never claim less than a fraction of the true worst case.
  const floor = structure.definedRisk ? structure.maxLoss * floorFraction : cvar;
  return Math.max(cvar, floor);
}

/**
 * Return on capital: NEV per dollar of buying power, over the holding period.
 * This is the "how much of my account does this tie up" measure.
 */
export function returnOnCapital({ evaluation, structure }) {
  const bp = structure.buyingPower;
  if (!isNum(bp) || bp <= 0) {
    // A zero-BP structure (e.g. a covered call on shares already owned)
    // has undefined ROC; RAROC is the meaningful measure there.
    return { roc: null, basis: 'no-buying-power' };
  }
  return { roc: evaluation.nev / bp, basis: 'nev/bp' };
}

/**
 * Risk-adjusted return on capital, ANNUALISED.
 *
 * Annualising is what makes a 7-DTE and a 45-DTE candidate comparable at
 * all. Without it, longer-dated trades always look better simply because
 * they collect more absolute premium for more time and more risk.
 */
export function raroc({ evaluation, structure, dte }) {
  const ec = economicCapital({ evaluation, structure });
  if (!isNum(ec) || ec <= 0) return { raroc: null, economicCapital: ec, basis: 'no-economic-capital' };
  const periodReturn = evaluation.nev / ec;
  const periods = isNum(dte) && dte > 0 ? 365 / dte : 1;
  return {
    raroc: periodReturn * periods,
    periodReturn,
    economicCapital: ec,
    annualisationFactor: periods,
    basis: 'annualised nev/economic-capital',
  };
}

/**
 * Capital efficiency summary for one candidate.
 */
export function capitalProfile({ evaluation, structure, dte }) {
  const roc = returnOnCapital({ evaluation, structure });
  const rar = raroc({ evaluation, structure, dte });
  const bp = structure.buyingPower;
  return {
    buyingPower: bp,
    economicCapital: rar.economicCapital,
    roc: roc.roc,
    rocAnnualised: isNum(roc.roc) && isNum(dte) && dte > 0 ? roc.roc * (365 / dte) : null,
    raroc: rar.raroc,
    periodReturn: rar.periodReturn,
    /**
     * Leverage of risk over locked capital. High values mean the broker is
     * under-collateralising the real risk — which is the shape of every
     * defined-risk trade that turns out not to be.
     */
    riskDensity: isNum(bp) && bp > 0 && isNum(rar.economicCapital)
      ? rar.economicCapital / bp
      : null,
    creditToBp: isNum(bp) && bp > 0 ? structure.credit / bp : null,
    creditToMaxLoss: structure.maxLoss > 0 ? structure.credit / structure.maxLoss : null,
  };
}

/**
 * Opportunity cost check (§3: "What else could that capital be doing?").
 *
 * A candidate must beat not just zero but the best alternative use of the
 * same capital — including the risk-free rate, which a CSP's collateral
 * earns anyway and which is therefore NOT part of the trade's edge.
 */
export function opportunityAdjusted({ capital, dte, riskFreeRate = 0.045, bestAlternativeRaroc = null }) {
  const rf = riskFreeRate;
  const hurdle = bestAlternativeRaroc !== null ? Math.max(rf, bestAlternativeRaroc) : rf;
  return {
    hurdle,
    excessRaroc: isNum(capital.raroc) ? capital.raroc - hurdle : null,
    beatsAlternative: isNum(capital.raroc) ? capital.raroc > hurdle : false,
    note: `Collateral earns ${(rf * 100).toFixed(2)}% regardless; only the excess is edge.`,
  };
}
