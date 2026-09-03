import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCashSecuredPutDecision, calculateAtmStraddleExpectedMoves,
  cspDecisionAlertText, CSP_DECISION_OUTCOME, weeklyExpiryDteTargets,
} from '../cloudflare/csp-decision-engine.js';

const NOW = Date.parse('2026-09-03T17:00:00Z');

function row({ dte = 14, strike = 90, bid = 2, ask = 2.08, iv = 0.50,
  openInterest = 1000, volume = 200, nev = 25, contract = null } = {}) {
  const netCredit = bid * 100 - 0.65;
  return {
    symbol: 'XYZ', contract: contract ?? `XYZ-${dte}-${strike}-P`,
    expiration: new Date(NOW + dte * 86_400_000).toISOString().slice(0, 10), dte, strike,
    quote: { bid, ask, strike_iv: iv, open_interest: openInterest, volume },
    one_contract_economics: {
      net_credit: netCredit, net_tied_cash: strike * 100 - netCredit,
      assigned_basis: strike - netCredit / 100,
    },
    headline_models: { primary_nev: nev },
    events_in_tenor: [],
  };
}

function input(overrides = {}) {
  const rows = [
    row({ dte: 7, strike: 92, bid: 1.5, ask: 1.56, iv: 0.5 }),
    row({ dte: 14, strike: 90, bid: 2.0, ask: 2.08, iv: 0.5 }),
    row({ dte: 21, strike: 88, bid: 2.15, ask: 2.23, iv: 0.5 }),
  ];
  const expectedMoves = Object.fromEntries(rows.map((candidate, index) => [candidate.expiration, {
    atm_strike: 100,
    atm_call_mid: [3.5, 4.75, 5.75][index],
    atm_put_mid: [3.5, 4.75, 5.75][index],
    expected_move: [7, 9.5, 11.5][index],
    lower_boundary: [93, 90.5, 88.5][index],
    upper_boundary: [107, 109.5, 111.5][index],
    formula: 'ATM_CALL_MID_PLUS_ATM_PUT_MID',
  }]));
  return {
    symbol: 'XYZ',
    calculation: { ok: true, symbol: 'XYZ', spot: 100, rows, expected_moves: expectedMoves },
    account: { nav: 100_000, cash: 80_000, withdrawableCash: 80_000 },
    positions: [], openOrders: [], accountAsOf: NOW, accountHash: 'account-1',
    controls: { globalPause: false, independentKill: false },
    reconciliation: 'CAPTURED', marketSession: 'OPEN', source: 'UNIT', asof: NOW,
    now: NOW, ...overrides,
  };
}

test('expected move is the nearest-ATM live straddle, not an IV shortcut', () => {
  const expiration = '2026-09-18';
  const contract = (right, strike, bid, ask) => ({
    right, strike, bid, ask, expiration, dte: 15,
  });
  const moves = calculateAtmStraddleExpectedMoves({ spot: 101, contracts: [
    contract('call', 100, 3.8, 4.0), contract('put', 100, 2.8, 3.0),
    contract('call', 105, 1.8, 2.0), contract('put', 105, 5.7, 6.0),
  ] });
  assert.equal(moves[expiration].atm_strike, 100);
  assert.equal(moves[expiration].atm_call_mid, 3.9);
  assert.equal(moves[expiration].atm_put_mid, 2.9);
  assert.equal(moves[expiration].expected_move, 6.8);
  assert.equal(moves[expiration].lower_boundary, 94.2);
  assert.equal(moves[expiration].formula, 'ATM_CALL_MID_PLUS_ATM_PUT_MID');
});

test('weekly slots resolve to this Friday and the following two Fridays', () => {
  assert.deepEqual(weeklyExpiryDteTargets(Date.parse('2026-09-03T17:00:00Z')), [1, 8, 15]);
  assert.deepEqual(weeklyExpiryDteTargets(Date.parse('2026-09-04T17:00:00Z')), [0, 7, 14]);
});

test('one engine returns exactly one best result for each of three weekly expiries', () => {
  const decision = buildCashSecuredPutDecision(input());
  assert.equal(decision.outcome, CSP_DECISION_OUTCOME.SELL);
  assert.deepEqual(decision.evaluated_dtes, [7, 14, 21]);
  assert.equal(decision.choices.length, 3);
  assert.deepEqual(decision.choices.map((choice) => choice.slot),
    ['THIS_WEEK', 'NEXT_WEEK', 'WEEK_AFTER']);
  assert.deepEqual(decision.choices.map((choice) => choice.recommendation.contract),
    ['XYZ-7-92-P', 'XYZ-14-90-P', 'XYZ-21-88-P']);
  assert.ok(decision.choices.every((choice) => choice.recommendation.quantity >= 1));
  assert.ok(decision.choices.every((choice) => choice.mathematical_proof.gates.expected_move.passed));
  assert.ok(decision.choices.every((choice) => choice.mathematical_proof.gates.roc.passed));
  assert.equal(decision.authority.execution, 'PRINCIPAL_MANUAL_ORDER_ENTRY_ONLY');
  assert.equal('rows' in decision, false);
  assert.equal('alternatives' in decision, false);
  assert.equal(cspDecisionAlertText(decision).split('\n').length, 3);
});

test('identical canonical inputs reproduce an identical decision byte for byte', () => {
  const first = buildCashSecuredPutDecision(input());
  const second = buildCashSecuredPutDecision(input());
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.input_fingerprint, second.input_fingerprint);
  assert.equal(first.decision_id, second.decision_id);
});

test('no qualifying strike returns three KEEP_CASH weekly results and no chain dump', () => {
  const request = input();
  request.calculation.rows = request.calculation.rows.map((candidate) => ({
    ...candidate, strike: 99,
  }));
  const decision = buildCashSecuredPutDecision(request);
  assert.equal(decision.outcome, CSP_DECISION_OUTCOME.HOLD);
  assert.equal(decision.choices.length, 3);
  assert.ok(decision.choices.every((choice) => choice.outcome === CSP_DECISION_OUTCOME.HOLD));
  assert.ok(decision.choices.every((choice) =>
    choice.primary_blocker.code === 'POLICY/STRIKE_INSIDE_EXPECTED_MOVE'));
  assert.equal(decision.action.type, 'NO_TRADE');
  assert.equal('rows' in decision, false);
});

test('insufficient unborrowed cash returns KEEP_CASH', () => {
  const decision = buildCashSecuredPutDecision(input({
    account: { nav: 100_000, cash: 20_000, withdrawableCash: 20_000 },
  }));
  assert.equal(decision.outcome, CSP_DECISION_OUTCOME.HOLD);
  assert.ok(decision.choices.every((choice) =>
    choice.primary_blocker.code === 'POLICY/CASH_OR_RISK_CAPACITY_INSUFFICIENT'));
});

test('truth failure is ERROR while a known closed session is KEEP_CASH', () => {
  const broken = buildCashSecuredPutDecision(input({ reconciliation: 'MISMATCH' }));
  assert.equal(broken.outcome, CSP_DECISION_OUTCOME.ERROR);
  assert.equal(broken.ok, false);
  const closed = buildCashSecuredPutDecision(input({ marketSession: 'CLOSED' }));
  assert.equal(closed.outcome, CSP_DECISION_OUTCOME.HOLD);
  assert.equal(closed.primary_blocker.code, 'TRUTH/MARKET_NOT_OPEN');
});

test('wheel and open-order states prevent duplicate CSP entries', () => {
  const shares = buildCashSecuredPutDecision(input({ positions: [{
    type: 'EQUITY', symbol: 'XYZ', underlying: 'XYZ', quantity: 100, marketValue: 10_000,
  }] }));
  assert.equal(shares.primary_blocker.code, 'WHEEL/SHARES_OWNED');
  const order = buildCashSecuredPutDecision(input({ openOrders: [{ symbol: 'XYZ' }] }));
  assert.equal(order.primary_blocker.code, 'CUSTODY/OPEN_ORDERS_PRESENT');
});
