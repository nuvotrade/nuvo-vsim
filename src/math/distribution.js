/**
 * Forward terminal-price distributions.
 *
 * The Underwriter needs more than a probability of loss: it needs
 * E[L | S_T < K] — the conditional loss — and the tail beyond it.
 * A lognormal assumption systematically understates both, so NUVO
 * supports three families and records which one produced a number.
 */
import { Rng } from './random.js';
import {
  normInv, quantile, quantileSorted, conditionalVaR, conditionalVaRSorted, mean, isNum, stdev,
} from './stats.js';

/**
 * A terminal distribution is an object of terminal prices plus the metadata
 * needed to reproduce it. `samples` is always sorted ascending.
 */
export class TerminalDistribution {
  constructor({ samples, spot, t, model, params = {}, seed = null }) {
    this.samples = samples.slice().sort((a, b) => a - b);
    this.spot = spot;
    this.t = t;
    this.model = model;
    this.params = params;
    this.seed = seed;
  }

  get n() {
    return this.samples.length;
  }

  /** P(S_T < level) — the model's own view, independent of option prices. */
  probBelow(level) {
    if (!isNum(level)) return NaN;
    let below = 0;
    for (const s of this.samples) {
      if (s < level) below += 1;
      else break; // sorted
    }
    return below / this.n;
  }

  probAbove(level) {
    return 1 - this.probBelow(level);
  }

  quantile(q) {
    return quantile(this.samples, q);
  }

  /** E[S_T | S_T < level]. NaN when the conditioning set is empty. */
  expectedGiven(level, side = 'below') {
    const sel = side === 'below'
      ? this.samples.filter((s) => s < level)
      : this.samples.filter((s) => s > level);
    return sel.length ? mean(sel) : NaN;
  }

  /**
   * Map every path to a P&L via `payoff(S_T)` and summarise the result.
   * This is how a structure's whole outcome distribution is produced —
   * one code path for CSPs, spreads, shares and covered calls alike.
   */
  payoffStats(payoff, { alpha = 0.95 } = {}) {
    const n = this.samples.length;
    const pnl = new Array(n);
    // Single pass for the moments and loss statistics.
    let sum = 0;
    let lossSum = 0;
    let lossCount = 0;
    for (let i = 0; i < n; i += 1) {
      const v = payoff(this.samples[i]);
      pnl[i] = v;
      sum += v;
      if (v < 0) { lossSum += v; lossCount += 1; }
    }
    const ev = sum / n;
    let sq = 0;
    for (let i = 0; i < n; i += 1) sq += (pnl[i] - ev) ** 2;

    // ONE sort, reused for every order statistic. This function is on the
    // hot path (thousands of candidates per cycle, three calls each);
    // re-sorting per statistic made a cycle take eleven seconds.
    const sorted = pnl.slice().sort((a, b) => a - b);

    return {
      ev,
      sd: n > 1 ? Math.sqrt(sq / (n - 1)) : NaN,
      cvar: conditionalVaRSorted(sorted, alpha),
      var: Math.max(0, -quantileSorted(sorted, 1 - alpha)),
      worst: sorted[0],
      best: sorted[n - 1],
      pLoss: lossCount / n,
      expectedLoss: lossCount ? -(lossSum / lossCount) : 0,
      pnl,
      sorted,
    };
  }
}

/** Analytic lognormal — fast, thin-tailed, the honest baseline. */
export function lognormalTerminal({ spot, vol, t, drift = 0, n = 20000, seed = 'lognormal' }) {
  const rng = new Rng(seed);
  const mu = (drift - (vol * vol) / 2) * t;
  const sd = vol * Math.sqrt(t);
  const samples = new Array(n);
  for (let i = 0; i < n; i += 1) samples[i] = spot * Math.exp(mu + sd * rng.normal());
  return new TerminalDistribution({ samples, spot, t, model: 'lognormal', params: { vol, drift }, seed });
}

/**
 * Student-t terminal — fatter tails at the same variance.
 * `nu` around 4–6 reproduces the excess kurtosis of daily equity returns.
 */
export function studentTTerminal({ spot, vol, t, nu = 5, drift = 0, n = 20000, seed = 'studentt' }) {
  const rng = new Rng(seed);
  const mu = (drift - (vol * vol) / 2) * t;
  const sd = vol * Math.sqrt(t);
  const samples = new Array(n);
  for (let i = 0; i < n; i += 1) samples[i] = spot * Math.exp(mu + sd * rng.studentT(nu));
  return new TerminalDistribution({ samples, spot, t, model: 'student-t', params: { vol, nu, drift }, seed });
}

/**
 * Jump-diffusion (Merton). The reason NUVO does not price a 7-DTE short put
 * off a lognormal: overnight gaps are the actual mechanism by which a
 * "90% POP" trade produces a career-ending loss.
 */
export function jumpDiffusionTerminal({
  spot, vol, t, drift = 0,
  jumpIntensity = 1.0,   // expected jumps per year
  jumpMean = -0.03,      // mean log jump size (downward)
  jumpVol = 0.06,
  n = 20000, seed = 'jump',
}) {
  const rng = new Rng(seed);
  const kappa = Math.exp(jumpMean + (jumpVol * jumpVol) / 2) - 1;
  const mu = (drift - jumpIntensity * kappa - (vol * vol) / 2) * t;
  const sd = vol * Math.sqrt(t);
  const samples = new Array(n);
  for (let i = 0; i < n; i += 1) {
    // Poisson jump count by inversion.
    let k = 0;
    let p = Math.exp(-jumpIntensity * t);
    let cum = p;
    const u = rng.next();
    while (u > cum && k < 50) {
      k += 1;
      p *= (jumpIntensity * t) / k;
      cum += p;
    }
    let jump = 0;
    for (let j = 0; j < k; j += 1) jump += jumpMean + jumpVol * rng.normal();
    samples[i] = spot * Math.exp(mu + sd * rng.normal() + jump);
  }
  return new TerminalDistribution({
    samples, spot, t, model: 'jump-diffusion',
    params: { vol, drift, jumpIntensity, jumpMean, jumpVol }, seed,
  });
}

/**
 * Empirical block bootstrap over historical returns.
 * Blocks preserve volatility clustering, which i.i.d. resampling destroys —
 * and clustering is precisely what turns one bad day into a drawdown.
 */
export function bootstrapTerminal({
  spot, returns, horizonDays, blockSize = 5, n = 20000, seed = 'bootstrap',
}) {
  if (!returns.length) throw new RangeError('bootstrapTerminal requires a return series');
  const rng = new Rng(seed);
  const samples = new Array(n);
  for (let i = 0; i < n; i += 1) {
    let cum = 0;
    let d = 0;
    while (d < horizonDays) {
      const start = rng.int(returns.length);
      const take = Math.min(blockSize, horizonDays - d);
      for (let j = 0; j < take; j += 1) cum += returns[(start + j) % returns.length];
      d += take;
    }
    samples[i] = spot * Math.exp(cum);
  }
  return new TerminalDistribution({
    samples, spot, t: horizonDays / 365, model: 'block-bootstrap',
    params: { blockSize, horizonDays, sourceLength: returns.length }, seed,
  });
}

/**
 * Ensemble of models with weights — NUVO's default p_model source.
 * Disagreement between the members is itself information: `modelSpread`
 * feeds the confidence multiplier C in position sizing (§15).
 */
export function ensembleTerminal(members, { seed = 'ensemble' } = {}) {
  const total = members.reduce((s, m) => s + (m.weight ?? 1), 0);
  const samples = [];
  for (const m of members) {
    const share = Math.round(((m.weight ?? 1) / total) * m.dist.n);
    const step = Math.max(1, Math.floor(m.dist.n / Math.max(share, 1)));
    for (let i = 0; i < m.dist.n && samples.length < 1e6; i += step) samples.push(m.dist.samples[i]);
  }
  const dist = new TerminalDistribution({
    samples,
    spot: members[0].dist.spot,
    t: members[0].dist.t,
    model: 'ensemble',
    params: { members: members.map((m) => ({ model: m.dist.model, weight: m.weight ?? 1 })) },
    seed,
  });
  dist.members = members;
  return dist;
}

/**
 * Dispersion of P(S_T < level) across ensemble members.
 * High spread => the models disagree => NUVO is less sure than any single
 * number suggests => size down. This is how §4's UNCALIBRATED honesty
 * becomes an actual number rather than a disclaimer.
 */
export function modelSpread(dist, level) {
  if (!dist.members || dist.members.length < 2) return 0;
  const ps = dist.members.map((m) => m.dist.probBelow(level));
  return stdev(ps);
}

/** Analytic lognormal quantile — used for fast pre-screens. */
export function lognormalQuantile({ spot, vol, t, q, drift = 0 }) {
  const z = normInv(q);
  if (!isNum(z)) return NaN;
  return spot * Math.exp((drift - (vol * vol) / 2) * t + vol * Math.sqrt(t) * z);
}
