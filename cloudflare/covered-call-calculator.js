import { dteToT, probItm, probTouch } from '../src/math/black_scholes.js';
import { DEFAULT_LIMITS } from '../src/constitution/limits.js';
import { logReturns, mean } from '../src/math/stats.js';
import { volatilityProfile } from '../src/market/realized_vol.js';
import { buildDistribution } from '../src/pipeline/cycle.js';
import { DEFAULT_COSTS } from '../src/underwriter/costs.js';

export const COVERED_CALL_DTE_TARGETS = Object.freeze([7, 14, 21]);

const finite = (value) => value !== null && value !== undefined && value !== ''
  && Number.isFinite(Number(value)) ? Number(value) : null;
const clampProbability = (value) => Number.isFinite(value)
  ? Math.min(1, Math.max(0, value)) : null;

function nearestTarget(dte, targets) {
  return targets.slice().sort((a, b) => Math.abs(a - dte) - Math.abs(b - dte) || a - b)[0];
}

/**
 * Rank covered-call sale candidates using only broker-supplied quotes and
 * Greeks. The function is deliberately unable to build or transmit an order.
 *
 * A strike must be strictly above both the share cost basis and current mark.
 * This is a hard admission rule; the ranker never softens it to find a result.
 */
export function calculateCoveredCallCandidates({
  symbol,
  shares,
  averagePrice,
  availableContracts,
  spot,
  contracts,
  historyBars,
  events = [],
  now = Date.now(),
  samples = 8_000,
  seed = 'covered-call-entry',
  targets = COVERED_CALL_DTE_TARGETS,
  costs = DEFAULT_COSTS,
  limits = DEFAULT_LIMITS,
} = {}) {
  const ticker = String(symbol ?? '').trim().toUpperCase();
  const ownedShares = finite(shares);
  const basis = finite(averagePrice);
  const capacity = finite(availableContracts);
  const underlying = finite(spot);
  const targetDtes = [...new Set((targets ?? []).map(Number).filter((value) => value > 0))]
    .sort((a, b) => a - b);
  if (!ticker || !(ownedShares >= 100) || !(basis > 0) || !(capacity >= 1)
    || !(underlying > 0) || targetDtes.length !== 3 || !Array.isArray(contracts)
    || !Array.isArray(historyBars)) {
    return { ok: false, outcome: 'NO_ELIGIBLE_COVERED_CALL', reason_code: 'CALCULATOR_INPUT_INCOMPLETE' };
  }

  const usableBars = historyBars.filter((bar) => [bar?.o, bar?.h, bar?.l, bar?.c]
    .every((value) => finite(value) > 0));
  const closes = usableBars.map((bar) => finite(bar.c));
  const returns = logReturns(closes);
  const volProfile = volatilityProfile(usableBars);
  if (usableBars.length < 121 || returns.length < 120 || !volProfile.garchOk
    || !(finite(volProfile.realized) > 0)
    || !(finite(volProfile.estimatorSpread) <= 0.60)) {
    return {
      ok: false,
      outcome: 'NO_ELIGIBLE_COVERED_CALL',
      reason_code: 'FORECAST_HISTORY_OR_VOLATILITY_ENSEMBLE_UNAVAILABLE',
      symbol: ticker,
      history_sessions: usableBars.length,
      estimator_spread: finite(volProfile.estimatorSpread),
    };
  }

  const contractCount = Math.min(Math.floor(ownedShares / 100), Math.floor(capacity));
  const minimumStrikeExclusive = Math.max(basis, underlying);
  const entryFees = contractCount * (finite(costs?.commissionPerContract) ?? 0
    + (finite(costs?.exchangeFeePerContract) ?? 0));
  const economicCapital = underlying * 100 * contractCount;
  const rejected = {
    at_or_below_cost_basis: 0, at_or_below_market: 0, incomplete_quote: 0,
    dte_outside_limits: 0, event_in_window: 0, illiquid: 0, no_incremental_edge: 0,
  };
  const distributions = new Map();
  const forecastFor = (dte) => {
    if (!distributions.has(dte)) distributions.set(dte, buildDistribution({
      spot: underlying,
      vol: volProfile.garch?.forecast(dte) ?? volProfile.realized,
      dte,
      returns,
      seed: `${seed}:${ticker}:${dte}`,
      drift: 0,
      n: samples,
    }));
    return distributions.get(dte);
  };

  const candidates = [];
  for (const contract of contracts) {
    if (String(contract?.right ?? '').toLowerCase() !== 'call') continue;
    const strike = finite(contract.strike);
    const dte = finite(contract.dte);
    const bid = finite(contract.bid);
    const ask = finite(contract.ask);
    const iv = finite(contract.iv);
    const delta = finite(contract.delta);
    const theta = finite(contract.theta);
    const openInterest = finite(contract.openInterest);
    const volume = finite(contract.volume);
    if (![strike, dte, bid, ask, iv, delta].every(Number.isFinite)
      || !(strike > 0 && dte > 0 && bid > 0 && ask >= bid && iv > 0)
      || !(delta >= 0 && delta <= 1)) {
      rejected.incomplete_quote += 1;
      continue;
    }
    if (!(strike > basis)) {
      rejected.at_or_below_cost_basis += 1;
      continue;
    }
    if (!(strike > underlying)) {
      rejected.at_or_below_market += 1;
      continue;
    }
    if (dte < limits.minDte || dte > limits.maxDte) {
      rejected.dte_outside_limits += 1;
      continue;
    }
    const expiryMs = now + dte * 86_400_000;
    const eventInsideLife = (events ?? []).some((event) => Number.isFinite(finite(event?.at))
      && finite(event.at) <= expiryMs
      && finite(event.at) >= now - limits.eventBlackoutDays * 86_400_000);
    if (eventInsideLife) {
      rejected.event_in_window += 1;
      continue;
    }
    const mid = (bid + ask) / 2;
    const spreadPct = mid > 0 ? (ask - bid) / mid : Infinity;
    if (spreadPct > limits.maxSpreadPctOfMid || !(openInterest >= limits.minOpenInterest)
      || !(volume >= limits.minDailyOptionVolume)
      || contractCount / openInterest > limits.maxPositionPctOfOi) {
      rejected.illiquid += 1;
      continue;
    }

    const t = dteToT(dte);
    const assignmentProbability = clampProbability(probItm({
      type: 'call', spot: underlying, strike, vol: iv, t,
    }));
    const touchProbability = clampProbability(probTouch({
      spot: underlying, strike, vol: iv, t,
    }));
    if (assignmentProbability === null || touchProbability === null) {
      rejected.incomplete_quote += 1;
      continue;
    }
    const grossPremium = bid * 100 * contractCount;
    const netPremium = grossPremium - entryFees;
    const premiumRoc = netPremium / economicCapital;
    const annualizedPremiumRoc = premiumRoc * 365 / dte;
    const weeklyPremiumRoc = premiumRoc * 7 / dte;
    const expireOtmProbability = 1 - assignmentProbability;
    const shortCallLossProbability = clampProbability(probItm({
      type: 'call', spot: underlying, strike: strike + bid, vol: iv, t,
    }));
    const shortCallProfitProbability = shortCallLossProbability === null
      ? null : 1 - shortCallLossProbability;
    const upsideToStrike = (strike - underlying) / underlying;
    const expectedMove = underlying * iv * Math.sqrt(t);
    const expectedMoveBuffer = expectedMove > 0 ? (strike - underlying) / expectedMove : null;
    const forecast = forecastFor(dte);
    const expectedIntrinsicByModel = forecast.dist.members.map((member) => mean(
      member.dist.samples.map((terminal) => Math.max(terminal - strike, 0)),
    ));
    const conservativeExpectedIntrinsic = Math.max(...expectedIntrinsicByModel);
    const modelAssignmentProbability = clampProbability(forecast.dist.probAbove(strike));
    const expectedSurrenderedUpside = conservativeExpectedIntrinsic * 100 * contractCount;
    const expectedAssignmentFee = modelAssignmentProbability * (finite(costs?.assignmentFee) ?? 0);
    const incrementalNev = netPremium - expectedSurrenderedUpside - expectedAssignmentFee;
    const edgeHurdle = Math.max(finite(limits.minNev) ?? 0,
      entryFees * (finite(limits.minEdgeOverCosts) ?? 1));
    if (!(incrementalNev > edgeHurdle)) {
      rejected.no_incremental_edge += 1;
      continue;
    }
    const incrementalNevPerDay = incrementalNev / dte;
    const incrementalNevPerDayRoc = incrementalNevPerDay / economicCapital;
    const calledAwayReturnOnCost = ((strike - basis) * 100 * contractCount + netPremium)
      / (basis * 100 * contractCount);
    candidates.push({
      symbol: String(contract.symbol ?? '').replaceAll(' ', ''),
      underlying: ticker,
      target_dte: nearestTarget(dte, targetDtes),
      expiration: contract.expiration ?? null,
      dte,
      strike,
      contracts: contractCount,
      covered_shares: contractCount * 100,
      executable_credit_per_share: bid,
      gross_premium: grossPremium,
      entry_fees: entryFees,
      net_premium: netPremium,
      economic_capital: economicCapital,
      premium_roc: premiumRoc,
      weekly_premium_roc: weeklyPremiumRoc,
      annualized_premium_roc: annualizedPremiumRoc,
      incremental_nev_vs_holding: incrementalNev,
      incremental_nev_per_day: incrementalNevPerDay,
      incremental_nev_per_day_roc: incrementalNevPerDayRoc,
      expected_upside_surrendered: expectedSurrenderedUpside,
      expected_assignment_fee: expectedAssignmentFee,
      edge_hurdle: edgeHurdle,
      upside_to_strike: upsideToStrike,
      called_away_return_on_cost: calledAwayReturnOnCost,
      market_implied_expire_otm: expireOtmProbability,
      market_implied_assignment: assignmentProbability,
      market_implied_touch: touchProbability,
      market_implied_short_call_profit: shortCallProfitProbability,
      model_expire_otm: 1 - modelAssignmentProbability,
      model_assignment: modelAssignmentProbability,
      expected_move: expectedMove,
      expected_move_buffer: expectedMoveBuffer,
      delta,
      theta_income_per_day: Number.isFinite(theta) ? -theta * 100 * contractCount : null,
      implied_volatility: iv,
      bid,
      ask,
      spread_pct: spreadPct,
      open_interest: openInterest,
      volume,
      quote_asof: Number.isFinite(contract.quoteAsOf)
        ? new Date(contract.quoteAsOf).toISOString() : null,
    });
  }

  candidates.sort((a, b) => b.incremental_nev_per_day - a.incremental_nev_per_day
    || b.incremental_nev_vs_holding - a.incremental_nev_vs_holding
    || a.spread_pct - b.spread_pct || b.strike - a.strike);
  const ranked = candidates.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  const tenors = targetDtes.map((target) => {
    const rows = ranked.filter((candidate) => candidate.target_dte === target);
    return {
      target_dte: target,
      listed_dte: rows[0]?.dte ?? null,
      expiration: rows[0]?.expiration ?? null,
      eligible_candidates: rows.length,
      best: rows[0] ?? null,
      status: rows.length ? 'EVALUATED' : 'NO_ELIGIBLE_STRIKE',
    };
  });
  if (!ranked.length) return {
    ok: false,
    outcome: 'NO_ELIGIBLE_COVERED_CALL',
    reason_code: rejected.no_incremental_edge > 0
      ? 'NO_COVERED_CALL_ADDS_VALUE_VS_HOLDING_SHARES'
      : 'NO_LIQUID_STRIKE_STRICTLY_ABOVE_COST_BASIS_AND_MARKET',
    symbol: ticker,
    shares: ownedShares,
    available_contracts: contractCount,
    average_price: basis,
    spot: underlying,
    minimum_strike_exclusive: minimumStrikeExclusive,
    targets: tenors,
    rejected,
    forecast: {
      status: 'VERIFIED_NO_FALLBACK', history_sessions: usableBars.length,
      realized_volatility: volProfile.realized, estimator_spread: volProfile.estimatorSpread,
      garch: true, drift: 0, models: 'LOGNORMAL_JUMP_DIFFUSION_STUDENT_T_BLOCK_BOOTSTRAP',
    },
  };
  return {
    ok: true,
    outcome: 'COVERED_CALL_CANDIDATE_IDENTIFIED',
    objective: 'MAX_INCREMENTAL_NEV_PER_DAY_VS_HOLDING_SHARES',
    symbol: ticker,
    shares: ownedShares,
    available_contracts: contractCount,
    average_price: basis,
    spot: underlying,
    minimum_strike_exclusive: minimumStrikeExclusive,
    targets: tenors,
    selected: ranked[0],
    candidates: ranked,
    rejected,
    forecast: {
      status: 'VERIFIED_NO_FALLBACK', history_sessions: usableBars.length,
      realized_volatility: volProfile.realized, estimator_spread: volProfile.estimatorSpread,
      garch: true, drift: 0, models: 'LOGNORMAL_JUMP_DIFFUSION_STUDENT_T_BLOCK_BOOTSTRAP',
    },
    method: {
      credit: 'SCHWAB_EXECUTABLE_BID',
      assignment_probability: 'MARKET_IMPLIED_FROM_SCHWAB_IV',
      independent_forecast: 'ZERO_DRIFT_REALIZED_VOLATILITY_ENSEMBLE_WITH_GARCH_AND_BOOTSTRAP',
      score: 'INCREMENTAL_NEV_VS_HOLDING_SHARES_PER_CALENDAR_DAY',
      no_trade_competitor: 'REQUIRED; INCREMENTAL_NEV_MUST_CLEAR_COST_HURDLE',
      liquidity_gate: `CONSTITUTION_V5: SPREAD≤${limits.maxSpreadPctOfMid}; OI≥${limits.minOpenInterest}; VOLUME≥${limits.minDailyOptionVolume}; POSITION≤${limits.maxPositionPctOfOi}_OF_OI`,
      event_gate: `NO_VERIFIED_EVENT_INSIDE_OPTION_LIFE; ${limits.eventBlackoutDays}_DAY_BLACKOUT`,
      cost_basis_rule: 'STRIKE_MUST_BE_STRICTLY_ABOVE_AVERAGE_SHARE_PRICE',
      market_rule: 'STRIKE_MUST_BE_STRICTLY_ABOVE_CURRENT_MARK',
    },
  };
}
