import { d1d2, dteToT, greeks, probItm } from '../math/black_scholes.js';

const DAY_MS = 86_400_000;
const DEFAULT_ASSIGNMENT_EXTRINSIC_PCT = 0.10;

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function calendarDte(expiration, now) {
  const today = new Date(now).toISOString().slice(0, 10);
  const end = Date.parse(`${expiration}T00:00:00.000Z`);
  const start = Date.parse(`${today}T00:00:00.000Z`);
  return Number.isFinite(end) ? Math.max(0, Math.round((end - start) / DAY_MS)) : null;
}

function cleanSymbol(value) {
  return String(value ?? '').replace(/\s+/gu, '').toUpperCase();
}

function money(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function unitPrice(value) {
  return Number.isFinite(value) ? Math.round(value * 100_000) / 100_000 : null;
}

function eventTime(event) {
  const value = event?.at ?? event?.date ?? event?.ex_dividend_date ?? event?.exDividendDate;
  if (Number.isFinite(Number(value)) && Number(value) > 10_000_000_000) return Number(value);
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedEventType(event) {
  return String(event?.type ?? event?.event_type ?? '').trim().toUpperCase();
}

function lifecycleFlag(code, observed, threshold, explanation) {
  return { code, observed, threshold, explanation };
}

/**
 * Reconstruct the still-open option credit from broker-ledger open lots.
 * Fees are first-class economics and may not be silently assumed to be zero.
 */
export function coveredCallEntryEvidenceFromOpenLots(openLots, optionPosition) {
  const optionSymbol = cleanSymbol(optionPosition?.symbol);
  const requestedContracts = Math.abs(finite(optionPosition?.qty ?? optionPosition?.quantity) ?? 0);
  if (!optionSymbol || !(requestedContracts > 0) || !Array.isArray(openLots)) {
    return { verified: false, reason: 'COVERED_CALL_ENTRY_LEDGER_INPUT_INCOMPLETE' };
  }
  const matching = openLots.filter((lot) => cleanSymbol(lot.symbol) === optionSymbol
    && finite(lot.quantity) < 0);
  const available = matching.reduce((sum, lot) => sum + Math.abs(finite(lot.quantity) ?? 0), 0);
  if (available < requestedContracts) {
    return {
      verified: false,
      reason: 'COVERED_CALL_ENTRY_LEDGER_QUANTITY_MISMATCH',
      requested_contracts: requestedContracts,
      ledger_contracts: available,
    };
  }
  let remaining = requestedContracts;
  let netCredit = 0;
  let openingFees = 0;
  const transactionIds = [];
  for (const lot of matching) {
    if (!(remaining > 0)) break;
    const take = Math.min(remaining, Math.abs(finite(lot.quantity) ?? 0));
    const cashPerContract = finite(lot.cash_per_unit);
    const feePerContract = finite(lot.fee_per_unit);
    if (!(take > 0) || cashPerContract === null || feePerContract === null) {
      return { verified: false, reason: 'COVERED_CALL_ENTRY_LEDGER_ECONOMICS_INCOMPLETE' };
    }
    netCredit += take * cashPerContract;
    openingFees += take * feePerContract;
    if (lot.transaction_id) transactionIds.push(String(lot.transaction_id));
    remaining -= take;
  }
  if (remaining > 0 || !(netCredit > 0) || openingFees < 0) {
    return { verified: false, reason: 'COVERED_CALL_ENTRY_LEDGER_ECONOMICS_INVALID' };
  }
  return {
    verified: true,
    source: 'SCHWAB_LEDGER_OPEN_LOTS',
    contracts: requestedContracts,
    grossCredit: money(netCredit + openingFees),
    openingFees: money(openingFees),
    netCredit: money(netCredit),
    transactionIds: [...new Set(transactionIds)],
  };
}

/**
 * Deterministic lifecycle accounting for shares already encumbered by an open
 * covered call. CLOSE, ROLL and EXIT remain NO_TRUTH until a separately
 * validated common-horizon decision model exists.
 */
export function analyzeCoveredCallLifecycle({
  optionPosition,
  sharePosition,
  optionQuote,
  underlyingQuote,
  entryEvidence,
  events = [],
  eventCoverage = {},
  now = Date.now(),
  rate = 0,
  dividendYield = 0,
  closeCommissionPerContract = 0.65,
  closeExchangeFeePerContract = 0,
  stockExitFees = 0,
  assignmentFees = 0,
  assignmentExtrinsicThresholdPct = DEFAULT_ASSIGNMENT_EXTRINSIC_PCT,
  expirationScenarioPrice,
} = {}) {
  const quantity = finite(optionPosition?.qty ?? optionPosition?.quantity);
  const multiplier = finite(optionPosition?.multiplier) ?? 100;
  const contracts = quantity < 0 ? Math.abs(quantity) : 0;
  const ownedShares = finite(sharePosition?.qty ?? sharePosition?.quantity);
  const shareBasis = finite(sharePosition?.average_price ?? sharePosition?.averagePrice);
  const strike = finite(optionPosition?.strike);
  const expiration = String(optionPosition?.expiration ?? '');
  const right = String(optionPosition?.right ?? '').toLowerCase();
  const spot = finite(underlyingQuote?.last ?? underlyingQuote?.mark ?? underlyingQuote?.price);
  const shareExitBid = finite(underlyingQuote?.bid);
  const optionBid = finite(optionQuote?.bid);
  const optionAsk = finite(optionQuote?.ask);
  const optionMid = finite(optionQuote?.mid) ?? (optionBid !== null && optionAsk !== null
    ? (optionBid + optionAsk) / 2 : null);
  const iv = finite(optionQuote?.iv ?? optionQuote?.volatility);
  const dte = calendarDte(expiration, now);
  const requiredShares = contracts * multiplier;
  const evidenceGross = finite(entryEvidence?.grossCredit ?? entryEvidence?.gross_credit);
  const evidenceFees = finite(entryEvidence?.openingFees ?? entryEvidence?.opening_fees);
  const evidenceNet = finite(entryEvidence?.netCredit ?? entryEvidence?.net_credit);
  const complete = contracts > 0 && right === 'call' && ownedShares >= requiredShares
    && [shareBasis, strike, spot, shareExitBid, optionBid, optionAsk, optionMid, iv, dte,
      evidenceGross, evidenceFees, evidenceNet].every(Number.isFinite)
    && entryEvidence?.verified === true && multiplier > 0 && shareBasis > 0 && strike > 0
    && spot > 0 && shareExitBid > 0 && optionAsk >= optionBid && optionBid >= 0 && iv > 0
    && dte > 0 && evidenceGross > 0 && evidenceFees >= 0 && evidenceNet > 0
    && Math.abs((evidenceGross - evidenceFees) - evidenceNet) < 0.011;
  if (!complete) {
    return {
      ok: false,
      symbol: optionPosition?.symbol ?? null,
      error: entryEvidence?.verified === true
        ? 'COVERED_CALL_ANALYSIS_INPUT_INCOMPLETE'
        : entryEvidence?.reason ?? 'COVERED_CALL_ENTRY_ECONOMICS_UNVERIFIED',
    };
  }

  const commission = finite(closeCommissionPerContract);
  const exchangeFee = finite(closeExchangeFeePerContract);
  const stockFees = finite(stockExitFees);
  const assignmentFee = finite(assignmentFees);
  if ([commission, exchangeFee, stockFees, assignmentFee].some((value) => value === null || value < 0)) {
    return { ok: false, symbol: optionPosition?.symbol ?? null, error: 'COVERED_CALL_COST_INPUT_INVALID' };
  }
  const closeFees = contracts * (commission + exchangeFee);
  const buybackPrincipal = optionAsk * requiredShares;
  const closeOutlay = buybackPrincipal + closeFees;
  const netCredit = evidenceNet;
  const grossCredit = evidenceGross;
  const adjustedBasis = shareBasis - netCredit / requiredShares;
  const lockedOptionPnl = netCredit - closeOutlay;
  const intrinsicPerShare = Math.max(spot - strike, 0);
  const executableExtrinsicPerShare = Math.max(optionAsk - intrinsicPerShare, 0);
  const executableExtrinsicTotal = executableExtrinsicPerShare * requiredShares;
  const extrinsicPctOfOriginalCredit = executableExtrinsicTotal / grossCredit;
  const totalLiabilityPctOfOriginalCredit = closeOutlay / grossCredit;
  const shareExitPnl = (shareExitBid - shareBasis) * requiredShares - stockFees;
  const exitNowPnl = shareExitPnl + lockedOptionPnl;
  const assignmentPnl = (strike - shareBasis) * requiredShares + netCredit - assignmentFee;
  const closeKeepCrossover = strike + closeOutlay / requiredShares;
  const sellWaitCrossover = shareExitBid - (closeOutlay + stockFees) / requiredShares;
  const scenarioPrice = finite(expirationScenarioPrice) ?? shareExitBid;
  const expireWorthlessPnl = scenarioPrice <= strike
    ? (scenarioPrice - shareBasis) * requiredShares + netCredit
    : null;

  const t = dteToT(dte);
  const { d1, d2 } = d1d2({ spot, strike, vol: iv, t, rate, yield: dividendYield });
  const pItmRn = probItm({ type: 'call', spot, strike, vol: iv, t, rate, yield: dividendYield });
  const pOtmRn = 1 - pItmRn;
  const modelGreeks = greeks({ type: 'call', spot, strike, vol: iv, t, rate, yield: dividendYield });
  const brokerLongTheta = finite(optionQuote?.theta);
  const shortThetaPerDay = brokerLongTheta === null ? null : -brokerLongTheta * requiredShares;
  const modelShortThetaPerDay = Number.isFinite(modelGreeks.theta)
    ? -modelGreeks.theta * requiredShares : null;

  const expiryMs = Date.parse(`${expiration}T23:59:59.999Z`);
  const inTenor = events.filter((event) => {
    const at = eventTime(event);
    return at !== null && at >= Number(now) && at <= expiryMs;
  });
  const exDividend = inTenor.find((event) => normalizedEventType(event) === 'EX_DIVIDEND');
  const dividendPerShare = finite(exDividend?.cash_amount ?? exDividend?.cashAmount ?? exDividend?.amount);
  const flags = [];
  if (dte <= 2) flags.push(lifecycleFlag(
    'EXPIRY_PROXIMITY', dte, 'DTE <= 2', `${dte} calendar day(s) remain to expiration.`,
  ));
  if (strike < shareBasis) flags.push(lifecycleFlag(
    'BELOW_BASIS', strike, `strike < share basis ${shareBasis}`,
    `Strike $${strike} is below the $${shareBasis} average share price.`,
  ));
  if (spot >= strike && extrinsicPctOfOriginalCredit <= assignmentExtrinsicThresholdPct) {
    flags.push(lifecycleFlag(
      'ASSIGNMENT_LIKELY', extrinsicPctOfOriginalCredit,
      `ITM and executable extrinsic/original gross credit <= ${assignmentExtrinsicThresholdPct}`,
      `Executable extrinsic is ${(extrinsicPctOfOriginalCredit * 100).toFixed(2)}% of original gross credit.`,
    ));
  }
  if (inTenor.length) flags.push(lifecycleFlag(
    'EVENT_IN_TENOR', inTenor.map((event) => ({ type: normalizedEventType(event), at: eventTime(event) })),
    'event date <= expiration', `${inTenor.length} verified event(s) occur before expiration.`,
  ));
  if (spot >= strike && exDividend && dividendPerShare !== null
    && dividendPerShare > executableExtrinsicPerShare) {
    flags.push(lifecycleFlag(
      'EARLY_ASSIGNMENT_RISK',
      { dividend_per_share: dividendPerShare, executable_extrinsic_per_share: executableExtrinsicPerShare },
      'ITM, ex-dividend before expiry, dividend > executable extrinsic',
      `Dividend $${dividendPerShare} exceeds executable extrinsic $${money(executableExtrinsicPerShare)}.`,
    ));
  }
  if (!flags.length) flags.push(lifecycleFlag(
    'NOMINAL', null, 'no deterministic flag fired', 'No deterministic condition is flagged.',
  ));

  const dataGaps = [];
  if (brokerLongTheta === null) dataGaps.push('BROKER_THETA_UNAVAILABLE');
  if (eventCoverage.eventsVerified !== true) dataGaps.push('EVENT_CALENDAR_UNVERIFIED');
  if (eventCoverage.dividendsVerified !== true) dataGaps.push('DIVIDEND_DATA_UNVERIFIED');

  return {
    ok: true,
    symbol: optionPosition.symbol,
    underlying: optionPosition.underlying ?? sharePosition?.symbol ?? null,
    right: 'call',
    contracts,
    covered_shares: requiredShares,
    total_owned_shares: ownedShares,
    strike,
    expiration,
    dte,
    spot,
    share_basis: shareBasis,
    distance_to_strike: {
      dollars_per_share: money(strike - spot),
      pct_of_spot: (strike - spot) / spot,
      risk_neutral_sigma: -d2,
    },
    strike_vs_share_basis: {
      dollars_per_share: money(strike - shareBasis),
      pct_of_share_basis: (strike - shareBasis) / shareBasis,
    },
    quote: {
      bid: optionBid, ask: optionAsk, mid: optionMid, iv,
      delta: finite(optionQuote?.delta), theta: brokerLongTheta,
      asof: optionQuote?.asof ?? null, source: optionQuote?.source ?? null,
      share_exit_bid: shareExitBid,
      share_quote_asof: underlyingQuote?.asof ?? null,
      executable_prices: true,
    },
    entry_evidence: {
      source: entryEvidence.source,
      transaction_ids: entryEvidence.transactionIds ?? entryEvidence.transaction_ids ?? [],
      gross_credit: money(grossCredit),
      opening_fees: money(evidenceFees),
      net_credit: money(netCredit),
    },
    cost_assumptions: {
      close_commission_per_contract: commission,
      close_exchange_fee_per_contract: exchangeFee,
      stock_exit_fees: money(stockFees),
      assignment_fees: money(assignmentFee),
      status: 'EXPLICIT_CONFIGURED_COSTS_NOT_EXECUTED_FEES',
    },
    current_trade: {
      original_gross_credit: money(grossCredit),
      opening_fees: money(evidenceFees),
      original_net_credit: money(netCredit),
      executable_buyback_per_share: optionAsk,
      buyback_principal: money(buybackPrincipal),
      close_fees: money(closeFees),
      total_close_outlay: money(closeOutlay),
      adjusted_share_basis: unitPrice(adjustedBasis),
      profit_locked_if_call_closed_now: money(lockedOptionPnl),
      executable_intrinsic_per_share: money(intrinsicPerShare),
      executable_extrinsic_per_share: money(executableExtrinsicPerShare),
      executable_extrinsic_total: money(executableExtrinsicTotal),
      extrinsic_pct_of_original_gross_credit: extrinsicPctOfOriginalCredit,
      total_liability_pct_of_original_gross_credit: totalLiabilityPctOfOriginalCredit,
      broker_short_theta_per_day: money(shortThetaPerDay),
      model_short_theta_per_day: money(modelShortThetaPerDay),
    },
    risk_neutral: {
      probability_expire_otm: pOtmRn,
      probability_expire_itm: pItmRn,
      sigma_distance_to_strike: -d2,
      d1,
      d2,
      rate,
      dividend_yield: dividendYield,
      label: 'RISK_NEUTRAL_EUROPEAN_EXCLUDES_EARLY_EXERCISE',
    },
    paths: {
      assignment: { pnl: money(assignmentPnl), terminal_share_price: strike, assignment_fees: money(assignmentFee) },
      exit_now: { pnl: money(exitNowPnl), executable_share_bid: shareExitBid, stock_exit_fees: money(stockFees) },
      expire_worthless: {
        pnl: money(expireWorthlessPnl), scenario_share_price: scenarioPrice,
        status: expireWorthlessPnl === null ? 'NOT_APPLICABLE_SCENARIO_ABOVE_STRIKE' : 'CALCULATED',
      },
      close_call_keep_shares: {
        locked_option_pnl: money(lockedOptionPnl),
        crossover_share_price: unitPrice(closeKeepCrossover),
      },
      sell_shares_wait_on_call: {
        crossover_share_price: unitPrice(sellWaitCrossover),
        executable_share_bid: shareExitBid,
        stock_exit_fees: money(stockFees),
      },
    },
    classification: {
      flags,
      data_gaps: dataGaps,
      recommendations: {
        do_nothing: flags.length === 1 && flags[0].code === 'NOMINAL'
          ? 'DETERMINISTIC_STATE_ONLY' : 'NOT_RECOMMENDED_BY_FLAGS',
        close: 'NO_TRUTH',
        roll: 'NO_TRUTH',
        exit: 'NO_TRUTH',
      },
      note: 'Flags identify observable conditions. They are not blended into a score or trading recommendation.',
    },
  };
}
