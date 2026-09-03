import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareCoveredCallLifecycleChoices } from '../cloudflare/covered-call-lifecycle-choices.js';

const now = Date.parse('2026-09-02T17:00:00.000Z');

function history(n = 180) {
  const rows = [];
  let close = 185;
  for (let index = 0; index < n; index += 1) {
    const change = Math.sin(index * 0.61) * 0.004 + Math.cos(index * 0.19) * 0.002;
    const open = close * (1 + change * 0.2);
    close *= 1 + change;
    rows.push({ o: open, h: Math.max(open, close) * 1.004,
      l: Math.min(open, close) * 0.996, c: close });
  }
  return rows;
}

function input(overrides = {}) {
  return {
    currentOption: {
      symbol: 'CBRS260904C00200000', underlying: 'CBRS', right: 'call',
      strike: 200, expiration: '2026-09-04', quantity: -6, multiplier: 100,
      spot: 185,
    },
    currentQuote: {
      bid: 0.70, ask: 0.73, underlyingPrice: 185,
      asof: new Date(now).toISOString(), rollChainAsOf: new Date(now).toISOString(),
      underlyingAsOf: new Date(now).toISOString(),
    },
    rollContracts: [
      { symbol: 'CBRS260911C00200000', right: 'call', strike: 200, dte: 9,
        expiration: '2026-09-11', bid: 1.50, ask: 1.60 },
      { symbol: 'CBRS260918C00210000', right: 'call', strike: 210, dte: 16,
        expiration: '2026-09-18', bid: 1.05, ask: 1.15 },
    ],
    historyBars: history(), shareBasis: 198.26, valuationAt: now,
    quotesCurrent: true, samples: 1_500, seed: 'u4-fixture',
    rate: 0.045, rateSource: 'constitution-v5.2.1:riskFreeRate',
    costs: { commissionPerContract: 0.65, exchangeFeePerContract: 0 },
    eventCoverage: { eventsVerified: true, dividendsVerified: true },
    ...overrides,
  };
}

test('U4 values HOLD, CLOSE, and ROLL at one present-value origin with executable prices', () => {
  const result = compareCoveredCallLifecycleChoices(input());
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'LIFECYCLE_CHOICES_CALCULATED');
  assert.equal(result.primary_model, 'bootstrap');
  assert.equal(result.sample_count, 1_500);
  assert.equal(result.mutation_eligible, false);
  assert.equal(result.close.buyback_principal, 438);
  assert.equal(result.close.close_fees, 3.9);
  assert.equal(result.close.path_nev_0, -441.9);
  assert.equal(result.close.path_monte_carlo_standard_error, 0);
  assert.equal(result.close.versus_hold_monte_carlo_standard_error,
    result.hold.path_monte_carlo_standard_error);
  assert.equal(result.close.versus_hold_0,
    Math.round((result.close.path_nev_0 - result.hold.path_nev_0) * 100) / 100);
  assert.equal(result.rolls.length, 2);
  for (const roll of result.rolls) {
    assert.equal(roll.path_nev_0,
      Math.round((result.close.path_nev_0 + roll.new_net_credit_0
        - roll.expected_call_liability_pv_0) * 100) / 100);
    assert.equal(roll.versus_hold_0,
      Math.round((roll.path_nev_0 - result.hold.path_nev_0) * 100) / 100);
    assert.equal(roll.versus_hold_monte_carlo_standard_error,
      Math.hypot(roll.path_monte_carlo_standard_error,
        result.hold.path_monte_carlo_standard_error));
    assert.equal(roll.discount_factor,
      Math.exp(-result.rate * roll.time_to_expiry_years));
    assert.ok(Object.hasOwn(roll, 'spread_pct'));
    assert.ok(Object.hasOwn(roll, 'open_interest'));
    assert.ok(Object.hasOwn(roll, 'volume'));
  }
  assert.equal(result.method.max_of_models, 'REMOVED');
  assert.equal(result.method.mixture, 'NONE');
  assert.equal(result.method.selection, 'NONE_ROWS_SORTED_BY_EXPIRATION_THEN_STRIKE');
  assert.equal(result.method.recommendation, 'NONE');
  assert.equal(result.method.order_route, 'NONE');
  assert.equal(result.method.versus_hold_standard_error,
    'SQRT(PATH_SE^2+HOLD_SE^2)_INDEPENDENT_DTE_SEEDS');
  assert.equal('selected' in result, false);
  assert.equal('rank' in result.rolls[0], false);
});

test('U4 refuses stale executable quotes instead of comparing historical prices', () => {
  const result = compareCoveredCallLifecycleChoices(input({ quotesCurrent: false }));
  assert.deepEqual(result, {
    ok: false,
    outcome: 'NOT_EVALUATED',
    reason_code: 'TRUTH/EXECUTABLE_QUOTES_NOT_CURRENT',
    mutation_eligible: false,
  });
});

test('U4 keeps below-basis and event conditions visible without suppressing roll math', () => {
  const eventAt = now + 5 * 86_400_000;
  const result = compareCoveredCallLifecycleChoices(input({
    rollContracts: [{ symbol: 'CBRS260911C00190000', right: 'call', strike: 190, dte: 9,
      expiration: '2026-09-11', bid: 3.25, ask: 3.40 }],
    events: [{ type: 'EX_DIVIDEND', at: eventAt, cash_amount: 0.25 }],
  }));
  assert.equal(result.ok, true);
  assert.equal(result.rolls.length, 1);
  assert.ok(result.rolls[0].warnings.includes('BELOW_BASIS:190<198.26'));
  assert.ok(result.rolls[0].warnings.some((warning) => warning.startsWith(
    'EX_DIVIDEND_IN_TENOR:2026-09-07T17:00:00.000Z:$0.25/share',
  )));
  assert.equal(result.rolls[0].events_in_tenor[0].type, 'EX_DIVIDEND');
});

test('U4 event tenor ends at the New York expiration-session close', () => {
  const result = compareCoveredCallLifecycleChoices(input({
    events: [
      { type: 'EARNINGS', at: '2026-09-04T19:59:00.000Z' },
      { type: 'EX_DIVIDEND', at: '2026-09-04T20:01:00.000Z', cash_amount: 0.25 },
    ],
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.hold.events_in_tenor.map((event) => event.type), ['EARNINGS']);
  assert.ok(result.hold.warnings.some((warning) => warning.startsWith('EARNINGS_IN_TENOR:')));
  assert.equal(result.hold.warnings.some((warning) => warning.startsWith('EX_DIVIDEND_IN_TENOR:')), false);
});

test('U4 derives roll T from the New York expiration calendar, not broker DTE', () => {
  const result = compareCoveredCallLifecycleChoices(input({
    rollContracts: [{ symbol: 'CBRS260911C00200000', right: 'call', strike: 200,
      dte: 99, expiration: '2026-09-11', bid: 1.50, ask: 1.60 }],
  }));
  assert.equal(result.ok, true);
  assert.equal(result.rolls[0].dte, 9);
  assert.equal(result.rolls[0].broker_reported_dte, 99);
  assert.ok(result.rolls[0].warnings.includes(
    'BROKER_DTE_DIFFERS_FROM_NEW_YORK_CALENDAR:99!=9',
  ));
});

test('U4 only requires the executable side of each trade leg', () => {
  const result = compareCoveredCallLifecycleChoices(input({
    currentQuote: { ...input().currentQuote, bid: null },
    rollContracts: [{ symbol: 'CBRS260911C00200000', right: 'call', strike: 200,
      dte: 9, expiration: '2026-09-11', bid: 1.50, ask: null }],
  }));
  assert.equal(result.ok, true);
  assert.equal(result.close.executable_ask_per_share, 0.73);
  assert.equal(result.rolls[0].executable_bid_per_share, 1.50);
});

test('U4 requires the sealed history/GARCH contract and has no fallback model', () => {
  const result = compareCoveredCallLifecycleChoices(input({ historyBars: history(60) }));
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'NOT_EVALUATED');
  assert.equal(result.reason_code, 'FORECAST/HISTORY_OR_GARCH_UNAVAILABLE');
  assert.equal(result.history_sessions, 60);
});

test('U4 requires the registered 100-share US equity-option contract unit', () => {
  const result = compareCoveredCallLifecycleChoices(input({
    currentOption: { ...input().currentOption, multiplier: 10 },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'CONTRACT/OPTION_MULTIPLIER_UNSUPPORTED');
  assert.equal(result.observed_multiplier, 10);
  assert.equal(result.required_multiplier, 100);
});

test('U4 never prices a roll with a mismatched deliverable multiplier', () => {
  const result = compareCoveredCallLifecycleChoices(input({
    rollContracts: [{ symbol: 'CBRS260911C00200000', underlying: 'CBRS', right: 'call',
      strike: 200, dte: 9, expiration: '2026-09-11', bid: 1.50, ask: 1.60,
      multiplier: 10 }],
  }));
  assert.equal(result.ok, true);
  assert.equal(result.rolls.length, 0);
  assert.deepEqual(result.unavailable_rolls, [{
    symbol: 'CBRS260911C00200000', reason_code: 'CONTRACT/ROLL_MULTIPLIER_MISMATCH',
  }]);
});

test('U4 labels unmodeled early exercise and omitted taxes once as global limitations', () => {
  const result = compareCoveredCallLifecycleChoices(input({
    eventCoverage: { eventsVerified: false, dividendsVerified: false },
  }));
  assert.equal(result.ok, true);
  assert.ok(result.global_warnings.includes('AMERICAN_EARLY_EXERCISE_NOT_MODELED'));
  assert.ok(result.global_warnings.includes('TAX_EFFECTS_OMITTED_NO_VERIFIED_TAX_INPUT'));
  assert.ok(result.global_warnings.includes('DIVIDEND_DATA_UNVERIFIED'));
  assert.equal(result.hold.warnings.includes('AMERICAN_EARLY_EXERCISE_NOT_MODELED'), false);
  assert.equal(result.method.early_exercise, 'NOT_MODELED_LABELED_ON_GLASS');
  assert.equal(result.method.taxes, 'OMITTED_NO_VERIFIED_TAX_INPUT');
  assert.equal('taxes' in result.hold, false);
});
