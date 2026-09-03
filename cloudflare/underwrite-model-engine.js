import { dteToT } from '../src/math/black_scholes.js';
import {
  bootstrapTerminal, jumpDiffusionTerminal, lognormalTerminal,
  studentTTerminal,
} from '../src/math/distribution.js';
import { quantileSorted } from '../src/math/stats.js';

export const UNDERWRITE_PRIMARY_MODEL = 'bootstrap';
export const UNDERWRITE_STRESS_MODEL = 'volatilityStress';
export const UNDERWRITE_MODEL_DEFINITIONS = Object.freeze({
  lognormal: 'LOGNORMAL_ZERO_ARITHMETIC_DRIFT_GARCH_VOL',
  studentT: 'STUDENT_T_DF5_VARIANCE_NORMALIZED_ZERO_ARITHMETIC_DRIFT',
  jump: 'JUMP_DIFFUSION_UNCALIBRATED_ADDITIVE_DIAGNOSTIC_POSSIBLE_JUMP_VARIANCE_DOUBLE_COUNT',
  bootstrap: 'PRIMARY_BLOCK_BOOTSTRAP_400_SESSIONS_5_SESSION_BLOCKS_CENTERED_ZERO_ARITHMETIC_DRIFT',
  volatilityStress: 'LOGNORMAL_VOLATILITY_STRESS_1_25X',
});

const finite = (value) => value !== null && value !== undefined && value !== ''
  && Number.isFinite(Number(value)) ? Number(value) : null;

function seedFor(seed, dte, model) {
  return `${seed}:${dte}:${model}`;
}

export function buildUnderwriteModelSet({ spot, dte, forecastVol, returns, samples, seed }) {
  const bootstrap = returns.length >= 120 ? bootstrapTerminal({
    spot, returns: returns.slice(-400), horizonDays: dte, drift: 0, blockSize: 5,
    n: samples, seed: seedFor(seed, dte, 'bootstrap'),
  }) : null;
  if (!(forecastVol > 0)) return {
    lognormal: null, studentT: null, jump: null, bootstrap, volatilityStress: null,
  };
  const t = dteToT(dte);
  return {
    lognormal: lognormalTerminal({
      spot, vol: forecastVol, t, drift: 0, n: samples,
      seed: seedFor(seed, dte, 'ln'),
    }),
    studentT: studentTTerminal({
      spot, vol: forecastVol, t, drift: 0, nu: 5, n: samples,
      seed: seedFor(seed, dte, 'student-t'), varianceNormalized: true,
      normalizeArithmeticGrowth: true,
    }),
    jump: jumpDiffusionTerminal({
      spot, vol: forecastVol, t, drift: 0, n: samples,
      seed: seedFor(seed, dte, 'jump'), jumpIntensity: 2,
      jumpMean: -0.06, jumpVol: 0.10,
    }),
    bootstrap,
    volatilityStress: lognormalTerminal({
      spot, vol: forecastVol * 1.25, t, drift: 0, n: samples,
      seed: seedFor(seed, dte, 'vol-stress-1.25'),
    }),
  };
}

export function evaluateShortOptionModel(dist, {
  right, strike, netCredit, discount, capital,
} = {}) {
  if (!dist) return null;
  const optionRight = String(right ?? '').toLowerCase();
  if (!['put', 'call'].includes(optionRight)) throw new RangeError('right must be put or call');
  const pnl = new Array(dist.n);
  let pnlSum = 0;
  let exercisedCount = 0;
  let exercisedTerminalSum = 0;
  let severitySum = 0;
  let lossCount = 0;
  for (let index = 0; index < dist.n; index += 1) {
    const terminal = dist.samples[index];
    const intrinsic = optionRight === 'put'
      ? Math.max(strike - terminal, 0) : Math.max(terminal - strike, 0);
    const value = netCredit - discount * intrinsic * 100;
    pnl[index] = value;
    pnlSum += value;
    if (value < 0) lossCount += 1;
    const exercised = optionRight === 'put' ? terminal < strike : terminal > strike;
    if (exercised) {
      exercisedCount += 1;
      exercisedTerminalSum += terminal;
      severitySum += intrinsic;
    }
  }
  pnl.sort((a, b) => a - b);
  const rawNev0 = pnlSum / dist.n;
  let squared = 0;
  for (const value of pnl) squared += (value - rawNev0) ** 2;
  const sd = dist.n > 1 ? Math.sqrt(squared / (dist.n - 1)) : null;
  const tailCount = Math.max(1, Math.floor(dist.n * 0.05));
  let tailSum = 0;
  for (let index = 0; index < tailCount; index += 1) tailSum += pnl[index];
  return {
    model_value: netCredit - rawNev0,
    nev: rawNev0,
    raw_nev_0: rawNev0,
    nev_to_capital: capital > 0 ? rawNev0 / capital : null,
    nev_to_collateral: capital > 0 ? rawNev0 / capital : null,
    information_ratio: sd > 0 ? rawNev0 / sd : null,
    p_finish_itm: exercisedCount / dist.n,
    p_profit: 1 - lossCount / dist.n,
    conditional_assignment_severity_per_share: exercisedCount
      ? severitySum / exercisedCount : null,
    conditional_terminal_price_if_itm: exercisedCount
      ? exercisedTerminalSum / exercisedCount : null,
    pnl_standard_deviation: sd,
    value_at_risk_95: Math.max(0, -quantileSorted(pnl, 0.05)),
    conditional_value_at_risk_95: Math.max(0, -(tailSum / tailCount)),
    monte_carlo_standard_error: sd / Math.sqrt(dist.n),
    worst_simulated_pnl: pnl[0],
    best_simulated_pnl: pnl.at(-1),
    sample_count: dist.n,
    model_parameters: dist.params,
    seed: dist.seed,
  };
}

export function presentValueCashCarryCost({
  netTiedCash, t, discount, alternativeRate, collateralRate,
  alternativeRateVerified = false, collateralRateVerified = false,
} = {}) {
  const tied = finite(netTiedCash);
  const alt = finite(alternativeRate);
  const collateral = finite(collateralRate);
  if (!(tied >= 0) || !(t >= 0) || !(discount > 0)
    || !alternativeRateVerified || !collateralRateVerified
    || alt === null || collateral === null) return null;
  return discount * tied * (Math.exp(alt * t) - Math.exp(collateral * t));
}
