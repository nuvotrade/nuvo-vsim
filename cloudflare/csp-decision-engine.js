import { DEFAULT_LIMITS } from '../src/constitution/limits.js';
import { contentHash } from '../src/execution/order.js';

export const CSP_DECISION_SCHEMA = 'nuvo.csp-decision/v1';
export const CSP_DECISION_ENGINE_VERSION = 'CSP_VERTICAL_SLICE_V1';
export const CSP_DECISION_OUTCOME = Object.freeze({
  SELL: 'SELL_CSP',
  HOLD: 'KEEP_CASH',
  ERROR: 'ERROR',
});

export const CSP_OPERATING_AUTHORITY = Object.freeze({
  mode: 'SUPERVISED_MANUAL',
  decision: 'DETERMINISTIC_ENGINE_ONLY',
  llm: 'ANALYZE_EXPLAIN_AND_ORCHESTRATE_ONLY',
  execution: 'PRINCIPAL_MANUAL_ORDER_ENTRY_ONLY',
});

export const CSP_DECISION_POLICY = Object.freeze({
  version: 'CSP_ENTRY_POLICY_PROVISIONAL_V1',
  targetDtes: Object.freeze([7, 14, 21]),
  minimumRoc: DEFAULT_LIMITS.minRoc,
  minimumAnnualizedRoc: DEFAULT_LIMITS.riskFreeRate + DEFAULT_LIMITS.cspRequiredExcessReturn,
  maximumSpreadPctOfMid: DEFAULT_LIMITS.maxSpreadPctOfMid,
  minimumOpenInterest: DEFAULT_LIMITS.minOpenInterest,
  minimumVolume: DEFAULT_LIMITS.minDailyOptionVolume,
  maximumPositionPctOfOpenInterest: DEFAULT_LIMITS.maxPositionPctOfOi,
  minimumReservePct: DEFAULT_LIMITS.minReservePct,
  maximumDeployedPct: DEFAULT_LIMITS.maxDeployedPct,
  maximumSingleUnderlyingPct: DEFAULT_LIMITS.maxSingleUnderlyingPct,
  maximumExpirationPct: DEFAULT_LIMITS.maxExpirationPct,
});

const finite = (value) => value !== null && value !== undefined && value !== ''
  && Number.isFinite(Number(value)) ? Number(value) : null;
const round = (value, digits = 2) => Number(Number(value).toFixed(digits));
const upper = (value) => String(value ?? '').trim().toUpperCase();

export function weeklyExpiryDteTargets(now = Date.now()) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) return [];
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short',
  }).format(date);
  const index = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
  if (index < 0) return [];
  const sameWeekFriday = (5 - index + 7) % 7;
  return [sameWeekFriday, sameWeekFriday + 7, sameWeekFriday + 14];
}

export function calculateAtmStraddleExpectedMoves({ spot, contracts = [] } = {}) {
  const underlying = finite(spot);
  if (!(underlying > 0)) return {};
  const expirations = [...new Set(contracts.map((contract) => contract?.expiration).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b)));
  return Object.fromEntries(expirations.flatMap((expiration) => {
    const rows = contracts.filter((contract) => contract?.expiration === expiration);
    const strikes = [...new Set(rows.map((contract) => finite(contract?.strike)).filter((strike) => strike > 0))]
      .sort((a, b) => Math.abs(a - underlying) - Math.abs(b - underlying) || a - b);
    for (const strike of strikes) {
      const call = rows.find((contract) => finite(contract?.strike) === strike
        && String(contract?.right ?? '').toLowerCase() === 'call');
      const put = rows.find((contract) => finite(contract?.strike) === strike
        && String(contract?.right ?? '').toLowerCase() === 'put');
      const callBid = finite(call?.bid); const callAsk = finite(call?.ask);
      const putBid = finite(put?.bid); const putAsk = finite(put?.ask);
      if (!(callBid >= 0) || !(callAsk >= callBid) || !(putBid >= 0) || !(putAsk >= putBid)) continue;
      const callMid = (callBid + callAsk) / 2;
      const putMid = (putBid + putAsk) / 2;
      const expectedMove = callMid + putMid;
      return [[expiration, {
        expiration,
        dte: finite(call?.dte ?? put?.dte),
        atm_strike: strike,
        atm_call_mid: round(callMid, 4),
        atm_put_mid: round(putMid, 4),
        expected_move: round(expectedMove, 4),
        lower_boundary: round(underlying - expectedMove, 4),
        upper_boundary: round(underlying + expectedMove, 4),
        formula: 'ATM_CALL_MID_PLUS_ATM_PUT_MID',
      }]];
    }
    return [];
  }));
}

function baseDecision({ symbol, inputFingerprint, source, asof, accountAsOf, policy }) {
  return {
    schema: CSP_DECISION_SCHEMA,
    engine_version: CSP_DECISION_ENGINE_VERSION,
    policy_version: policy.version,
    decision_id: `CSP-${inputFingerprint.slice(0, 16)}`,
    input_fingerprint: inputFingerprint,
    wheel_stage: 'CASH_TO_CSP',
    symbol,
    evaluated_dtes: [...policy.targetDtes],
    source,
    asof,
    account_asof: accountAsOf,
    mutation_eligible: false,
    authority: CSP_OPERATING_AUTHORITY,
  };
}

function errorDecision(base, code, message) {
  return {
    ...base,
    ok: false,
    outcome: CSP_DECISION_OUTCOME.ERROR,
    primary_blocker: { code, message },
    reason: message,
    action: { type: 'NONE', label: 'ERROR · DO NOT TRADE' },
  };
}

function holdDecision(base, code, message, detail = null) {
  return {
    ...base,
    ok: true,
    outcome: CSP_DECISION_OUTCOME.HOLD,
    primary_blocker: { code, message, ...(detail ? { detail } : {}) },
    reason: message,
    action: { type: 'NO_TRADE', label: 'KEEP CASH / NO TRADE' },
  };
}

function underlyingOf(position) {
  return upper(position?.underlying ?? position?.symbol);
}

function relatedOpenOrders(openOrders, symbol) {
  return (openOrders ?? []).filter((order) => {
    const orderSymbol = upper(order?.underlying ?? order?.underlyingSymbol ?? order?.symbol)
      .replaceAll(' ', '');
    return !orderSymbol || orderSymbol === symbol || orderSymbol.startsWith(symbol);
  });
}

function wheelBlocker(positions, symbol) {
  const held = (positions ?? []).filter((position) => underlyingOf(position) === symbol
    && finite(position?.quantity) !== 0);
  const shortPut = held.find((position) => upper(position?.type) === 'OPTION'
    && String(position?.right ?? '').toLowerCase().startsWith('p')
    && finite(position.quantity) < 0);
  if (shortPut) return {
    code: 'WHEEL/CSP_ALREADY_OPEN',
    message: `${symbol} already has an open short put. Manage that CSP before opening another wheel entry.`,
  };
  const shares = held.find((position) => upper(position?.type) === 'EQUITY'
    && finite(position.quantity) > 0);
  if (shares) return {
    code: 'WHEEL/SHARES_OWNED',
    message: `${symbol} is already in the shares stage. Run the covered-call workflow instead of adding a CSP.`,
  };
  return null;
}

function existingCommitment(positions) {
  return (positions ?? []).reduce((sum, position) => {
    const quantity = finite(position?.quantity);
    if (quantity === null || quantity === 0) return sum;
    if (upper(position?.type) === 'OPTION' && quantity < 0
      && String(position?.right ?? '').toLowerCase().startsWith('p')) {
      const strike = finite(position?.strike);
      const multiplier = finite(position?.multiplier) ?? 100;
      return sum + (strike === null ? 0 : strike * multiplier * Math.abs(quantity));
    }
    if (upper(position?.type) === 'EQUITY') {
      const marketValue = finite(position?.marketValue);
      return sum + (marketValue === null ? 0 : Math.abs(marketValue));
    }
    return sum;
  }, 0);
}

function existingUnderlyingCommitment(positions, symbol) {
  return existingCommitment((positions ?? []).filter((position) => underlyingOf(position) === symbol));
}

function existingExpirationCommitment(positions, expiration) {
  return existingCommitment((positions ?? []).filter((position) =>
    String(position?.expiration ?? '') === String(expiration ?? '')));
}

function accountCapacity({ account, positions, row, policy }) {
  const nav = finite(account?.nav);
  const cash = finite(account?.cash);
  const withdrawableCash = finite(account?.withdrawableCash ?? account?.withdrawable_cash);
  if (!(nav > 0) || cash === null) return { contracts: 0, error: 'ACCOUNT_BALANCES_UNAVAILABLE' };
  const unborrowedCash = Math.max(0, withdrawableCash === null ? cash : Math.min(cash, withdrawableCash));
  const reserve = nav * policy.minimumReservePct;
  const cashCapacity = Math.max(0, unborrowedCash - reserve);
  const deployedCapacity = Math.max(0, nav * policy.maximumDeployedPct - existingCommitment(positions));
  const underlyingCapacity = Math.max(0, nav * policy.maximumSingleUnderlyingPct
    - existingUnderlyingCommitment(positions, row.symbol));
  const expirationCapacity = Math.max(0, nav * policy.maximumExpirationPct
    - existingExpirationCommitment(positions, row.expiration));
  const perContract = finite(row?.one_contract_economics?.net_tied_cash);
  const openInterest = finite(row?.quote?.open_interest);
  if (!(perContract > 0)) return { contracts: 0, error: 'CONTRACT_COLLATERAL_UNAVAILABLE' };
  const capitalContracts = Math.floor(Math.min(
    cashCapacity, deployedCapacity, underlyingCapacity, expirationCapacity,
  ) / perContract);
  const liquidityContracts = openInterest === null ? 0
    : Math.floor(openInterest * policy.maximumPositionPctOfOpenInterest);
  return {
    contracts: Math.max(0, Math.min(capitalContracts, liquidityContracts)),
    unborrowed_cash: round(unborrowedCash),
    required_reserve: round(reserve),
    deployable_cash: round(cashCapacity),
    net_tied_cash_per_contract: round(perContract),
  };
}

function assessRow(row, context) {
  const { calculation, account, positions, policy } = context;
  const spot = finite(calculation?.spot);
  const dte = finite(row?.dte);
  const strike = finite(row?.strike);
  const bid = finite(row?.quote?.bid);
  const ask = finite(row?.quote?.ask);
  const mid = bid !== null && ask !== null && ask >= bid ? (bid + ask) / 2 : null;
  const spreadPct = mid > 0 ? (ask - bid) / mid : null;
  const iv = finite(row?.quote?.strike_iv);
  const openInterest = finite(row?.quote?.open_interest);
  const volume = finite(row?.quote?.volume);
  const netCredit = finite(row?.one_contract_economics?.net_credit);
  const tiedCash = finite(row?.one_contract_economics?.net_tied_cash);
  const roc = netCredit !== null && tiedCash > 0 ? netCredit / tiedCash : null;
  const annualizedRoc = roc !== null && dte > 0 ? roc * 365 / dte : null;
  const expectedMoveTruth = calculation?.expected_moves?.[row?.expiration] ?? null;
  const expectedMove = finite(expectedMoveTruth?.expected_move);
  const expectedMoveFloor = finite(expectedMoveTruth?.lower_boundary);
  const outsideExpectedMove = expectedMoveFloor !== null && strike < expectedMoveFloor;
  const primaryNev = finite(row?.headline_models?.primary_nev);
  const modelFinishItm = finite(row?.models?.bootstrap?.p_finish_itm);
  const blockers = [];
  if (!(bid > 0) || ask === null || ask < bid) blockers.push('EXECUTABLE_MARKET_UNAVAILABLE');
  if (spreadPct === null || spreadPct > policy.maximumSpreadPctOfMid) blockers.push('LIQUIDITY/SPREAD');
  if (openInterest === null || openInterest < policy.minimumOpenInterest) blockers.push('LIQUIDITY/OPEN_INTEREST');
  if (volume === null || volume < policy.minimumVolume) blockers.push('LIQUIDITY/VOLUME');
  if ((row?.events_in_tenor ?? []).length > 0) blockers.push('EVENT_IN_TENOR');
  if (expectedMove === null) blockers.push('EXPECTED_MOVE_UNAVAILABLE');
  else if (!outsideExpectedMove) blockers.push('STRIKE_INSIDE_EXPECTED_MOVE');
  if (roc === null) blockers.push('ROC_UNAVAILABLE');
  else if (roc < policy.minimumRoc || annualizedRoc < policy.minimumAnnualizedRoc) {
    blockers.push('ROC_BELOW_HURDLE');
  }
  if (primaryNev === null) blockers.push('PRIMARY_MODEL_UNAVAILABLE');
  else if (!(primaryNev > 0)) blockers.push('PRIMARY_NEV_NONPOSITIVE');
  const capacity = accountCapacity({ account, positions, row, policy });
  if (capacity.error) blockers.push(capacity.error);
  else if (capacity.contracts < 1) blockers.push('CASH_OR_RISK_CAPACITY_INSUFFICIENT');
  return {
    row,
    blockers,
    gatesPassed: 10 - blockers.length,
    capacity,
    metrics: {
      spot, dte, strike, bid, ask, spreadPct, iv, openInterest, volume,
      netCredit, tiedCash, roc, annualizedRoc, expectedMove,
      expectedMoveFloor, expectedMoveTruth, outsideExpectedMove, primaryNev,
      modelFinishItm,
      nevCapital: primaryNev !== null && tiedCash > 0 ? primaryNev / tiedCash : null,
      nevEfficiencyPerDay: primaryNev !== null && tiedCash > 0 && dte > 0
        ? primaryNev / tiedCash / dte : null,
    },
  };
}

function compareAssessments(a, b) {
  if (a.blockers.length !== b.blockers.length) return a.blockers.length - b.blockers.length;
  if (a.metrics.strike !== b.metrics.strike) return b.metrics.strike - a.metrics.strike;
  const efficiency = (b.metrics.nevEfficiencyPerDay ?? -Infinity)
    - (a.metrics.nevEfficiencyPerDay ?? -Infinity);
  if (efficiency !== 0) return efficiency;
  const roc = (b.metrics.annualizedRoc ?? -Infinity) - (a.metrics.annualizedRoc ?? -Infinity);
  if (roc !== 0) return roc;
  const outsideA = a.metrics.expectedMoveFloor === null ? -Infinity
    : a.metrics.expectedMoveFloor - a.metrics.strike;
  const outsideB = b.metrics.expectedMoveFloor === null ? -Infinity
    : b.metrics.expectedMoveFloor - b.metrics.strike;
  if (outsideB !== outsideA) return outsideB - outsideA;
  if (a.metrics.spreadPct !== b.metrics.spreadPct) {
    return (a.metrics.spreadPct ?? Infinity) - (b.metrics.spreadPct ?? Infinity);
  }
  if (a.metrics.openInterest !== b.metrics.openInterest) {
    return (b.metrics.openInterest ?? -Infinity) - (a.metrics.openInterest ?? -Infinity);
  }
  if (a.metrics.volume !== b.metrics.volume) {
    return (b.metrics.volume ?? -Infinity) - (a.metrics.volume ?? -Infinity);
  }
  if (a.metrics.dte !== b.metrics.dte) return a.metrics.dte - b.metrics.dte;
  return String(a.row.contract ?? '').localeCompare(String(b.row.contract ?? ''));
}

const BLOCKER_COPY = Object.freeze({
  LISTED_EXPIRY_UNAVAILABLE: 'No listed weekly expiration was returned for this slot.',
  EXECUTABLE_MARKET_UNAVAILABLE: 'The best available contract does not have a valid executable bid and ask.',
  'LIQUIDITY/SPREAD': 'The best available contract has a bid/ask spread above the liquidity limit.',
  'LIQUIDITY/OPEN_INTEREST': 'The best available contract has insufficient open interest.',
  'LIQUIDITY/VOLUME': 'The best available contract has insufficient daily option volume.',
  EVENT_IN_TENOR: 'A known event occurs before expiration.',
  EXPECTED_MOVE_UNAVAILABLE: 'The market-maker expected move cannot be established from a verified live ATM call-and-put straddle.',
  STRIKE_INSIDE_EXPECTED_MOVE: 'No eligible strike is below the market-maker expected-move floor.',
  ROC_UNAVAILABLE: 'Return on secured cash cannot be calculated.',
  ROC_BELOW_HURDLE: 'The premium return does not justify tying up the secured cash.',
  PRIMARY_MODEL_UNAVAILABLE: 'The provisional primary risk model cannot evaluate the contract.',
  PRIMARY_NEV_NONPOSITIVE: 'The provisional primary model does not show positive value after option liability.',
  ACCOUNT_BALANCES_UNAVAILABLE: 'Verified NAV and unborrowed cash are unavailable.',
  CONTRACT_COLLATERAL_UNAVAILABLE: 'The exact secured-cash requirement cannot be calculated.',
  CASH_OR_RISK_CAPACITY_INSUFFICIENT: 'Available unborrowed cash or a constitutional risk cap permits zero contracts.',
});

const WEEK_SLOTS = Object.freeze([
  Object.freeze({ index: 0, key: 'THIS_WEEK', label: 'This week' }),
  Object.freeze({ index: 1, key: 'NEXT_WEEK', label: 'Next week' }),
  Object.freeze({ index: 2, key: 'WEEK_AFTER', label: 'Week after' }),
]);

const SELECTION_RULE = 'WITHIN_EXPIRY_PASS_ALL_GATES_THEN_HIGHEST_STRIKE_OUTSIDE_EXPECTED_MOVE_THEN_HIGHEST_PRIMARY_NEV_PER_CAPITAL_PER_DAY_THEN_HIGHEST_ROC_PER_DAY_THEN_GREATER_EXPECTED_MOVE_BUFFER_THEN_BETTER_LIQUIDITY_THEN_CONTRACT_SYMBOL';

function holdChoice(slot, code, message, detail = null) {
  return {
    slot: slot.key,
    slot_label: slot.label,
    outcome: CSP_DECISION_OUTCOME.HOLD,
    primary_blocker: { code: `POLICY/${code}`, message, ...(detail ? { detail } : {}) },
    reason: `Keep cash for ${slot.label.toLowerCase()}. ${message}`,
    action: { type: 'NO_TRADE', label: 'KEEP CASH / NO TRADE' },
  };
}

function sellChoice(slot, selected, candidateCount, policy) {
  const { row, metrics, capacity } = selected;
  const quantity = capacity.contracts;
  const collateral = round(metrics.tiedCash * quantity);
  const totalNetCredit = round(metrics.netCredit * quantity);
  const contract = row.contract;
  const reason = `${slot.label}: sell ${quantity} ${row.symbol} ${row.expiration} $${round(metrics.strike)} put at a $${round(metrics.bid)} limit. `
    + `It passed every gate and ranked first of ${candidateCount}: the strike is $${round(metrics.expectedMoveFloor - metrics.strike)} below the $${round(metrics.expectedMoveFloor)} expected-move floor, `
    + `and ${(metrics.roc * 100).toFixed(2)}% ROC (${(metrics.annualizedRoc * 100).toFixed(1)}% simple annualized) clears both return hurdles.`;
  return {
    slot: slot.key,
    slot_label: slot.label,
    outcome: CSP_DECISION_OUTCOME.SELL,
    primary_blocker: null,
    reason,
    recommendation: {
      strategy: 'CASH_SECURED_PUT',
      contract,
      underlying: row.symbol,
      expiration: row.expiration,
      dte: metrics.dte,
      strike: round(metrics.strike),
      quantity,
      limit_credit_per_share: round(metrics.bid),
      estimated_net_credit: totalNetCredit,
      secured_cash: collateral,
      assigned_basis_per_share: round(row.one_contract_economics.assigned_basis, 4),
    },
    mathematical_proof: {
      selection_rule: SELECTION_RULE,
      candidates_evaluated_in_expiry: candidateCount,
      eligible_candidates_in_expiry: 1,
      selected_rank: 1,
      gates: {
        executable_market: { passed: true, bid: round(metrics.bid), ask: round(metrics.ask) },
        spread: { passed: true, actual: round(metrics.spreadPct, 6), maximum: policy.maximumSpreadPctOfMid },
        open_interest: { passed: true, actual: metrics.openInterest, minimum: policy.minimumOpenInterest },
        volume: { passed: true, actual: metrics.volume, minimum: policy.minimumVolume },
        event_clear: { passed: true },
        expected_move: {
          passed: true,
          formula: 'ATM_CALL_MID + ATM_PUT_MID',
          spot: round(metrics.spot),
          atm_strike: metrics.expectedMoveTruth?.atm_strike ?? null,
          atm_call_mid: metrics.expectedMoveTruth?.atm_call_mid ?? null,
          atm_put_mid: metrics.expectedMoveTruth?.atm_put_mid ?? null,
          expected_move: round(metrics.expectedMove),
          expected_move_floor: round(metrics.expectedMoveFloor),
          strike: round(metrics.strike),
          dollars_outside_floor: round(metrics.expectedMoveFloor - metrics.strike),
        },
        roc: {
          passed: true,
          formula: 'NET_CREDIT / NET_TIED_CASH',
          actual: round(metrics.roc, 6),
          minimum: policy.minimumRoc,
          simple_annualized_actual: round(metrics.annualizedRoc, 6),
          simple_annualized_minimum: policy.minimumAnnualizedRoc,
        },
        primary_nev: { passed: true, per_contract: round(metrics.primaryNev), minimum_exclusive: 0 },
        model_finish_probability: {
          label: 'PROVISIONAL_PHYSICAL_TERMINAL_PROBABILITY_NOT_ASSIGNMENT_CERTAINTY',
          finish_otm: metrics.modelFinishItm === null ? null : round(1 - metrics.modelFinishItm, 6),
          finish_itm: metrics.modelFinishItm === null ? null : round(metrics.modelFinishItm, 6),
        },
        risk_adjusted_economic_efficiency: {
          passed: metrics.nevEfficiencyPerDay > 0,
          formula: 'PRIMARY_NEV / NET_TIED_CASH / DTE',
          nev_per_capital: round(metrics.nevCapital, 8),
          nev_per_capital_per_day: round(metrics.nevEfficiencyPerDay, 10),
        },
        account_capacity: { passed: true, contracts: quantity, ...capacity },
      },
      interpretation: 'DETERMINISTIC_SELECTION_CERTAINTY_NOT_PROFIT_CERTAINTY',
    },
    action: {
      type: 'REVIEW_ORDER_TICKET',
      label: `SELL TO OPEN ${quantity} ${contract} @ $${round(metrics.bid)} LIMIT`,
      order: {
        instruction: 'SELL_TO_OPEN',
        quantity,
        contract,
        order_type: 'LIMIT',
        limit_price: round(metrics.bid),
        time_in_force: 'DAY',
      },
      transmission: 'HUMAN_REVIEW_REQUIRED_NO_ORDER_ROUTE',
    },
  };
}

function choicesForAssessments(assessments, policy) {
  const expirations = [...new Set(assessments.map((assessment) => assessment.row.expiration)
    .filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b))).slice(0, 3);
  return WEEK_SLOTS.map((slot) => {
    const expiration = expirations[slot.index];
    if (!expiration) return holdChoice(slot, 'LISTED_EXPIRY_UNAVAILABLE',
      BLOCKER_COPY.LISTED_EXPIRY_UNAVAILABLE, { candidates_evaluated_in_expiry: 0 });
    const expiryAssessments = assessments.filter((assessment) => assessment.row.expiration === expiration)
      .sort(compareAssessments);
    const selected = expiryAssessments.find((assessment) => assessment.blockers.length === 0);
    if (selected) {
      const choice = sellChoice(slot, selected, expiryAssessments.length, policy);
      choice.mathematical_proof.eligible_candidates_in_expiry = expiryAssessments
        .filter((assessment) => assessment.blockers.length === 0).length;
      return choice;
    }
    const best = expiryAssessments[0];
    const code = best?.blockers?.[0] ?? 'NO_ELIGIBLE_CONTRACT';
    const message = BLOCKER_COPY[code] ?? 'No contract passed every deterministic CSP gate.';
    return holdChoice(slot, code, message, best ? {
      expiration,
      closest_contract: best.row.contract ?? null,
      dte: best.metrics.dte,
      strike: best.metrics.strike,
      expected_move_floor: best.metrics.expectedMoveFloor === null
        ? null : round(best.metrics.expectedMoveFloor),
      roc: best.metrics.roc === null ? null : round(best.metrics.roc, 6),
      annualized_roc: best.metrics.annualizedRoc === null
        ? null : round(best.metrics.annualizedRoc, 6),
      candidates_evaluated_in_expiry: expiryAssessments.length,
      selection_rule: SELECTION_RULE,
    } : { expiration, candidates_evaluated_in_expiry: 0, selection_rule: SELECTION_RULE });
  });
}

export function buildCashSecuredPutDecision({
  symbol: rawSymbol,
  calculation,
  account = null,
  positions = [],
  openOrders = [],
  accountAsOf = null,
  accountHash = null,
  controls = {},
  reconciliation = null,
  marketSession = null,
  marketSessionError = null,
  source = null,
  asof = null,
  now = null,
  maxAccountAgeMs = DEFAULT_LIMITS.maxAccountAgeMs,
  maxChainAgeMs = DEFAULT_LIMITS.maxChainAgeMs,
  policy = CSP_DECISION_POLICY,
} = {}) {
  const symbol = upper(rawSymbol ?? calculation?.symbol);
  const fingerprintInput = {
    symbol, calculation, account, positions, openOrders, accountAsOf, accountHash,
    controls, reconciliation, marketSession, marketSessionError, source, asof,
    maxAccountAgeMs, maxChainAgeMs, policy,
  };
  const fingerprint = contentHash(fingerprintInput);
  const base = baseDecision({ symbol: symbol || null, inputFingerprint: fingerprint,
    source, asof, accountAsOf, policy });
  if (!/^[A-Z][A-Z0-9.]{0,9}$/u.test(symbol)) {
    return errorDecision(base, 'TRUTH/SYMBOL_INVALID', 'A valid ticker is required.');
  }
  if (marketSessionError) return errorDecision(base, 'TRUTH/MARKET_SESSION_UNAVAILABLE',
    'Market-session truth could not be established.');
  const session = upper(marketSession);
  if (!session) return errorDecision(base, 'TRUTH/MARKET_SESSION_UNAVAILABLE',
    'Market-session truth could not be established.');
  if (!['OPEN', 'RTH'].includes(session)) return holdDecision(base, 'TRUTH/MARKET_NOT_OPEN',
    `Keep cash. The market session is ${session}; evaluate CSP entries during regular trading hours.`);
  if (!calculation?.ok || !Array.isArray(calculation?.rows) || calculation.rows.length === 0) {
    return errorDecision(base, `TRUTH/${calculation?.reason_code ?? 'CSP_CALCULATION_UNAVAILABLE'}`,
      'Fresh option truth or required calculation inputs are unavailable.');
  }
  const nowMs = finite(now);
  const chainMs = finite(asof) ?? Date.parse(String(asof ?? ''));
  const accountMs = finite(accountAsOf) ?? Date.parse(String(accountAsOf ?? ''));
  if (!Number.isFinite(chainMs) || !Number.isFinite(accountMs)) {
    return errorDecision(base, 'TRUTH/SNAPSHOT_TIME_UNAVAILABLE',
      'The market and account snapshots do not have verifiable timestamps.');
  }
  if (nowMs !== null && (nowMs - chainMs > maxChainAgeMs || chainMs - nowMs > 10_000)) {
    return errorDecision(base, 'TRUTH/OPTION_CHAIN_STALE', 'The option-chain snapshot is stale or future-dated.');
  }
  if (nowMs !== null && (nowMs - accountMs > maxAccountAgeMs || accountMs - nowMs > 10_000)) {
    return errorDecision(base, 'TRUTH/ACCOUNT_SNAPSHOT_STALE', 'The account snapshot is stale or future-dated.');
  }
  if (!account || !(finite(account.nav) > 0) || finite(account.cash) === null) {
    return errorDecision(base, 'TRUTH/ACCOUNT_BALANCES_UNAVAILABLE',
      'Verified NAV and unborrowed cash are required before sizing a CSP.');
  }
  if (reconciliation !== 'CAPTURED') return errorDecision(base,
    `TRUTH/RECONCILIATION_${upper(reconciliation || 'MISSING')}`,
    'Current Schwab custody does not match the canonical reconciliation checkpoint.');
  if (controls?.independentKill) return holdDecision(base, 'CONSTITUTION/INDEPENDENT_KILL_SWITCH',
    'Keep cash. The independent safety switch is active.');
  if (controls?.globalPause) return holdDecision(base, 'CONSTITUTION/GLOBAL_PAUSE',
    'Keep cash. New-trade evaluation is paused.');
  const wheel = wheelBlocker(positions, symbol);
  if (wheel) return holdDecision(base, wheel.code, wheel.message);
  const orders = relatedOpenOrders(openOrders, symbol);
  if (orders.length) return holdDecision(base, 'CUSTODY/OPEN_ORDERS_PRESENT',
    'Keep cash. A working broker order may already encumber this ticker.',
    { related_order_count: orders.length });

  const assessments = calculation.rows.map((row) => assessRow(row, {
    calculation, account, positions, policy,
  })).sort(compareAssessments);
  const choices = choicesForAssessments(assessments, policy);
  const sellCount = choices.filter((choice) => choice.outcome === CSP_DECISION_OUTCOME.SELL).length;
  const primaryBlocker = choices.find((choice) => choice.primary_blocker)?.primary_blocker ?? null;
  return {
    ...base,
    ok: true,
    outcome: sellCount > 0 ? CSP_DECISION_OUTCOME.SELL : CSP_DECISION_OUTCOME.HOLD,
    primary_blocker: sellCount > 0 ? null : primaryBlocker,
    reason: sellCount > 0
      ? `${sellCount} of 3 weekly CSP slots ${sellCount === 1 ? 'has' : 'have'} a deterministic sell candidate. Choose the expiry you want; each slot contains only its top-ranked contract.`
      : 'Keep cash. None of the three weekly expiry slots passed every deterministic gate.',
    choices,
    action: {
      type: sellCount > 0 ? 'CHOOSE_ONE_WEEKLY_CSP' : 'NO_TRADE',
      label: sellCount > 0 ? 'CHOOSE ONE OF 3 WEEKLY CSP RESULTS' : 'KEEP CASH / NO TRADE',
    },
    evaluated_contract_count: assessments.length,
    selection_rule: SELECTION_RULE,
  };
}

export function cspDecisionAlertText(decision) {
  if (Array.isArray(decision?.choices)) {
    return decision.choices.map((choice) => choice.outcome === CSP_DECISION_OUTCOME.SELL
      ? `${choice.slot_label}: ${choice.action.label}`
      : `${choice.slot_label}: KEEP CASH · ${choice.primary_blocker?.code ?? 'NO_TRADE'}`).join('\n');
  }
  if (decision?.outcome === CSP_DECISION_OUTCOME.HOLD) {
    return `KEEP CASH / NO TRADE · ${decision.symbol ?? 'UNKNOWN'} · ${decision.reason}`;
  }
  return `ERROR · ${decision?.symbol ?? 'UNKNOWN'} · ${decision?.reason ?? 'Decision truth unavailable.'}`;
}
