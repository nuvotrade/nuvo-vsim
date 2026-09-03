import { DEFAULT_LIMITS } from '../src/constitution/limits.js';
import { normInv } from '../src/math/stats.js';

export const POSITION_MANAGEMENT_DECISION_VERSION = 'position-management-v1';
export const POSITION_MANAGEMENT_CONFIDENCE_Z = 1.96;

const SAFE_NO_CHANGE_CODES = new Set([
  'TRUTH/SESSION_NOT_RTH',
  'TRUTH/ROLL_CHAIN_UNAVAILABLE',
  'TRUTH/FORECAST_HISTORY_UNAVAILABLE',
  'FORECAST/HISTORY_OR_GARCH_UNAVAILABLE',
  'CUSTODY/ORDER_IN_FLIGHT',
]);

const finite = (value) => value !== null && value !== undefined && value !== ''
  && Number.isFinite(Number(value)) ? Number(value) : null;

const money = (value) => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
const moneyText = (value) => Number.isFinite(value) ? money(value).toFixed(2) : 'UNAVAILABLE';

function baseDecision(comparison, lifecycle) {
  return {
    engine_version: POSITION_MANAGEMENT_DECISION_VERSION,
    wheel_stage: 'MANAGE_COVERED_CALL',
    ticker: comparison?.underlying ?? lifecycle?.underlying ?? null,
    option_symbol: comparison?.current_option_symbol ?? lifecycle?.symbol ?? null,
    contracts: finite(comparison?.contracts ?? lifecycle?.contracts),
    covered_shares: finite(comparison?.covered_shares ?? lifecycle?.covered_shares),
    market_timestamp: comparison?.valuation_at ?? lifecycle?.quote?.asof ?? null,
    authority: 'PROPOSAL_ONLY_MANUAL_EXECUTION',
    mutation_eligible: false,
  };
}

function noChange(comparison, lifecycle, blocker, reason) {
  const base = baseDecision(comparison, lifecycle);
  return {
    ...base,
    outcome: 'NO_ORDER',
    decision: 'HOLD',
    action_required: false,
    primary_blocker: blocker,
    operator_action: `HOLD ${base.contracts ?? 'the'} short call contract(s). Place no order.`,
    reason,
    order: null,
    proof: {
      current_strike: finite(lifecycle?.strike),
      current_expiration: lifecycle?.expiration ?? null,
      dte: finite(lifecycle?.dte),
      spot: finite(lifecycle?.spot),
      share_basis: finite(lifecycle?.share_basis),
      assignment_pnl: finite(lifecycle?.paths?.assignment?.pnl),
      close_outlay: finite(lifecycle?.current_trade?.total_close_outlay),
      locked_option_pnl_if_closed: finite(
        lifecycle?.current_trade?.profit_locked_if_call_closed_now,
      ),
    },
  };
}

function errorDecision(comparison, lifecycle, blocker, reason) {
  return {
    ...baseDecision(comparison, lifecycle),
    outcome: 'ERROR',
    decision: 'ERROR',
    action_required: false,
    primary_blocker: blocker,
    operator_action: 'DO NOT PLACE OR CHANGE AN ORDER.',
    reason,
    order: null,
    proof: null,
  };
}

function rollIsAdmissible(row, comparison, limits) {
  const bid = finite(row?.executable_bid_per_share);
  const ask = finite(row?.executable_ask_per_share);
  const strike = finite(row?.strike);
  const dte = finite(row?.dte);
  const basis = finite(comparison?.share_basis);
  const spot = finite(comparison?.spot);
  const openInterest = finite(row?.open_interest);
  const volume = finite(row?.volume);
  const spreadPct = finite(row?.spread_pct);
  const contracts = finite(comparison?.contracts);
  if ([bid, ask, strike, dte, basis, spot, openInterest, volume, spreadPct, contracts]
    .some((value) => value === null)) return false;
  return bid > 0 && ask >= bid && strike > basis && strike > spot
    && dte >= limits.minDte && dte <= limits.maxDte
    && spreadPct <= limits.maxSpreadPctOfMid
    && openInterest >= limits.minOpenInterest
    && volume >= limits.minDailyOptionVolume
    && contracts / openInterest <= limits.maxPositionPctOfOi
    && !(row?.events_in_tenor ?? []).length;
}

/**
 * Turn the exhaustive read-only lifecycle calculation into one operator action.
 *
 * The calculation remains the evidence layer. This policy may select only a
 * CLOSE or a liquid, above-basis ROLL whose lower 95% Monte Carlo confidence
 * bound beats HOLD. If no adjustment clears that proof, HOLD is the decision.
 */
export function buildCoveredCallPositionDecision({
  comparison,
  lifecycle,
  limits = DEFAULT_LIMITS,
  confidenceZ = null,
} = {}) {
  if (!lifecycle?.ok) return errorDecision(
    comparison, lifecycle,
    lifecycle?.error ?? 'TRUTH/LIFECYCLE_INPUT_UNAVAILABLE',
    'Current position economics could not be established from custody, entry evidence, and executable quotes.',
  );
  if (lifecycle?.classification?.current !== true) return errorDecision(
    comparison, lifecycle,
    'TRUTH/EXECUTABLE_QUOTES_NOT_CURRENT',
    'A current executable option quote is required before changing an open position.',
  );

  const flags = new Set((lifecycle.classification?.flags ?? []).map((flag) => flag.code));
  const assignmentPnl = finite(lifecycle?.paths?.assignment?.pnl);
  if (flags.has('EARLY_ASSIGNMENT_RISK') && assignmentPnl !== null && assignmentPnl >= 0) {
    const base = baseDecision(comparison, lifecycle);
    return {
      ...base,
      outcome: 'NO_ORDER',
      decision: 'ACCEPT_ASSIGNMENT',
      action_required: false,
      primary_blocker: null,
      operator_action: `HOLD ${base.contracts} short call contract(s). Place no order; accept assignment if exercised.`,
      reason: `Assignment at the $${moneyText(finite(lifecycle.strike))} strike realizes $${moneyText(assignmentPnl)} after verified entry economics, while early-assignment risk is active.`,
      order: null,
      proof: {
        assignment_pnl: assignmentPnl,
        strike: finite(lifecycle.strike),
        share_basis: finite(lifecycle.share_basis),
        early_assignment_rule: 'ITM_AND_DIVIDEND_EXCEEDS_EXECUTABLE_EXTRINSIC',
      },
    };
  }

  if (!comparison?.ok) {
    const blocker = comparison?.reason_code ?? 'TRUTH/LIFECYCLE_COMPARISON_UNAVAILABLE';
    if (!SAFE_NO_CHANGE_CODES.has(blocker)) return errorDecision(
      comparison, lifecycle, blocker,
      'Current position or market truth changed while the action was being calculated. No instruction was inferred.',
    );
    return noChange(
      comparison, lifecycle, blocker,
      'No CLOSE or ROLL is permitted because the common-clock comparison could not prove an improvement over HOLD.',
    );
  }

  const currentStrike = finite(comparison?.hold?.strike ?? lifecycle?.strike);
  const currentSpot = finite(comparison?.spot ?? lifecycle?.spot);
  if (currentStrike !== null && currentSpot !== null && currentSpot >= currentStrike
    && (comparison.global_warnings ?? []).includes('AMERICAN_EARLY_EXERCISE_NOT_MODELED')) {
    return errorDecision(
      comparison, lifecycle,
      'MODEL/AMERICAN_EARLY_EXERCISE_NOT_MODELED_FOR_ITM_CALL',
      'The current call is in the money, but the comparison does not model American early exercise. No CLOSE or ROLL instruction was inferred.',
    );
  }

  const close = comparison.close;
  const alternatives = [];
  if (finite(close?.versus_hold_0) !== null
    && finite(close?.versus_hold_monte_carlo_standard_error) !== null) {
    alternatives.push(close);
  }
  for (const roll of comparison.rolls ?? []) {
    if (rollIsAdmissible(roll, comparison, limits)
      && finite(roll?.versus_hold_0) !== null
      && finite(roll?.versus_hold_monte_carlo_standard_error) !== null) alternatives.push(roll);
  }

  // Selection considers more than one alternative. Bonferroni controls the
  // family-wise Monte Carlo false-positive rate at 5% instead of pretending
  // that a post-ranking 1.96σ bound is still a single pre-specified test.
  const comparisonCount = Math.max(1, alternatives.length);
  const criticalZ = finite(confidenceZ)
    ?? normInv(1 - (0.05 / (2 * comparisonCount)));
  const scored = alternatives.map((row) => ({
    row,
    lower_bound_vs_hold_0: finite(row.versus_hold_0)
      - criticalZ * finite(row.versus_hold_monte_carlo_standard_error),
  })).sort((left, right) => finite(right.row.path_nev_0) - finite(left.row.path_nev_0)
    || right.lower_bound_vs_hold_0 - left.lower_bound_vs_hold_0
    || String(left.row.symbol ?? '').localeCompare(String(right.row.symbol ?? '')));
  const selected = scored.find((candidate) => candidate.lower_bound_vs_hold_0 > 0);
  if (!selected) return noChange(
    comparison, lifecycle,
    'POLICY/NO_ADJUSTMENT_PROVES_POSITIVE_VALUE_VS_HOLD',
    `HOLD is retained because no admissible adjustment has a positive family-wise 95% lower bound versus HOLD after executable prices and fees.`,
  );

  const base = baseDecision(comparison, lifecycle);
  const proof = {
    selected_path_nev_0: finite(selected.row.path_nev_0),
    hold_path_nev_0: finite(comparison.hold?.path_nev_0),
    advantage_vs_hold_0: finite(selected.row.versus_hold_0),
    advantage_standard_error: finite(selected.row.versus_hold_monte_carlo_standard_error),
    confidence_z: criticalZ,
    multiple_comparisons: comparisonCount,
    confidence_method: 'BONFERRONI_FAMILY_WISE_95_PERCENT_TWO_SIDED',
    lower_95_bound_vs_hold_0: money(selected.lower_bound_vs_hold_0),
    executable_prices: true,
    costs_included: true,
    shares_and_original_credit: 'COMMON_OR_SUNK_EXCLUDED',
  };
  if (selected.row.path === 'CLOSE') {
    const ask = finite(selected.row.executable_ask_per_share);
    return {
      ...base,
      outcome: 'ACTION',
      decision: 'CLOSE',
      action_required: true,
      primary_blocker: null,
      operator_action: `BUY TO CLOSE ${base.contracts} ${base.option_symbol} at a $${moneyText(ask)} limit or better.`,
      reason: `CLOSE improves modeled value over HOLD by $${moneyText(finite(selected.row.versus_hold_0))}; the family-wise 95% Monte Carlo lower bound remains +$${moneyText(selected.lower_bound_vs_hold_0)} after executable ask and fees.`,
      order: {
        type: 'LIMIT', side: 'BUY_TO_CLOSE', option_symbol: base.option_symbol,
        contracts: base.contracts, limit_price_per_share: ask,
        estimated_cash_outlay_with_fees: Math.abs(finite(selected.row.executable_cash_now_0)),
      },
      proof,
    };
  }

  const bid = finite(selected.row.executable_bid_per_share);
  const currentAsk = finite(comparison.close?.executable_ask_per_share);
  const netLimit = money(bid - currentAsk);
  const netSide = netLimit >= 0 ? 'CREDIT' : 'DEBIT';
  return {
    ...base,
    outcome: 'ACTION',
    decision: 'ROLL',
    action_required: true,
    primary_blocker: null,
    operator_action: `ROLL ${base.contracts} contract(s): BUY TO CLOSE ${base.option_symbol} and SELL TO OPEN ${selected.row.symbol} at a net $${moneyText(Math.abs(netLimit))} ${netSide} limit or better.`,
    reason: `ROLL improves modeled value over HOLD by $${moneyText(finite(selected.row.versus_hold_0))}; the family-wise 95% Monte Carlo lower bound remains +$${moneyText(selected.lower_bound_vs_hold_0)} after executable prices and fees.`,
    order: {
      type: 'NET_LIMIT', side: 'ROLL', contracts: base.contracts,
      close_option_symbol: base.option_symbol,
      close_limit_price_per_share: currentAsk,
      open_option_symbol: selected.row.symbol,
      open_limit_price_per_share: bid,
      net_limit_side: netSide,
      net_limit_price_per_share: Math.abs(netLimit),
      estimated_cash_now_after_fees: finite(selected.row.executable_cash_now_0),
    },
    proof: { ...proof, new_expiration: selected.row.expiration, new_strike: finite(selected.row.strike),
      spread_pct: finite(selected.row.spread_pct), open_interest: finite(selected.row.open_interest),
      volume: finite(selected.row.volume) },
  };
}
