/**
 * Three independent probabilities (§4).
 *
 *   p_market — extracted from option prices (risk-neutral, skew-adjusted)
 *   p_model  — from NUVO's own forward distribution
 *   p_cal    — p_model corrected by NUVO's observed track record
 *
 * The useful signal is the DISAGREEMENT. And until enough live evidence
 * exists, p_model carries the label UNCALIBRATED — which is not a
 * disclaimer, it is a value that suppresses position size downstream.
 */
import { probItm, dteToT } from '../math/black_scholes.js';
import { modelSpread } from '../math/distribution.js';
import { isNum, clamp, brierScore, mean, stdev } from '../math/stats.js';

export const CALIBRATION = Object.freeze({
  UNCALIBRATED: 'UNCALIBRATED',
  PROVISIONAL: 'PROVISIONAL',
  CALIBRATED: 'CALIBRATED',
  DEGRADED: 'DEGRADED',
});

/**
 * Market-implied probability of finishing below `strike`.
 *
 * Uses the STRIKE's own implied vol, not ATM vol. Using ATM vol here is a
 * classic error: it discards the skew, which is precisely the compensation
 * a downside underwriter is being paid, and produces a p_market that is
 * systematically too low for OTM puts.
 */
export function marketProbability({ spot, strike, strikeIv, dte, rate = 0.045, right = 'put' }) {
  if (!isNum(strikeIv)) return { p: NaN, basis: 'no-strike-iv' };
  const t = dteToT(dte);
  const p = probItm({ type: right, spot, strike, vol: strikeIv, t, rate });
  return { p, basis: 'risk-neutral-strike-iv', strikeIv, note: 'Risk-neutral, not a real-world probability.' };
}

/**
 * Model probability from the forward distribution, with a spread measure
 * capturing how much the ensemble members disagree.
 */
export function modelProbability({ dist, strike, right = 'put' }) {
  const p = right === 'put' ? dist.probBelow(strike) : dist.probAbove(strike);
  return {
    p,
    basis: dist.model,
    spread: modelSpread(dist, strike),
    n: dist.n,
    seed: dist.seed,
  };
}

/**
 * Calibration store: NUVO's record of whether its own probabilities came true.
 *
 * Bins forecasts and compares predicted frequency to realised frequency.
 * If NUVO says 80% and it happens 62% of the time, that is not bad luck,
 * it is a broken model, and this is where that becomes visible.
 */
export class CalibrationStore {
  constructor({ bins = 10, minPerBin = 15, minTotal = 50 } = {}) {
    this.binCount = bins;
    this.minPerBin = minPerBin;
    this.minTotal = minTotal;
    this.observations = [];
  }

  /** @param {{p:number, outcome:boolean, tag?:string, at?:number}} obs */
  record(obs) {
    if (!isNum(obs.p)) throw new TypeError('CalibrationStore.record requires a numeric probability.');
    this.observations.push({ ...obs, p: clamp(obs.p, 0, 1) });
    return this;
  }

  get n() { return this.observations.length; }

  /** Reliability bins: predicted vs observed frequency. */
  reliability(filter = () => true) {
    const obs = this.observations.filter(filter);
    const bins = Array.from({ length: this.binCount }, (_, i) => ({
      lo: i / this.binCount,
      hi: (i + 1) / this.binCount,
      n: 0,
      predictedSum: 0,
      observedSum: 0,
    }));
    for (const o of obs) {
      const idx = Math.min(this.binCount - 1, Math.floor(o.p * this.binCount));
      bins[idx].n += 1;
      bins[idx].predictedSum += o.p;
      bins[idx].observedSum += o.outcome ? 1 : 0;
    }
    return bins.map((b) => ({
      ...b,
      predicted: b.n ? b.predictedSum / b.n : NaN,
      observed: b.n ? b.observedSum / b.n : NaN,
      sufficient: b.n >= this.minPerBin,
    }));
  }

  /**
   * Calibration slope by weighted least squares of observed on predicted.
   * Slope 1 with intercept 0 is perfect. Slope < 1 means NUVO is
   * OVERCONFIDENT — its extreme probabilities are too extreme.
   */
  slope(filter = () => true) {
    const bins = this.reliability(filter).filter((b) => b.sufficient && isNum(b.predicted) && isNum(b.observed));
    if (bins.length < 3) return { slope: NaN, intercept: NaN, bins: bins.length, sufficient: false };
    const wsum = bins.reduce((s, b) => s + b.n, 0);
    const mx = bins.reduce((s, b) => s + b.n * b.predicted, 0) / wsum;
    const my = bins.reduce((s, b) => s + b.n * b.observed, 0) / wsum;
    let num = 0;
    let den = 0;
    for (const b of bins) {
      num += b.n * (b.predicted - mx) * (b.observed - my);
      den += b.n * (b.predicted - mx) ** 2;
    }
    if (den === 0) return { slope: NaN, intercept: NaN, bins: bins.length, sufficient: false };
    const slope = num / den;
    return { slope, intercept: my - slope * mx, bins: bins.length, sufficient: true };
  }

  brier(filter = () => true) {
    const obs = this.observations.filter(filter);
    return obs.length ? brierScore(obs) : NaN;
  }

  /**
   * Brier skill score against the base rate. Positive means NUVO's
   * probabilities beat simply quoting the historical frequency — which is
   * a much harder test than "the trades made money".
   */
  skillScore(filter = () => true) {
    const obs = this.observations.filter(filter);
    if (obs.length < this.minTotal) return NaN;
    const base = mean(obs.map((o) => (o.outcome ? 1 : 0)));
    const refBrier = mean(obs.map((o) => (base - (o.outcome ? 1 : 0)) ** 2));
    const b = this.brier(filter);
    return refBrier > 0 ? 1 - b / refBrier : NaN;
  }

  status(filter = () => true) {
    const n = this.observations.filter(filter).length;
    if (n < this.minTotal) return CALIBRATION.UNCALIBRATED;
    const s = this.slope(filter);
    const b = this.brier(filter);
    if (!s.sufficient) return CALIBRATION.UNCALIBRATED;
    if (b > 0.28 || s.slope < 0.5 || s.slope > 1.6) return CALIBRATION.DEGRADED;
    if (n < this.minTotal * 4) return CALIBRATION.PROVISIONAL;
    return CALIBRATION.CALIBRATED;
  }

  /**
   * Apply the learned correction to a raw model probability.
   *
   * While UNCALIBRATED, this deliberately returns the raw probability
   * UNCHANGED and flags it — inventing a correction from 12 observations
   * would be worse than admitting there isn't one.
   */
  calibrate(pModel, filter = () => true) {
    const status = this.status(filter);
    if (status === CALIBRATION.UNCALIBRATED) {
      return { p: pModel, status, adjusted: false, note: 'Insufficient live evidence to calibrate.' };
    }
    const { slope, intercept, sufficient } = this.slope(filter);
    if (!sufficient || !isNum(slope)) {
      return { p: pModel, status: CALIBRATION.UNCALIBRATED, adjusted: false };
    }
    return {
      p: clamp(intercept + slope * pModel, 0, 1),
      status,
      adjusted: true,
      slope,
      intercept,
    };
  }
}

/**
 * Assemble all three probabilities plus their disagreement.
 *
 * `edge` (p_market - p_cal) is the quantity that actually justifies the
 * trade: the market thinks loss is more likely than NUVO does, and is
 * paying for that difference.
 */
export function probabilitySet({ market, model, store, tag }) {
  const filter = tag ? (o) => o.tag === tag : () => true;
  const cal = store ? store.calibrate(model.p, filter) : { p: model.p, status: CALIBRATION.UNCALIBRATED, adjusted: false };
  const disagreement = isNum(model.p) && isNum(market.p) ? model.p - market.p : NaN;
  const edge = isNum(cal.p) && isNum(market.p) ? market.p - cal.p : NaN;

  return {
    pMarket: market.p,
    pModel: model.p,
    pCal: cal.p,
    calibration: cal.status,
    calibrationAdjusted: cal.adjusted,
    /** p_model - p_market. Negative means NUVO sees LESS risk than the market prices. */
    disagreement,
    /** Positive means NUVO is being overpaid relative to its own view. */
    edge,
    modelSpread: model.spread,
    /**
     * Confidence in [0,1] feeding the C term of position sizing (§15).
     * Uncalibrated models and disagreeing ensembles both cut it.
     */
    confidence: confidenceFrom(cal.status, model.spread),
    detail: { market, model, cal },
  };
}

export function confidenceFrom(status, spread) {
  const base = {
    [CALIBRATION.CALIBRATED]: 1.0,
    [CALIBRATION.PROVISIONAL]: 0.65,
    [CALIBRATION.UNCALIBRATED]: 0.35,
    [CALIBRATION.DEGRADED]: 0.15,
  }[status] ?? 0.25;
  if (!isNum(spread)) return base;
  // An ensemble spread of 5 percentage points roughly halves confidence.
  return clamp(base * Math.exp(-10 * spread), 0.05, 1);
}
