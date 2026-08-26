import { probItm, probTouch, dteToT } from '../math/black_scholes.js';
import { logReturns, mean } from '../math/stats.js';
import { volatilityProfile } from '../market/realized_vol.js';
import { buildDistribution } from '../pipeline/cycle.js';
import { DEFAULT_COSTS } from '../underwriter/costs.js';

const DAY_MS = 86_400_000;

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function calendarDte(expiration, now) {
  const today = new Date(now).toISOString().slice(0, 10);
  const end = Date.parse(`${expiration}T00:00:00.000Z`);
  const start = Date.parse(`${today}T00:00:00.000Z`);
  return Number.isFinite(end) ? Math.max(0, Math.round((end - start) / DAY_MS)) : null;
}

function probabilityBelow(dist, level) {
  const value = dist.probBelow(level);
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
}

/**
 * Deterministic close-now versus hold-to-expiry analysis for an existing
 * covered short call. The language model never performs this math.
 */
export function analyzeCoveredCallLifecycle({
  optionPosition,
  sharePosition,
  optionQuote,
  underlyingQuote,
  historyBars,
  now = Date.now(),
  samples = 12_000,
  seed = 'covered-call-lifecycle',
  costs = DEFAULT_COSTS,
} = {}) {
  const quantity = finite(optionPosition?.qty ?? optionPosition?.quantity);
  const multiplier = finite(optionPosition?.multiplier) ?? 100;
  const contracts = quantity < 0 ? Math.abs(quantity) : 0;
  const shares = finite(sharePosition?.qty ?? sharePosition?.quantity);
  const strike = finite(optionPosition?.strike);
  const entryPrice = finite(optionPosition?.average_price ?? optionPosition?.averagePrice);
  const spot = finite(underlyingQuote?.last ?? underlyingQuote?.mark);
  const bid = finite(optionQuote?.bid);
  const ask = finite(optionQuote?.ask);
  const mid = finite(optionQuote?.mid);
  const iv = finite(optionQuote?.iv);
  const expiration = String(optionPosition?.expiration ?? '');
  const dte = calendarDte(expiration, now);
  const requiredShares = contracts * multiplier;
  if (!(contracts > 0) || optionPosition?.right !== 'call' || !(shares >= requiredShares)
    || ![strike, entryPrice, spot, bid, ask, mid, iv, dte].every(Number.isFinite)
    || !(ask >= bid && bid >= 0 && spot > 0 && strike > 0 && entryPrice > 0 && iv > 0 && dte > 0)
    || !Array.isArray(historyBars) || historyBars.length < 21) {
    return { ok: false, error: 'COVERED_CALL_ANALYSIS_INPUT_INCOMPLETE' };
  }

  const closes = historyBars.map((bar) => finite(bar.c ?? bar.close)).filter((value) => value > 0);
  const returns = logReturns(closes);
  const measuredVol = volatilityProfile(historyBars).realized;
  const shortHistory = historyBars.length < 120;
  const vol = shortHistory ? Math.max(measuredVol || 0, 0.80) : measuredVol;
  if (!(vol > 0) || returns.length < 20) {
    return { ok: false, error: 'COVERED_CALL_REALIZED_VOL_UNAVAILABLE' };
  }
  const { dist, bootstrapIncluded } = buildDistribution({
    spot, vol, dte, returns, seed, drift: 0, n: samples,
  });

  const perContractCost = costs.commissionPerContract + costs.exchangeFeePerContract;
  const closeFees = perContractCost * contracts;
  const closeOutlay = ask * multiplier * contracts + closeFees;
  const entryCredit = entryPrice * multiplier * contracts;
  const lockedProfit = entryCredit - closeOutlay;
  const capturedProfitPct = entryCredit > 0 ? lockedProfit / entryCredit : null;
  const expectedIntrinsicPerShare = mean(dist.samples.map((terminal) => Math.max(terminal - strike, 0)));
  const pModelItm = 1 - probabilityBelow(dist, strike);
  const expectedAssignmentFee = pModelItm * costs.assignmentFee;
  const expectedHoldProfit = entryCredit
    - expectedIntrinsicPerShare * multiplier * contracts
    - expectedAssignmentFee;
  const expectedHoldVsClose = expectedHoldProfit - lockedProfit;
  const holdCloseBreakeven = strike + closeOutlay / (multiplier * contracts);
  const totalProfitBreakeven = strike + entryPrice;
  const pMarketItm = probItm({ type: 'call', spot, strike, vol: iv, t: dteToT(dte) });
  const pMarketTouch = probTouch({ spot, strike, vol: iv, t: dteToT(dte) });
  const pMarketProfit = 1 - probItm({
    type: 'call', spot, strike: totalProfitBreakeven, vol: iv, t: dteToT(dte),
  });
  const edgeBuffer = Math.max(10, closeOutlay * 0.05);
  const quantitativeVerdict = expectedHoldVsClose > edgeBuffer
    ? 'HOLD_TO_EXPIRY_STATISTICALLY_FAVORED'
    : expectedHoldVsClose < -edgeBuffer
      ? 'CLOSE_NOW_STATISTICALLY_FAVORED'
      : 'CLOSE_VS_HOLD_NEAR_TIE';

  return {
    ok: true,
    symbol: optionPosition.symbol,
    underlying: optionPosition.underlying,
    right: 'call',
    contracts,
    covered_shares: requiredShares,
    total_owned_shares: shares,
    strike,
    expiration,
    dte,
    spot,
    distance_to_strike_pct: (strike - spot) / spot,
    quote: {
      bid, ask, mid, iv,
      delta: finite(optionQuote.delta),
      theta: finite(optionQuote.theta),
      asof: optionQuote.asof ?? null,
      source: optionQuote.source ?? null,
    },
    model: {
      volatility: vol,
      measured_volatility: measuredVol,
      volatility_floor_applied: shortHistory ? 0.80 : null,
      history_sessions: historyBars.length,
      drift: 0,
      paths: dist.n,
      bootstrap_included: bootstrapIncluded,
      seed,
    },
    current_trade: {
      entry_credit_per_share: entryPrice,
      entry_credit_total: entryCredit,
      executable_buyback_per_share: ask,
      executable_buyback_total: closeOutlay,
      close_fees: closeFees,
      profit_locked_if_closed_now: lockedProfit,
      profit_captured_pct: capturedProfitPct,
      maximum_additional_option_profit_if_worthless: closeOutlay,
    },
    probabilities: {
      market_implied_expire_otm: 1 - pMarketItm,
      market_implied_expire_itm_assignment: pMarketItm,
      market_implied_touch_strike: pMarketTouch,
      model_expire_otm: probabilityBelow(dist, strike),
      model_expire_itm_assignment: pModelItm,
      model_short_call_profitable_from_entry: probabilityBelow(dist, totalProfitBreakeven),
      market_implied_short_call_profitable_from_entry: pMarketProfit,
      model_hold_outperforms_close_now: probabilityBelow(dist, holdCloseBreakeven),
      broker_delta_assignment_proxy: finite(optionQuote.delta),
    },
    comparison: {
      close_now_locked_profit: lockedProfit,
      hold_expected_profit_model: expectedHoldProfit,
      hold_minus_close_expected_value: expectedHoldVsClose,
      expected_expiry_intrinsic_value_total: expectedIntrinsicPerShare * multiplier * contracts,
      hold_outperformance_breakeven_spot: holdCloseBreakeven,
      total_trade_profit_breakeven_spot: totalProfitBreakeven,
      quantitative_verdict: quantitativeVerdict,
      note: 'Model probabilities use zero drift, realized-volatility ensemble paths; market probabilities use live strike IV.',
    },
  };
}
