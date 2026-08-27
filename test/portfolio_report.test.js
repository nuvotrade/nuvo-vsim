import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  COVERED_CALL_REVIEW_EXPIRY_DTE, matchRealizedTrades, performanceFromBrokerRows,
  portfolioFromCustody, transactionFills,
} from '../cloudflare/portfolio-report.js';

function packet(overrides = {}) {
  return {
    activityId: 'TX-1', orderId: 'ORDER-1', type: 'TRADE', time: '2026-08-26T15:00:00Z',
    transferItems: [
      { amount: 100, cost: -1000, price: 10, positionEffect: 'OPENING',
        instrument: { assetType: 'EQUITY', symbol: 'ABC' } },
      { amount: 1, cost: -1, feeType: 'COMMISSION', instrument: { assetType: 'CURRENCY' } },
    ],
    ...overrides,
  };
}

describe('canonical Schwab portfolio and performance reporting', () => {
  test('security fills allocate fees once and preserve the broker cash flow', () => {
    const fills = transactionFills(packet());
    assert.equal(fills.length, 1);
    assert.equal(fills[0].cash_flow, -1001);
    assert.equal(fills[0].fees, 1);

    const multi = transactionFills(packet({ transferItems: [
      { amount: -1, cost: 200, price: 2, positionEffect: 'OPENING',
        instrument: { assetType: 'OPTION', symbol: 'ABC  260918C00010000', underlyingSymbol: 'ABC' } },
      { amount: 1, cost: -50, price: 0.5, positionEffect: 'OPENING',
        instrument: { assetType: 'OPTION', symbol: 'ABC  260918C00012000', underlyingSymbol: 'ABC' } },
      { amount: 1, cost: -1.25, feeType: 'COMMISSION', instrument: { assetType: 'CURRENCY' } },
    ] }));
    assert.equal(multi.length, 2);
    assert.ok(Math.abs(multi.reduce((sum, fill) => sum + fill.cash_flow, 0) - 148.75) < 1e-9);
    assert.ok(Math.abs(multi.reduce((sum, fill) => sum + fill.fees, 0) - 1.25) < 1e-9);
  });

  test('FIFO matching handles long and short lifecycles without inventing missing entries', () => {
    const long = transactionFills(packet());
    const close = transactionFills(packet({ activityId: 'TX-2', time: '2026-08-27T15:00:00Z',
      transferItems: [{ amount: -100, cost: 1200, price: 12, positionEffect: 'CLOSING',
        instrument: { assetType: 'EQUITY', symbol: 'ABC' } }] }));
    const result = matchRealizedTrades([...long, ...close]);
    assert.equal(result.trades.length, 1);
    assert.equal(result.trades[0].realized_pnl, 199);

    const unmatched = matchRealizedTrades(close);
    assert.equal(unmatched.trades.length, 0);
    assert.equal(unmatched.unmatched[0].reason, 'OPENING_LEG_NOT_IN_IMPORTED_HISTORY');

    const shortOpen = transactionFills(packet({ activityId: 'TX-3',
      transferItems: [{ amount: -1, cost: 250, price: 2.5, positionEffect: 'OPENING',
        instrument: { assetType: 'OPTION', symbol: 'ABC260918C00015000', underlyingSymbol: 'ABC', putCall: 'CALL' } }] }));
    const shortClose = transactionFills(packet({ activityId: 'TX-4', time: '2026-08-28T15:00:00Z',
      transferItems: [{ amount: 1, cost: -100, price: 1, positionEffect: 'CLOSING',
        instrument: { assetType: 'OPTION', symbol: 'ABC260918C00015000', underlyingSymbol: 'ABC', putCall: 'CALL' } }] }));
    assert.equal(matchRealizedTrades([...shortOpen, ...shortClose]).trades[0].realized_pnl, 150);
  });

  test('performance totals are derived from deduplicated raw broker packets', () => {
    const open = packet();
    const close = packet({ activityId: 'TX-2', time: '2026-08-27T15:00:00Z',
      transferItems: [{ amount: -100, cost: 1200, price: 12, positionEffect: 'CLOSING',
        instrument: { assetType: 'EQUITY', symbol: 'ABC' } }] });
    const rows = [{ transaction_id: 'TX-1', raw_json: JSON.stringify(open) },
      { transaction_id: 'TX-1', raw_json: JSON.stringify(open) },
      { transaction_id: 'TX-2', raw_json: JSON.stringify(close) }];
    const report = performanceFromBrokerRows(rows, { currentUnrealized: 25 });
    assert.equal(report.summary.realized_pnl, 199);
    assert.equal(report.summary.total_pnl, 224);
    assert.equal(report.summary.closed_trades, 1);
    assert.equal(report.summary.win_rate, 1);
    assert.equal(report.fills.length, 2);
    assert.equal(report.trades[0].strategy, 'SHARES');
    assert.equal(report.trades[0].mandate_bucket, 'MANDATE_COMPATIBLE');
    assert.equal(report.by_strategy[0].closed_trades, 1);
    assert.equal(report.mandate_view.mandate_compatible.realized_pnl, 199);
    assert.equal(report.mandate_view.structure_review.closed_trades, 0);
  });

  test('MTD realized premium includes only covered-call and CSP closures in the Pacific calendar month', () => {
    const optionPacket = ({ activityId, time, symbol, underlying, right, amount, cost, price,
      positionEffect, fee = 0 }) => packet({
      activityId, time,
      transferItems: [
        { amount, cost, price, positionEffect,
          instrument: { assetType: 'OPTION', symbol, underlyingSymbol: underlying, putCall: right } },
        ...(fee ? [{ amount: 1, cost: -fee, feeType: 'COMMISSION',
          instrument: { assetType: 'CURRENCY' } }] : []),
      ],
    });
    const packets = [
      optionPacket({ activityId: 'CALL-OPEN', time: '2026-08-21T20:00:00Z', symbol: 'ABC260918C00130000',
        underlying: 'ABC', right: 'CALL', amount: -1, cost: 300, price: 3, positionEffect: 'OPENING' }),
      optionPacket({ activityId: 'CALL-CLOSE', time: '2026-08-25T20:00:00Z', symbol: 'ABC260918C00130000',
        underlying: 'ABC', right: 'CALL', amount: 1, cost: -100, price: 1, positionEffect: 'CLOSING', fee: 1 }),
      optionPacket({ activityId: 'PUT-OPEN', time: '2026-08-20T20:00:00Z', symbol: 'XYZ260918P00050000',
        underlying: 'XYZ', right: 'PUT', amount: -1, cost: 200, price: 2, positionEffect: 'OPENING' }),
      optionPacket({ activityId: 'PUT-CLOSE', time: '2026-08-26T20:00:00Z', symbol: 'XYZ260918P00050000',
        underlying: 'XYZ', right: 'PUT', amount: 1, cost: -50, price: 0.5, positionEffect: 'CLOSING' }),
      optionPacket({ activityId: 'LONG-OPEN', time: '2026-08-24T20:00:00Z', symbol: 'DEF260918C00050000',
        underlying: 'DEF', right: 'CALL', amount: 1, cost: -100, price: 1, positionEffect: 'OPENING' }),
      optionPacket({ activityId: 'LONG-CLOSE', time: '2026-08-26T21:00:00Z', symbol: 'DEF260918C00050000',
        underlying: 'DEF', right: 'CALL', amount: -1, cost: 140, price: 1.4, positionEffect: 'CLOSING' }),
      optionPacket({ activityId: 'OLD-OPEN', time: '2026-07-29T20:00:00Z', symbol: 'OLD260918C00050000',
        underlying: 'OLD', right: 'CALL', amount: -1, cost: 100, price: 1, positionEffect: 'OPENING' }),
      optionPacket({ activityId: 'OLD-CLOSE', time: '2026-07-31T20:00:00Z', symbol: 'OLD260918C00050000',
        underlying: 'OLD', right: 'CALL', amount: 1, cost: -25, price: 0.25, positionEffect: 'CLOSING' }),
    ];
    const rows = packets.map((value) => ({ transaction_id: value.activityId, raw_json: JSON.stringify(value) }));
    const report = performanceFromBrokerRows(rows, { now: '2026-08-26T23:00:00Z' });
    assert.equal(report.summary.mtd_realized_premium, 349);
    assert.equal(report.summary.mtd_realized_premium_trades, 2);
    assert.equal(report.summary.mtd_period_start, '2026-08-01');
    assert.equal(report.summary.mtd_period_end_exclusive, '2026-09-01');
    assert.equal(report.summary.mtd_timezone, 'America/Los_Angeles');
    assert.equal(report.by_strategy.find((row) => row.strategy === 'SHORT_CALL').closed_trades, 2);
    assert.equal(report.by_strategy.find((row) => row.strategy === 'SHORT_PUT').closed_trades, 1);
    assert.equal(report.by_strategy.find((row) => row.strategy === 'LONG_CALL').closed_trades, 1);
    assert.equal(report.mandate_view.mandate_compatible.closed_trades, 3);
    assert.equal(report.mandate_view.mandate_compatible.realized_pnl, 424);
    assert.equal(report.mandate_view.structure_review.closed_trades, 1);
    assert.equal(report.mandate_view.structure_review.realized_pnl, 40);
  });

  test('portfolio separates cash, margin and buying power and reports option income facts', () => {
    const custody = {
      observedAt: '2026-08-26T15:00:00Z',
      account: { nav: 100000, cash: -30000, marginDebit: 30000, buyingPower: 95000, withdrawableCash: 0 },
      positions: [
        { type: 'EQUITY', symbol: 'ABC', quantity: 300, multiplier: 1, averagePrice: 100, marketValue: 36000 },
        { type: 'OPTION', symbol: 'ABC260918C00130000', underlying: 'ABC', right: 'call',
          quantity: -2, multiplier: 100, averagePrice: 3, marketValue: -400, strike: 130, expiration: '2026-09-18' },
        { type: 'OPTION', symbol: 'XYZ260918P00050000', underlying: 'XYZ', right: 'put',
          quantity: -1, multiplier: 100, averagePrice: 2, marketValue: -150, strike: 50, expiration: '2026-09-18' },
        { type: 'OPTION', symbol: 'DEF260918P00040000', underlying: 'DEF', right: 'put',
          quantity: 1, multiplier: 100, averagePrice: 1, marketValue: 80, strike: 40, expiration: '2026-09-18' },
      ],
    };
    const analytics = new Map([
      ['ABC260918C00130000', { theta: -0.05, asof: custody.observedAt }],
      ['XYZ260918P00050000', { theta: -0.03, asof: custody.observedAt }],
      ['DEF260918P00040000', { theta: -0.02, asof: custody.observedAt }],
    ]);
    const report = portfolioFromCustody(custody, analytics);
    assert.equal(report.account.cash, -30000);
    assert.equal(report.account.margin_debit, 30000);
    assert.equal(report.account.buying_power, 95000);
    assert.equal(report.inventory[0].covered_call_capacity, 1);
    assert.equal(report.inventory[0].covered_call_actionable, true);
    assert.equal(report.inventory[0].covered_call_blocker, null);
    assert.equal(report.summary.booked_premium, 800);
    assert.equal(report.account.position_equity, 100800);
    assert.equal(report.summary.income_theta_per_day, 13);
    assert.equal(report.summary.net_theta_per_day, 11);
    assert.equal(report.harvest.find(row => row.type === 'CASH_SECURED_PUT').capital_committed, 5000);
    assert.ok(!report.capital_committed.some(row => row.symbol === 'CASH'));
  });

  test('working broker orders make covered-call inventory non-actionable', () => {
    const report = portfolioFromCustody({
      observedAt: '2026-08-26T15:00:00Z',
      account: { nav: 20_000, cash: 1_000 },
      positions: [{
        type: 'EQUITY', symbol: 'ABC', quantity: 200, averagePrice: 80, marketValue: 20_000,
      }],
      openOrders: [{ brokerOrderId: 'working-1', symbol: 'ABC', side: 'BUY' }],
    });
    assert.equal(report.inventory[0].covered_call_capacity, 2);
    assert.equal(report.inventory[0].covered_call_actionable, false);
    assert.equal(report.inventory[0].covered_call_blocker, 'OPEN_ORDER_RECONCILIATION_REQUIRED');
  });

  test('an unrelated working order does not encumber another ticker covered-call capacity', () => {
    const report = portfolioFromCustody({
      observedAt: '2026-08-26T15:00:00Z',
      account: { nav: 20_000, cash: 1_000 },
      positions: [{
        type: 'EQUITY', symbol: 'ABC', quantity: 200, averagePrice: 80, marketValue: 20_000,
      }],
      openOrders: [{ brokerOrderId: 'working-1', symbol: 'XYZ', side: 'BUY' }],
    });
    assert.equal(report.inventory[0].covered_call_capacity, 2);
    assert.equal(report.inventory[0].covered_call_actionable, true);
    assert.equal(report.inventory[0].covered_call_blocker, null);
  });

  test('builds the expiry ladder and guardrail gauges from Schwab custody', () => {
    const observedAt = '2026-08-27T03:26:29.035Z';
    const report = portfolioFromCustody({
      observedAt,
      account: {
        nav: 167_242.68,
        cash: 3_467.68,
        accounts: [{ accountMask: '4315' }],
      },
      positions: [
        { type: 'EQUITY', symbol: 'CBRS', quantity: 500, averagePrice: 202.95, marketValue: 93_520 },
        { type: 'OPTION', symbol: 'CBRS260828C00210000', underlying: 'CBRS', right: 'call',
          quantity: -5, multiplier: 100, averagePrice: 0.56, marketValue: -212.5,
          strike: 210, expiration: '2026-08-28' },
        { type: 'EQUITY', symbol: 'SPCX', quantity: 500, averagePrice: 145.18, marketValue: 70_100 },
        { type: 'OPTION', symbol: 'SPCX260828C00143000', underlying: 'SPCX', right: 'call',
          quantity: -5, multiplier: 100, averagePrice: 1.35, marketValue: -738,
          strike: 143, expiration: '2026-08-28' },
      ],
    }, new Map([
      ['CBRS260828C00210000', {
        theta: -0.03, iv: 0.44, spot: 187.04, asof: observedAt, freshness: 'LAST_MARKET_QUOTE',
      }],
      ['SPCX260828C00143000', {
        theta: -0.06, iv: 0.28, spot: 140.20, asof: observedAt, freshness: 'LAST_MARKET_QUOTE',
      }],
    ]), { limits: {
      version: 'constitution-v5.2.1',
      maxExpirationPct: 0.25,
      maxSingleUnderlyingPct: 0.20,
      minReservePct: 0.20,
      maxDeployedPct: 0.65,
    } });

    const w1 = report.risk_instrumentation.expiration_ladder.find((row) => row.bucket === 'W1');
    assert.equal(w1.contracts, 10);
    assert.equal(w1.value, 163_620);
    assert.equal(w1.pct, 163_620 / 167_242.68);
    assert.equal(w1.limit_pct, 0.25);
    assert.equal(w1.breached, true);
    assert.equal(report.risk_instrumentation.cash_reserve_pct, 3_467.68 / 167_242.68);
    assert.equal(report.risk_instrumentation.reserve_breached, true);
    assert.equal(report.risk_instrumentation.deployed_breached, true);
    assert.deepEqual(report.risk_instrumentation.custody_scope.account_masks, ['4315']);
    assert.equal(report.risk_instrumentation.custody_scope.product_surface, 'EQUITIES_AND_OPTIONS');
    assert.ok(report.capital_committed.filter((row) => row.symbol !== 'CASH')
      .every((row) => row.limit_pct === 0.20 && row.breached));
    assert.equal(report.risk_instrumentation.limits_version, 'constitution-v5.2.1');
    assert.equal(report.summary.share_open_pnl, -10_445);
    assert.equal(report.summary.option_open_pnl, 4.5);
    assert.equal(report.summary.open_pnl, -10_440.5);

    const cbrs = report.harvest.find((row) => row.symbol === 'CBRS');
    assert.equal(cbrs.dte, 2);
    assert.ok(Math.abs(cbrs.distance_to_strike_dollars - 22.96) < 1e-9);
    assert.ok(Math.abs(cbrs.distance_to_strike_pct - (22.96 / 187.04)) < 1e-12);
    assert.ok(cbrs.distance_to_strike_sigma > 1);
    assert.equal(cbrs.quote_freshness, 'LAST_MARKET_QUOTE');
  });

  test('builds fact-only covered-call reviews with exact accounting and no ranked action', () => {
    const observedAt = '2026-08-27T20:00:00.000Z';
    const optionSymbol = 'SPCX260828C00143000';
    const report = portfolioFromCustody({
      hash: 'custody-hash-1', observedAt,
      account: { nav: 164_440.52, cash: 3_433.02, accounts: [{ accountMask: '4315' }] },
      positions: [
        { type: 'EQUITY', symbol: 'SPCX', quantity: 500, averagePrice: 145.18, marketValue: 70_500 },
        { type: 'OPTION', symbol: optionSymbol, underlying: 'SPCX', right: 'call',
          quantity: -5, multiplier: 100, averagePrice: 1.35, marketValue: -510,
          strike: 143, expiration: '2026-08-28' },
      ],
      openOrders: [],
    }, new Map([[optionSymbol, {
      bid: 1, ask: 1.05, theta: -0.04, iv: 0.28, spot: 141,
      dividendYield: 0.012, source: 'SCHWAB_MARKET_DATA_OPTION_QUOTE_REALTIME',
      asof: observedAt, freshness: 'CURRENT',
    }]]), { limits: {
      version: 'constitution-test', maxSingleUnderlyingPct: 0.20,
      maxExpirationPct: 0.25, minReservePct: 0.20, maxDeployedPct: 0.80,
      riskFreeRate: 0.045,
    } });

    assert.equal(COVERED_CALL_REVIEW_EXPIRY_DTE, 2);
    assert.equal(report.covered_call_reviews.length, 1);
    const review = report.covered_call_reviews[0];
    assert.equal(review.review_status, 'REVIEW_REQUIRED');
    assert.equal(review.lifecycle_status, 'C1_UNSPECIFIED_NO_ACTION_RANKED');
    assert.equal(review.custody_hash, 'custody-hash-1');
    assert.deepEqual(review.reasons.map((reason) => reason.code), [
      'EXPIRY_PROXIMITY', 'SHORT_CALL_BELOW_SHARE_BASIS', 'CONCENTRATION_BREACH',
    ]);
    assert.equal(review.reasons[2].classification, 'PREEXISTING_NONCONFORMING');
    assert.equal(review.measurements.distance_to_strike_dollars.value, 2);
    assert.equal(review.measurements.distance_to_strike_pct.value, 2 / 141);
    assert.equal(review.measurements.theta_per_day.value, 20);
    assert.equal(review.measurements.broker_average_price.value, 145.18);
    assert.equal(review.measurements.strike_vs_broker_average.value, -2.18);
    assert.equal(review.measurements.entry_credit.value, 675);
    assert.equal(review.measurements.marked_liability.value, 510);
    assert.equal(review.measurements.unrealized_option_pnl.value, 165);
    assert.equal(review.measurements.btc_ask_per_share.value, 1.05);
    assert.equal(review.measurements.btc_ask_notional.value, 525);
    assert.equal(review.measurements.btc_estimated_fees.value, 4);
    assert.equal(review.measurements.btc_total_estimate.value, 529);
    assert.ok(Math.abs(review.measurements.risk_neutral_probability_otm.value
      - 0.8320228299785722) < 1e-14);
    assert.equal(review.measurements.risk_neutral_probability_otm.source, 'BLACK_SCHOLES_STRIKE_IV');
    assert.match(review.measurements.risk_neutral_probability_otm.derivation, /1 - N\(d2\)/u);
    assert.deepEqual(review.measurements.risk_neutral_probability_otm.inputs, {
      spot: 141, strike: 143, strike_iv: 0.28, dte: 1,
      risk_free_rate: 0.045, dividend_yield: 0.012,
    });
    assert.equal(review.approximation_note, 'European approximation; excludes early exercise.');
    assert.doesNotMatch(JSON.stringify(review),
      /\b(?:EXIT|ROLL|HOLD|POP|ACTION_REQUIRED|ACTION_RECOMMENDED|BEST ACTION|RECOMMEND|BUY TO CLOSE|SELL SHARES|CLOSE NOW)\b/iu);
  });

  test('omits risk-neutral probability without a verified dividend input and uses actual multipliers', () => {
    const observedAt = '2026-08-27T20:00:00.000Z';
    const optionSymbol = 'ADJ260828C00143000';
    const report = portfolioFromCustody({
      observedAt, account: { nav: 20_000, cash: 2_000 },
      positions: [
        { type: 'EQUITY', symbol: 'ADJ', quantity: 100, averagePrice: 140, marketValue: 14_100 },
        { type: 'OPTION', symbol: optionSymbol, underlying: 'ADJ', right: 'call',
          quantity: -2, multiplier: 10, averagePrice: 2.5, marketValue: -30,
          strike: 143, expiration: '2026-08-28' },
      ], openOrders: [],
    }, new Map([[optionSymbol, {
      ask: 2, theta: -0.02, iv: 0.28, spot: 141,
      source: 'SCHWAB_MARKET_DATA_OPTION_QUOTE_REALTIME', asof: observedAt, freshness: 'CURRENT',
    }]]), { limits: { maxSingleUnderlyingPct: 0.20, riskFreeRate: 0.045 } });

    const review = report.covered_call_reviews[0];
    assert.equal(review.measurements.btc_ask_notional.value, 40);
    assert.equal(review.measurements.btc_estimated_fees.value, 1.6);
    assert.equal(review.measurements.btc_total_estimate.value, 41.6);
    assert.equal(review.measurements.risk_neutral_probability_otm.status, 'UNAVAILABLE');
    assert.equal(review.measurements.risk_neutral_probability_otm.value, null);
    assert.equal(review.measurements.risk_neutral_probability_otm.reason, 'DIVIDEND_YIELD_UNVERIFIED');
  });
});
