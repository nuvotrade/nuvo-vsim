/**
 * Regime engine (§6).
 *
 * Every day the market gets a state, and the state decides what NUVO is
 * ALLOWED to do — not what it feels like doing. This is the mechanism that
 * kills the old habit of finding something to sell every week.
 *
 * Transparency is chosen over sophistication on purpose. An HMM would
 * classify better and explain nothing; when a regime call blocks a trade,
 * NUVO has to be able to say which input caused it.
 */
import { isNum, clamp, stdev } from '../math/stats.js';

export const REGIME = Object.freeze({
  CALM: 'CALM',
  NORMAL: 'NORMAL',
  FEAR: 'FEAR',
  PANIC: 'PANIC',
  DISLOCATION: 'DISLOCATION',
});

export const REGIME_ORDER = [REGIME.CALM, REGIME.NORMAL, REGIME.FEAR, REGIME.PANIC, REGIME.DISLOCATION];

export const STANCE = Object.freeze({
  PREFERRED: 'PREFERRED',
  ALLOWED: 'ALLOWED',
  SELECTIVE: 'SELECTIVE',
  RESTRICTED: 'RESTRICTED',
  FORBIDDEN: 'FORBIDDEN',
});

/**
 * The allowed-action matrix from §6.
 *
 * Read it as a permission system, not a suggestion. FORBIDDEN cannot be
 * overridden by an attractive RAROC; RESTRICTED requires the candidate to
 * clear an elevated bar; SELECTIVE requires an explicit portfolio reason.
 */
export const ACTION_MATRIX = Object.freeze({
  CALM: {
    CSP: STANCE.RESTRICTED,
    BULL_PUT_SPREAD: STANCE.RESTRICTED,
    SHARES: STANCE.SELECTIVE,
    COVERED_CALL: STANCE.ALLOWED,
    CASH: STANCE.ALLOWED,
  },
  NORMAL: {
    CSP: STANCE.ALLOWED,
    BULL_PUT_SPREAD: STANCE.ALLOWED,
    SHARES: STANCE.SELECTIVE,
    COVERED_CALL: STANCE.ALLOWED,
    CASH: STANCE.ALLOWED,
  },
  FEAR: {
    CSP: STANCE.PREFERRED,
    BULL_PUT_SPREAD: STANCE.PREFERRED,
    SHARES: STANCE.ALLOWED,
    COVERED_CALL: STANCE.ALLOWED,
    CASH: STANCE.ALLOWED,
  },
  PANIC: {
    CSP: STANCE.SELECTIVE,          // undefined risk is the wrong shape here
    BULL_PUT_SPREAD: STANCE.PREFERRED,
    SHARES: STANCE.SELECTIVE,
    COVERED_CALL: STANCE.RESTRICTED, // no urgency to cap upside into a bottom
    CASH: STANCE.PREFERRED,
  },
  DISLOCATION: {
    CSP: STANCE.RESTRICTED,         // only exceptional setups
    BULL_PUT_SPREAD: STANCE.PREFERRED,
    SHARES: STANCE.SELECTIVE,
    COVERED_CALL: STANCE.FORBIDDEN,
    CASH: STANCE.PREFERRED,
  },
});

/** Multiplier applied to position size by regime (§15's R term). */
export const REGIME_SIZE_MULTIPLIER = Object.freeze({
  CALM: 0.50,        // thin premium; take less risk for it
  NORMAL: 1.00,
  FEAR: 1.25,        // best-paid regime for a downside underwriter
  PANIC: 0.70,       // paid well, but the tail is live
  DISLOCATION: 0.35, // survival dominates
});

/** How much extra expectancy a restricted stance must show to proceed. */
export const STANCE_HURDLE_MULTIPLIER = Object.freeze({
  PREFERRED: 0.90,
  ALLOWED: 1.00,
  SELECTIVE: 1.35,
  RESTRICTED: 2.00,
  FORBIDDEN: Infinity,
});

/**
 * Classify the market state.
 *
 * Scoring rather than a decision tree, so that no single input can flip the
 * regime alone and every input's contribution is visible in `components`.
 */
export function classify(inputs, { limits } = {}) {
  const {
    vix, vix3m, realizedVol, impliedVol, indexDrawdown,
    breadthCorrelation, gapFrequency, crossAssetStress,
    liquidityScore, volOfVol,
  } = inputs;

  const components = [];
  const add = (name, value, score, note) => components.push({ name, value, score, note });

  // 1. Volatility level — the primary axis.
  let s = 0;
  if (isNum(vix)) {
    const v = vix <= 13 ? 0 : vix <= 18 ? 1 : vix <= 26 ? 2 : vix <= 36 ? 3 : 4;
    add('vixLevel', vix, v, `VIX ${vix.toFixed(1)}`);
    s += v * 1.6;
  } else {
    add('vixLevel', null, null, 'VIX unavailable');
  }

  // 2. Term structure. Backwardation is the market pricing stress NOW.
  if (isNum(vix) && isNum(vix3m) && vix3m > 0) {
    const ratio = vix / vix3m;
    const v = ratio < 0.92 ? 0 : ratio < 1.0 ? 1 : ratio < 1.08 ? 2.5 : 4;
    add('termStructure', ratio, v, ratio >= 1 ? 'backwardated' : 'contango');
    s += v * 1.2;
  }

  // 3. Realised vs implied. Realised above implied means the market is
  //    UNDERPRICING what is already happening — the most dangerous state
  //    for a short-vol book and easy to miss if you only watch VIX.
  if (isNum(realizedVol) && isNum(impliedVol) && impliedVol > 0) {
    const r = realizedVol / impliedVol;
    const v = r < 0.7 ? 0 : r < 0.9 ? 1 : r < 1.05 ? 2 : r < 1.25 ? 3 : 4;
    add('realizedVsImplied', r, v, `RV/IV ${r.toFixed(2)}`);
    s += v * 1.3;
  }

  // 4. Index drawdown from peak.
  if (isNum(indexDrawdown)) {
    const d = Math.abs(indexDrawdown);
    const v = d < 0.03 ? 0 : d < 0.07 ? 1 : d < 0.12 ? 2 : d < 0.20 ? 3 : 4;
    add('indexDrawdown', d, v, `${(d * 100).toFixed(1)}% off peak`);
    s += v * 1.0;
  }

  // 5. Correlation/breadth. Correlation going to one is what turns a
  //    diversified book into a single trade (§14).
  if (isNum(breadthCorrelation)) {
    const v = breadthCorrelation < 0.3 ? 0 : breadthCorrelation < 0.5 ? 1
      : breadthCorrelation < 0.7 ? 2 : breadthCorrelation < 0.85 ? 3 : 4;
    add('correlation', breadthCorrelation, v, `avg pairwise rho ${breadthCorrelation.toFixed(2)}`);
    s += v * 1.1;
  }

  // 6. Gap frequency — direct evidence about the risk NUVO is short.
  if (isNum(gapFrequency)) {
    const v = gapFrequency < 0.02 ? 0 : gapFrequency < 0.05 ? 1
      : gapFrequency < 0.10 ? 2 : gapFrequency < 0.18 ? 3 : 4;
    add('gapFrequency', gapFrequency, v, `${(gapFrequency * 100).toFixed(1)}% of days gapped >1.5 sigma`);
    s += v * 0.9;
  }

  if (isNum(crossAssetStress)) {
    const v = clamp(crossAssetStress * 4, 0, 4);
    add('crossAssetStress', crossAssetStress, v, 'credit/FX/rates composite');
    s += v * 0.8;
  }
  if (isNum(volOfVol)) {
    const v = volOfVol < 0.6 ? 0 : volOfVol < 0.9 ? 1 : volOfVol < 1.3 ? 2 : volOfVol < 2.0 ? 3 : 4;
    add('volOfVol', volOfVol, v, `vol-of-vol ${volOfVol.toFixed(2)}`);
    s += v * 0.7;
  }
  // Liquidity is inverted: a LOW score is bad.
  if (isNum(liquidityScore)) {
    const v = liquidityScore > 0.8 ? 0 : liquidityScore > 0.6 ? 1
      : liquidityScore > 0.4 ? 2 : liquidityScore > 0.2 ? 3 : 4;
    add('liquidity', liquidityScore, v, `liquidity score ${liquidityScore.toFixed(2)}`);
    s += v * 1.0;
  }

  const weightUsed = components.filter((c) => isNum(c.score))
    .reduce((acc, c) => acc + WEIGHTS[c.name], 0);
  const coverage = weightUsed / TOTAL_WEIGHT;
  const normalized = weightUsed > 0 ? s / weightUsed : NaN;

  // DISLOCATION is not merely "more panic": it is stress plus broken
  // liquidity. Selling into a market that cannot absorb a hedge is a
  // different failure mode from selling into a scary but functioning one.
  const illiquid = isNum(liquidityScore) && liquidityScore < 0.35;
  let regime;
  if (!isNum(normalized)) regime = null;
  // Thresholds calibrated against the five reference states in
  // test/regime.test.js. Changing one without re-running those is an
  // amendment to what "FEAR" means, and should be treated as such.
  else if (normalized >= 3.40 && illiquid) regime = REGIME.DISLOCATION;
  else if (normalized >= 2.60) regime = REGIME.PANIC;
  else if (normalized >= 1.50) regime = REGIME.FEAR;
  else if (normalized >= 0.50) regime = REGIME.NORMAL;
  else regime = REGIME.CALM;

  return {
    regime,
    score: normalized,
    components,
    coverage,
    /**
     * Insufficient inputs is NOT a reason to assume NORMAL. A regime call
     * built on a third of its inputs is a guess, and §18 says guesses do
     * not get trading authority.
     */
    confident: coverage >= 0.6,
    sizeMultiplier: regime ? REGIME_SIZE_MULTIPLIER[regime] : 0,
    limitsVersion: limits?.version ?? null,
  };
}

const WEIGHTS = {
  vixLevel: 1.6, termStructure: 1.2, realizedVsImplied: 1.3, indexDrawdown: 1.0,
  correlation: 1.1, gapFrequency: 0.9, crossAssetStress: 0.8, volOfVol: 0.7, liquidity: 1.0,
};
const TOTAL_WEIGHT = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);

/** Look up the stance for a structure in a regime. */
export function stanceFor(regime, structure) {
  if (!regime) return STANCE.FORBIDDEN; // unknown regime => no authority
  return ACTION_MATRIX[regime]?.[structure] ?? STANCE.FORBIDDEN;
}

export const isPermitted = (regime, structure) => stanceFor(regime, structure) !== STANCE.FORBIDDEN;

/** The expectancy hurdle a candidate must clear, given regime and structure. */
export function hurdleFor(regime, structure, baseHurdle) {
  const stance = stanceFor(regime, structure);
  return { stance, hurdle: baseHurdle * STANCE_HURDLE_MULTIPLIER[stance] };
}

/**
 * Gap frequency: fraction of sessions whose overnight move exceeded
 * `sigmas` of the prevailing daily vol. Feeds the classifier and, more
 * importantly, the gap-risk penalty in NEV.
 */
export function gapFrequency(bars, { sigmas = 1.5, window = 60 } = {}) {
  const w = bars.slice(-(window + 1));
  if (w.length < 10) return NaN;
  let gaps = 0;
  let n = 0;
  for (let i = 1; i < w.length; i += 1) {
    const prev = w[i - 1];
    const cur = w[i];
    if (!isNum(prev.c) || !isNum(cur.o) || prev.c <= 0) continue;
    const trailingReturns = [];
    for (let j = Math.max(1, i - 20); j < i; j += 1) {
      if (isNum(w[j - 1].c) && isNum(w[j].c) && w[j - 1].c > 0 && w[j].c > 0) {
        trailingReturns.push(Math.log(w[j].c / w[j - 1].c));
      }
    }
    const dailyVol = isNum(cur.annualisedVar)
      ? Math.sqrt(cur.annualisedVar / 252)
      : trailingReturns.length >= 10 ? stdev(trailingReturns) : NaN;
    if (!isNum(dailyVol) || dailyVol <= 0) continue;
    if (Math.abs(Math.log(cur.o / prev.c)) > sigmas * dailyVol) gaps += 1;
    n += 1;
  }
  return n ? gaps / n : NaN;
}

/** Drawdown from the running peak of a close series. */
export function drawdownFromPeak(closes) {
  if (!closes.length) return NaN;
  let peak = -Infinity;
  for (const c of closes) if (c > peak) peak = c;
  return peak > 0 ? (closes[closes.length - 1] - peak) / peak : NaN;
}
