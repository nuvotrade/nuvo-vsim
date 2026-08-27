import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  calculateCoveredCallCandidates, COVERED_CALL_DTE_TARGETS,
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
  assert.ok(result.selected.net_premium < result.selected.gross_premium);
  assert.ok(result.selected.incremental_nev_vs_holding > 0);
  assert.ok(result.selected.incremental_nev_per_day > 0);
  assert.equal(result.objective, 'MAX_INCREMENTAL_NEV_PER_DAY_VS_HOLDING_SHARES');
  assert.equal(result.forecast.status, 'VERIFIED_NO_FALLBACK');
  assert.equal(result.method.credit, 'SCHWAB_EXECUTABLE_BID');
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

test('holding shares wins when executable premium does not pay for modeled surrendered upside', () => {
  const result = calculateCoveredCallCandidates({
    symbol: 'ABC', shares: 100, averagePrice: 90, availableContracts: 1, spot: 100,
    historyBars: history(), samples: 1_500,
    contracts: [call({ dte: 7, strike: 100.01, bid: 0.05, ask: 0.051, delta: 0.50 })],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'NO_COVERED_CALL_ADDS_VALUE_VS_HOLDING_SHARES');
  assert.equal(result.rejected.no_incremental_edge, 1);
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
