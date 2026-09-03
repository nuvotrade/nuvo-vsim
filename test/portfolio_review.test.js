import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculatePortfolioReviewSymbol, compilePortfolioReview,
  contractsAtReviewTenors, nearestListedDtes,
} from '../cloudflare/portfolio-review.js';

const NOW = Date.parse('2026-09-03T17:00:00Z');

function history(count = 180, base = 100) {
  return Array.from({ length: count }, (_, index) => {
    const close = base + 0.025 * index + 1.2 * Math.sin(index / 5);
    return {
      t: NOW - (count - index) * 86_400_000,
      o: close - 0.2, h: close + 0.65, l: close - 0.7, c: close,
    };
  });
}

function option({ symbol = 'TEST', right = 'put', strike = 100, dte = 14,
  bid = 2.1, ask = 2.3, iv = 0.34 } = {}) {
  return {
    symbol: `${symbol}-${right}-${strike}-${dte}`, right, strike, dte, bid, ask, iv,
    expiration: new Date(NOW + dte * 86_400_000).toISOString().slice(0, 10),
    delta: right === 'put' ? -0.3 : 0.3, gamma: 0.025, vega: 0.08, theta: -0.04,
    openInterest: 800, volume: 160, quoteAsOf: NOW,
  };
}

function book(overrides = {}) {
  return {
    complete: true, nav: 10_000, settled_cash: 500,
    deployed_pct: 0.95, cash_reserve_pct: 0.05,
    underlying_exposure: [{ symbol: 'AAA', market_value: 6_000 }],
    spot_by_symbol: {}, ...overrides,
  };
}

test('review selects the nearest listed 14 / 30 / 45 DTE expirations once', () => {
  const contracts = [8, 13, 15, 29, 31, 44, 46].map((dte) => option({ dte }));
  assert.deepEqual(nearestListedDtes(contracts), [13, 29, 44]);
  assert.deepEqual([...new Set(contractsAtReviewTenors(contracts).map((row) => row.dte))],
    [13, 29, 44]);
});

test('portfolio review uses executable bid, one contract, RAW economics, and visible policy stamps', () => {
  const result = calculatePortfolioReviewSymbol({
    symbol: 'AAA', spot: 100, historyBars: history(),
    contracts: [option({ symbol: 'AAA', right: 'put', strike: 95, dte: 14, bid: 1.5 }),
      option({ symbol: 'AAA', right: 'call', strike: 105, dte: 14, bid: 1.25 })],
    freeCoveredCallContracts: 2, samples: 400, seed: 'review-math', now: NOW,
    book: book(),
  });
  assert.equal(result.state, 'POLICY_BLOCK');
  assert.equal(result.rows.length, 2);
  const put = result.rows.find((row) => row.structure === 'CSP');
  const call = result.rows.find((row) => row.structure === 'COVERED_CALL');
  assert.equal(put.net_credit, 149.35);
  assert.equal(call.net_credit, 124.35);
  assert.equal(put.gross_assignment_obligation, 9_500);
  assert.equal(call.gross_assignment_obligation, 0);
  assert.equal(call.net_tied_cash, 0);
  assert.equal(Object.hasOwn(call, 'cash_carry_cost_0'), false);
  assert.equal(Object.hasOwn(call, 'cash_adjusted_nev_0'), false);
  assert.equal(JSON.stringify(call).includes('CASH_CARRY'), false);
  assert.ok(Number.isFinite(put.primary_raw_nev_0));
  assert.ok(Number.isFinite(put.primary_standard_error));
  assert.equal(put.policy.status, 'POLICY_BLOCK');
  assert.ok(put.policy.reasons.includes('DEPLOYED_CAP_EXCEEDED'));
  assert.ok(put.policy.reasons.includes('CASH_RESERVE_BELOW_FLOOR'));
  assert.equal(result.rows.includes(put), true, 'policy-blocked math must remain visible');
  assert.equal(put.gamma.policy_effect,
    'INFORMATIONAL_ONLY_GAMMA_PCT_NAV_DIMENSIONAL_LOCK_OPEN');
  assert.ok(Math.abs(put.gamma.dollar_gamma_for_one_percent_move - (-1.25)) < 1e-12);
});

test('one HISTORY_SHORT symbol does not refuse a cycle when a peer calculates', () => {
  const contracts = [option({ symbol: 'AAA', dte: 14, bid: 20, ask: 20.1 }),
    option({ symbol: 'AAA', dte: 30, bid: 20, ask: 20.1 }),
    option({ symbol: 'AAA', dte: 45, bid: 20, ask: 20.1 })];
  const result = compilePortfolioReview({
    symbols: ['AAA', 'IPO'], session: 'RTH', samples: 300, now: NOW,
    book: book({ nav: 100_000, settled_cash: 100_000, deployed_pct: 0,
      cash_reserve_pct: 1, underlying_exposure: [] }),
    packets: {
      AAA: { spot: 100, contracts, historyBars: history(), events: [] },
      IPO: { spot: 50, contracts: contracts.map((row) => ({ ...row, symbol: row.symbol.replace('AAA', 'IPO') })),
        historyBars: history(76, 50), events: [] },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'PORTFOLIO_REVIEW_COMPLETE');
  assert.equal(result.counts.calculated_symbols, 1);
  assert.equal(result.counts.refused_symbols, 1);
  assert.equal(result.per_symbol.find((row) => row.symbol === 'AAA').state, 'CALCULATED');
  assert.equal(result.per_symbol.find((row) => row.symbol === 'IPO').reason_codes[0],
    'HISTORY_SHORT');
  assert.ok(result.rows.every((row) => row.underlying === 'AAA'));
});

test('a symbol breaching every reference limit still completes the review with visible rows', () => {
  const result = compilePortfolioReview({
    symbols: ['AAA'], session: 'RTH', samples: 300, now: NOW,
    structures: ['CSP'], book: book(),
    packets: {
      AAA: {
        spot: 100,
        contracts: [option({ symbol: 'AAA', right: 'put', strike: 95, dte: 14,
          bid: 2.4, ask: 2.5 })],
        historyBars: history(), events: [],
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'PORTFOLIO_REVIEW_COMPLETE');
  assert.equal(result.per_symbol[0].state, 'POLICY_BLOCK');
  assert.equal(result.counts.calculated_symbols, 1);
  assert.equal(result.counts.policy_block_symbols, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].policy.effect,
    'VISIBLE_STAMP_ONLY_ROW_REMAINS_VISIBLE_NO_ORDER_ROUTE');
});

test('closed session is NOT_EVALUATED and never NO ELIGIBLE', () => {
  const result = compilePortfolioReview({
    symbols: ['AAA'], session: 'CLOSED', now: NOW,
    packets: { AAA: { spot: 100, contracts: [option()], historyBars: history() } },
  });
  assert.equal(result.outcome, 'NOT_EVALUATED');
  assert.equal(result.per_symbol[0].state, 'NOT_EVALUATED');
  assert.equal(JSON.stringify(result).includes('NO_ELIGIBLE'), false);
  assert.equal(result.mutation_eligible, false);
});

test('ranking is isolated to each structure and expiration', () => {
  const result = calculatePortfolioReviewSymbol({
    symbol: 'AAA', spot: 100, historyBars: history(), freeCoveredCallContracts: 1,
    contracts: [
      option({ symbol: 'AAA', right: 'put', strike: 90, dte: 14, bid: 0.8 }),
      option({ symbol: 'AAA', right: 'put', strike: 95, dte: 14, bid: 2.4 }),
      option({ symbol: 'AAA', right: 'call', strike: 105, dte: 14, bid: 2.2 }),
      option({ symbol: 'AAA', right: 'call', strike: 110, dte: 14, bid: 1.0 }),
    ], samples: 300, seed: 'rank-groups', now: NOW, book: book({
      nav: 100_000, settled_cash: 100_000, deployed_pct: 0,
      cash_reserve_pct: 1, underlying_exposure: [],
    }),
  });
  const groups = Object.groupBy(result.rows, (row) => row.rank_group);
  for (const rows of Object.values(groups)) {
    assert.deepEqual(rows.map((row) => row.rank_within_structure_and_expiry), [1, 2]);
    assert.ok(rows[0].primary_raw_nev_0 >= rows[1].primary_raw_nev_0);
  }
});
