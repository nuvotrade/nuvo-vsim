/**
 * Implied volatility surface metrics (§5).
 *
 * Everything here is measured off the live chain. Nothing is interpolated
 * across a gap in the data and then presented as observed — if the chain
 * cannot support a metric, the metric is NaN and the caller must handle it.
 */
import { isNum, percentileRank, quantile } from '../math/stats.js';

/** Contracts of one expiry, sorted by strike. */
export function sliceExpiry(chain, dte, right = 'put') {
  const exact = chain.contracts.filter((c) => c.dte === dte && c.right === right);
  if (exact.length) return exact.sort((a, b) => a.strike - b.strike);
  // Fall back to the nearest available tenor, but say so via `.dte`.
  const tenors = [...new Set(chain.contracts.map((c) => c.dte))];
  if (!tenors.length) return [];
  const near = tenors.reduce((a, b) => (Math.abs(b - dte) < Math.abs(a - dte) ? b : a));
  return chain.contracts.filter((c) => c.dte === near && c.right === right)
    .sort((a, b) => a.strike - b.strike);
}

/** ATM implied vol: the contract whose strike is nearest spot. */
export function atmIv(chain, dte, right = 'put') {
  const slice = sliceExpiry(chain, dte, right);
  if (!slice.length || !isNum(chain.spot)) return NaN;
  const near = slice.reduce((a, b) =>
    (Math.abs(b.strike - chain.spot) < Math.abs(a.strike - chain.spot) ? b : a));
  return near.iv;
}

/** IV at a target delta (absolute value), interpolated between neighbours. */
export function ivAtDelta(chain, dte, targetDelta, right = 'put') {
  const slice = sliceExpiry(chain, dte, right).filter((c) => isNum(c.delta) && isNum(c.iv));
  if (slice.length < 2) return NaN;
  const t = Math.abs(targetDelta);
  const sorted = slice.slice().sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const lo = Math.abs(sorted[i].delta);
    const hi = Math.abs(sorted[i + 1].delta);
    if (t >= lo && t <= hi && hi > lo) {
      const w = (t - lo) / (hi - lo);
      return sorted[i].iv + w * (sorted[i + 1].iv - sorted[i].iv);
    }
  }
  return NaN; // outside the quoted delta range — do not extrapolate
}

/**
 * Downside skew: IV(25-delta put) - IV(ATM), in vol points.
 *
 * This number is the compensation for selling downside specifically.
 * A wide skew means the market is paying up for crash protection; that is
 * where a downside underwriter is supposed to make money, and it is also
 * where it is supposed to be most careful about why.
 */
export function downsideSkew(chain, dte) {
  const wing = ivAtDelta(chain, dte, 0.25, 'put');
  const atm = atmIv(chain, dte, 'put');
  return isNum(wing) && isNum(atm) ? wing - atm : NaN;
}

/** Risk reversal: IV(25d put) - IV(25d call). Positive = downside bid. */
export function riskReversal(chain, dte) {
  const p = ivAtDelta(chain, dte, 0.25, 'put');
  const c = ivAtDelta(chain, dte, 0.25, 'call');
  return isNum(p) && isNum(c) ? p - c : NaN;
}

/** Butterfly: wing average minus ATM. Measures overall smile curvature. */
export function butterfly(chain, dte) {
  const p = ivAtDelta(chain, dte, 0.25, 'put');
  const c = ivAtDelta(chain, dte, 0.25, 'call');
  const atm = atmIv(chain, dte, 'put');
  return isNum(p) && isNum(c) && isNum(atm) ? (p + c) / 2 - atm : NaN;
}

/**
 * Term structure across available tenors.
 * `slope` < 0 is BACKWARDATION — near-dated vol bid above far-dated, the
 * classic stress signature and one of the regime engine's inputs.
 */
export function termStructure(chain) {
  const tenors = [...new Set(chain.contracts.map((c) => c.dte))].sort((a, b) => a - b);
  const points = tenors
    .map((dte) => ({ dte, iv: atmIv(chain, dte, 'put') }))
    .filter((p) => isNum(p.iv));
  if (points.length < 2) return { points, slope: NaN, backwardated: null };
  const first = points[0];
  const last = points[points.length - 1];
  const slope = (last.iv - first.iv) / Math.max(1, last.dte - first.dte);
  return {
    points,
    slope,                                   // vol points per day of tenor
    ratio: first.iv / last.iv,
    backwardated: slope < 0,
  };
}

/**
 * IV Rank and IV Percentile against a trailing history.
 *
 * Rank is where today sits in the min-max range; percentile is the fraction
 * of days below today. They differ, and quoting one as the other is a
 * common way to make a mediocre setup look like an opportunity.
 */
export function ivRankPercentile(currentIv, history) {
  const h = (history ?? []).filter(isNum);
  if (!isNum(currentIv) || h.length < 20) {
    return { rank: NaN, percentile: NaN, n: h.length, sufficient: false };
  }
  const lo = Math.min(...h);
  const hi = Math.max(...h);
  return {
    rank: hi > lo ? (currentIv - lo) / (hi - lo) : NaN,
    percentile: percentileRank(h, currentIv),
    n: h.length,
    sufficient: true,
    median: quantile(h, 0.5),
  };
}

/** Full surface summary for one underlying. */
export function surfaceSummary(chain, { dte = 30 } = {}) {
  return {
    underlying: chain.underlying,
    spot: chain.spot,
    dte,
    atmIv: atmIv(chain, dte, 'put'),
    iv25dPut: ivAtDelta(chain, dte, 0.25, 'put'),
    iv10dPut: ivAtDelta(chain, dte, 0.10, 'put'),
    iv25dCall: ivAtDelta(chain, dte, 0.25, 'call'),
    skew: downsideSkew(chain, dte),
    riskReversal: riskReversal(chain, dte),
    butterfly: butterfly(chain, dte),
    term: termStructure(chain),
  };
}
