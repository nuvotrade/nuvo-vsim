/**
 * The five scoreboards (§21).
 *
 *   Economic     — is it making money?
 *   Calibration  — are its probabilities truthful?
 *   Execution    — does the theoretical edge survive trading?
 *   Constitutional — did it obey every rule?
 *   Survival     — could it be killed by what it is holding?
 *
 * Kept separate on purpose. "A profitable unauthorized trade is still a
 * system failure", and a single blended score is exactly the instrument
 * that would hide it.
 */
import { mean, stdev, quantile, isNum, conditionalVaR } from '../math/stats.js';

/** ── ECONOMIC ────────────────────────────────────────────────────────── */
export function economicScoreboard({ trades, nav, startingNav, days }) {
  const closed = trades.filter((t) => isNum(t.realizedPnl));
  if (!closed.length) {
    return { sufficient: false, n: 0, note: 'No closed trades yet.' };
  }
  const pnl = closed.map((t) => t.realizedPnl);
  const wins = pnl.filter((p) => p > 0);
  const losses = pnl.filter((p) => p <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);
  const totalPnl = pnl.reduce((a, b) => a + b, 0);
  const years = days > 0 ? days / 365 : null;

  const capitalUsed = closed.map((t) => t.capitalEmployed ?? t.buyingPower ?? 0);
  const riskUsed = closed.map((t) => t.economicCapital ?? 0);

  return {
    sufficient: closed.length >= 20,
    n: closed.length,
    realizedPnl: totalPnl,
    winRate: wins.length / closed.length,
    expectancy: mean(pnl),
    avgWin: wins.length ? mean(wins) : 0,
    avgLoss: losses.length ? -mean(losses) : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : NaN),
    returnOnCapital: mean(capitalUsed) > 0 ? totalPnl / mean(capitalUsed) : NaN,
    cagr: years && years > 0 && startingNav > 0
      ? (nav / startingNav) ** (1 / years) - 1
      : null,
    /**
     * The governing objective from §1:
     *   G = realized return / (capital employed x risk consumed)
     * Reported alongside, never instead of, the survival constraints.
     */
    G: (() => {
      const c = mean(capitalUsed);
      const r = mean(riskUsed);
      return c > 0 && r > 0 ? totalPnl / (c * r) : NaN;
    })(),
    sharpe: stdev(pnl) > 0 ? (mean(pnl) / stdev(pnl)) * Math.sqrt(252 / Math.max(1, days / closed.length)) : NaN,
  };
}

/** ── CALIBRATION ─────────────────────────────────────────────────────── */
export function calibrationScoreboard({ store, tag, tagSuffix, evidenceMode = null }) {
  // `tagSuffix` selects one forecast EVENT across all strategies; `tag`
  // selects one exact series. Neither defaults to "everything", because
  // averaging a terminal board with a touch board describes nothing.
  const eventFilter = tag
    ? (o) => o.tag === tag
    : (tagSuffix ? (o) => String(o.tag ?? '').endsWith(tagSuffix) : () => true);
  const filter = (o) => eventFilter(o)
    && (evidenceMode === null || o.evidenceMode === evidenceMode);
  const n = store.observations.filter(filter).length;
  const slope = store.slope(filter);
  return {
    sufficient: n >= store.minTotal,
    n,
    status: store.status(filter),
    brierScore: store.brier(filter),
    skillScore: store.skillScore(filter),
    calibrationSlope: slope.slope,
    calibrationIntercept: slope.intercept,
    reliability: store.reliability(filter).filter((b) => b.n > 0),
    interpretation: interpretSlope(slope.slope),
  };
}

function interpretSlope(s) {
  if (!isNum(s)) return 'Insufficient evidence to judge calibration.';
  if (s < 0.7) return 'OVERCONFIDENT: extreme probabilities are too extreme.';
  if (s > 1.3) return 'UNDERCONFIDENT: probabilities are too close to the base rate.';
  return 'Probabilities are approximately truthful.';
}

/** ── EXECUTION ───────────────────────────────────────────────────────── */
export function executionScoreboard({ fills, evidenceMode = null }) {
  const selected = evidenceMode === null
    ? fills
    : fills.filter((f) => f.evidenceMode === evidenceMode);
  if (!selected.length) return { sufficient: false, n: 0, note: 'No fills recorded.' };
  const slip = selected.map((f) => f.slippagePct).filter(isNum);
  const retained = selected.map((f) => f.edgeRetained).filter(isNum);
  const latency = selected.map((f) => f.latencyMs).filter(isNum);
  const attempted = selected.length + (selected.attempted ?? 0);
  return {
    sufficient: selected.length >= 20,
    n: selected.length,
    meanSlippagePct: mean(slip),
    medianSlippagePct: quantile(slip, 0.5),
    worstSlippagePct: slip.length ? Math.max(...slip) : NaN,
    /**
     * The number that gates Authority 3: how much of the modelled edge
     * actually survives contact with the market.
     */
    edgeRetained: mean(retained),
    edgeRetainedP10: quantile(retained, 0.10),
    fillRate: attempted > 0 ? selected.length / attempted : NaN,
    medianLatencyMs: quantile(latency, 0.5),
    interpretation: mean(retained) < 0.5
      ? 'Execution is consuming more than half the modelled edge — the edge may not be real.'
      : 'Modelled edge is substantially surviving execution.',
  };
}

/** ── CONSTITUTIONAL ──────────────────────────────────────────────────── */
export function constitutionalScoreboard({ cycles, breaches, killSwitchBoard }) {
  const total = cycles ?? 0;
  return {
    cycles: total,
    breaches: breaches.length,
    breachRate: total > 0 ? breaches.length / total : 0,
    /**
     * Compliance is not a percentage to be optimised — it is a gate.
     * Any breach at all fails the scoreboard.
     */
    passed: breaches.length === 0,
    byCode: breaches.reduce((acc, b) => {
      acc[b.code] = (acc[b.code] ?? 0) + 1;
      return acc;
    }, {}),
    activeKillSwitches: killSwitchBoard ? killSwitchBoard.tripped.map((k) => k.name) : [],
    detail: breaches.map((b) => ({ code: b.code, message: b.message, at: b.at ?? null })),
    note: 'A profitable unauthorised trade is still a system failure.',
  };
}

/** ── SURVIVAL ────────────────────────────────────────────────────────── */
export function survivalScoreboard({ equityCurve, positions, nav, limits, stress, ruin, exposures }) {
  const dd = maxDrawdown(equityCurve);
  const clusterPcts = Object.values(exposures?.pctOfNav?.cluster ?? {});
  const pnlSeries = [];
  for (let i = 1; i < (equityCurve?.length ?? 0); i += 1) {
    pnlSeries.push(equityCurve[i] - equityCurve[i - 1]);
  }
  return {
    maxDrawdownPct: dd.maxDrawdown,
    currentDrawdownPct: dd.current,
    drawdownDurationDays: dd.duration,
    withinDrawdownLimit: dd.maxDrawdown <= limits.maxDrawdownPct,
    portfolioCvar95: pnlSeries.length ? conditionalVaR(pnlSeries, 0.95) : NaN,
    worstStressScenario: stress?.worst?.scenario ?? null,
    worstStressPctOfNav: stress?.worstPctOfNav ?? null,
    stressPassed: stress?.passed ?? null,
    maxClusterPct: clusterPcts.length ? Math.max(...clusterPcts) : 0,
    withinClusterLimit: !clusterPcts.length || Math.max(...clusterPcts) <= limits.maxClusterPct,
    ruinProbability: ruin?.probability ?? null,
    ruinStandardError: ruin?.standardError ?? null,
    withinRuinLimit: ruin ? ruin.probability <= limits.maxRuinProbability : null,
    openPositions: positions?.length ?? 0,
    passed: dd.maxDrawdown <= limits.maxDrawdownPct
      && (!clusterPcts.length || Math.max(...clusterPcts) <= limits.maxClusterPct)
      && (stress ? stress.passed : true)
      && (ruin ? ruin.probability <= limits.maxRuinProbability : true),
  };
}

export function maxDrawdown(equityCurve) {
  if (!equityCurve?.length) return { maxDrawdown: 0, current: 0, duration: 0 };
  let peak = equityCurve[0];
  let maxDd = 0;
  let peakIdx = 0;
  let ddStart = 0;
  let maxDuration = 0;
  for (const [i, v] of equityCurve.entries()) {
    if (v > peak) { peak = v; peakIdx = i; ddStart = i; }
    const dd = peak > 0 ? (peak - v) / peak : 0;
    if (dd > maxDd) { maxDd = dd; maxDuration = i - ddStart; }
  }
  const last = equityCurve[equityCurve.length - 1];
  return {
    maxDrawdown: maxDd,
    current: peak > 0 ? (peak - last) / peak : 0,
    duration: maxDuration,
    peakIndex: peakIdx,
  };
}

/**
 * All five at once.
 *
 * `overallPassed` requires constitutional AND survival to pass. Economic
 * performance cannot compensate for either — that ordering is the
 * hierarchy from §27 applied to measurement.
 */
export function fullScoreboard(inputs) {
  const economic = economicScoreboard(inputs.economic);
  const calibration = calibrationScoreboard(inputs.calibration);
  const execution = executionScoreboard(inputs.execution);
  const constitutional = constitutionalScoreboard(inputs.constitutional);
  const survival = survivalScoreboard(inputs.survival);
  return {
    economic,
    calibration,
    execution,
    constitutional,
    survival,
    overallPassed: constitutional.passed && survival.passed,
    blockingIssues: [
      ...(constitutional.passed ? [] : ['Constitutional breaches recorded.']),
      ...(survival.passed ? [] : ['Survival limits exceeded.']),
    ],
  };
}
