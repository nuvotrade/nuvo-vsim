/**
 * Backtesting, walk-forward, and bootstrap (§2).
 *
 * Two rules govern everything here:
 *
 *   1. Costs are charged on every trade, always. A backtest without
 *      realistic frictions is a generator of confidence, not of evidence.
 *   2. No decision may use information from after the decision point.
 *      The bar index is passed explicitly so lookahead is visible in the
 *      signature rather than hidden in a closure.
 */
import { mean, stdev, quantile, isNum } from '../math/stats.js';
import { maxDrawdown } from '../scoreboard/scoreboard.js';
import { Rng } from '../math/random.js';

/**
 * Run a strategy over a bar series.
 *
 * `strategy.onBar(ctx)` returns null or a trade intent. `ctx` exposes ONLY
 * data up to and including index i — enforced by slicing, not by convention.
 */
export function backtest({ bars, strategy, startingCapital = 100_000, warmup = 120, costPerTrade = 2.60 }) {
  const trades = [];
  const equity = [startingCapital];
  let capital = startingCapital;
  const open = [];

  for (let i = warmup; i < bars.length; i += 1) {
    const history = bars.slice(0, i + 1); // never bars[i+1..]
    const bar = bars[i];

    // Settle anything expiring today, before new decisions are made.
    for (let k = open.length - 1; k >= 0; k -= 1) {
      const pos = open[k];
      if (i >= pos.exitIndex) {
        const pnl = pos.settle(bar.c) - costPerTrade;
        capital += pnl;
        trades.push({
          ...pos.meta, realizedPnl: pnl, entryIndex: pos.entryIndex, exitIndex: i,
          exitPrice: bar.c, capitalEmployed: pos.capitalEmployed, economicCapital: pos.economicCapital,
        });
        open.splice(k, 1);
      }
    }

    const intent = strategy.onBar({ i, bar, history, capital, open: open.length });
    if (intent) {
      capital -= costPerTrade; // charged at entry too
      open.push({ ...intent, entryIndex: i });
    }
    equity.push(capital + open.reduce((s, p) => s + (p.markToMarket?.(bar.c) ?? 0), 0));
  }

  return summariseBacktest({ trades, equity, startingCapital, bars: bars.length - warmup });
}

export function summariseBacktest({ trades, equity, startingCapital, bars }) {
  const pnl = trades.map((t) => t.realizedPnl);
  const wins = pnl.filter((p) => p > 0);
  const losses = pnl.filter((p) => p <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);
  const dd = maxDrawdown(equity);
  const capitals = trades.map((t) => t.capitalEmployed ?? 0).filter((c) => c > 0);

  return {
    trades: trades.length,
    tradeList: trades,
    equity,
    totalPnl: pnl.reduce((a, b) => a + b, 0),
    expectancy: trades.length ? mean(pnl) : NaN,
    winRate: trades.length ? wins.length / trades.length : NaN,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : NaN),
    maxDrawdownPct: dd.maxDrawdown,
    sharpe: pnl.length > 1 && stdev(pnl) > 0 ? mean(pnl) / stdev(pnl) : NaN,
    cvarPct: pnl.length && startingCapital > 0
      ? Math.max(0, -quantile(pnl, 0.05)) / startingCapital : NaN,
    finalEquity: equity[equity.length - 1],
    returnPct: startingCapital > 0 ? (equity[equity.length - 1] - startingCapital) / startingCapital : NaN,
    avgCapitalEmployed: capitals.length ? mean(capitals) : NaN,
    bars,
  };
}

/**
 * Walk-forward analysis.
 *
 * Each fold fits on a training window and is evaluated on the NEXT,
 * untouched window. The output that matters is not the average — it is the
 * CONSISTENCY: a strategy that works in three folds and collapses in two
 * has not been shown to work.
 */
export function walkForward({ bars, buildStrategy, folds = 5, trainRatio = 0.7, ...opts }) {
  const foldSize = Math.floor(bars.length / folds);
  const results = [];
  for (let f = 0; f < folds; f += 1) {
    const start = f * foldSize;
    const end = Math.min(bars.length, start + foldSize);
    const split = start + Math.floor((end - start) * trainRatio);
    if (split - start < 150 || end - split < 40) continue;

    const trainBars = bars.slice(start, split);
    const testBars = bars.slice(split, end);
    const strategy = buildStrategy({ trainBars, fold: f });
    const test = backtest({ bars: testBars, strategy, ...opts });
    results.push({ fold: f, trainRange: [start, split], testRange: [split, end], ...test });
  }
  if (!results.length) return { folds: 0, sufficient: false, note: 'Series too short for walk-forward.' };

  const exps = results.map((r) => r.expectancy).filter(isNum);
  const positive = exps.filter((e) => e > 0).length;
  return {
    folds: results.length,
    results: results.map(({ tradeList, equity, ...r }) => r),
    meanExpectancy: mean(exps),
    sdExpectancy: stdev(exps),
    positiveFolds: positive,
    /**
     * The headline. A strategy passes walk-forward on CONSISTENCY, not on
     * a good average that one fold produced.
     */
    consistency: results.length ? positive / results.length : 0,
    worstFold: results.reduce((a, b) => (b.expectancy < a.expectancy ? b : a), results[0]).fold,
    sufficient: results.length >= 3,
  };
}

/**
 * Block bootstrap over the realised trade sequence.
 *
 * Blocks preserve the serial dependence in trade outcomes — losses cluster
 * because the regimes that cause them cluster. An i.i.d. bootstrap would
 * report a drawdown distribution far kinder than reality.
 */
export function bootstrapTrades({ trades, startingCapital, trials = 2000, blockSize = 5, seed = 'bootstrap' }) {
  const pnl = trades.map((t) => t.realizedPnl).filter(isNum);
  if (pnl.length < 10) return { sufficient: false, n: pnl.length };
  const rng = new Rng(seed);
  const finals = [];
  const drawdowns = [];
  let ruined = 0;

  for (let t = 0; t < trials; t += 1) {
    const curve = [startingCapital];
    let eq = startingCapital;
    let i = 0;
    while (i < pnl.length) {
      const start = rng.int(pnl.length);
      for (let b = 0; b < blockSize && i < pnl.length; b += 1, i += 1) {
        eq += pnl[(start + b) % pnl.length];
        curve.push(eq);
      }
    }
    finals.push(eq);
    const dd = maxDrawdown(curve);
    drawdowns.push(dd.maxDrawdown);
    if (eq <= startingCapital * 0.5) ruined += 1;
  }

  return {
    sufficient: true,
    trials,
    blockSize,
    medianFinal: quantile(finals, 0.5),
    p05Final: quantile(finals, 0.05),
    p95Final: quantile(finals, 0.95),
    probabilityOfLoss: finals.filter((f) => f < startingCapital).length / trials,
    medianMaxDrawdown: quantile(drawdowns, 0.5),
    p95MaxDrawdown: quantile(drawdowns, 0.95),
    ruinProbability: ruined / trials,
    /**
     * The honest framing: even a genuinely positive-expectancy strategy
     * produces losing paths. This is what fraction of them lose.
     */
    note: `${((finals.filter((f) => f < startingCapital).length / trials) * 100).toFixed(0)}% of resampled paths ended below starting capital.`,
  };
}

/**
 * Deflated significance check.
 *
 * If N variants were tried, the best one's apparent edge is inflated by
 * selection. This applies a Sidak-style correction so a strategy cannot be
 * promoted on the strength of having been the luckiest of forty.
 */
export function selectionAdjusted({ observedSharpe, trials, n }) {
  if (!isNum(observedSharpe) || !isNum(n) || n < 2) return { adjusted: NaN, sufficient: false };
  const se = 1 / Math.sqrt(n);
  const t = observedSharpe / se;
  // Probability that the best of `trials` independent nulls exceeds this t.
  const pSingle = 1 - normalCdfApprox(t);
  const pFamily = 1 - (1 - pSingle) ** Math.max(1, trials);
  return {
    tStat: t,
    pSingle,
    pFamilyWise: pFamily,
    significant: pFamily < 0.05,
    trials,
    note: trials > 1
      ? `Adjusted for ${trials} variants tested. A p-value of ${pSingle.toFixed(4)} becomes ${pFamily.toFixed(4)}.`
      : 'Single variant; no selection adjustment applied.',
  };
}

function normalCdfApprox(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
