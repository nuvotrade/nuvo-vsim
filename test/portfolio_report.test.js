import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  matchRealizedTrades, performanceFromBrokerRows, portfolioFromCustody, transactionFills,
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
      ],
    };
    const analytics = new Map([
      ['ABC260918C00130000', { theta: -0.05, asof: custody.observedAt }],
      ['XYZ260918P00050000', { theta: -0.03, asof: custody.observedAt }],
    ]);
    const report = portfolioFromCustody(custody, analytics);
    assert.equal(report.account.cash, -30000);
    assert.equal(report.account.margin_debit, 30000);
    assert.equal(report.account.buying_power, 95000);
    assert.equal(report.inventory[0].covered_call_capacity, 1);
    assert.equal(report.summary.booked_premium, 800);
    assert.equal(report.summary.income_theta_per_day, 13);
    assert.equal(report.harvest.find(row => row.type === 'CASH_SECURED_PUT').capital_committed, 5000);
    assert.ok(!report.capital_committed.some(row => row.symbol === 'CASH'));
  });
});
