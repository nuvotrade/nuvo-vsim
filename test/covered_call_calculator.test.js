import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  calculateCoveredCallCandidates,
  configuredCoveredCallDteTargets, COVERED_CALL_DTE_TARGETS, SCHWAB_COVERED_CALL_COSTS,
  summarizeCoveredCallPortfolioState,
} from '../cloudflare/covered-call-calculator.js';

function call({ dte, strike, bid, ask = bid + 0.1, delta = 0.25, oi = 500 } = {}) {
  return {
    symbol: `ABC${dte}C${strike}`,
    right: 'call', dte, strike, expiration: `2026-09-${String(dte).padStart(2, '0')}`,
    bid, ask, iv: 0.35, delta, theta: -0.08, openInterest: oi, volume: 75,
    quoteAsOf: Date.parse('2026-08-26T17:00:00.000Z'),
  };
}

function history(n = 180) {
  const bars = [];
  let close = 100;
  for (let index = 0; index < n; index += 1) {
    const change = Math.sin(index * 0.67) * 0.003 + Math.cos(index * 0.23) * 0.002;
    const open = close * (1 + change * 0.15);
    close *= 1 + change;
    bars.push({ o: open, h: Math.max(open, close) * 1.003, l: Math.min(open, close) * 0.997, c: close });
  }
  return bars;
}

test('covered-call calculator evaluates the 7, 14, and 21 DTE targets and ranks an exact winner', () => {
  const result = calculateCoveredCallCandidates({
    symbol: 'ABC', shares: 300, averagePrice: 100, availableContracts: 3, spot: 110,
    historyBars: history(), samples: 1_500,
    contracts: [
      call({ dte: 7, strike: 115, bid: 1.3, delta: 0.25 }),
      call({ dte: 14, strike: 118, bid: 2.1, delta: 0.22 }),
      call({ dte: 21, strike: 120, bid: 2.5, delta: 0.20 }),
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.targets.map((row) => row.target_dte), COVERED_CALL_DTE_TARGETS);
  assert.ok(result.targets.every((row) => row.status === 'EVALUATED'));
  assert.equal(result.selected.rank, 1);
  assert.equal(result.selected.contracts, 3);
  assert.equal(result.selected.covered_shares, 300);
  assert.equal(result.selected.entry_fees, 1.95,
    '3 contracts must charge the observed $0.65 Schwab commission exactly once at entry');
  assert.ok(Math.abs((result.selected.gross_premium - result.selected.net_premium) - 1.95) < 1e-9);
  assert.equal(result.selected.expected_assignment_fee, 0);
  assert.equal(result.selected.cost_model_version, SCHWAB_COVERED_CALL_COSTS.version);
  assert.ok(result.selected.net_premium_per_calendar_day > 0);
  assert.ok(result.selected.wheel_income_return_on_cost_per_day > 0);
  assert.equal(result.objective, 'MAX_PRIMARY_EXPECTED_WHEEL_PROFIT_FROM_COST_PER_CALENDAR_DAY');
  assert.ok(Number.isFinite(result.selected.expected_wheel_profit));
  assert.ok(Number.isFinite(result.selected.expected_wheel_profit_per_calendar_day));
  assert.equal(result.forecast.status, 'VERIFIED_NO_FALLBACK');
  assert.equal(result.method.credit, 'SCHWAB_EXECUTABLE_BID');
  assert.equal(result.method.primary_model, 'bootstrap');
  assert.equal(result.method.max_of_models, 'REMOVED');
  assert.equal(result.method.mixture, 'NONE');
  assert.equal(result.method.cash_carry,
    'NOT_APPLICABLE_COVERED_CALL_INCREMENTAL_VALUE_IS_RAW_ONLY');
  assert.equal(result.method.uncovered_hold_comparison, 'DIAGNOSTIC_ONLY_NOT_AN_ENTRY_GATE');
  assert.equal(result.selected.calculation_unit_contracts, 1);
  assert.equal('cash_carry_cost_0' in result.selected, false);
  assert.equal('cash_adj_nev_0' in result.selected, false);
  assert.equal(result.selected.headline_models.primary_raw_nev_0,
    result.selected.one_contract_models.bootstrap.raw_nev_0);
  assert.equal(result.method.rejection_codes.illiquid,
    'CONSTITUTION/OPTION_LIQUIDITY_GATE_FAILED');
});

test('covered-call tenor targets are configurable while 7/14/21 remains the unratified default', () => {
  assert.deepEqual(configuredCoveredCallDteTargets(undefined), [7, 14, 21]);
  assert.deepEqual(configuredCoveredCallDteTargets('45,14,30,14'), [14, 30, 45]);
  assert.equal(configuredCoveredCallDteTargets('14,not-a-dte,45'), null);

  const result = calculateCoveredCallCandidates({
    symbol: 'ABC', shares: 100, averagePrice: 90, availableContracts: 1, spot: 100,
    historyBars: history(), samples: 1_500, targets: [14, 30, 45],
    contracts: [
      call({ dte: 14, strike: 110, bid: 1.2 }),
      call({ dte: 30, strike: 115, bid: 2.0 }),
      call({ dte: 45, strike: 120, bid: 2.8 }),
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.targets.map((row) => row.target_dte), [14, 30, 45]);
});

test('strike at or below average share price is never admitted', () => {
  const result = calculateCoveredCallCandidates({
    symbol: 'ABC', shares: 100, averagePrice: 120, availableContracts: 1, spot: 100,
    historyBars: history(), samples: 1_500,
    contracts: [
      call({ dte: 7, strike: 119, bid: 1 }),
      call({ dte: 14, strike: 120, bid: 1.2 }),
      call({ dte: 21, strike: 121, bid: 1.3 }),
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.selected.strike, 121);
  assert.ok(result.candidates.every((row) => row.strike > result.average_price));
  assert.equal(result.rejected.at_or_below_cost_basis, 2);
});

test('returns no eligible covered call rather than weakening the cost-basis rule', () => {
  const result = calculateCoveredCallCandidates({
    symbol: 'ABC', shares: 100, averagePrice: 130, availableContracts: 1, spot: 100,
    historyBars: history(), samples: 1_500,
    contracts: [
      call({ dte: 7, strike: 110, bid: 1 }),
      call({ dte: 14, strike: 120, bid: 1.2 }),
      call({ dte: 21, strike: 130, bid: 1.5 }),
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'NO_ELIGIBLE_COVERED_CALL');
  assert.equal(result.reason_code, 'NO_LIQUID_STRIKE_STRICTLY_ABOVE_COST_BASIS_AND_MARKET');
  assert.equal(result.rejected.at_or_below_cost_basis, 3);
  assert.ok(result.targets.every((row) => row.decision === 'HOLD_SHARES_NO_TRADE'));
  assert.ok(result.targets.every((row) => row.primary_blocker.code
    === 'UNDERWRITE/STRIKE_AT_OR_BELOW_COST_BASIS'));
});

test('refuses incomplete custody or uncovered capacity', () => {
  const result = calculateCoveredCallCandidates({
    symbol: 'ABC', shares: 100, averagePrice: 100, availableContracts: 0,
    spot: 110, contracts: [], historyBars: history(),
  });
  assert.deepEqual(result, {
    ok: false, outcome: 'NO_ELIGIBLE_COVERED_CALL', reason_code: 'CALCULATOR_INPUT_INCOMPLETE',
  });
});

test('constitutional event and liquidity gates cannot be outweighed by premium', () => {
  const now = Date.parse('2026-08-26T17:00:00.000Z');
  const result = calculateCoveredCallCandidates({
    symbol: 'ABC', shares: 100, averagePrice: 90, availableContracts: 1, spot: 100, now,
    historyBars: history(), samples: 1_500,
    events: [{ type: 'EARNINGS', at: now + 10 * 86_400_000 }],
    contracts: [
      call({ dte: 7, strike: 105, bid: 1.1, ask: 1.4, oi: 5_000 }),
      call({ dte: 14, strike: 110, bid: 20, ask: 20.1, oi: 5_000 }),
      call({ dte: 21, strike: 115, bid: 25, ask: 25.1, oi: 5_000 }),
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.rejected.illiquid, 1);
  assert.equal(result.rejected.event_in_window, 2);
});

test('wheel profit policy does not reject an above-cost call merely because uncovered shares model higher upside', () => {
  const result = calculateCoveredCallCandidates({
    symbol: 'ABC', shares: 100, averagePrice: 90, availableContracts: 1, spot: 100,
    historyBars: history(), samples: 1_500,
    contracts: [call({ dte: 7, strike: 100.01, bid: 0.05, ask: 0.051, delta: 0.50 })],
  });
  assert.equal(result.ok, true);
  assert.equal(result.selected.strike, 100.01);
  assert.equal(result.selected.legacy_uncovered_hold_gate_passed, false);
  assert.equal(result.method.score, 'MAX_PRIMARY_EXPECTED_WHEEL_PROFIT_FROM_COST_PER_CALENDAR_DAY');
  assert.equal(result.method.uncovered_hold_comparison, 'DIAGNOSTIC_ONLY_NOT_AN_ENTRY_GATE');
});

test('returns exactly one wheel choice for this week, next week, and week after', () => {
  const result = calculateCoveredCallCandidates({
    symbol: 'ABC', shares: 100, averagePrice: 99, availableContracts: 1, spot: 100,
    historyBars: history(), samples: 1_500, targets: [1, 8, 15],
    expectedMoves: {
      '2026-09-01': { expected_move: 1.5, upper_boundary: 101.5 },
      '2026-09-08': { expected_move: 2.2, upper_boundary: 102.2 },
      '2026-09-15': { expected_move: 3.0, upper_boundary: 103.0 },
    },
    contracts: [
      call({ dte: 1, strike: 101, bid: 0.45, ask: 0.47, delta: 0.28 }),
      call({ dte: 1, strike: 102, bid: 0.20, ask: 0.21, delta: 0.16 }),
      call({ dte: 8, strike: 102, bid: 0.85, ask: 0.89, delta: 0.25 }),
      call({ dte: 15, strike: 103, bid: 1.10, ask: 1.15, delta: 0.23 }),
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.targets.map((row) => row.slot_label),
    ['This week', 'Next week', 'Week after']);
  assert.deepEqual(result.targets.map((row) => row.best?.dte), [1, 8, 15]);
  assert.ok(result.targets.every((row) => row.best?.order_instruction.startsWith('SELL TO OPEN 1 ')));
  assert.ok(result.targets.every((row) => Number.isFinite(row.best?.expected_wheel_profit)));
  assert.ok(result.targets.every((row) => row.best?.expected_move_formula === 'ATM_CALL_MID_PLUS_ATM_PUT_MID'));
  assert.equal(result.method.expected_move_reference,
    'ATM_CALL_MID_PLUS_ATM_PUT_MID_INFORMATIONAL_NOT_A_GATE');
  assert.equal(result.technical_timing.policy_effect, 'INFORMATIONAL_ONLY_NOT_A_GATE');
  assert.ok(result.targets.every((row) => row.decision === 'SELL_COVERED_CALL'));
});

test('short history is blocked instead of using a fallback volatility', () => {
  const result = calculateCoveredCallCandidates({
    symbol: 'ABC', shares: 100, averagePrice: 90, availableContracts: 1, spot: 100,
    historyBars: history(60), contracts: [call({ dte: 7, strike: 105, bid: 1.2 })],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'FORECAST_HISTORY_OR_VOLATILITY_ENSEMBLE_UNAVAILABLE');
  assert.equal(result.history_sessions, 60);
});

test('portfolio context reports current utilization without blocking RUN', () => {
  const result = summarizeCoveredCallPortfolioState({
    nav: 100_000,
    cash: 2_900,
    positions: [
      { type: 'EQUITY', symbol: 'CBRS', marketValue: 55_200 },
      { type: 'EQUITY', symbol: 'SPCX', marketValue: 43_000 },
      { type: 'OPTION', symbol: 'CBRS-CALL', marketValue: -300 },
    ],
  });
  assert.equal(result.complete, true);
  assert.equal(result.deployed_pct, 0.971);
  assert.equal(result.cash_reserve_pct, 0.029);
  assert.deepEqual(result.observations.map((row) => row.name), [
    'DEPLOYED_ABOVE_REFERENCE',
    'CASH_BELOW_REFERENCE',
    'SINGLE_UNDERLYING_ABOVE_REFERENCE',
    'SINGLE_UNDERLYING_ABOVE_REFERENCE',
  ]);
  assert.deepEqual(result.observations.slice(2).map((row) => row.symbol), ['CBRS', 'SPCX']);
  assert.equal(result.policy_effect, 'INFORMATIONAL_ONLY_NEVER_BLOCKS_RUN');
});

test('incomplete portfolio context remains informational and names missing fields', () => {
  const result = summarizeCoveredCallPortfolioState({
    nav: 100_000,
    cash: 25_000,
    positions: [{ type: 'EQUITY', symbol: 'ABC', marketValue: null }],
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.unavailable, ['EQUITY_MARKET_VALUES']);
  assert.deepEqual(result.missing_market_value_symbols, ['ABC']);
  assert.equal(result.policy_effect, 'INFORMATIONAL_ONLY_NEVER_BLOCKS_RUN');
});

test('portfolio context shows no reference observations for a book inside them', () => {
  const result = summarizeCoveredCallPortfolioState({
    nav: 100_000,
    cash: 40_000,
    positions: [
      { type: 'EQUITY', symbol: 'ABC', marketValue: 18_000 },
      { type: 'EQUITY', symbol: 'XYZ', marketValue: 15_000 },
    ],
  });
  assert.equal(result.complete, true);
  assert.deepEqual(result.observations, []);
});

test('a candidate still appears when all portfolio reference figures are breached', () => {
  const portfolio = summarizeCoveredCallPortfolioState({
    nav: 100_000,
    cash: 2_900,
    positions: [
      { type: 'EQUITY', symbol: 'ABC', marketValue: 97_100 },
    ],
  });
  const calculation = calculateCoveredCallCandidates({
    symbol: 'ABC', shares: 100, averagePrice: 90, availableContracts: 1, spot: 100,
    historyBars: history(), samples: 1_500,
    contracts: [call({ dte: 14, strike: 118, bid: 2.1, delta: 0.22 })],
  });
  assert.equal(portfolio.observations.some((row) => row.name === 'DEPLOYED_ABOVE_REFERENCE'), true);
  assert.equal(portfolio.observations.some((row) => row.name === 'CASH_BELOW_REFERENCE'), true);
  assert.equal(portfolio.observations.some((row) => row.name === 'SINGLE_UNDERLYING_ABOVE_REFERENCE'), true);
  assert.equal(portfolio.policy_effect, 'INFORMATIONAL_ONLY_NEVER_BLOCKS_RUN');
  assert.equal(calculation.ok, true);
  assert.equal(calculation.selected.symbol, 'ABC14C118');
});

test('RUN proposal theta converts Schwab per-share premium theta to position dollars once', () => {
  const schwabCall = {
    ...call({ dte: 14, strike: 118, bid: 2.1, delta: 0.22 }),
    theta: -0.57309031,
    greekUnits: { theta: 'PREMIUM_DOLLARS_PER_SHARE_PER_CALENDAR_DAY' },
  };
  const result = calculateCoveredCallCandidates({
    symbol: 'ABC', shares: 600, averagePrice: 90, availableContracts: 6, spot: 100,
    historyBars: history(), samples: 1_500, contracts: [schwabCall],
  });
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.selected.theta_income_per_day - 343.854186) < 1e-9);
  assert.equal(result.selected.theta_source_unit,
    'PREMIUM_DOLLARS_PER_SHARE_PER_CALENDAR_DAY');
});
