/**
 * Candidate elimination (§7).
 *
 * "Candidate elimination should happen upstream. The system should not
 * score garbage."
 *
 * Every gate here is a hard pass/fail with a stated reason. None of them
 * are scores that a high premium can outweigh — that is the entire point.
 */
import { TIER, violation } from '../constitution/hierarchy.js';
import { isNum } from '../math/stats.js';

/** Liquidity of the underlying itself. */
export function underlyingLiquidity(state, limits) {
  const fails = [];
  const adv = state.quote?.adv;
  if (!isNum(adv)) {
    fails.push(violation(TIER.TRUTH, 'ADV_UNKNOWN', `${state.symbol}: average daily volume unavailable.`));
  } else if (adv < limits.minUnderlyingAdv) {
    fails.push(violation(TIER.SURVIVAL, 'ADV_LOW',
      `${state.symbol}: ADV ${adv.toLocaleString()} below ${limits.minUnderlyingAdv.toLocaleString()}.`,
      { adv }));
  }
  return fails;
}

/**
 * Option-level liquidity. Applied per contract, because a name can have a
 * fine chain at 30 DTE and an untradeable one at 7.
 */
export function contractLiquidity(contract, limits, { intendedContracts = 1 } = {}) {
  const fails = [];
  const { bid, ask, openInterest, volume } = contract;

  if (!isNum(bid) || !isNum(ask) || bid <= 0) {
    fails.push(violation(TIER.TRUTH, 'NO_TWO_SIDED_MARKET',
      `${contract.symbol}: no valid two-sided market.`, { bid, ask }));
    return fails; // nothing else is meaningful without a market
  }
  const mid = (bid + ask) / 2;
  const spreadPct = (ask - bid) / mid;
  if (spreadPct > limits.maxSpreadPctOfMid) {
    fails.push(violation(TIER.EXPECTANCY, 'SPREAD_WIDE',
      `${contract.symbol}: spread ${(spreadPct * 100).toFixed(1)}% of mid exceeds ${(limits.maxSpreadPctOfMid * 100).toFixed(1)}%.`,
      { spreadPct, bid, ask }));
  }
  if (!isNum(openInterest) || openInterest < limits.minOpenInterest) {
    fails.push(violation(TIER.SURVIVAL, 'OI_LOW',
      `${contract.symbol}: open interest ${openInterest ?? 'unknown'} below ${limits.minOpenInterest}.`,
      { openInterest }));
  }
  if (!isNum(volume) || volume < limits.minDailyOptionVolume) {
    fails.push(violation(TIER.SURVIVAL, 'OPT_VOLUME_LOW',
      `${contract.symbol}: option volume ${volume ?? 'unknown'} below ${limits.minDailyOptionVolume}.`,
      { volume }));
  }
  // Being a large share of open interest means NUVO cannot exit without
  // moving the price it is exiting at.
  if (isNum(openInterest) && openInterest > 0) {
    const share = intendedContracts / openInterest;
    if (share > limits.maxPositionPctOfOi) {
      fails.push(violation(TIER.SURVIVAL, 'OI_SHARE_HIGH',
        `${contract.symbol}: ${intendedContracts} contracts is ${(share * 100).toFixed(1)}% of open interest.`,
        { share }));
    }
  }
  return fails;
}

/**
 * Event clearance. A known binary event inside the option's life is not a
 * volatility premium — it is a coin flip that has been priced as one.
 */
export function eventClearance(state, { dte, limits, now }) {
  const fails = [];
  const expiryMs = now + dte * 86_400_000;
  for (const ev of state.events ?? []) {
    if (!isNum(ev.at)) {
      fails.push(violation(TIER.TRUTH, 'EVENT_UNDATED',
        `${state.symbol}: event '${ev.type}' has no verified date.`, { event: ev }));
      continue;
    }
    if (ev.at <= expiryMs && ev.at >= now - limits.eventBlackoutDays * 86_400_000) {
      fails.push(violation(TIER.EXPECTANCY, 'EVENT_IN_WINDOW',
        `${state.symbol}: ${ev.type} on ${new Date(ev.at).toISOString().slice(0, 10)} falls inside the ${dte}-day window.`,
        { event: ev, dte }));
    }
  }
  return fails;
}

/** Data sufficiency — enough history to model, and estimators that agree. */
export function dataQuality(state, { minBars = 120, maxEstimatorSpread = 0.60 } = {}) {
  const fails = [];
  const n = state.returns?.length ?? 0;
  if (n < minBars) {
    fails.push(violation(TIER.TRUTH, 'HISTORY_SHORT',
      `${state.symbol}: ${n} return observations, need ${minBars}.`, { n }));
  }
  if (!state.volProfile?.garchOk) {
    fails.push(violation(TIER.TRUTH, 'GARCH_UNAVAILABLE',
      `${state.symbol}: conditional volatility model would not fit.`));
  }
  const spread = state.volProfile?.estimatorSpread;
  if (isNum(spread) && spread > maxEstimatorSpread) {
    fails.push(violation(TIER.TRUTH, 'VOL_ESTIMATORS_DISAGREE',
      `${state.symbol}: volatility estimators disagree by ${(spread * 100).toFixed(0)}% — data likely corrupt.`,
      { spread }));
  }
  if (!isNum(state.spot) || state.spot <= 0) {
    fails.push(violation(TIER.TRUTH, 'SPOT_INVALID', `${state.symbol}: spot price invalid.`));
  }
  return fails;
}

/** Structural risk: names whose gap profile makes short downside unwise. */
export function structuralRisk(state, { maxGapFrequency = 0.15 } = {}) {
  const fails = [];
  if (isNum(state.gapFrequency) && state.gapFrequency > maxGapFrequency) {
    fails.push(violation(TIER.SURVIVAL, 'GAP_PRONE',
      `${state.symbol}: gaps beyond 1.5 sigma on ${(state.gapFrequency * 100).toFixed(0)}% of sessions.`,
      { gapFrequency: state.gapFrequency }));
  }
  return fails;
}
