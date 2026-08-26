import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeCoveredCallLifecycle } from '../src/lifecycle/covered_call_analysis.js';

function history(n = 252) {
  const bars = [];
  let close = 100;
  for (let i = 0; i < n; i += 1) {
    const change = Math.sin(i * 0.71) * 0.012 + Math.cos(i * 0.19) * 0.006;
    const open = close * (1 + change * 0.2);
    close *= 1 + change;
    bars.push({ o: open, h: Math.max(open, close) * 1.01, l: Math.min(open, close) * 0.99, c: close });
  }
  return bars;
}

const base = {
  optionPosition: {
    symbol: 'TEST260828C00105000', underlying: 'TEST', right: 'call',
    strike: 105, expiration: '2026-08-28', qty: -2, multiplier: 100, average_price: 2.4,
  },
  sharePosition: { symbol: 'TEST', qty: 300 },
  optionQuote: {
    bid: 0.9, ask: 1.0, mid: 0.95, iv: 0.42, delta: 0.31, theta: -0.18,
    asof: '2026-08-26T16:00:00.000Z', source: 'SCHWAB',
  },
  underlyingQuote: { last: 100 },
  historyBars: history(),
  now: Date.parse('2026-08-26T16:00:00.000Z'),
  samples: 4_000,
  seed: 'covered-call-test',
};

test('covered-call lifecycle analysis quantifies close versus hold deterministically', () => {
  const first = analyzeCoveredCallLifecycle(base);
  const second = analyzeCoveredCallLifecycle(base);
  assert.deepEqual(first, second);
  assert.equal(first.ok, true);
  assert.equal(first.contracts, 2);
  assert.equal(first.covered_shares, 200);
  assert.equal(first.current_trade.entry_credit_total, 480);
  assert.equal(first.current_trade.executable_buyback_total, 201.6);
  assert.equal(first.current_trade.profit_locked_if_closed_now, 278.4);
  assert.ok(first.current_trade.profit_captured_pct > 0.5);
  assert.equal(
    first.comparison.expected_upside_surrendered_if_held,
    first.comparison.expected_expiry_intrinsic_value_total,
  );
  assert.ok(first.comparison.expected_upside_surrendered_if_held >= 0);
  assert.equal(
    first.comparison.hold_expected_profit_model,
    first.current_trade.entry_credit_total
      - first.comparison.expected_upside_surrendered_if_held
      - first.comparison.expected_assignment_fee,
  );
  assert.equal(
    first.probabilities.model_minus_market_assignment,
    first.probabilities.model_expire_itm_assignment
      - first.probabilities.market_implied_expire_itm_assignment,
  );
  assert.ok(Number.isFinite(first.probabilities.model_minus_market_assignment));
  assert.ok(first.probabilities.model_minus_market_assignment >= -1);
  assert.ok(first.probabilities.model_minus_market_assignment <= 1);
  for (const [name, probability] of Object.entries(first.probabilities)) {
    if (name === 'model_minus_market_assignment' || !Number.isFinite(probability)) continue;
    assert.ok(probability >= 0 && probability <= 1);
  }
  assert.match(first.comparison.quantitative_verdict, /STATISTICALLY_FAVORED|NEAR_TIE/u);
  assert.equal(first.model.drift, 0);
});

test('an uncovered or incomplete short call is refused rather than guessed', () => {
  const result = analyzeCoveredCallLifecycle({
    ...base,
    sharePosition: { symbol: 'TEST', qty: 100 },
  });
  assert.deepEqual(result, { ok: false, error: 'COVERED_CALL_ANALYSIS_INPUT_INCOMPLETE' });
});

test('a recent listing uses the constitutional short-history volatility floor', () => {
  const result = analyzeCoveredCallLifecycle({ ...base, historyBars: history(51) });
  assert.equal(result.ok, true);
  assert.equal(result.model.history_sessions, 51);
  assert.equal(result.model.volatility_floor_applied, 0.80);
  assert.ok(result.model.volatility >= 0.80);
  assert.equal(result.model.bootstrap_included, false);
});
