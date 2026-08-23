/**
 * Volatility Risk Premium (§5).
 *
 * Unconditional VRP is almost useless for decisions: it is positive on
 * average and that fact alone has funded a great many blown-up short-vol
 * books. What NUVO acts on is CONDITIONAL VRP — the premium given the
 * regime, the event calendar, and where realised vol is heading.
 */
import { isNum, mean, stdev, quantile } from '../math/stats.js';

/** Absolute premium in vol points: IV - RV. */
export const vrpSpread = (iv, rv) => (isNum(iv) && isNum(rv) ? iv - rv : NaN);

/** Ratio form: IV / RV. Scale-free, so comparable across underlyings. */
export const vrpRatio = (iv, rv) => (isNum(iv) && isNum(rv) && rv > 0 ? iv / rv : NaN);

/**
 * Forward-looking VRP: compare implied against the GARCH FORECAST over the
 * option's own horizon, not against trailing realised vol.
 *
 * This is the single most important correction in this file. Selling 30-DTE
 * vol because IV exceeds the last 20 days of realised vol is backward-looking;
 * if vol is mean-reverting upward from a calm patch, that "premium" is a
 * mirage and the position is short gamma into a rising-vol regime.
 */
export function forwardVrp({ iv, garch, horizonDays }) {
  if (!isNum(iv)) return { spread: NaN, ratio: NaN, basis: 'unavailable' };
  if (!garch?.ok) {
    return { spread: NaN, ratio: NaN, basis: 'no-garch', note: 'GARCH unavailable; VRP not computed forward.' };
  }
  const forecast = garch.forecast(horizonDays);
  return {
    spread: iv - forecast,
    ratio: forecast > 0 ? iv / forecast : NaN,
    forecastVol: forecast,
    basis: 'garch-forecast',
    horizonDays,
  };
}

/**
 * Conditional VRP: the distribution of the premium in comparable states.
 *
 * `history` entries are { iv, rv, state } observations. NUVO asks "what has
 * this premium been worth when the world looked like it looks today", which
 * is a very different question from "what is it worth on average".
 */
export function conditionalVrp(history, condition, { minSample = 30 } = {}) {
  const matching = history.filter(condition);
  if (matching.length < minSample) {
    return {
      sufficient: false,
      n: matching.length,
      required: minSample,
      note: `Only ${matching.length} comparable observations; conditional VRP is UNRELIABLE.`,
    };
  }
  const spreads = matching.map((h) => vrpSpread(h.iv, h.rv)).filter(isNum);
  const ratios = matching.map((h) => vrpRatio(h.iv, h.rv)).filter(isNum);
  return {
    sufficient: true,
    n: matching.length,
    meanSpread: mean(spreads),
    medianSpread: quantile(spreads, 0.5),
    sdSpread: stdev(spreads),
    meanRatio: mean(ratios),
    // The share of comparable days on which the premium was NEGATIVE — the
    // honest read on how often this trade was simply mispriced against you.
    fractionNegative: spreads.filter((s) => s < 0).length / spreads.length,
    p10: quantile(spreads, 0.10),
    p90: quantile(spreads, 0.90),
  };
}

/**
 * Is the premium worth underwriting?
 *
 * Deliberately strict. Both the level and the forward comparison must clear,
 * because a wide IV/RV ratio on a name whose vol is exploding is not a
 * premium — it is a warning that has been mispriced as an opportunity.
 */
export function assessPremium({ iv, rv, forward, minRatio = 1.10, minSpread = 0.02 }) {
  const spread = vrpSpread(iv, rv);
  const ratio = vrpRatio(iv, rv);
  const reasons = [];
  let attractive = true;

  if (!isNum(spread) || !isNum(ratio)) {
    return { attractive: false, spread, ratio, reasons: ['VRP not computable from available data.'] };
  }
  if (ratio < minRatio) {
    attractive = false;
    reasons.push(`IV/RV ${ratio.toFixed(2)} below floor ${minRatio.toFixed(2)}.`);
  }
  if (spread < minSpread) {
    attractive = false;
    reasons.push(`IV-RV ${(spread * 100).toFixed(1)}pts below floor ${(minSpread * 100).toFixed(1)}pts.`);
  }
  if (forward && isNum(forward.spread) && forward.spread <= 0) {
    attractive = false;
    reasons.push(
      `Forward VRP is negative (${(forward.spread * 100).toFixed(1)}pts vs ${horizonLabel(forward)}): ` +
      'trailing realised vol understates where vol is heading.',
    );
  }
  return { attractive, spread, ratio, forward, reasons };
}

const horizonLabel = (f) => (isNum(f.horizonDays) ? `${f.horizonDays}d forecast` : 'forecast');
