import { dteToT, probItm } from '../src/math/black_scholes.js';
import { logReturns } from '../src/math/stats.js';
import { volatilityProfile } from '../src/market/realized_vol.js';
import { DEFAULT_LIMITS } from '../src/constitution/limits.js';
import {
  buildUnderwriteModelSet, evaluateShortOptionModel,
  UNDERWRITE_MODEL_DEFINITIONS, UNDERWRITE_PRIMARY_MODEL, UNDERWRITE_STRESS_MODEL,
} from './underwrite-model-engine.js';
import {
  calculateCashSecuredPutRows, CASH_SECURED_PUT_COSTS,
} from './cash-secured-put-calculator.js';

export const PORTFOLIO_REVIEW_DTE_TARGETS = Object.freeze([14, 30, 45]);
export const PORTFOLIO_REVIEW_VERSION = 'UNDERWRITE_U2_PORTFOLIO_REVIEW_V1';

const DAY_MS = 86_400_000;
const finite = (value) => value !== null && value !== undefined && value !== ''
  && Number.isFinite(Number(value)) ? Number(value) : null;

export function nearestListedDtes(contracts, targets = PORTFOLIO_REVIEW_DTE_TARGETS) {
  const listed = [...new Set((contracts ?? []).map((contract) => finite(contract?.dte))
    .filter((dte) => dte > 0))].sort((a, b) => a - b);
  const selected = [];
  for (const target of targets) {
    const dte = listed.slice().sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || a - b)[0];
    if (dte !== undefined && !selected.includes(dte)) selected.push(dte);
  }
  return selected.sort((a, b) => a - b);
}

export function contractsAtReviewTenors(contracts, targets = PORTFOLIO_REVIEW_DTE_TARGETS) {
  const selected = new Set(nearestListedDtes(contracts, targets));
  return (contracts ?? []).filter((contract) => selected.has(finite(contract?.dte)));
}

function eventsInsideTenor(events, now, dte) {
  const through = now + dte * DAY_MS;
  return (events ?? []).filter((event) => {
    const at = finite(event?.at);
    return at !== null && at >= now && at <= through;
  }).map((event) => ({ type: String(event?.type ?? 'EVENT'), at, source: event?.source ?? null }));
}

function quoteDiagnostics(contract, { intendedContracts = 1 } = {}) {
  const bid = finite(contract?.bid);
  const ask = finite(contract?.ask);
  const mid = bid !== null && ask !== null && ask >= bid ? (bid + ask) / 2 : null;
  const spreadPct = mid > 0 ? (ask - bid) / mid : null;
  const openInterest = finite(contract?.openInterest);
  const volume = finite(contract?.volume);
  const warnings = [];
  if (spreadPct === null) warnings.push('SPREAD_UNAVAILABLE');
  else if (spreadPct > DEFAULT_LIMITS.maxSpreadPctOfMid) warnings.push('SPREAD_ABOVE_8_PERCENT_OF_MID');
  if (openInterest === null) warnings.push('OPEN_INTEREST_UNAVAILABLE');
  else if (openInterest < DEFAULT_LIMITS.minOpenInterest) warnings.push('OPEN_INTEREST_BELOW_250');
  if (volume === null) warnings.push('VOLUME_UNAVAILABLE');
  else if (volume < DEFAULT_LIMITS.minDailyOptionVolume) warnings.push('VOLUME_BELOW_50');
  if (openInterest > 0 && intendedContracts / openInterest > DEFAULT_LIMITS.maxPositionPctOfOi) {
    warnings.push('SIZE_ABOVE_5_PERCENT_OF_OPEN_INTEREST');
  }
  return { bid, ask, mid, spreadPct, openInterest, volume, warnings };
}

function gammaMeasure(contract, spot) {
  const gamma = finite(contract?.gamma);
  if (gamma === null || !(spot > 0)) return {
    broker_gamma_per_share_per_dollar: gamma,
    position_gamma_per_dollar: null,
    dollar_gamma_for_one_percent_move: null,
    policy_effect: 'NOT_APPLIED_UNAVAILABLE',
  };
  const positionGamma = -gamma * 100;
  return {
    broker_gamma_per_share_per_dollar: gamma,
    position_gamma_per_dollar: positionGamma,
    dollar_gamma_for_one_percent_move: 0.5 * positionGamma * (0.01 * spot) ** 2,
    formula: '0.5 × SIGNED_POSITION_GAMMA × (0.01 × SPOT)^2',
    policy_effect: 'INFORMATIONAL_ONLY_GAMMA_PCT_NAV_DIMENSIONAL_LOCK_OPEN',
  };
}

function vrpMeasure(contract, forecastVol) {
  const iv = finite(contract?.iv);
  if (!(iv > 0) || !(forecastVol > 0)) return {
    status: 'UNAVAILABLE', ratio: null, spread: null, policy_effect: 'INFORMATIONAL_ONLY',
  };
  const ratio = iv / forecastVol;
  const spread = iv - forecastVol;
  return {
    status: ratio >= 1.10 && spread >= 0.02 && iv > forecastVol ? 'PASS' : 'VRP_FAIL',
    ratio, spread, strike_iv: iv, garch_dte_vol: forecastVol,
    thresholds: { minimum_ratio: 1.10, minimum_spread: 0.02, iv_above_garch: true },
    policy_effect: 'INFORMATIONAL_ONLY_THRESHOLDS_NOT_REGISTERED_AS_PRINCIPAL_LAW',
  };
}

function bookPolicyReasons(row, book) {
  if (!book?.complete) return ['POLICY_BOOK_UNAVAILABLE'];
  const reasons = [];
  if (row.structure === 'CSP') {
    if (book.deployed_pct > DEFAULT_LIMITS.maxDeployedPct) reasons.push('DEPLOYED_CAP_EXCEEDED');
    if (book.cash_reserve_pct < DEFAULT_LIMITS.minReservePct) reasons.push('CASH_RESERVE_BELOW_FLOOR');
    const existing = finite(book.underlying_exposure?.find((item) => item.symbol === row.underlying)?.market_value) ?? 0;
    const projected = (existing + row.gross_assignment_obligation) / book.nav;
    if (projected > DEFAULT_LIMITS.maxSingleUnderlyingPct) reasons.push('PROJECTED_UNDERLYING_CAP_EXCEEDED');
    if (row.net_tied_cash > Math.max(0, book.settled_cash)) reasons.push('SETTLED_CASH_INSUFFICIENT');
  }
  return reasons;
}

function rowPolicy(row, book) {
  const reasons = [];
  if (!(row.primary_raw_nev_0 > 0)) reasons.push('PRIMARY_RAW_NEV_NONPOSITIVE');
  if (row.warnings.includes('EVENT_IN_TENOR')) reasons.push('EVENT_BLACKOUT');
  if (row.warnings.some((warning) => [
    'SPREAD_UNAVAILABLE', 'SPREAD_ABOVE_8_PERCENT_OF_MID',
    'OPEN_INTEREST_UNAVAILABLE', 'OPEN_INTEREST_BELOW_250',
    'VOLUME_UNAVAILABLE', 'VOLUME_BELOW_50',
    'SIZE_ABOVE_5_PERCENT_OF_OPEN_INTEREST',
  ].includes(warning))) reasons.push('LIQUIDITY_POLICY_FAILED');
  reasons.push(...bookPolicyReasons(row, book));
  return {
    status: reasons.length ? 'POLICY_BLOCK' : 'POLICY_PASS',
    first_block: reasons[0] ?? null,
    reasons: [...new Set(reasons)],
    effect: 'VISIBLE_STAMP_ONLY_ROW_REMAINS_VISIBLE_NO_ORDER_ROUTE',
  };
}

function normalizeCspRow(row, book) {
  const primary = row.models?.[UNDERWRITE_PRIMARY_MODEL] ?? null;
  const quote = row.quote ?? {};
  const economics = row.one_contract_economics ?? {};
  const warnings = [...new Set(row.warnings ?? [])];
  const normalized = {
    underlying: row.symbol,
    structure: 'CSP',
    contract_symbol: row.contract,
    expiration: row.expiration,
    dte: row.dte,
    strike: row.strike,
    bid: quote.bid,
    ask: quote.ask,
    net_credit: economics.net_credit,
    gross_assignment_obligation: economics.gross_obligation,
    net_tied_cash: economics.net_tied_cash,
    assigned_basis: economics.assigned_basis,
    primary_model: UNDERWRITE_PRIMARY_MODEL,
    primary_raw_nev_0: primary?.raw_nev_0 ?? null,
    primary_standard_error: primary?.monte_carlo_standard_error ?? null,
    primary_p_finish_itm: primary?.p_finish_itm ?? null,
    model_time_to_expiry_years: row.market_math?.model_time_to_expiry_years ?? null,
    risk_free_rate: row.market_math?.risk_free_rate ?? null,
    model_scores: Object.fromEntries(Object.entries(row.models ?? {}).map(([name, value]) => [
      name, value ? { probability: value.p_finish_itm,
        raw_nev_0: value.raw_nev_0 } : null,
    ])),
    conditional_assignment_severity_per_share:
      primary?.conditional_assignment_severity_per_share ?? null,
    cvar_95: primary?.conditional_value_at_risk_95 ?? null,
    stress_raw_nev_0: row.models?.[UNDERWRITE_STRESS_MODEL]?.raw_nev_0 ?? null,
    garch_dte_vol: row.market_math?.expiry_level_forecast_vol ?? null,
    risk_neutral_finish_itm: row.market_math?.risk_neutral_finish_itm_european ?? null,
    vrp: vrpMeasure({ iv: quote.strike_iv }, row.market_math?.expiry_level_forecast_vol),
    gamma: gammaMeasure({ gamma: quote.gamma }, book?.spot_by_symbol?.[row.symbol]),
    warnings,
    model_status: primary ? 'MODELED_UNCALIBRATED' : 'PRIMARY_UNAVAILABLE',
    calibration_n: 0,
    rank_group: `CSP|${row.expiration}`,
  };
  normalized.policy = rowPolicy(normalized, book);
  return normalized;
}

function calculateCoveredCallReviewRows({
  symbol, spot, contracts, historyBars, events, now, freeContracts,
  rate, dividendYield, samples, seed, book,
}) {
  if (!(freeContracts >= 1)) return [];
  const bars = (historyBars ?? []).filter((bar) => [bar?.o, bar?.h, bar?.l, bar?.c]
    .every((value) => finite(value) > 0)).slice(-400);
  const returns = logReturns(bars.map((bar) => finite(bar.c)));
  const profile = bars.length >= 61 ? volatilityProfile(bars) : null;
  const modelCache = new Map();
  const modelsFor = (dte) => {
    if (!modelCache.has(dte)) {
      const forecastVol = profile?.garchOk ? finite(profile.garch?.forecast(dte)) : null;
      modelCache.set(dte, { forecastVol, models: buildUnderwriteModelSet({
        spot, dte, forecastVol, returns, samples, seed: `${seed}:${symbol}`,
      }) });
    }
    return modelCache.get(dte);
  };
  return contracts.filter((contract) => String(contract?.right ?? '').toLowerCase() === 'call'
    && finite(contract?.strike) > 0 && finite(contract?.dte) > 0 && finite(contract?.bid) !== null)
    .map((contract) => {
      const strike = finite(contract.strike);
      const dte = finite(contract.dte);
      const diagnostics = quoteDiagnostics(contract);
      const entryFee = CASH_SECURED_PUT_COSTS.commissionPerContract
        + CASH_SECURED_PUT_COSTS.exchangeFeePerContract;
      const netCredit = diagnostics.bid * 100 - entryFee;
      const t = dteToT(dte);
      const discount = Math.exp(-rate * t);
      const forecast = modelsFor(dte);
      const models = Object.fromEntries(Object.entries(forecast.models).map(([name, dist]) => [
        name, evaluateShortOptionModel(dist, {
          right: 'call', strike, netCredit, discount, capital: spot * 100,
        }),
      ]));
      const inside = eventsInsideTenor(events, now, dte);
      const warnings = [...diagnostics.warnings];
      if (inside.length) warnings.push('EVENT_IN_TENOR');
      warnings.push('JUMP_DIAGNOSTIC_UNCALIBRATED_POSSIBLE_DOUBLE_COUNT');
      const primary = models[UNDERWRITE_PRIMARY_MODEL];
      const riskNeutral = finite(contract.iv) > 0 ? probItm({
        type: 'call', spot, strike, vol: finite(contract.iv), t,
        rate, yield: dividendYield,
      }) : null;
      const row = {
        underlying: symbol,
        structure: 'COVERED_CALL',
        contract_symbol: contract.symbol ?? null,
        expiration: contract.expiration ?? null,
        dte,
        strike,
        bid: diagnostics.bid,
        ask: diagnostics.ask,
        net_credit: netCredit,
        gross_assignment_obligation: 0,
        net_tied_cash: 0,
        assigned_basis: null,
        primary_model: UNDERWRITE_PRIMARY_MODEL,
        primary_raw_nev_0: primary?.raw_nev_0 ?? null,
        primary_standard_error: primary?.monte_carlo_standard_error ?? null,
        primary_p_finish_itm: primary?.p_finish_itm ?? null,
        model_time_to_expiry_years: t,
        risk_free_rate: rate,
        model_scores: Object.fromEntries(Object.entries(models).map(([name, value]) => [
          name, value ? { probability: value.p_finish_itm,
            raw_nev_0: value.raw_nev_0 } : null,
        ])),
        conditional_assignment_severity_per_share:
          primary?.conditional_assignment_severity_per_share ?? null,
        cvar_95: primary?.conditional_value_at_risk_95 ?? null,
        stress_raw_nev_0: models[UNDERWRITE_STRESS_MODEL]?.raw_nev_0 ?? null,
        garch_dte_vol: forecast.forecastVol,
        risk_neutral_finish_itm: riskNeutral,
        vrp: vrpMeasure(contract, forecast.forecastVol),
        gamma: gammaMeasure(contract, spot),
        warnings: [...new Set(warnings)],
        model_status: primary ? 'MODELED_UNCALIBRATED' : 'PRIMARY_UNAVAILABLE',
        calibration_n: 0,
        available_contracts: freeContracts,
        rank_group: `COVERED_CALL|${contract.expiration}`,
      };
      row.policy = rowPolicy(row, book);
      return row;
    });
}

export function calculatePortfolioReviewSymbol({
  symbol, session = 'RTH', spot, contracts = [], historyBars = [], events = [],
  freeCoveredCallContracts = 0, structures = ['CSP', 'COVERED_CALL'],
  targets = PORTFOLIO_REVIEW_DTE_TARGETS, now = Date.now(), rate = DEFAULT_LIMITS.riskFreeRate,
  dividendYield = 0, samples = 8_000, seed = 'portfolio-review', book = null,
} = {}) {
  const ticker = String(symbol ?? '').trim().toUpperCase();
  if (session !== 'RTH') return {
    symbol: ticker, state: 'NOT_EVALUATED', stage: 'SESSION', rows: [],
    reason_codes: ['SESSION_NOT_RTH'], reasons: [`Market session is ${session || 'UNVERIFIED'}.`],
  };
  if (!ticker || !(finite(spot) > 0)) return {
    symbol: ticker || null, state: 'REFUSED', stage: 'QUOTE', rows: [],
    reason_codes: ['UNDERLYING_QUOTE_UNAVAILABLE'], reasons: ['A live underlying quote is required.'],
  };
  const usableBars = historyBars.filter((bar) => [bar?.o, bar?.h, bar?.l, bar?.c]
    .every((value) => finite(value) > 0)).slice(-400);
  if (usableBars.length < 121) return {
    symbol: ticker, state: 'REFUSED', stage: 'HISTORY', rows: [],
    reason_codes: ['HISTORY_SHORT'],
    reasons: [`${usableBars.length} usable bars supplied; 121 bars are required for 120 returns.`],
    history_sessions: usableBars.length,
  };
  const selectedContracts = contractsAtReviewTenors(contracts, targets);
  if (!selectedContracts.length) return {
    symbol: ticker, state: 'REFUSED', stage: 'OPTION_CHAIN', rows: [],
    reason_codes: ['LISTED_TENORS_UNAVAILABLE'], reasons: ['No listed expiration matched the 14 / 30 / 45 DTE review tenors.'],
  };
  const reviewBook = book ? { ...book, spot_by_symbol: { ...(book.spot_by_symbol ?? {}), [ticker]: finite(spot) } } : null;
  const rows = [];
  if (structures.includes('CSP')) {
    const csp = calculateCashSecuredPutRows({
      symbol: ticker, spot, contracts: selectedContracts, historyBars: usableBars,
      events, now, rate, dividendYield, samples, seed: `${seed}:csp`,
    });
    if (csp.ok) rows.push(...csp.rows.map((row) => normalizeCspRow(row, reviewBook)));
  }
  if (structures.includes('COVERED_CALL')) rows.push(...calculateCoveredCallReviewRows({
    symbol: ticker, spot: finite(spot), contracts: selectedContracts,
    historyBars: usableBars, events, now, freeContracts: freeCoveredCallContracts,
    rate, dividendYield, samples, seed: `${seed}:cc`, book: reviewBook,
  }));
  if (!rows.length) return {
    symbol: ticker, state: 'UNAVAILABLE', stage: 'CALCULATION', rows: [],
    reason_codes: ['NO_BID_BEARING_OPTION_ROWS'], reasons: ['No option row had the minimum inputs needed for executable-bid math.'],
    history_sessions: usableBars.length,
  };
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.rank_group)) grouped.set(row.rank_group, []);
    grouped.get(row.rank_group).push(row);
  }
  for (const group of grouped.values()) {
    group.sort((a, b) => (b.primary_raw_nev_0 ?? -Infinity) - (a.primary_raw_nev_0 ?? -Infinity)
      || b.strike - a.strike);
    group.forEach((row, index) => { row.rank_within_structure_and_expiry = index + 1; });
  }
  rows.sort((a, b) => a.structure.localeCompare(b.structure)
    || String(a.expiration).localeCompare(String(b.expiration))
    || a.rank_within_structure_and_expiry - b.rank_within_structure_and_expiry);
  const policyPassCount = rows.filter((row) => row.policy.status === 'POLICY_PASS').length;
  const policyBlockCount = rows.filter((row) => row.policy.status === 'POLICY_BLOCK').length;
  return {
    symbol: ticker,
    state: policyPassCount > 0 ? 'CALCULATED' : 'POLICY_BLOCK',
    stage: 'PORTFOLIO_REVIEW',
    rows,
    candidate_count: rows.length,
    policy_pass_count: policyPassCount,
    policy_block_count: policyBlockCount,
    reason_codes: [], reasons: [], history_sessions: usableBars.length,
  };
}

export function compilePortfolioReview({
  symbols = [], session = 'RTH', packets = {}, holdings = {}, structures = ['CSP', 'COVERED_CALL'],
  targets = PORTFOLIO_REVIEW_DTE_TARGETS, now = Date.now(), rate = DEFAULT_LIMITS.riskFreeRate,
  dividendYield = 0, samples = 8_000, seed = 'portfolio-review', book = null,
} = {}) {
  const perSymbol = symbols.map((symbol) => {
    const packet = packets[symbol] ?? {};
    if (packet.error) return {
      symbol, state: 'REFUSED', stage: packet.stage ?? 'DATA', rows: [],
      reason_codes: [packet.error_code ?? 'MARKET_DATA_UNAVAILABLE'],
      reasons: [String(packet.error)], candidate_count: 0,
      history_sessions: finite(packet.history_sessions),
    };
    return calculatePortfolioReviewSymbol({
      symbol, session, spot: packet.spot, contracts: packet.contracts,
      historyBars: packet.historyBars, events: packet.events,
      freeCoveredCallContracts: holdings[symbol]?.freeCoveredCallContracts ?? 0,
      structures, targets, now, rate, dividendYield, samples,
      seed: `${seed}:${symbol}`, book,
    });
  });
  const rows = perSymbol.flatMap((result) => result.rows ?? []);
  const calculated = perSymbol.filter((result) => ['CALCULATED', 'POLICY_BLOCK'].includes(result.state)).length;
  return {
    ok: calculated > 0,
    version: PORTFOLIO_REVIEW_VERSION,
    outcome: session !== 'RTH' ? 'NOT_EVALUATED'
      : calculated > 0 ? 'PORTFOLIO_REVIEW_COMPLETE' : 'PORTFOLIO_REVIEW_REFUSED',
    session,
    at: now,
    target_dtes: [...targets],
    rows,
    row_count: rows.length,
    per_symbol: perSymbol.map(({ rows: _rows, ...result }) => result),
    counts: {
      requested_symbols: symbols.length,
      calculated_symbols: calculated,
      refused_symbols: perSymbol.filter((result) => result.state === 'REFUSED').length,
      policy_block_symbols: perSymbol.filter((result) => result.state === 'POLICY_BLOCK').length,
      unavailable_symbols: perSymbol.filter((result) => result.state === 'UNAVAILABLE').length,
      not_evaluated_symbols: perSymbol.filter((result) => result.state === 'NOT_EVALUATED').length,
      policy_pass_rows: rows.filter((row) => row.policy.status === 'POLICY_PASS').length,
      policy_block_rows: rows.filter((row) => row.policy.status === 'POLICY_BLOCK').length,
    },
    ranking: 'WITHIN_SAME_STRUCTURE_AND_EXPIRY_BY_PRIMARY_RAW_NEV_0',
    primary_model: UNDERWRITE_PRIMARY_MODEL,
    models: UNDERWRITE_MODEL_DEFINITIONS,
    economics: {
      fill: 'EXECUTABLE_BID',
      csp: 'NET_CREDIT_MINUS_EXP_NEG_R_T_TIMES_EXPECTED_PUT_LIABILITY',
      covered_call: 'NET_CREDIT_MINUS_EXP_NEG_R_T_TIMES_EXPECTED_SURRENDERED_UPSIDE_VS_HOLD',
      kitchen_sink_penalties: 'REMOVED',
      collateral_hurdle_8_5_percent: 'REMOVED',
      max_of_models: 'REMOVED',
      weighted_mixture: 'REMOVED',
      unit: 'ONE_CONTRACT',
    },
    gamma_policy: 'NOT_APPLIED_GAMMA_PCT_NAV_DIMENSIONALLY_INVALID',
    calibration: { status: 'UNCALIBRATED', n: 0 },
    execution: 'READ_ONLY_PORTFOLIO_REVIEW_NO_ORDER_ROUTE',
    mutation_eligible: false,
  };
}
