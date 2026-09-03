import { dteToT, probItm, probTouch } from '../src/math/black_scholes.js';
import { DEFAULT_LIMITS } from '../src/constitution/limits.js';
import { logReturns } from '../src/math/stats.js';
import { volatilityProfile } from '../src/market/realized_vol.js';
import {
  buildUnderwriteModelSet, evaluateShortOptionModel,
  UNDERWRITE_MODEL_DEFINITIONS, UNDERWRITE_PRIMARY_MODEL, UNDERWRITE_STRESS_MODEL,
} from './underwrite-model-engine.js';

export const COVERED_CALL_DTE_TARGETS = Object.freeze([7, 14, 21]);

// Account-observed Schwab equity-option charges. Keep this scanner-specific:
// changing the global structure cost model would silently reprice unrelated
// strategies. The covered-call lifecycle ledger remains the source of truth
// for fees after a real fill.
export const SCHWAB_COVERED_CALL_COSTS = Object.freeze({
  version: 'schwab-covered-call-observed-2026-09-02',
  commissionPerContract: 0.65,
  exchangeFeePerContract: 0,
  assignmentFee: 0,
});

export function configuredCoveredCallDteTargets(value) {
  if (value === null || value === undefined || value === '') return [...COVERED_CALL_DTE_TARGETS];
  const tokens = Array.isArray(value) ? value : String(value).split(',');
  const parsed = tokens.map((token) => Number(String(token).trim()));
  if (!parsed.length || parsed.some((dte) => !Number.isInteger(dte) || dte <= 0 || dte > 365)) {
    return null;
  }
  return [...new Set(parsed)].sort((a, b) => a - b);
}

const finite = (value) => value !== null && value !== undefined && value !== ''
  && Number.isFinite(Number(value)) ? Number(value) : null;
const clampProbability = (value) => Number.isFinite(value)
  ? Math.min(1, Math.max(0, value)) : null;

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const alpha = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, row) => sum + row, 0) / period;
  const rows = [value];
  for (const row of values.slice(period)) {
    value = row * alpha + value * (1 - alpha);
    rows.push(value);
  }
  return rows;
}

function technicalTiming(closes) {
  if (!Array.isArray(closes) || closes.length < 40) return {
    status: 'UNAVAILABLE', policy_effect: 'INFORMATIONAL_ONLY_NOT_A_GATE',
  };
  const changes = closes.slice(1).map((close, index) => close - closes[index]);
  const gains = changes.slice(-14).reduce((sum, change) => sum + Math.max(0, change), 0) / 14;
  const losses = changes.slice(-14).reduce((sum, change) => sum + Math.max(0, -change), 0) / 14;
  const rsi14 = losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
  const fast = ema(closes, 12); const slow = ema(closes, 26);
  const overlap = Math.min(fast?.length ?? 0, slow?.length ?? 0);
  const fastTail = overlap ? fast.slice(-overlap) : [];
  const slowTail = overlap ? slow.slice(-overlap) : [];
  const macdSeries = fastTail.map((value, index) => value - slowTail[index]);
  const signalSeries = ema(macdSeries, 9) ?? [];
  const macd = macdSeries.at(-1) ?? null;
  const signal = signalSeries.at(-1) ?? null;
  const histogram = macd != null && signal != null ? macd - signal : null;
  const priorMacd = macdSeries.at(-2) ?? null;
  const priorSignal = signalSeries.at(-2) ?? null;
  const priorHistogram = priorMacd != null && priorSignal != null ? priorMacd - priorSignal : null;
  const rsiOverbought = rsi14 >= 70;
  const macdMomentumRollingOver = macd != null && histogram != null
    && priorHistogram != null && macd > 0 && histogram < priorHistogram;
  return {
    status: rsiOverbought || macdMomentumRollingOver ? 'FAVORABLE_TO_SELL_CALL' : 'NEUTRAL',
    rsi_14: rsi14,
    rsi_overbought: rsiOverbought,
    macd_12_26: macd,
    macd_signal_9: signal,
    macd_histogram: histogram,
    macd_momentum_rolling_over: macdMomentumRollingOver,
    policy_effect: 'INFORMATIONAL_ONLY_NOT_A_GATE',
  };
}

const REJECTION_CODES = Object.freeze({
  incomplete_quote: 'TRUTH/OPTION_QUOTE_INCOMPLETE',
  at_or_below_cost_basis: 'UNDERWRITE/STRIKE_AT_OR_BELOW_COST_BASIS',
  at_or_below_market: 'UNDERWRITE/STRIKE_AT_OR_BELOW_MARKET',
  dte_outside_limits: 'CONSTITUTION/DTE_OUTSIDE_LIMITS',
  event_in_window: 'TRUTH/EVENT_IN_TENOR',
  illiquid: 'CONSTITUTION/OPTION_LIQUIDITY_GATE_FAILED',
});

const WEEK_SLOTS = Object.freeze(['THIS_WEEK', 'NEXT_WEEK', 'WEEK_AFTER']);
const WEEK_LABELS = Object.freeze(['This week', 'Next week', 'Week after']);

function namedRejections(rejected) {
  return Object.fromEntries(Object.entries(REJECTION_CODES)
    .map(([counter, code]) => [code, rejected[counter] ?? 0]));
}

/**
 * Describe current portfolio utilization for the dashboard. These figures are
 * informational only: the Principal explicitly declined book-level admission
 * gates on the covered-call RUN route.
 */
export function summarizeCoveredCallPortfolioState(snapshot, limits = DEFAULT_LIMITS) {
  const nav = finite(snapshot?.nav ?? snapshot?.account?.nav);
  const cash = finite(snapshot?.cash ?? snapshot?.account?.cash);
  const positions = Array.isArray(snapshot?.positions) ? snapshot.positions : null;
  const unavailable = [];
  if (!(nav > 0)) unavailable.push('NAV');
  if (!Number.isFinite(cash)) unavailable.push('SETTLED_CASH');
  if (!positions) unavailable.push('POSITIONS');
  const equities = positions?.filter((position) => position?.type === 'EQUITY') ?? [];
  const missingMarketValues = equities.filter((position) => !Number.isFinite(finite(position?.marketValue)))
    .map((position) => String(position?.symbol ?? 'UNKNOWN').toUpperCase());
  if (missingMarketValues.length) unavailable.push('EQUITY_MARKET_VALUES');
  if (unavailable.length) return {
    complete: false,
    unavailable,
    nav,
    settled_cash: cash,
    missing_market_value_symbols: missingMarketValues,
    limits_version: limits?.version ?? null,
    policy_effect: 'INFORMATIONAL_ONLY_NEVER_BLOCKS_RUN',
  };

  const positiveCash = Math.max(0, cash);
  const cashReservePct = positiveCash / nav;
  const deployedPct = Math.max(0, 1 - cashReservePct);
  const observations = [];
  if (Number.isFinite(finite(limits?.maxDeployedPct)) && deployedPct > limits.maxDeployedPct) {
    observations.push({
      name: 'DEPLOYED_ABOVE_REFERENCE',
      actual: deployedPct,
      reference: limits.maxDeployedPct,
    });
  }
  if (Number.isFinite(finite(limits?.minReservePct)) && cashReservePct < limits.minReservePct) {
    observations.push({
      name: 'CASH_BELOW_REFERENCE',
      actual: cashReservePct,
      reference: limits.minReservePct,
    });
  }

  const underlyingExposure = equities.map((position) => ({
    symbol: String(position.symbol ?? '').toUpperCase(),
    market_value: Math.abs(finite(position.marketValue)),
    pct_nav: Math.abs(finite(position.marketValue)) / nav,
  }));
  if (Number.isFinite(finite(limits?.maxSingleUnderlyingPct))) {
    for (const exposure of underlyingExposure) {
      if (exposure.pct_nav > limits.maxSingleUnderlyingPct) observations.push({
        name: 'SINGLE_UNDERLYING_ABOVE_REFERENCE',
        symbol: exposure.symbol,
        actual: exposure.pct_nav,
        reference: limits.maxSingleUnderlyingPct,
      });
    }
  }
  return {
    complete: true,
    observations,
    nav,
    settled_cash: cash,
    cash_reserve_pct: cashReservePct,
    deployed_pct: deployedPct,
    underlying_exposure: underlyingExposure,
    limits_version: limits?.version ?? null,
    policy_effect: 'INFORMATIONAL_ONLY_NEVER_BLOCKS_RUN',
  };
}

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
  expectedMoves = {},
  events = [],
  now = Date.now(),
  samples = 8_000,
  seed = 'covered-call-entry',
  targets = COVERED_CALL_DTE_TARGETS,
  costs = SCHWAB_COVERED_CALL_COSTS,
  limits = DEFAULT_LIMITS,
  rate = DEFAULT_LIMITS.riskFreeRate,
  dividendYield = 0,
} = {}) {
  const ticker = String(symbol ?? '').trim().toUpperCase();
  const ownedShares = finite(shares);
  const basis = finite(averagePrice);
  const capacity = finite(availableContracts);
  const underlying = finite(spot);
  const targetDtes = configuredCoveredCallDteTargets(targets);
  if (!ticker || !(ownedShares >= 100) || !(basis > 0) || !(capacity >= 1)
    || !(underlying > 0) || !targetDtes?.length || !Array.isArray(contracts)
    || !Array.isArray(historyBars)) {
    return { ok: false, outcome: 'NO_ELIGIBLE_COVERED_CALL', reason_code: 'CALCULATOR_INPUT_INCOMPLETE' };
  }

  const usableBars = historyBars.filter((bar) => [bar?.o, bar?.h, bar?.l, bar?.c]
    .every((value) => finite(value) > 0));
  const closes = usableBars.map((bar) => finite(bar.c));
  const returns = logReturns(closes);
  const volProfile = volatilityProfile(usableBars);
  const timing = technicalTiming(closes);
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
  const entryFees = Math.round(contractCount * ((finite(costs?.commissionPerContract) ?? 0)
    + (finite(costs?.exchangeFeePerContract) ?? 0)) * 100) / 100;
  const economicCapital = underlying * 100 * contractCount;
  const rejectionTemplate = () => ({
    at_or_below_cost_basis: 0, at_or_below_market: 0, incomplete_quote: 0,
    dte_outside_limits: 0, event_in_window: 0, illiquid: 0,
  });
  const rejected = rejectionTemplate();
  const rejectedByTarget = Object.fromEntries(targetDtes.map((target) => [target, rejectionTemplate()]));
  const reject = (code, dte) => {
    rejected[code] += 1;
    if (Number.isFinite(dte)) rejectedByTarget[nearestTarget(dte, targetDtes)][code] += 1;
  };
  const distributions = new Map();
  const forecastFor = (dte) => {
    if (!distributions.has(dte)) {
      const forecastVol = finite(volProfile.garch?.forecast(dte));
      distributions.set(dte, {
        forecastVol,
        models: buildUnderwriteModelSet({
          spot: underlying, dte, forecastVol, returns, samples,
          seed: `${seed}:${ticker}`,
        }),
      });
    }
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
      reject('incomplete_quote', dte);
      continue;
    }
    if (!(strike > basis)) {
      reject('at_or_below_cost_basis', dte);
      continue;
    }
    if (!(strike > underlying)) {
      reject('at_or_below_market', dte);
      continue;
    }
    // The wheel explicitly evaluates the current weekly expiration plus the
    // next two weeklies. This workflow-specific horizon is independent of the
    // longer-DTE new-risk scanner floor; it still refuses expired contracts.
    if (dte <= 0 || dte > limits.maxDte) {
      reject('dte_outside_limits', dte);
      continue;
    }
    const expiryMs = now + dte * 86_400_000;
    const eventInsideLife = (events ?? []).some((event) => Number.isFinite(finite(event?.at))
      && finite(event.at) <= expiryMs
      && finite(event.at) >= now - limits.eventBlackoutDays * 86_400_000);
    if (eventInsideLife) {
      reject('event_in_window', dte);
      continue;
    }
    const mid = (bid + ask) / 2;
    const spreadPct = mid > 0 ? (ask - bid) / mid : Infinity;
    if (spreadPct > limits.maxSpreadPctOfMid || !(openInterest >= limits.minOpenInterest)
      || !(volume >= limits.minDailyOptionVolume)
      || contractCount / openInterest > limits.maxPositionPctOfOi) {
      reject('illiquid', dte);
      continue;
    }

    const t = dteToT(dte);
    const rateUsed = finite(rate) ?? 0;
    const yieldUsed = finite(dividendYield) ?? 0;
    const discount = Math.exp(-rateUsed * t);
    const assignmentProbability = clampProbability(probItm({
      type: 'call', spot: underlying, strike, vol: iv, t,
      rate: rateUsed, yield: yieldUsed,
    }));
    const touchProbability = clampProbability(probTouch({
      spot: underlying, strike, vol: iv, t,
    }));
    if (assignmentProbability === null || touchProbability === null) {
      reject('incomplete_quote', dte);
      continue;
    }
    const grossPremiumPerContract = bid * 100;
    const entryFeesPerContract = entryFees / contractCount;
    const netPremiumPerContract = grossPremiumPerContract - entryFeesPerContract;
    const grossPremium = grossPremiumPerContract * contractCount;
    const netPremium = netPremiumPerContract * contractCount;
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
    const expectedMoveTruth = expectedMoves?.[contract.expiration] ?? null;
    const marketMakerExpectedMove = finite(expectedMoveTruth?.expected_move);
    const marketMakerExpectedMoveCeiling = finite(expectedMoveTruth?.upper_boundary);
    const ivExpectedMove = underlying * iv * Math.sqrt(t);
    const expectedMove = marketMakerExpectedMove ?? ivExpectedMove;
    const expectedMoveBuffer = expectedMove > 0 ? (strike - underlying) / expectedMove : null;
    const forecast = forecastFor(dte);
    const modelResults = Object.fromEntries(Object.entries(forecast.models).map(([name, dist]) => [
      name, evaluateShortOptionModel(dist, {
        right: 'call', strike, netCredit: netPremiumPerContract,
        discount, capital: underlying * 100,
      }),
    ]));
    const primary = modelResults[UNDERWRITE_PRIMARY_MODEL];
    if (!primary) {
      reject('incomplete_quote', dte);
      continue;
    }
    const modelAssignmentProbability = clampProbability(primary.p_finish_itm);
    const expectedSurrenderedUpside = (netPremiumPerContract - primary.raw_nev_0)
      * contractCount;
    const expectedAssignmentFee = modelAssignmentProbability
      * (finite(costs?.assignmentFee) ?? 0) * contractCount;
    const incrementalNev = primary.raw_nev_0 * contractCount - expectedAssignmentFee;
    const legacyEdgeHurdle = Math.max(finite(limits.minNev) ?? 0,
      entryFees * (finite(limits.minEdgeOverCosts) ?? 1));
    const incrementalNevPerDay = incrementalNev / dte;
    const incrementalNevPerDayRoc = incrementalNevPerDay / economicCapital;
    const costBasisCapital = basis * 100 * contractCount;
    const wheelIncomeReturnOnCost = netPremium / costBasisCapital;
    const wheelIncomeReturnOnCostPerDay = wheelIncomeReturnOnCost / dte;
    const calledAwayProfit = (strike - basis) * 100 * contractCount + netPremium;
    const calledAwayReturnOnCost = calledAwayProfit / costBasisCapital;
    const downsideBreakeven = basis - netPremium / (100 * contractCount);
    const currentShareProfit = (underlying - basis) * 100 * contractCount;
    const expectedWheelProfit = currentShareProfit + incrementalNev;
    const expectedWheelProfitPerDay = expectedWheelProfit / dte;
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
      cost_model_version: costs?.version ?? 'UNVERSIONED_EXECUTION_COST',
      net_premium: netPremium,
      economic_capital: economicCapital,
      premium_roc: premiumRoc,
      weekly_premium_roc: weeklyPremiumRoc,
      annualized_premium_roc: annualizedPremiumRoc,
      incremental_nev_vs_holding: incrementalNev,
      incremental_nev_per_day: incrementalNevPerDay,
      incremental_nev_per_day_roc: incrementalNevPerDayRoc,
      legacy_uncovered_hold_edge_hurdle: legacyEdgeHurdle,
      legacy_uncovered_hold_gate_passed: incrementalNev > legacyEdgeHurdle,
      expected_upside_surrendered: expectedSurrenderedUpside,
      expected_assignment_fee: expectedAssignmentFee,
      wheel_income_return_on_cost: wheelIncomeReturnOnCost,
      wheel_income_return_on_cost_per_day: wheelIncomeReturnOnCostPerDay,
      net_premium_per_calendar_day: netPremium / dte,
      current_share_profit: currentShareProfit,
      expected_wheel_profit: expectedWheelProfit,
      expected_wheel_profit_per_calendar_day: expectedWheelProfitPerDay,
      expected_wheel_profit_formula:
        'CURRENT_SHARE_PROFIT_FROM_COST_PLUS_NET_PREMIUM_MINUS_PRIMARY_EXPECTED_SURRENDERED_UPSIDE_AND_ASSIGNMENT_FEE',
      upside_to_strike: upsideToStrike,
      called_away_profit: calledAwayProfit,
      called_away_return_on_cost: calledAwayReturnOnCost,
      downside_breakeven: downsideBreakeven,
      market_implied_expire_otm: expireOtmProbability,
      market_implied_assignment: assignmentProbability,
      market_implied_touch: touchProbability,
      market_implied_short_call_profit: shortCallProfitProbability,
      model_expire_otm: 1 - modelAssignmentProbability,
      model_assignment: modelAssignmentProbability,
      expected_move: expectedMove,
      market_maker_expected_move: marketMakerExpectedMove,
      market_maker_expected_move_ceiling: marketMakerExpectedMoveCeiling,
      strike_at_or_above_market_maker_expected_move: marketMakerExpectedMoveCeiling == null
        ? null : strike >= marketMakerExpectedMoveCeiling,
      expected_move_formula: marketMakerExpectedMove == null
        ? 'IV_SIGMA_MOVE_DIAGNOSTIC' : 'ATM_CALL_MID_PLUS_ATM_PUT_MID',
      expected_move_buffer: expectedMoveBuffer,
      calculation_unit_contracts: 1,
      one_contract_gross_premium: grossPremiumPerContract,
      one_contract_entry_fees: entryFeesPerContract,
      one_contract_net_premium: netPremiumPerContract,
      one_contract_models: modelResults,
      headline_models: {
        primary: UNDERWRITE_PRIMARY_MODEL,
        primary_raw_nev_0: primary.raw_nev_0,
        primary_monte_carlo_standard_error: primary.monte_carlo_standard_error,
        stress: UNDERWRITE_STRESS_MODEL,
        stress_raw_nev_0: modelResults[UNDERWRITE_STRESS_MODEL]?.raw_nev_0 ?? null,
        stress_monte_carlo_standard_error:
          modelResults[UNDERWRITE_STRESS_MODEL]?.monte_carlo_standard_error ?? null,
        stress_veto: 'NOT_REGISTERED_DISPLAY_ONLY',
      },
      expiry_level_forecast_vol: forecast.forecastVol,
      model_time_to_expiry_years: t,
      delta,
      theta_income_per_day: Number.isFinite(theta)
        ? -theta * contractCount * (finite(contract.multiplier) ?? 100)
        : null,
      theta_source_unit: contract.greekUnits?.theta
        ?? 'PREMIUM_DOLLARS_PER_SHARE_PER_CALENDAR_DAY',
      implied_volatility: iv,
      bid,
      ask,
      spread_pct: spreadPct,
      open_interest: openInterest,
      volume,
      quote_asof: Number.isFinite(contract.quoteAsOf)
        ? new Date(contract.quoteAsOf).toISOString() : null,
      order_instruction: `SELL TO OPEN ${contractCount} ${String(contract.symbol ?? '').replaceAll(' ', '')} at $${bid.toFixed(2)} LIMIT or better`,
    });
  }

  candidates.sort((a, b) => b.expected_wheel_profit_per_calendar_day
    - a.expected_wheel_profit_per_calendar_day
    || b.called_away_profit - a.called_away_profit
    || b.net_premium - a.net_premium
    || a.spread_pct - b.spread_pct || b.strike - a.strike);
  const ranked = candidates.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  const primaryBlockerFor = (counts) => {
    const code = ['event_in_window', 'incomplete_quote', 'illiquid', 'at_or_below_cost_basis',
      'at_or_below_market', 'dte_outside_limits'].find((name) => counts[name] > 0);
    return code ? { code: REJECTION_CODES[code], count: counts[code] } : {
      code: 'TRUTH/NO_LISTED_CALLS_FOR_WEEK', count: 0,
    };
  };
  const tenors = targetDtes.map((target, index) => {
    const rows = ranked.filter((candidate) => candidate.target_dte === target);
    const listed = contracts.find((contract) => String(contract?.right ?? '').toLowerCase() === 'call'
      && Number.isFinite(finite(contract?.dte)) && nearestTarget(finite(contract.dte), targetDtes) === target);
    const targetRejected = rejectedByTarget[target];
    return {
      slot: WEEK_SLOTS[index] ?? `WEEK_${index + 1}`,
      slot_label: WEEK_LABELS[index] ?? `Week ${index + 1}`,
      target_dte: target,
      listed_dte: rows[0]?.dte ?? finite(listed?.dte),
      expiration: rows[0]?.expiration ?? listed?.expiration ?? null,
      eligible_candidates: rows.length,
      best: rows[0] ?? null,
      status: rows.length ? 'EVALUATED' : 'NO_ELIGIBLE_STRIKE',
      decision: rows.length ? 'SELL_COVERED_CALL' : 'HOLD_SHARES_NO_TRADE',
      primary_blocker: rows.length ? null : primaryBlockerFor(targetRejected),
      rejected: targetRejected,
      rejection_codes: namedRejections(targetRejected),
    };
  });
  const method = {
    cost_model_version: costs?.version ?? 'UNVERSIONED_EXECUTION_COST',
    credit: 'SCHWAB_EXECUTABLE_BID',
    assignment_probability: 'MARKET_IMPLIED_FROM_SCHWAB_IV',
    independent_forecast: 'PRIMARY_CENTERED_5_SESSION_BLOCK_BOOTSTRAP_WITH_SEPARATE_CHALLENGERS',
    primary_model: UNDERWRITE_PRIMARY_MODEL,
    models: UNDERWRITE_MODEL_DEFINITIONS,
    score: 'MAX_PRIMARY_EXPECTED_WHEEL_PROFIT_FROM_COST_PER_CALENDAR_DAY',
    max_of_models: 'REMOVED',
    mixture: 'NONE',
    time_basis: 'TODAY_DOLLARS_PREMIUM_TODAY_MINUS_DISCOUNTED_TERMINAL_CALL_LIABILITY',
    rate: finite(rate) ?? 0,
    dividend_yield: finite(dividendYield) ?? 0,
    cash_carry: 'NOT_APPLICABLE_COVERED_CALL_INCREMENTAL_VALUE_IS_RAW_ONLY',
    uncovered_hold_comparison: 'DIAGNOSTIC_ONLY_NOT_AN_ENTRY_GATE',
    liquidity_gate: `CONSTITUTION_V5: SPREAD≤${limits.maxSpreadPctOfMid}; OI≥${limits.minOpenInterest}; VOLUME≥${limits.minDailyOptionVolume}; POSITION≤${limits.maxPositionPctOfOi}_OF_OI`,
    event_gate: `NO_VERIFIED_EVENT_INSIDE_OPTION_LIFE; ${limits.eventBlackoutDays}_DAY_BLACKOUT`,
    cost_basis_rule: 'STRIKE_MUST_BE_STRICTLY_ABOVE_AVERAGE_SHARE_PRICE',
    market_rule: 'STRIKE_MUST_BE_STRICTLY_ABOVE_CURRENT_MARK',
    expected_move_reference: 'ATM_CALL_MID_PLUS_ATM_PUT_MID_INFORMATIONAL_NOT_A_GATE',
    wheel_assignment_rule: 'ASSIGNMENT_AT_STRIKE_IS_ACCEPTED_WHEN_STRIKE_EXCEEDS_COST_BASIS',
    technical_timing_rule: 'RSI14_AND_MACD_12_26_9_INFORMATIONAL_ONLY_PENDING_BACKTEST',
    technical_timing_policy_effect: 'INFORMATIONAL_ONLY_NOT_A_GATE',
    atr_policy_effect: 'INFORMATIONAL_ONLY_NOT_A_GATE_NOT_YET_CONNECTED',
    rejection_codes: REJECTION_CODES,
  };
  if (!ranked.length) return {
    ok: false,
    outcome: 'NO_ELIGIBLE_COVERED_CALL',
    reason_code: 'NO_LIQUID_STRIKE_STRICTLY_ABOVE_COST_BASIS_AND_MARKET',
    symbol: ticker,
    shares: ownedShares,
    available_contracts: contractCount,
    average_price: basis,
    spot: underlying,
    minimum_strike_exclusive: minimumStrikeExclusive,
    targets: tenors,
    rejected,
    rejection_codes: namedRejections(rejected),
    forecast: {
      status: 'VERIFIED_NO_FALLBACK', history_sessions: usableBars.length,
      realized_volatility: volProfile.realized, estimator_spread: volProfile.estimatorSpread,
      garch: true, drift: 0,
      primary_model: UNDERWRITE_PRIMARY_MODEL,
      models: UNDERWRITE_MODEL_DEFINITIONS,
      max_of_models: 'REMOVED', mixture: 'NONE',
    },
    technical_timing: timing,
    method,
  };
  return {
    ok: true,
    outcome: 'COVERED_CALL_CANDIDATE_IDENTIFIED',
    objective: 'MAX_PRIMARY_EXPECTED_WHEEL_PROFIT_FROM_COST_PER_CALENDAR_DAY',
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
    rejection_codes: namedRejections(rejected),
    forecast: {
      status: 'VERIFIED_NO_FALLBACK', history_sessions: usableBars.length,
      realized_volatility: volProfile.realized, estimator_spread: volProfile.estimatorSpread,
      garch: true, drift: 0,
      primary_model: UNDERWRITE_PRIMARY_MODEL,
      models: UNDERWRITE_MODEL_DEFINITIONS,
      max_of_models: 'REMOVED', mixture: 'NONE',
    },
    technical_timing: timing,
    method,
  };
}
