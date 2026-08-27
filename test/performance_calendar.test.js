import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { nyseFullDayClosures, performanceFromBrokerRows, realizedPnlCalendar } from '../cloudflare/portfolio-report.js';
import { liveDashboardScript, rewriteDesignHtml } from '../cloudflare/worker.js';

function transaction(activityId, time, transferItems) {
  return { activityId, orderId: `ORDER-${activityId}`, type: 'TRADE', time, transferItems };
}

function equity(symbol, amount, cost, positionEffect) {
  return { amount, cost, price: Math.abs(cost / amount), positionEffect,
    instrument: { assetType: 'EQUITY', symbol } };
}

function option(symbol, underlying, right, amount, cost, positionEffect) {
  return { amount, cost, price: Math.abs(cost / (amount * 100)), positionEffect,
    instrument: { assetType: 'OPTION', symbol, underlyingSymbol: underlying, putCall: right } };
}

function matchedReport() {
  const packets = [
    transaction('SHARE-OPEN', '2026-07-30T15:00:00Z', [equity('ABC', 1, -100, 'OPENING')]),
    transaction('CALL-OPEN', '2026-08-05T15:00:00Z', [option('ABC260918C00120000', 'ABC', 'CALL', -1, 100, 'OPENING')]),
    transaction('LONG-OPEN', '2026-08-07T15:00:00Z', [option('XYZ260918C00050000', 'XYZ', 'CALL', 1, -100, 'OPENING')]),
    transaction('BOUNDARY-OPEN', '2026-08-28T15:00:00Z', [equity('LATE', 1, -10, 'OPENING')]),
    transaction('SHARE-CLOSE', '2026-08-06T15:00:00Z', [equity('ABC', -1, 199, 'CLOSING')]),
    transaction('CALL-CLOSE', '2026-08-06T16:00:00Z', [option('ABC260918C00120000', 'ABC', 'CALL', 1, -50, 'CLOSING')]),
    transaction('LONG-CLOSE', '2026-08-11T15:00:00Z', [option('XYZ260918C00050000', 'XYZ', 'CALL', -1, 75, 'CLOSING')]),
    // UTC September 1 is still August 31 in New York and must remain in the August ledger filter.
    transaction('BOUNDARY-CLOSE', '2026-09-01T01:30:00Z', [equity('LATE', -1, 30, 'CLOSING')]),
  ];
  return performanceFromBrokerRows(packets.map((packet) => ({
    transaction_id: packet.activityId, raw_json: JSON.stringify(packet),
  })));
}

describe('realized P&L calendar', () => {
  test('stamps the canonical New York close date in the shared FIFO report', () => {
    const report = matchedReport();
    const boundary = report.trades.find((trade) => trade.underlying === 'LATE');
    assert.equal(boundary.closed_at, '2026-09-01T01:30:00.000Z');
    assert.equal(boundary.closed_date, '2026-08-31');
    assert.equal(report.summary.closed_date_timezone, 'America/New_York');
    assert.equal(report.curve.find((point) => point.trade_id === boundary.trade_id).closed_date, '2026-08-31');
  });

  test('returns one month with all strategies by default and CC/CSP as the secondary scope', () => {
    const report = matchedReport();
    const all = realizedPnlCalendar(report.trades, {
      month: '2026-08', scope: 'ALL', now: '2026-08-26T20:00:00Z',
    });
    assert.equal(all.summary.net, 124);
    assert.equal(all.summary.profit, 149);
    assert.equal(all.summary.loss, -25);
    assert.equal(all.summary.closed_trades, 3);
    assert.equal(all.days.reduce((sum, day) => sum + Number(day.pnl || 0), 0), all.summary.net);
    assert.equal(all.by_ticker.reduce((sum, row) => sum + row.realized_pnl, 0), all.summary.net);
    assert.equal(all.by_strategy.reduce((sum, row) => sum + row.realized_pnl, 0), all.summary.net);
    assert.deepEqual(all.reconciliation, {
      status: 'MATCH', cell_total: 124, ticker_attribution_total: 124, strategy_attribution_total: 124,
    });
    assert.deepEqual(all.days.find((day) => day.date === '2026-08-06'), {
      date: '2026-08-06', day: 6, weekday: 'Thu', state: 'CLOSES', pnl: 149,
      trades: 2, trade_ids: all.days.find((day) => day.date === '2026-08-06').trade_ids,
    });
    assert.equal(all.days.find((day) => day.date === '2026-08-03').state, 'ZERO');
    assert.equal(all.days.find((day) => day.date === '2026-08-03').pnl, 0);
    assert.equal(all.days.find((day) => day.date === '2026-08-27').state, 'FUTURE');
    assert.equal(all.days.some((day) => day.weekday === 'Sat' || day.weekday === 'Sun'), false);

    const mandate = realizedPnlCalendar(report.trades, {
      month: '2026-08', scope: 'IN_MANDATE', now: '2026-08-26T20:00:00Z',
    });
    assert.equal(mandate.summary.net, 50);
    assert.equal(mandate.summary.closed_trades, 1);
    assert.equal(mandate.days.find((day) => day.date === '2026-08-06').trades, 1);

    const afterOpen = realizedPnlCalendar(report.trades, {
      month: '2026-08', scope: 'ALL', now: '2026-08-27T14:00:00Z',
    });
    assert.equal(afterOpen.days.find((day) => day.date === '2026-08-27').state, 'ZERO');
  });

  test('treats full closures as empty and early closes as trading days', () => {
    assert.equal(nyseFullDayClosures(2026).has('2026-07-03'), true);
    const july = realizedPnlCalendar([], { month: '2026-07', now: '2026-12-01T17:00:00Z' });
    assert.equal(july.days.find((day) => day.date === '2026-07-03').state, 'HOLIDAY');
    const november = realizedPnlCalendar([], { month: '2026-11', now: '2026-12-01T17:00:00Z' });
    assert.equal(november.days.find((day) => day.date === '2026-11-27').state, 'ZERO');
  });

  test('keeps a future New York close empty until that market date arrives', () => {
    const packets = [
      transaction('BOUNDARY-OPEN', '2026-08-26T15:00:00Z', [equity('BOUNDARY', 1, -10, 'OPENING')]),
      transaction('BOUNDARY-CLOSE', '2026-08-28T00:30:00Z', [equity('BOUNDARY', -1, 20, 'CLOSING')]),
      transaction('FRIDAY-OPEN', '2026-08-27T15:00:00Z', [option('ABC260828C00100000', 'ABC', 'CALL', -1, 100, 'OPENING')]),
      transaction('FRIDAY-CLOSE', '2026-08-28T14:00:00Z', [option('ABC260828C00100000', 'ABC', 'CALL', 1, -25, 'CLOSING')]),
    ];
    const report = performanceFromBrokerRows(packets.map((packet) => ({
      transaction_id: packet.activityId, raw_json: JSON.stringify(packet),
    })));
    assert.equal(report.trades.find((trade) => trade.underlying === 'BOUNDARY').closed_date, '2026-08-27',
      '00:30 UTC must remain on the prior New York market date');
    assert.equal(report.trades.find((trade) => trade.underlying === 'ABC').closed_date, '2026-08-28');

    const beforeFriday = realizedPnlCalendar(report.trades, {
      month: '2026-08', now: '2026-08-27T17:00:00Z',
    });
    assert.equal(beforeFriday.days.find((day) => day.date === '2026-08-28').state, 'FUTURE');
    assert.equal(beforeFriday.days.find((day) => day.date === '2026-08-28').pnl, null);
    assert.equal(beforeFriday.summary.net, 10);
    assert.equal(beforeFriday.reconciliation.status, 'MATCH');

    const onFriday = realizedPnlCalendar(report.trades, {
      month: '2026-08', now: '2026-08-28T17:00:00Z',
    });
    assert.equal(onFriday.days.find((day) => day.date === '2026-08-28').state, 'CLOSES');
    assert.equal(onFriday.days.find((day) => day.date === '2026-08-28').pnl, 75);
    assert.equal(onFriday.days.find((day) => day.date === '2026-08-28').trades, 1);
    assert.equal(onFriday.summary.net, 85);
  });

  test('ships an embedded calendar with one shared URL-backed ledger filter', () => {
    const rewriteSource = rewriteDesignHtml.toString();
    assert.match(rewriteSource, /Realized P&amp;L calendar/u);
    assert.match(rewriteSource, /data-pnl-calendar-scope="ALL"/u);
    assert.match(rewriteSource, /data-vsim="pnl-calendar-grid"/u);
    const source = liveDashboardScript();
    assert.match(source, /\/api\/performance\/calendar\?month=/u);
    assert.match(source, /item\.closed_date \|\| filterDate\(item\.closed_at\)/u);
    assert.match(source, /data-performance-date/u);
    assert.match(source, /commitPerformanceState/u);
    assert.match(source, /window\.history\[/u);
    assert.match(source, /popstate/u);
    assert.match(source, /largest_absolute_day/u);
    assert.match(source, /daily cells = monthly ticker attribution = monthly strategy attribution/u);
    assert.match(source, /Lifetime · matched closed trades/u);
    assert.match(source, /RECONCILED/u);
    assert.match(source, /DRIFT: cells/u);
    assert.match(source, /Filtered ·/u);
    assert.doesNotMatch(source, /calendar\.trades/u);
  });
});
