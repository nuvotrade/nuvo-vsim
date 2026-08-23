/**
 * Synthetic market provider.
 *
 * Not a mock. This generates an internally consistent market — price paths
 * with volatility clustering and gaps, and an option surface with a real
 * downside skew and term structure — so the Research Lab, the backtester
 * and the tests all exercise the same code paths a live provider would.
 *
 * It is deterministic given its seed, so any surprising result is replayable.
 */
import { DataProvider } from './provider.js';
import { Rng } from '../../math/random.js';
import { price as bsPrice, greeks as bsGreeks, dteToT } from '../../math/black_scholes.js';
import { isNum } from '../../math/stats.js';

const DAY_MS = 86_400_000;

/**
 * GARCH(1,1)-driven path with Poisson downside gaps.
 * The gaps exist because they are the actual risk in short-put books;
 * a generator without them would flatter every strategy NUVO tests.
 */
export function generatePath({
  spot = 100, days = 500, seed = 'path',
  targetVol = 0.22, alpha = 0.08, beta = 0.85, omega = null,
  drift = 0.06, jumpsPerYear = 2.0, jumpMean = -0.05, jumpVol = 0.05,
  startAt = Date.UTC(2023, 0, 3),
} = {}) {
  const rng = new Rng(seed);
  const bars = [];
  let s = spot;
  // Pin the unconditional variance to the requested annualised vol, so a
  // symbol configured at 16% vol actually trades near 16% vol. Persistence
  // (alpha+beta) still lets it cluster away from that level, which is the
  // behaviour the regime engine has to cope with.
  const targetDailyVar = (targetVol * targetVol) / 252;
  const w = omega ?? targetDailyVar * Math.max(1e-9, 1 - alpha - beta);
  let varT = w / Math.max(1e-9, 1 - alpha - beta);
  // Merton compensator: without it the jump term silently steals drift, and
  // `drift: 0.07` would not actually mean a 7% expected return.
  const kappa = Math.exp(jumpMean + (jumpVol * jumpVol) / 2) - 1;
  const mu = (drift - jumpsPerYear * kappa) / 252;
  const pJump = jumpsPerYear / 252;

  for (let i = 0; i < days; i += 1) {
    const sd = Math.sqrt(varT);
    let r = mu - 0.5 * varT + sd * rng.normal();
    if (rng.next() < pJump) r += jumpMean + jumpVol * rng.normal();
    const open = s * Math.exp(rng.normal(0, sd * 0.25));
    const close = s * Math.exp(r);
    const hi = Math.max(open, close) * Math.exp(Math.abs(rng.normal(0, sd * 0.6)));
    const lo = Math.min(open, close) * Math.exp(-Math.abs(rng.normal(0, sd * 0.6)));
    bars.push({
      t: startAt + i * DAY_MS,
      o: +open.toFixed(4), h: +hi.toFixed(4), l: +lo.toFixed(4), c: +close.toFixed(4),
      v: Math.round(1e6 * (1 + Math.abs(rng.normal(0, 0.4)))),
      annualisedVar: varT * 252,
    });
    varT = w + alpha * r * r + beta * varT;
    s = close;
  }
  return bars;
}

/**
 * Volatility surface: ATM level plus a downside skew and a term slope.
 * Put IV rises as strikes fall — which is exactly why "sell the 20-delta"
 * is not a strategy, it is a coin flip about how much skew you were paid.
 */
export function surfaceIv({ moneyness, dte, atmIv, skew = 1.2, smile = 0.35, termSlope = 0.06 }) {
  const t = Math.max(dte, 1) / 365;
  const k = Math.log(moneyness); // <0 below spot
  // Skew steepens as expiry approaches — the reason 7-DTE downside is priced
  // so differently from 45-DTE downside at the same delta.
  const tenorScale = Math.sqrt((30 / 365) / Math.max(t, 1 / 365));
  const skewTerm = -skew * k * tenorScale;          // puts bid, calls offered
  const smileTerm = smile * k * k * tenorScale;     // both wings curve up
  const term = termSlope * (Math.sqrt(t) - Math.sqrt(30 / 365)); // upward-sloping in calm
  // Cap the wings: an unbounded skew produces arbitrageable quotes.
  const mult = Math.min(2.5, Math.max(0.45, 1 + skewTerm + smileTerm));
  return Math.max(0.03, atmIv * mult + term);
}

export class SyntheticProvider extends DataProvider {
  /**
   * @param {object} cfg
   * @param {Record<string, object>} cfg.symbols - per-symbol path parameters
   * @param {number} cfg.now - simulated clock (ms)
   */
  constructor({ symbols = {}, now = Date.UTC(2024, 5, 3, 15, 0), seed = 'synthetic', days = 600 } = {}) {
    super('synthetic');
    this.seed = seed;
    this.nowMs = now;
    this.days = days;
    this.paths = new Map();
    this.config = new Map();
    for (const [sym, cfgIn] of Object.entries(symbols)) {
      const cfg = {
        spot: 100, drift: 0.07, jumpsPerYear: 2, atmIv: 0.28, ivRankHistory: null,
        adv: 5_000_000, spreadPct: 0.02, oi: 2500, optVolume: 400, sector: 'UNKNOWN',
        beta: 1.0, events: [], ...cfgIn,
      };
      this.config.set(sym, cfg);
      this.paths.set(sym, generatePath({
        spot: cfg.spot, days, seed: `${seed}:${sym}`, drift: cfg.drift,
        jumpsPerYear: cfg.jumpsPerYear, targetVol: cfg.atmIv,
        alpha: cfg.alpha ?? 0.08, beta: cfg.garchBeta ?? 0.85,
      }));
    }
  }

  /** Index of the bar at or before the simulated clock. */
  _idx(sym) {
    const bars = this.paths.get(sym);
    if (!bars) return -1;
    let i = bars.length - 1;
    while (i > 0 && bars[i].t > this.nowMs) i -= 1;
    return i;
  }

  setNow(ms) { this.nowMs = ms; return this; }

  advanceDays(n = 1) { this.nowMs += n * DAY_MS; return this; }

  async quote(symbol) {
    const i = this._idx(symbol);
    if (i < 0) return { error: `unknown symbol ${symbol}` };
    const bar = this.paths.get(symbol)[i];
    const cfg = this.config.get(symbol);
    const half = bar.c * 0.0002;
    return {
      value: {
        symbol, last: bar.c, bid: +(bar.c - half).toFixed(4), ask: +(bar.c + half).toFixed(4),
        volume: bar.v, adv: cfg.adv, sector: cfg.sector, beta: cfg.beta,
      },
      asOf: this.nowMs - 1000,
      source: 'synthetic',
    };
  }

  async history(symbol, { lookback = 400 } = {}) {
    const i = this._idx(symbol);
    if (i < 0) return { error: `unknown symbol ${symbol}` };
    const bars = this.paths.get(symbol).slice(Math.max(0, i - lookback + 1), i + 1);
    return { value: bars, asOf: this.nowMs - 1000, source: 'synthetic' };
  }

  /** Current realised annualised vol implied by the generator's own state. */
  _atmIv(symbol) {
    const i = this._idx(symbol);
    const bars = this.paths.get(symbol);
    const cfg = this.config.get(symbol);
    const realised = Math.sqrt(Math.max(bars[i].annualisedVar, 1e-6));
    // Implied sits above realised by the volatility risk premium the whole
    // business depends on — plus noise, so NUVO cannot simply read it off.
    const rng = new Rng(`${this.seed}:iv:${symbol}:${i}`);
    const vrpMult = 1.08 + 0.10 * rng.next();
    return Math.max(0.05, realised * vrpMult * (cfg.ivMult ?? 1));
  }

  async optionChain(symbol, { expirations = [7, 14, 30, 45], strikeCount = 21 } = {}) {
    const i = this._idx(symbol);
    if (i < 0) return { error: `unknown symbol ${symbol}` };
    const cfg = this.config.get(symbol);
    const spot = this.paths.get(symbol)[i].c;
    const atmIv = this._atmIv(symbol);
    const inc = spot < 25 ? 0.5 : spot < 200 ? 1 : 5;
    const atmStrike = Math.round(spot / inc) * inc;
    const contracts = [];

    for (const dte of expirations) {
      const t = dteToT(dte);
      const expiration = new Date(this.nowMs + dte * DAY_MS).toISOString().slice(0, 10);
      for (let j = -Math.floor(strikeCount / 2); j <= Math.floor(strikeCount / 2); j += 1) {
        const strike = +(atmStrike + j * inc).toFixed(2);
        if (strike <= 0) continue;
        const iv = surfaceIv({ moneyness: strike / spot, dte, atmIv });
        for (const right of ['put', 'call']) {
          const mid = bsPrice({ type: right, spot, strike, vol: iv, t, rate: 0.045 });
          if (!isNum(mid) || mid < 0.01) continue;
          const g = bsGreeks({ type: right, spot, strike, vol: iv, t, rate: 0.045 });
          // Spreads widen away from the money and in thin names — the cost
          // model must see this, or backtests will bank edge that never fills.
          const otm = Math.abs(Math.log(strike / spot));
          const spreadPct = Math.min(0.35, cfg.spreadPct * (1 + 6 * otm) * (dte <= 7 ? 1.3 : 1));
          const half = Math.max(0.01, (mid * spreadPct) / 2);
          contracts.push({
            symbol: `${symbol}${expiration.replace(/-/g, '')}${right[0].toUpperCase()}${strike}`,
            underlying: symbol, right, strike, expiration, dte,
            bid: +Math.max(0.01, mid - half).toFixed(2),
            ask: +(mid + half).toFixed(2),
            mid: +mid.toFixed(4),
            iv: +iv.toFixed(4),
            delta: +g.delta.toFixed(4), gamma: +g.gamma.toFixed(6),
            vega: +g.vega.toFixed(4), theta: +g.theta.toFixed(4),
            openInterest: Math.round(cfg.oi * Math.exp(-3 * otm)),
            volume: Math.round(cfg.optVolume * Math.exp(-3 * otm)),
            multiplier: 100,
          });
        }
      }
    }
    return { value: { underlying: symbol, spot, atmIv, contracts, asOf: this.nowMs - 1000 }, asOf: this.nowMs - 1000, source: 'synthetic' };
  }

  async events(symbol) {
    const cfg = this.config.get(symbol);
    if (!cfg) return { error: `unknown symbol ${symbol}` };
    return { value: cfg.events ?? [], asOf: this.nowMs, source: 'synthetic' };
  }

  /** VIX-analogue built from the cross-section, so regime is not hand-set. */
  async marketState() {
    const syms = [...this.config.keys()];
    if (!syms.length) return { error: 'no symbols' };
    let sum = 0;
    for (const s of syms) sum += this._atmIv(s);
    const vix = (sum / syms.length) * 100 * 0.85;
    return {
      value: {
        vix: +vix.toFixed(2),
        // Term structure inverts under stress; that inversion is a regime input.
        vix3m: +(vix * (vix > 26 ? 0.94 : 1.06)).toFixed(2),
        status: 'OPEN',
      },
      asOf: this.nowMs - 1000,
      source: 'synthetic',
    };
  }
}
