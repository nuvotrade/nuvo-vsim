/** Numerical primitives. Every function returns NaN rather than guessing on bad input. */

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function mean(xs) {
  if (!xs.length) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample variance (Bessel-corrected). */
export function variance(xs) {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return s / (xs.length - 1);
}

export const stdev = (xs) => Math.sqrt(variance(xs));

export function skewness(xs) {
  const n = xs.length;
  if (n < 3) return NaN;
  const m = mean(xs);
  const sd = stdev(xs);
  if (!isNum(sd) || sd === 0) return NaN;
  let s = 0;
  for (const x of xs) s += ((x - m) / sd) ** 3;
  return (n / ((n - 1) * (n - 2))) * s;
}

export function kurtosis(xs) {
  const n = xs.length;
  if (n < 4) return NaN;
  const m = mean(xs);
  const sd = stdev(xs);
  if (!isNum(sd) || sd === 0) return NaN;
  let s = 0;
  for (const x of xs) s += ((x - m) / sd) ** 4;
  const g2 = (n * (n + 1) * s) / ((n - 1) * (n - 2) * (n - 3));
  return g2 - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3)); // excess kurtosis
}

/**
 * Quantile from an ALREADY-SORTED ascending array.
 * Split out because the hot path evaluates thousands of candidates and
 * re-sorting the same array for each order statistic dominated the cost.
 */
export function quantileSorted(s, q) {
  if (!s.length || !isNum(q)) return NaN;
  if (q <= 0) return s[0];
  if (q >= 1) return s[s.length - 1];
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] + (pos - lo) * (s[hi] - s[lo]);
}

/** Conditional VaR from an ALREADY-SORTED ascending array of P&L. */
export function conditionalVaRSorted(s, alpha = 0.95) {
  if (!s.length) return NaN;
  const k = Math.max(1, Math.floor(s.length * (1 - alpha)));
  let sum = 0;
  for (let i = 0; i < k; i += 1) sum += s[i];
  return Math.max(0, -(sum / k));
}

/** Linear-interpolated quantile (type 7, matching NumPy/R defaults). */
export function quantile(xs, q) {
  if (!xs.length) return NaN;
  if (!isNum(q)) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  if (q <= 0) return s[0];
  if (q >= 1) return s[s.length - 1];
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] + (pos - lo) * (s[hi] - s[lo]);
}

export const median = (xs) => quantile(xs, 0.5);

/**
 * Value at Risk at confidence `alpha`, reported as a POSITIVE loss magnitude.
 * `xs` are P&L outcomes (losses negative).
 */
export function valueAtRisk(xs, alpha = 0.95) {
  const cut = quantile(xs, 1 - alpha);
  return isNum(cut) ? Math.max(0, -cut) : NaN;
}

/**
 * Conditional VaR (expected shortfall) — the mean loss in the worst
 * (1-alpha) tail, as a POSITIVE magnitude. This is the number the
 * Underwriter penalises with lambda_1, so it must never be optimistic:
 * when the tail bucket is empty we fall back to the single worst outcome.
 */
export function conditionalVaR(xs, alpha = 0.95) {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const k = Math.max(1, Math.floor(s.length * (1 - alpha)));
  let sum = 0;
  for (let i = 0; i < k; i += 1) sum += s[i];
  return Math.max(0, -(sum / k));
}

/** Abramowitz–Stegun 7.1.26 error function, |eps| < 1.5e-7. */
export function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-a * a);
  return sign * y;
}

export const normCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
export const normPdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

/** Acklam's inverse normal CDF, refined by one Halley step. */
export function normInv(p) {
  if (!isNum(p) || p <= 0 || p >= 1) return NaN;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416];
  const pLow = 0.02425;
  let x;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pLow) {
    const q = p - 0.5;
    const r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const e = normCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

/** Pearson correlation. */
export function correlation(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return NaN;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return NaN;
  return sxy / Math.sqrt(sxx * syy);
}

/** Simple log returns from a close series. */
export function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (isNum(prev) && isNum(cur) && prev > 0 && cur > 0) out.push(Math.log(cur / prev));
  }
  return out;
}

/** Percentile rank of `x` within `xs`, on [0,1]. */
export function percentileRank(xs, x) {
  if (!xs.length || !isNum(x)) return NaN;
  let below = 0;
  for (const v of xs) if (v < x) below += 1;
  return below / xs.length;
}

/** Brier score for probabilistic forecasts: mean squared error of probabilities. */
export function brierScore(pairs) {
  if (!pairs.length) return NaN;
  let s = 0;
  for (const { p, outcome } of pairs) s += (p - (outcome ? 1 : 0)) ** 2;
  return s / pairs.length;
}
