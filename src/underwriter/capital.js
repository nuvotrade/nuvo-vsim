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

/** The mandated crash shock economic capital must stand behind. */
export const CRASH_SHOCK = -0.20;

/** Minimum share of locked buying power an undefined-risk position consumes. */
export const UNDEFINED_RISK_CAPITAL_FLOOR = 0.10;

/**
 * Economic capital: the capital that must stand behind this position to
 * survive its own tail.
 *
 * Three measures are taken and the LARGEST wins, because each one is blind
 * to a different failure:
 *
 *   1. CVaR at 99%, not 95%. For a 5-delta short put, P(loss) is below the
 *      95% cutoff entirely, so CVaR95 is nearly zero and RAROC divides by
 *      almost nothing. That produces a systematic bias toward selling the
 *      furthest, cheapest wing available - picking up pennies in front of
 *      the steamroller, arrived at by arithmetic rather than by judgement.
 *      The 99% level sits inside the loss region where it belongs.
 *   2. A deterministic stress loss at a 3-sigma adverse move. This does not
 *      depend on the distribution being right about its own tail, which is
 *      the assumption most likely to fail exactly when it matters.
 *   3. A floor fraction of true max loss for defined-risk structures, so a
 *      narrow spread cannot claim near-zero capital.
 *
 * Max loss alone is rejected as the measure: for a CSP it is the strike
 * going to zero, and reserving against that would permit about three
 * positions. Max loss is a solvency fact, not an allocation basis.
 */
export function economicCapital({ evaluation, structure, dist = null, floorFraction = 0.25 }) {
  const candidates = [];

  // 1. Deep tail expected shortfall.
  if (dist) {
    const deep = dist.payoffStats(structure.payoff, { alpha: 0.99 });
    if (isNum(deep.cvar)) candidates.push(deep.cvar);
  }
  if (isNum(evaluation.cvar)) candidates.push(evaluation.cvar);

  // 2. Deterministic stress, independent of the tail model being right:
  //    a 3-sigma move, and the mandated -20% crash scenario.
  if (dist && isNum(dist.spot) && dist.spot > 0 && isNum(dist.t) && dist.t > 0) {
    const vol = dist.params?.vol;
    const shocks = [];
    if (isNum(vol) && vol > 0) shocks.push(dist.spot * Math.exp(-3 * vol * Math.sqrt(dist.t)));
    shocks.push(dist.spot * (1 + CRASH_SHOCK));
    for (const stressed of shocks) {
      const loss = -structure.payoff(stressed);
      if (isNum(loss) && loss > 0) candidates.push(loss);
    }
  }

  // 3. Structural floors.
  if (structure.definedRisk && isNum(structure.maxLoss)) {
    candidates.push(structure.maxLoss * floorFraction);
  } else if (isNum(structure.buyingPower) && structure.buyingPower > 0) {
    // An undefined-risk position may not claim to consume less than a tenth
    // of what the broker locks against it. Without this floor, RAROC is
    // maximised by selling the furthest, thinnest wing on the board - the
    // denominator collapses faster than the numerator, and the ranking
    // walks itself into exactly the trade that ends short-premium books.
    // The broker demands that collateral for a reason; so does NUVO.
    candidates.push(structure.buyingPower * UNDEFINED_RISK_CAPITAL_FLOOR);
  }

  if (!candidates.length) return NaN;
  // Never exceed what can actually be lost.
  const ec = Math.max(...candidates);
  return isNum(structure.maxLoss) && structure.maxLoss > 0 ? Math.min(ec, structure.maxLoss) : ec;
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
export function raroc({ evaluation, structure, dte, dist = null }) {
  const ec = economicCapital({ evaluation, structure, dist });
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
export function capitalProfile({ evaluation, structure, dte, dist = null }) {
  if (structure?.kind === 'CSP') {
    const ec = economicCapital({ evaluation, structure, dist });
    const bp = structure.buyingPower;
    return {
      buyingPower: bp,
      economicCapital: ec,
      // CSP ranking and eligibility are NEV/day after the full collateral
      // hurdle. Do not compute or pass annualised ROC/RAROC for CSPs: a
      // deprecated display metric must not find its way back into selection.
      decisionMetric: 'NEV_PER_CALENDAR_DAY',
      decisionValue: isNum(evaluation.nev) && isNum(dte) && dte > 0
        ? evaluation.nev / dte : null,
      riskDensity: isNum(bp) && bp > 0 && isNum(ec) ? ec / bp : null,
      creditToBp: isNum(bp) && bp > 0 ? structure.credit / bp : null,
      creditToMaxLoss: structure.maxLoss > 0 ? structure.credit / structure.maxLoss : null,
    };
  }
  const roc = returnOnCapital({ evaluation, structure });
  const rar = raroc({ evaluation, structure, dte, dist });
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
    decisionMetric: 'RAROC',
    decisionValue: rar.raroc,
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
