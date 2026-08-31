import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lane1EventLedger, projectLane1LedgerRow } from '../cloudflare/lane-1-event-ledger.js';
import { liveDashboardScript, rewriteDesignHtml } from '../cloudflare/worker.js';

function row(eventType, detail, createdAt, id = crypto.randomUUID()) {
  return { id, event_type: eventType, detail_json: JSON.stringify(detail), created_at: createdAt };
}

function environment(d1Rows, coordinatorRows = []) {
  let writes = 0;
  const DB = { prepare(sql) {
    assert.match(sql, /^SELECT /u);
    return { bind() { return { async all() { return { results: d1Rows }; },
      async run() { writes += 1; throw new Error('WRITE_NOT_ALLOWED'); } }; } };
  } };
  const coordinator = { async laneV2History() {
    return { appendOnly: true, readOnly: true, events: coordinatorRows };
  } };
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
  const source = '<html><head><title>NUVO VSIM v5 — Shadow Preview</title></head><body><nav><button class="nav-button" data-view="opportunities">Opportunities</button><button class="nav-button" data-view="evidence">Evidence</button><button class="nav-button" data-view="system">System</button></nav><main>      <section class="view" id="evidence"></section></main><script src="app.js"></script></body></html>';
  const html = rewriteDesignHtml(source);
  assert.match(html, /data-view="bot">BOT/u);
  assert.match(html, /id="bot"/u);
  assert.match(html, /P&amp;L · <span data-vsim="bot-pnl-status">NOT_MEASURED/u);
  assert.match(html, /data-vsim="bot-order-reason">NEVER ARMED/u);
  assert.match(html, /data-vsim="bot-fill-reason">NEVER ARMED/u);
  assert.doesNotMatch(html, /data-action="bot/u);
  const script = liveDashboardScript();
  assert.match(script, /\/api\/lane-1-spy\/ledger\?limit=250/u);
  assert.match(script, /Lane 1 event source unavailable; empty state is not asserted/u);
  assert.doesNotMatch(script, /\/orders/u);
});
