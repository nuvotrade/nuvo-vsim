import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLane1BotSummary, lane1EventLedger, projectLane1LedgerRow,
} from '../cloudflare/lane-1-event-ledger.js';
import { liveDashboardScript, rewriteDesignHtml } from '../cloudflare/worker.js';

function row(eventType, detail, createdAt, id = crypto.randomUUID()) {
  return { id, event_type: eventType, detail_json: JSON.stringify(detail), created_at: createdAt };
}

function environment(d1Rows, coordinatorRows = [], coordinatorState = {
  armed: false, stage: 'DISARMED', positionSide: 'FLAT', latestUnit: null, fault: null,
}) {
  let writes = 0;
  const DB = { prepare(sql) {
    assert.match(sql, /^SELECT /u);
    return { bind() { return { async all() { return { results: d1Rows }; },
      async run() { writes += 1; throw new Error('WRITE_NOT_ALLOWED'); } }; } };
  } };
  const coordinator = { async laneV2History() {
    return { appendOnly: true, readOnly: true, events: coordinatorRows };
  }, async laneV2Status() { return structuredClone(coordinatorState); } };
  return { env: { DB, ACCOUNT_COORDINATOR: { getByName: () => coordinator } },
    writes: () => writes };
}

test('Lane 1 projection preserves raw side and never backfills an accepted instruction', () => {
  const rejected = projectLane1LedgerRow(row('LANE_1_TV_SIGNAL_REFUSED', {
    rawMessage: { ticker: 'SPY', side: ' buy ', qty: '1' },
    acceptedInstruction: null, faultCode: 'LANE_1_INVALID_SIGNAL', secret: 'MUST_NOT_ESCAPE',
  }, '2026-08-31T21:00:00.000Z'));
  assert.equal(rejected.rawSide, ' buy ');
  assert.equal(rejected.quantity, '1');
  assert.equal(rejected.instruction, null);
  assert.equal(rejected.reasonCode, 'LANE_1_INVALID_SIGNAL');
  assert.doesNotMatch(JSON.stringify(rejected), /MUST_NOT_ESCAPE/u);
});

test('Lane 1 ledger merges live audit and existing coordinator history chronologically', async () => {
  const audit = [
    row('LANE_1_TV_INGRESS', { rawMessage: { ticker: 'SPY', side: 'SELL_SHORT', qty: 1 },
      acceptedInstruction: 'SELL_SHORT', signalShapeAccepted: true },
    '2026-08-31T21:37:35.090Z', '00000000-0000-4000-8000-000000000001'),
    row('LANE_1_ORDER_PREVIEW', { replayBody: { ticker: 'SPY', side: 'SELL_SHORT', qty: 1 },
      brokerInstruction: 'SELL_SHORT', quantity: 1 },
    '2026-08-31T22:21:05.387Z', '00000000-0000-4000-8000-000000000002'),
  ];
  const coordinator = [
    { sequence: 3, event_type: 'ORDER_ACCEPTED', detail_json: '{"signal":"SHORT"}',
      created_at: '2026-08-31T22:30:00.000Z' },
    { sequence: 4, event_type: 'OPEN_FILLED', detail_json: '{"signal":"SHORT"}',
      created_at: '2026-08-31T22:31:00.000Z' },
  ];
  const harness = environment(audit, coordinator);
  const ledger = await lane1EventLedger(harness.env, 'owner-1');
  assert.deepEqual(ledger.events.map((event) => event.event),
    ['SIGNAL', 'PREVIEW', 'ORDER', 'FILL']);
  assert.deepEqual(ledger.counts, { SIGNAL: 1, REFUSED: 0, PREVIEW: 1, ORDER: 1, FILL: 1 });
  assert.equal(ledger.events[0].rawSide, 'SELL_SHORT');
  assert.equal(ledger.events[2].instruction, null,
    'coordinator history does not invent a broker instruction it did not store');
  assert.equal(ledger.pnl.status, 'NOT_MEASURED');
  assert.equal(ledger.phase2.status, 'BLOCKED_NO_FILL_PAYLOADS');
  assert.equal(ledger.availability, 'COMPLETE');
  assert.equal(harness.writes(), 0);
});

test('zero order and fill counts are explicit and attributed to never armed', async () => {
  const harness = environment([], []);
  const ledger = await lane1EventLedger(harness.env, 'owner-1');
  assert.equal(ledger.counts.ORDER, 0);
  assert.equal(ledger.counts.FILL, 0);
  assert.deepEqual(ledger.zeroReasons, { ORDER: 'NEVER_ARMED', FILL: 'NEVER_ARMED' });
  assert.deepEqual(ledger.events, []);
});

test('source failure is distinguishable from an intentionally empty ledger', async () => {
  const harness = environment([], []);
  harness.env.ACCOUNT_COORDINATOR.getByName = () => ({});
  const ledger = await lane1EventLedger(harness.env, 'owner-1');
  assert.equal(ledger.availability, 'DEGRADED');
  assert.equal(ledger.counts.ORDER, null);
  assert.equal(ledger.counts.FILL, null);
  assert.equal(ledger.zeroReasons.ORDER, null);
  assert.match(ledger.sourceErrors[0], /LANE_1_COORDINATOR_HISTORY_UNAVAILABLE/u);
});

test('BOT tab is a read-only Phase 1 surface with no order or ARM action', () => {
  const source = `<html><head><title>NUVO VSIM v5 — Shadow Preview</title></head><body><nav><button class="nav-button" data-view="opportunities">Opportunities</button><button class="nav-button" data-view="evidence">Evidence</button><button class="nav-button" data-view="system">System</button></nav><main><section class="view active" id="overview"><article class="panel scorecard"><div class="panel-head"><div><p class="kicker">Five scoreboards</p><h3>Readiness</h3></div><strong class="readiness">1 / 5</strong></div>
            <div class="score-rows"><div><span>Economic</span><i></i><small>Awaiting data</small></div><div><span>Calibration</span><i></i><small>Awaiting data</small></div><div><span>Execution</span><i></i><small>Not connected</small></div><div class="ready"><span>Constitution</span><i></i><small>Clean</small></div><div><span>Survival</span><i></i><small>Awaiting data</small></div></div>
          </article></section>      <section class="view" id="evidence"></section></main><script src="app.js"></script></body></html>`;
  const html = rewriteDesignHtml(source);
  assert.match(html, /data-view="bot">BOT/u);
  assert.match(html, /id="bot"/u);
  assert.match(html, /LANE_1 · SPY 1 SHARE/u);
  assert.match(html, /BOT summary/u);
  assert.doesNotMatch(html, /Five scoreboards|1 \/ 5/u);
  assert.match(html, /P&amp;L · <span data-vsim="bot-pnl-status">NOT_MEASURED/u);
  assert.match(html, /data-vsim="bot-order-reason">NEVER ARMED/u);
  assert.match(html, /data-vsim="bot-fill-reason">NEVER ARMED/u);
  assert.doesNotMatch(html, /data-action="bot/u);
  const script = liveDashboardScript();
  assert.match(script, /\/api\/lane-1-spy\/ledger\?limit=250/u);
  assert.match(script, /Lane 1 event source unavailable; empty state is not asserted/u);
  assert.match(script, /SYSTEMS LIVE · BOT OFF/u);
  assert.match(script, /system-health-tile system-' \+ displayColor/u);
  assert.doesNotMatch(script, /\/orders/u);
});

test('Lane 1 summary distinguishes clear previews from audited no-position refusals', async () => {
  const audit = [
    row('LANE_1_TV_INGRESS', { rawMessage: { ticker: 'SPY', side: 'BUY', qty: 1 },
      acceptedInstruction: 'BUY', signalShapeAccepted: true }, '2026-08-31T21:37:34.486Z',
    'signal-buy'),
    row('LANE_1_ORDER_PREVIEW', { replayBody: { ticker: 'SPY', side: 'BUY', qty: 1 },
      brokerInstruction: 'BUY', quantity: 1, sourceIngressId: 'signal-buy' },
    '2026-08-31T21:50:00.000Z',
    'eba4d1ac-3e3f-4735-92bb-0309732c1f52'),
    row('LANE_1_ORDER_PREVIEW_REFUSED', { replayBody: { ticker: 'SPY', side: 'SELL', qty: 1 },
      brokerInstruction: 'SELL', quantity: 1,
      faultCode: 'SCHWAB_LANE_MARKET_PREVIEW_EXIT_NOT_CLEAR' }, '2026-08-31T22:20:27.698Z',
    'ba07b4da-db6f-4043-909b-a920dae80462'),
    row('LANE_1_ORDER_PREVIEW', { replayBody: { ticker: 'SPY', side: 'SELL_SHORT', qty: 1 },
      brokerInstruction: 'SELL_SHORT', quantity: 1 }, '2026-08-31T22:21:05.387Z',
    '064aa8dc-1d97-4c26-929d-0f440c1221a5'),
    row('LANE_1_ORDER_PREVIEW_REFUSED', {
      replayBody: { ticker: 'SPY', side: 'BUY_TO_COVER', qty: 1 },
      brokerInstruction: 'BUY_TO_COVER', quantity: 1,
      faultCode: 'SCHWAB_LANE_MARKET_PREVIEW_EXIT_NOT_CLEAR' }, '2026-08-31T22:18:49.756Z',
    'e96f65da-dc0f-4217-96db-ffed666bc2d1'),
  ];
  const ledger = await lane1EventLedger(environment(audit).env, 'owner-1');
  assert.equal(ledger.summary.arm.value, 'OFF');
  assert.equal(ledger.summary.position.value, 'FLAT');
  assert.equal(ledger.summary.brokerReconciliation.value, 'NOT_MEASURED');
  assert.equal(ledger.summary.brokerReconciliation.positionDrift,
    'DEFINED_BUT_UNREACHABLE_UNTIL_REFRESH_PACKET');
  assert.equal(ledger.summary.matrix.BUY.preview.status, 'COMPLETE · CLEAR');
  assert.equal(ledger.summary.matrix.SELL.preview.status, 'COMPLETE · REFUSED_NO_POSITION');
  assert.equal(ledger.summary.matrix.SELL.preview.source, 'PRINCIPAL_CONFIRMED_DECRYPT_REPORT');
  assert.equal(ledger.summary.matrix.SELL_SHORT.preview.status, 'COMPLETE · CLEAR');
  assert.equal(ledger.summary.matrix.BUY_TO_COVER.preview.status,
    'COMPLETE · REFUSED_NO_POSITION');
  assert.ok(Object.values(ledger.summary.matrix).every((entry) =>
    entry.alert.status === 'CONFIRMED'
      && entry.alert.source === 'PRINCIPAL_CONFIRMED · SPY 5m'));
  assert.ok(Object.values(ledger.summary.matrix).every((entry) =>
    entry.fill.status === '0 · NEVER_ARMED'));
  assert.equal(ledger.summary.pnl.realizedToday.status, 'NOT_MEASURED');
  assert.equal(ledger.summary.blocking, 'ARM_OFF · INTENDED');
  assert.deepEqual(ledger.summary.lastSignal, {
    timestamp: '2026-08-31T21:37:34.486Z', instruction: 'BUY',
    outcome: 'PREVIEW · CLEAR', recordId: 'signal-buy',
    previewReceiptId: 'eba4d1ac-3e3f-4735-92bb-0309732c1f52',
  });
});

test('Lane 1 summary counts only coordinator fills and uses EXIT_FILLED realized cents', () => {
  const events = [
    { event: 'FILL', sourceEventType: 'OPEN_FILLED', signal: 'LONG', fillId: 'FILL-1',
      timestamp: '2026-08-31T14:31:00.000Z' },
    { event: 'FILL', sourceEventType: 'EXIT_FILLED', signal: null, fillId: 'FILL-2',
      realizedPnlCents: 250, timestamp: '2026-08-31T14:36:00.000Z' },
  ];
  const state = { armed: true, stage: 'FLAT', positionSide: 'FLAT', fault: null,
    latestUnit: { symbol: 'SPY', quantity: 1, positionSide: 'FLAT', events: [
      { eventType: 'EQUITY_FILL', fillId: 'FILL-1', symbol: 'SPY', side: 'BUY',
        quantityShares: 1 },
      { eventType: 'EQUITY_FILL', fillId: 'FILL-2', symbol: 'SPY', side: 'SELL',
        quantityShares: 1 },
    ] } };
  const summary = buildLane1BotSummary(events, state, {
    now: Date.parse('2026-08-31T15:00:00.000Z'),
  });
  assert.deepEqual(summary.fills, { today: 2, total: 2,
    provenInstructions: 2, targetInstructions: 4, source: 'ACCOUNT_COORDINATOR_HISTORY' });
  assert.deepEqual(summary.pnl.realizedToday,
    { valueCents: 250, source: 'ACCOUNT_COORDINATOR_EXIT_FILLED' });
  assert.equal(summary.matrix.BUY.fill.status, 'FILLED');
  assert.equal(summary.matrix.SELL.fill.status, 'FILLED');
  assert.equal(summary.matrix.SELL_SHORT.fill.status, 'NOT_MEASURED');
  assert.equal(summary.pnl.open.status, 'NOT_MEASURED');
  assert.equal(summary.pnl.aggregate.status, 'NOT_MEASURED');
});
