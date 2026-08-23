/**
 * Black–Scholes–Merton with continuous dividend yield.
 *
 * These are used for two distinct jobs and the distinction matters:
 *   1. Extracting the MARKET's view (implied vol, p_market) from quoted prices.
 *   2. Valuing hypothetical structures during optimisation.
 * They are never used to fabricate a Greek the broker failed to supply
 * (Constitution §18) — the Truth Engine gates that, not this file.
 */
import { normCdf, normPdf, isNum } from './stats.js';

const YEAR = 365;

/** Convert calendar DTE to year fraction. */
export const dteToT = (dte) => (isNum(dte) ? Math.max(dte, 0) / YEAR : NaN);

export function d1d2({ spot, strike, vol, t, rate = 0, yield: q = 0 }) {
  if (!isNum(spot) || !isNum(strike) || !isNum(vol) || !isNum(t)) return { d1: NaN, d2: NaN };
  if (spot <= 0 || strike <= 0 || vol <= 0 || t <= 0) return { d1: NaN, d2: NaN };
  const vsq = vol * Math.sqrt(t);
  const d1 = (Math.log(spot / strike) + (rate - q + (vol * vol) / 2) * t) / vsq;
  return { d1, d2: d1 - vsq };
}

/** Theoretical price. `type` is 'call' | 'put'. */
export function price({ type, spot, strike, vol, t, rate = 0, yield: q = 0 }) {
  if (t <= 0 || vol <= 0) {
    // At expiry (or zero vol) the option is worth its intrinsic value.
    if (!isNum(spot) || !isNum(strike)) return NaN;
    return type === 'call' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  }
  const { d1, d2 } = d1d2({ spot, strike, vol, t, rate, yield: q });
  if (!isNum(d1)) return NaN;
  const df = Math.exp(-rate * t);
  const dq = Math.exp(-q * t);
  return type === 'call'
    ? spot * dq * normCdf(d1) - strike * df * normCdf(d2)
    : strike * df * normCdf(-d2) - spot * dq * normCdf(-d1);
}

/** Full Greek set. Vega per 1 vol point, theta per calendar day. */
export function greeks({ type, spot, strike, vol, t, rate = 0, yield: q = 0 }) {
  const { d1, d2 } = d1d2({ spot, strike, vol, t, rate, yield: q });
  if (!isNum(d1)) return { delta: NaN, gamma: NaN, vega: NaN, theta: NaN, rho: NaN };
  const df = Math.exp(-rate * t);
  const dq = Math.exp(-q * t);
  const pdf = normPdf(d1);
  const delta = type === 'call' ? dq * normCdf(d1) : dq * (normCdf(d1) - 1);
  const gamma = (dq * pdf) / (spot * vol * Math.sqrt(t));
  const vega = (spot * dq * pdf * Math.sqrt(t)) / 100;
  const thetaAnnual =
    type === 'call'
      ? -(spot * dq * pdf * vol) / (2 * Math.sqrt(t)) -
        rate * strike * df * normCdf(d2) +
        q * spot * dq * normCdf(d1)
      : -(spot * dq * pdf * vol) / (2 * Math.sqrt(t)) +
        rate * strike * df * normCdf(-d2) -
        q * spot * dq * normCdf(-d1);
  const rho =
    type === 'call'
      ? (strike * t * df * normCdf(d2)) / 100
      : (-strike * t * df * normCdf(-d2)) / 100;
  return { delta, gamma, vega, theta: thetaAnnual / YEAR, rho };
}

/**
 * Risk-neutral probability of finishing in the money.
 * For a put this is N(-d2) — the market-implied P(S_T < K).
 *
 * This is `p_market`. It is NOT the real-world probability and NUVO must
 * never present it as one (§4).
 */
export function probItm({ type, spot, strike, vol, t, rate = 0, yield: q = 0 }) {
  const { d2 } = d1d2({ spot, strike, vol, t, rate, yield: q });
  if (!isNum(d2)) return NaN;
  return type === 'call' ? normCdf(d2) : normCdf(-d2);
}

/**
 * Probability the underlying touches `strike` at any point before expiry.
 * Reflection principle for a Brownian motion with drift `mu` in log space.
 *
 * This matters more than P(ITM at expiry) for management rules: a position
 * that is breached and repaired mid-life never shows up in a terminal
 * probability, but it consumed real risk while it was breached.
 */
export function probTouch({ spot, strike, vol, t, rate = 0 }) {
  if (!isNum(spot) || !isNum(strike) || !isNum(vol) || !isNum(t)) return NaN;
  if (spot <= 0 || strike <= 0 || vol <= 0 || t <= 0) return NaN;
  if (spot === strike) return 1;
  const mu = rate - (vol * vol) / 2;
  const b = Math.log(strike / spot); // barrier in log space: <0 below, >0 above
  const s = vol * Math.sqrt(t);
  const reflect = Math.exp((2 * mu * b) / (vol * vol));
  const p = strike < spot
    // Down-barrier: hit if the terminal point is below, or the reflected path was.
    ? normCdf((b - mu * t) / s) + reflect * normCdf((b + mu * t) / s)
    // Up-barrier: the mirror image.
    : normCdf((-b + mu * t) / s) + reflect * normCdf((-b - mu * t) / s);
  return Math.min(1, Math.max(0, p));
}

/**
 * Implied volatility by bisection on a bracketed interval.
 * Bisection (not Newton) because it cannot diverge on the deep wings where
 * vega collapses — robustness beats speed when the answer gates a trade.
 * Returns NaN when the price is outside the no-arbitrage envelope.
 */
export function impliedVol({ type, marketPrice, spot, strike, t, rate = 0, yield: q = 0 }, opts = {}) {
  const { tol = 1e-6, maxIter = 100, lo: loIn = 1e-4, hi: hiIn = 5 } = opts;
  if (!isNum(marketPrice) || marketPrice <= 0 || !isNum(spot) || !isNum(strike) || !isNum(t) || t <= 0) {
    return NaN;
  }
  const intrinsic =
    type === 'call'
      ? Math.max(spot * Math.exp(-q * t) - strike * Math.exp(-rate * t), 0)
      : Math.max(strike * Math.exp(-rate * t) - spot * Math.exp(-q * t), 0);
  if (marketPrice < intrinsic - tol) return NaN; // arbitrage / stale quote
  let lo = loIn;
  let hi = hiIn;
  const f = (v) => price({ type, spot, strike, vol: v, t, rate, yield: q }) - marketPrice;
  if (f(lo) > 0 || f(hi) < 0) return NaN; // not bracketed
  for (let i = 0; i < maxIter; i += 1) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (Math.abs(fm) < tol || hi - lo < tol) return mid;
    if (fm > 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}
