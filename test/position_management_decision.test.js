import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildCoveredCallPositionDecision, POSITION_MANAGEMENT_DECISION_VERSION,
} from '../cloudflare/position-management-decision.js';
import { liveDashboardScript } from '../cloudflare/worker.js';

const lifecycle = {
  ok: true,
  symbol: 'XYZ260904C00170000', underlying: 'XYZ', contracts: 1, covered_shares: 100,
  strike: 170, expiration: '2026-09-04', dte: 1, spot: 165, share_basis: 160,
  quote: { asof: '2026-09-03T17:00:00.000Z' },
  current_trade: { total_close_outlay: 200.65, profit_locked_if_call_closed_now: 56.68 },
  paths: { assignment: { pnl: 1_257.33 } },
  classification: { current: true, flags: [{ code: 'EXPIRY_PROXIMITY' }] },
};

const comparison = {
  ok: true, underlying: 'XYZ', current_option_symbol: lifecycle.symbol,
  contracts: 1, covered_shares: 100, spot: 165, share_basis: 160,
  valuation_at: '2026-09-03T17:00:00.000Z',
  hold: { path: 'HOLD', path_nev_0: -212.51 },
  close: {
    path: 'CLOSE', path_nev_0: -200.65, versus_hold_0: 11.86,
    versus_hold_monte_carlo_standard_error: 4.78,
    executable_ask_per_share: 2, executable_cash_now_0: -200.65,
  },
  rolls: [],
};

test('position management selects one exact CLOSE when its lower 95% bound beats HOLD', () => {
  const result = buildCoveredCallPositionDecision({ comparison, lifecycle });
  assert.equal(result.engine_version, POSITION_MANAGEMENT_DECISION_VERSION);
  assert.equal(result.decision, 'CLOSE');
  assert.equal(result.action_required, true);
  assert.equal(result.order.side, 'BUY_TO_CLOSE');
  assert.equal(result.order.contracts, 1);
  assert.equal(result.order.limit_price_per_share, 2);
  assert.equal(result.proof.lower_95_bound_vs_hold_0, 2.49);
  assert.match(result.operator_action, /BUY TO CLOSE 1 XYZ260904C00170000/u);
  assert.equal(result.mutation_eligible, false);
});

test('position management keeps HOLD when an adjustment is not proven', () => {
  const weak = { ...comparison, close: { ...comparison.close, versus_hold_0: 8,
    versus_hold_monte_carlo_standard_error: 5 } };
  const result = buildCoveredCallPositionDecision({ comparison: weak, lifecycle });
  assert.equal(result.decision, 'HOLD');
  assert.equal(result.action_required, false);
  assert.equal(result.order, null);
  assert.equal(result.primary_blocker, 'POLICY/NO_ADJUSTMENT_PROVES_POSITIVE_VALUE_VS_HOLD');
});

test('forecast refusal resolves to a conservative HOLD rather than a chain dump', () => {
  const result = buildCoveredCallPositionDecision({ comparison: {
    ok: false, reason_code: 'TRUTH/FORECAST_HISTORY_UNAVAILABLE',
    current_option_symbol: lifecycle.symbol,
  }, lifecycle });
  assert.equal(result.decision, 'HOLD');
  assert.equal(result.primary_blocker, 'TRUTH/FORECAST_HISTORY_UNAVAILABLE');
  assert.match(result.operator_action, /Place no order/u);
});

test('stale lifecycle truth returns ERROR and never fabricates an action', () => {
  const result = buildCoveredCallPositionDecision({ comparison,
    lifecycle: { ...lifecycle, classification: { current: false, flags: [{ code: 'QUOTE_STALE' }] } } });
  assert.equal(result.decision, 'ERROR');
  assert.equal(result.order, null);
  assert.equal(result.primary_blocker, 'TRUTH/EXECUTABLE_QUOTES_NOT_CURRENT');
});

test('custody disagreement returns ERROR rather than HOLD on a position that may no longer exist', () => {
  const result = buildCoveredCallPositionDecision({ comparison: {
    ok: false, reason_code: 'CUSTODY/OPEN_COVERED_CALL_NOT_FOUND',
    current_option_symbol: lifecycle.symbol,
  }, lifecycle });
  assert.equal(result.decision, 'ERROR');
  assert.equal(result.primary_blocker, 'CUSTODY/OPEN_COVERED_CALL_NOT_FOUND');
});

test('roll selection rejects below-basis and illiquid strikes before choosing one order', () => {
  const roll = {
    path: 'ROLL', symbol: 'XYZ260918C00175000', expiration: '2026-09-18', dte: 15,
    strike: 175, executable_bid_per_share: 2.5, executable_ask_per_share: 2.6,
    open_interest: 1_000, volume: 500, spread_pct: 0.0392, events_in_tenor: [],
    path_nev_0: -180, versus_hold_0: 32.51,
    versus_hold_monte_carlo_standard_error: 4, executable_cash_now_0: 48.7,
  };
  const bad = { ...roll, symbol: 'XYZ260918C00155000', strike: 155, path_nev_0: -100 };
  const result = buildCoveredCallPositionDecision({
    comparison: { ...comparison, rolls: [bad, roll] }, lifecycle,
  });
  assert.equal(result.decision, 'ROLL');
  assert.equal(result.order.open_option_symbol, roll.symbol);
  assert.equal(result.order.net_limit_side, 'CREDIT');
  assert.equal(result.order.net_limit_price_per_share, 0.5);
});

test('identical inputs produce byte-identical position decisions', () => {
  const first = buildCoveredCallPositionDecision({ comparison, lifecycle });
  const second = buildCoveredCallPositionDecision({ comparison, lifecycle });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('Position Management presents one-action cards and no comparison button', () => {
  const script = liveDashboardScript();
  const worker = readFileSync(new URL('../cloudflare/worker.js', import.meta.url), 'utf8');
  assert.match(worker, /What to do now/u);
  assert.match(script, /renderPositionManagementDecisions/u);
  assert.match(script, /WHY THIS IS THE DECISION/u);
  assert.doesNotMatch(worker.slice(worker.indexOf('const portfolio ='), worker.indexOf('const underwrite =')),
    /COMPARE IN UNDERWRITE/u);
});
