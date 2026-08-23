/**
 * Assembles the full MarketState the Underwriter reasons against.
 *
 * One object, one timestamp, one provenance record. Nothing downstream may
 * reach past this into a provider — if it is not in here, it was not
 * verified, and §18 applies.
 */
import { volatilityProfile } from './realized_vol.js';
import { surfaceSummary, ivRankPercentile, atmIv } from './implied_vol.js';
import { forwardVrp, assessPremium, vrpRatio, vrpSpread } from './vrp.js';
import { classify, gapFrequency, drawdownFromPeak } from './regime.js';
import { correlation, logReturns, mean, isNum } from '../math/stats.js';

/** Per-underlying analytical state. */
export function buildUnderlyingState({ symbol, bars, chain, quote, events = [], ivHistory = null, dte = 30 }) {
  const vol = volatilityProfile(bars);
  const surface = chain ? surfaceSummary(chain, { dte }) : null;
  const iv = surface?.atmIv;
  const fwd = forwardVrp({ iv, garch: vol.garch, horizonDays: dte });
  const closes = bars.map((b) => b.c);

  return {
    symbol,
    asOf: chain?.asOf ?? quote?.asOf ?? null,
    spot: quote?.last ?? chain?.spot ?? null,
    quote,
    events,
    realized: vol.realized,
    volProfile: vol,
    surface,
    ivRank: ivHistory ? ivRankPercentile(iv, ivHistory) : { rank: NaN, percentile: NaN, sufficient: false },
    vrp: {
      spread: vrpSpread(iv, vol.realized),
      ratio: vrpRatio(iv, vol.realized),
      forward: fwd,
      assessment: assessPremium({ iv, rv: vol.realized, forward: fwd }),
    },
    gapFrequency: gapFrequency(bars),
    drawdown: drawdownFromPeak(closes),
    returns: logReturns(closes),
  };
}

/**
 * Average pairwise correlation across the book's underlyings.
 *
 * This is a regime input AND a portfolio constraint input, and it is the
 * same number in both places on purpose: the thing that makes a regime
 * dangerous is the same thing that makes a portfolio concentrated (§14).
 */
export function averagePairwiseCorrelation(returnsBySymbol, { window = 60 } = {}) {
  const syms = Object.keys(returnsBySymbol);
  if (syms.length < 2) return NaN;
  const rs = [];
  for (let i = 0; i < syms.length; i += 1) {
    for (let j = i + 1; j < syms.length; j += 1) {
      const a = returnsBySymbol[syms[i]].slice(-window);
      const b = returnsBySymbol[syms[j]].slice(-window);
      const c = correlation(a, b);
      if (isNum(c)) rs.push(c);
    }
  }
  return rs.length ? mean(rs) : NaN;
}

/**
 * The full market state: regime plus every underlying's analytics.
 */
export function buildMarketState({ underlyings, indexState, limits, now }) {
  const returnsBySymbol = Object.fromEntries(
    Object.entries(underlyings).map(([s, u]) => [s, u.returns]),
  );
  const breadthCorrelation = averagePairwiseCorrelation(returnsBySymbol);

  const gaps = Object.values(underlyings).map((u) => u.gapFrequency).filter(isNum);
  const realizeds = Object.values(underlyings).map((u) => u.realized).filter(isNum);
  const implieds = Object.values(underlyings).map((u) => u.surface?.atmIv).filter(isNum);

  const regime = classify({
    vix: indexState?.vix,
    vix3m: indexState?.vix3m,
    realizedVol: realizeds.length ? mean(realizeds) : undefined,
    impliedVol: implieds.length ? mean(implieds) : undefined,
    indexDrawdown: indexState?.drawdown,
    breadthCorrelation,
    gapFrequency: gaps.length ? mean(gaps) : undefined,
    crossAssetStress: indexState?.crossAssetStress,
    liquidityScore: indexState?.liquidityScore,
    volOfVol: indexState?.volOfVol,
  }, { limits });

  return {
    now,
    marketStatus: indexState?.status ?? 'UNKNOWN',
    index: indexState,
    regime,
    breadthCorrelation,
    underlyings,
    limitsVersion: limits?.version ?? null,
  };
}
