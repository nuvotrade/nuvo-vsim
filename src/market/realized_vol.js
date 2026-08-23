/**
 * Realised volatility estimators (§5).
 *
 * NUVO's commodity is volatility, so it does not carry one estimate of it.
 * Close-to-close throws away the range; Parkinson and Garman-Klass use it
 * and are several times more efficient per observation. EWMA and GARCH add
 * the thing that actually matters for a 7-45 DTE position: what volatility
 * is doing NOW, not what it averaged over the lookback.
 */
import { logReturns, stdev, mean, isNum } from '../math/stats.js';

const ANN = Math.sqrt(252);

/** Close-to-close, annualised. The honest baseline. */
export function closeToClose(closes, window = 20) {
  const rets = logReturns(closes.slice(-(window + 1)));
  if (rets.length < 2) return NaN;
  return stdev(rets) * ANN;
}

/** Parkinson (1980) — high/low range. ~5x more efficient than close-to-close. */
export function parkinson(bars, window = 20) {
  const w = bars.slice(-window);
  if (w.length < 2) return NaN;
  const c = 1 / (4 * Math.log(2));
  let s = 0;
  let n = 0;
  for (const b of w) {
    if (!isNum(b.h) || !isNum(b.l) || b.l <= 0) continue;
    s += c * Math.log(b.h / b.l) ** 2;
    n += 1;
  }
  return n ? Math.sqrt(s / n) * ANN : NaN;
}

/** Garman–Klass — uses open, high, low and close. */
export function garmanKlass(bars, window = 20) {
  const w = bars.slice(-window);
  if (w.length < 2) return NaN;
  let s = 0;
  let n = 0;
  for (const b of w) {
    if (![b.o, b.h, b.l, b.c].every((v) => isNum(v) && v > 0)) continue;
    const hl = Math.log(b.h / b.l);
    const co = Math.log(b.c / b.o);
    s += 0.5 * hl * hl - (2 * Math.log(2) - 1) * co * co;
    n += 1;
  }
  return n ? Math.sqrt(Math.max(s / n, 0)) * ANN : NaN;
}

/**
 * Yang–Zhang — the only common estimator that handles overnight gaps
 * correctly. For a book that is short downside, gap risk is the risk, so
 * an estimator that ignores gaps is the wrong one to size against.
 */
export function yangZhang(bars, window = 20) {
  const w = bars.slice(-(window + 1));
  if (w.length < 3) return NaN;
  const overnight = [];
  const openClose = [];
  let rs = 0;
  let n = 0;
  for (let i = 1; i < w.length; i += 1) {
    const b = w[i];
    const prev = w[i - 1];
    if (![b.o, b.h, b.l, b.c, prev.c].every((v) => isNum(v) && v > 0)) continue;
    overnight.push(Math.log(b.o / prev.c));
    openClose.push(Math.log(b.c / b.o));
    const ho = Math.log(b.h / b.o);
    const lo = Math.log(b.l / b.o);
    const hc = Math.log(b.h / b.c);
    const lc = Math.log(b.l / b.c);
    rs += ho * hc + lo * lc; // Rogers–Satchell
    n += 1;
  }
  if (n < 2) return NaN;
  const varO = overnight.reduce((s, x) => s + (x - mean(overnight)) ** 2, 0) / (n - 1);
  const varC = openClose.reduce((s, x) => s + (x - mean(openClose)) ** 2, 0) / (n - 1);
  const varRs = rs / n;
  const k = 0.34 / (1.34 + (n + 1) / (n - 1));
  return Math.sqrt(Math.max(varO + k * varC + (1 - k) * varRs, 0)) * ANN;
}

/**
 * EWMA (RiskMetrics). lambda = 0.94 for daily data.
 * Returns the full variance path so callers can inspect the trajectory,
 * not just the endpoint.
 */
export function ewma(closes, lambda = 0.94) {
  const rets = logReturns(closes);
  if (rets.length < 5) return { vol: NaN, path: [] };
  let v = rets.slice(0, Math.min(20, rets.length)).reduce((s, r) => s + r * r, 0) /
    Math.min(20, rets.length);
  const path = [];
  for (const r of rets) {
    v = lambda * v + (1 - lambda) * r * r;
    path.push(Math.sqrt(v) * ANN);
  }
  return { vol: Math.sqrt(v) * ANN, path, lambda };
}

/**
 * GARCH(1,1) fitted by grid-refined maximum likelihood.
 *
 * A closed-form optimiser is not available and pulling in a dependency for
 * this would be worse than the coarse search: the parameter surface is
 * smooth and low-dimensional, so successive refinement converges fine and
 * — crucially — is deterministic, which a stochastic optimiser is not.
 */
export function garch11(closes, { iterations = 4, gridSize = 8 } = {}) {
  const rets = logReturns(closes);
  if (rets.length < 60) return { ok: false, reason: 'insufficient history (need >= 60 returns)' };
  const m = mean(rets);
  const eps = rets.map((r) => r - m);
  const sampleVar = eps.reduce((s, e) => s + e * e, 0) / eps.length;
  if (!isNum(sampleVar) || sampleVar <= 0) return { ok: false, reason: 'degenerate variance' };

  const negLogLik = (omega, alpha, beta) => {
    if (omega <= 0 || alpha < 0 || beta < 0 || alpha + beta >= 0.9999) return Infinity;
    let v = sampleVar;
    let ll = 0;
    for (const e of eps) {
      if (v <= 1e-14) return Infinity;
      ll += Math.log(v) + (e * e) / v;
      v = omega + alpha * e * e + beta * v;
    }
    return 0.5 * ll;
  };

  let best = { alpha: 0.08, beta: 0.88, nll: Infinity };
  let aLo = 0.001; let aHi = 0.30;
  let bLo = 0.50; let bHi = 0.985;

  for (let it = 0; it < iterations; it += 1) {
    for (let i = 0; i <= gridSize; i += 1) {
      const alpha = aLo + ((aHi - aLo) * i) / gridSize;
      for (let j = 0; j <= gridSize; j += 1) {
        const beta = bLo + ((bHi - bLo) * j) / gridSize;
        if (alpha + beta >= 0.9995) continue;
        // Variance targeting: omega is implied, not searched, which removes
        // a dimension and keeps the long-run variance at the sample value.
        const omega = sampleVar * (1 - alpha - beta);
        const nll = negLogLik(omega, alpha, beta);
        if (nll < best.nll) best = { omega, alpha, beta, nll };
      }
    }
    const aStep = (aHi - aLo) / gridSize;
    const bStep = (bHi - bLo) / gridSize;
    aLo = Math.max(0.0005, best.alpha - aStep); aHi = Math.min(0.5, best.alpha + aStep);
    bLo = Math.max(0.10, best.beta - bStep); bHi = Math.min(0.995, best.beta + bStep);
  }
  if (!isNum(best.nll) || best.nll === Infinity) return { ok: false, reason: 'fit failed' };

  // Filter forward to today's conditional variance.
  let v = sampleVar;
  for (const e of eps) v = best.omega + best.alpha * e * e + best.beta * v;

  const persistence = best.alpha + best.beta;
  const longRun = Math.sqrt(best.omega / Math.max(1e-12, 1 - persistence)) * ANN;

  return {
    ok: true,
    omega: best.omega,
    alpha: best.alpha,
    beta: best.beta,
    persistence,
    logLikelihood: -best.nll,
    conditionalVol: Math.sqrt(v) * ANN,
    longRunVol: longRun,
    /**
     * Multi-day forecast. Mean-reverts toward the long-run level at rate
     * `persistence`, which is why a spike in realised vol does NOT justify
     * pricing 45-DTE risk off today's number.
     */
    forecast(days) {
      let vt = v;
      let total = 0;
      for (let d = 0; d < days; d += 1) {
        total += vt;
        vt = best.omega + persistence * vt;
      }
      return Math.sqrt((total / days) * 252);
    },
  };
}

/** Every estimator at once, plus a blended headline number. */
export function volatilityProfile(bars, { windows = [10, 20, 60] } = {}) {
  const closes = bars.map((b) => b.c);
  const profile = { windows: {} };
  for (const w of windows) {
    profile.windows[w] = {
      closeToClose: closeToClose(closes, w),
      parkinson: parkinson(bars, w),
      garmanKlass: garmanKlass(bars, w),
      yangZhang: yangZhang(bars, w),
    };
  }
  const e = ewma(closes);
  profile.ewma = e.vol;
  const g = garch11(closes);
  profile.garch = g.ok ? g : null;
  profile.garchOk = g.ok;

  // The headline estimate leans on the gap-aware and conditional measures.
  const parts = [
    { v: profile.windows[20]?.yangZhang, w: 0.35 },
    { v: profile.ewma, w: 0.35 },
    { v: g.ok ? g.conditionalVol : NaN, w: 0.30 },
  ].filter((p) => isNum(p.v));
  const wsum = parts.reduce((s, p) => s + p.w, 0);
  profile.realized = wsum > 0 ? parts.reduce((s, p) => s + p.v * p.w, 0) / wsum : NaN;

  // Disagreement between estimators is a data-quality signal in its own right.
  const all = [profile.windows[20]?.closeToClose, profile.windows[20]?.yangZhang,
    profile.ewma, g.ok ? g.conditionalVol : NaN].filter(isNum);
  profile.estimatorSpread = all.length > 1 ? stdev(all) / mean(all) : NaN;
  return profile;
}
