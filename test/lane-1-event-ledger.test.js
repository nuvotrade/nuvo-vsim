import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLane1BotSummary, lane1EventLedger, projectLane1LedgerRow,
} from '../cloudflare/lane-1-event-ledger.js';
import { liveDashboardScript, rewriteDesignHtml } from '../cloudflare/worker.js';

function row(eventType, detail, createdAt, id = crypto.randomUUID()) {
  return { id, event_type: eventType, detail_json: JSON.stringify(detail), created_at: createdAt };
}

function projectionFor(state) {
  return { status: 'AGREE', positionSide: state.positionSide,
    coordinator: { positionSide: state.positionSide, stage: state.stage,
      armed: state.armed, updatedAt: state.updatedAt ?? '2026-08-31T22:00:00.000Z' },
    broker: { positionSide: state.positionSide, acquiredAt: '2026-08-31T22:00:01.000Z' },
    brokerRead: { ok: true, attemptedAt: '2026-08-31T22:00:01.000Z' } };
}

function environment(d1Rows, coordinatorRows = [], coordinatorState = {
  armed: false, stage: 'DISARMED', positionSide: 'FLAT', latestUnit: null, fault: null,
}, brokerRows = [], positionProjection = projectionFor(coordinatorState)) {
  let writes = 0;
  const DB = { prepare(sql) {
    assert.match(sql, /^SELECT /u);
    return { bind() { return { async all() { return { results: sql.includes('FROM broker_events')
      ? brokerRows : d1Rows }; },
      async run() { writes += 1; throw new Error('WRITE_NOT_ALLOWED'); } }; } };
  } };
  const coordinator = { async laneV2History() {
    return { appendOnly: true, readOnly: true, events: coordinatorRows };
  }, async laneV2Status() { return structuredClone(coordinatorState); },
  async laneV2PositionProjection() { return structuredClone(positionProjection); } };
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
  assert.equal(ledger.phase2.status, 'BLOCKED_NO_COMPLETE_EXIT');
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

test('BOT tab projects Phase 1 evidence and uses only existing coordinator controls', () => {
  const source = `<html><head><title>NUVO VSIM v5 — Shadow Preview</title></head><body><nav><button class="nav-button" data-view="opportunities">Opportunities</button><button class="nav-button" data-view="evidence">Evidence</button><button class="nav-button" data-view="system">System</button></nav><main><section class="view active" id="overview"><article class="panel scorecard"><div class="panel-head"><div><p class="kicker">Five scoreboards</p><h3>Readiness</h3></div><strong class="readiness">1 / 5</strong></div>
            <div class="score-rows"><div><span>Economic</span><i></i><small>Awaiting data</small></div><div><span>Calibration</span><i></i><small>Awaiting data</small></div><div><span>Execution</span><i></i><small>Not connected</small></div><div class="ready"><span>Constitution</span><i></i><small>Clean</small></div><div><span>Survival</span><i></i><small>Awaiting data</small></div></div>
          </article></section>      <section class="view" id="evidence"></section></main><script src="app.js"></script></body></html>`;
  const html = rewriteDesignHtml(source);
  assert.match(html, /data-view="bot">BOT/u);
  assert.match(html, /id="bot"/u);
  assert.match(html, /LANE_1 · SPY 1 SHARE/u);
  assert.match(html, /BOT summary/u);
  assert.doesNotMatch(html, /Evidence and measurement notes|lane-summary-details|lane-summary-source/u);
  assert.match(html, /title="Principal-confirmed TradingView configuration; not runtime fill evidence\."/u);
  assert.match(html, /<span role="columnheader"[^>]*>TV<\/span>/u);
  assert.match(html, /<span role="columnheader">Disposition<\/span>/u);
  assert.match(html, /<span role="columnheader">Schwab<\/span>/u);
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
  assert.deepEqual(ledger.summary.instrument, { broker: 'Schwab', ticker: 'SPY',
    quantityShares: 1, source: 'ACCEPTED_LANE_1_INGRESS' });
  assert.equal(ledger.summary.brokerReconciliation.status, 'AGREE');
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

test('Lane 1 summary counts only explicit fill receipts and uses captured exit realized cents', () => {
  const events = [
    { event: 'FILL', sourceEventType: 'LANE_1_FILL_RECEIPT', fillType: 'OPEN_FILLED',
      instruction: 'BUY', qualifiedStage0Fill: true, fillId: 'FILL-1',
      timestamp: '2026-08-31T14:31:00.000Z' },
    { event: 'FILL', sourceEventType: 'LANE_1_FILL_RECEIPT', fillType: 'EXIT_FILLED',
      instruction: 'SELL', qualifiedStage0Fill: true, fillId: 'FILL-2',
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
    positionProjection: projectionFor(state),
  });
  assert.deepEqual(summary.fills, { today: 2, total: 2,
    provenInstructions: 2, targetInstructions: 4, source: 'LANE_1_FILL_RECEIPT' });
  assert.deepEqual(summary.pnl.realizedToday,
    { valueCents: 250, source: 'LANE_1_FILL_RECEIPT' });
  assert.equal(summary.matrix.BUY.fill.status, 'FILLED');
  assert.equal(summary.matrix.SELL.fill.status, 'FILLED');
  assert.equal(summary.matrix.SELL_SHORT.fill.status, 'NOT_MEASURED');
  assert.equal(summary.pnl.open.status, 'NOT_MEASURED');
  assert.equal(summary.pnl.aggregate.status, 'NOT_MEASURED');
});

test('duplicate delivery of one fill cannot double fills or realized P&L', () => {
  const receipt = { event: 'FILL', sourceEventType: 'LANE_1_FILL_RECEIPT',
    fillType: 'EXIT_FILLED', instruction: 'BUY_TO_COVER', qualifiedStage0Fill: true,
    fillId: '129766132555', brokerOrderId: '1007804693875', realizedPnlCents: -324,
    timestamp: '2026-09-02T18:00:07.571Z' };
  const state = { armed: false, stage: 'FLAT', positionSide: 'FLAT', fault: null,
    latestUnit: { symbol: 'SPY', quantity: 1, positionSide: 'FLAT' } };
  const summary = buildLane1BotSummary([
    { ...receipt, recordId: 'receipt-a' }, { ...receipt, recordId: 'receipt-b' },
  ], state, { now: Date.parse('2026-09-02T23:00:00.000Z'),
    positionProjection: projectionFor(state) });
  assert.equal(summary.fills.today, 1);
  assert.equal(summary.fills.total, 1);
  assert.deepEqual(summary.pnl.realizedToday,
    { valueCents: -324, source: 'LANE_1_FILL_RECEIPT' });
});

test('projected ledger renders one row when legacy audit contains duplicate receipts', async () => {
  const fillAt = new Date(Date.now() - 1_000).toISOString();
  const detail = { type: 'EXIT_FILLED', qualifiedStage0Fill: true,
    realizedPnlCents: -324, evidenceOrigin: 'SCHWAB_WIRE_CAPTURE', identity: {
      executionActivityId: '129766132555', brokerOrderId: '1007804693875',
      instruction: 'BUY_TO_COVER', quantityShares: 1,
    } };
  const state = { armed: false, stage: 'FLAT', positionSide: 'FLAT', fault: null,
    latestUnit: { symbol: 'SPY', quantity: 1, positionSide: 'FLAT' } };
  const audit = [row('LANE_1_FILL_RECEIPT', detail, fillAt, 'a'),
    row('LANE_1_FILL_RECEIPT', detail, fillAt, 'b')];
  const ledger = await lane1EventLedger(environment(audit, [], state).env, 'owner-1');
  assert.equal(ledger.events.filter((event) => event.event === 'FILL').length, 1);
  assert.equal(ledger.counts.FILL, 1);
  assert.equal(ledger.summary.pnl.realizedToday.valueCents, -324);
});

test('open BOT position exposes only complete coordinator fill economics', () => {
  const state = { armed: true, stage: 'OPEN_LONG', positionSide: 'LONG', fault: null,
    latestUnit: { symbol: 'SPY', quantity: 1, positionSide: 'LONG', openingFillId: 'FILL-1',
      openingPriceUsdPerShare: 766.25, openingFeeCents: 2, events: [
        { eventType: 'EQUITY_FILL', fillId: 'FILL-1', symbol: 'SPY', side: 'BUY',
          quantityShares: 1 },
      ] } };
  const summary = buildLane1BotSummary([], state, { positionProjection: projectionFor(state) });
  assert.deepEqual(summary.instrument, { broker: 'Schwab', ticker: 'SPY', quantityShares: 1,
    source: 'ACCOUNT_COORDINATOR_LATEST_UNIT' });
  assert.deepEqual(summary.openPosition, { side: 'LONG', ticker: 'SPY', quantityShares: 1,
    openingPriceUsdPerShare: 766.25, openingFeeCents: 2, openingFillId: 'FILL-1',
    source: 'ACCOUNT_COORDINATOR_LATEST_UNIT' });

  const incompleteState = { ...state,
    latestUnit: { ...state.latestUnit, openingFeeCents: null } };
  const incomplete = buildLane1BotSummary([], incompleteState, {
    positionProjection: projectionFor(incompleteState),
  });
  assert.equal(incomplete.openPosition, null);
});

test('fault, auto-disarm, and broker-only fill are visible instead of disappearing', async () => {
  const coordinatorRows = [
    { sequence: 1, event_type: 'FAULT', detail_json: JSON.stringify({
      faultCode: 'MISSING_FEE', brokerOrderId: '1007778879812' }),
    created_at: '2026-09-01T13:35:05.000Z' },
    { sequence: 2, event_type: 'AUTO_DISARMED', detail_json: JSON.stringify({
      reason: 'MISSING_FEE', brokerOrderId: '1007778879812' }),
    created_at: '2026-09-01T13:35:05.001Z' },
  ];
  const brokerRows = [{ event_key: 'execution-129577264234', event_type: 'EXECUTION',
    broker_order_id: '1007778879812', activity_id: '129577264234', symbol: 'SPY',
    side: 'SELL_SHORT', quantity: 1, price: 761.98, state: 'FILLED',
    occurred_at: '2026-09-01T13:35:04.000Z', first_seen_at: '2026-09-01T13:35:05.000Z' }];
  const state = { armed: false, stage: 'FAULT', positionSide: 'FLAT', latestUnit: null,
    fault: { faultCode: 'MISSING_FEE' }, updatedAt: '2026-09-01T13:35:05.001Z' };
  const drift = { status: 'POSITION_DRIFT', positionSide: 'UNKNOWN',
    coordinator: { positionSide: 'FLAT', stage: 'FAULT', armed: false,
      updatedAt: '2026-09-01T13:35:05.001Z' },
    broker: { positionSide: 'SHORT', acquiredAt: '2026-09-01T13:36:00.000Z' },
    brokerRead: { ok: true, attemptedAt: '2026-09-01T13:36:00.000Z' } };
  const ledger = await lane1EventLedger(environment([], coordinatorRows, state,
    brokerRows, drift).env, 'owner-1');
  assert.equal(ledger.summary.position.value, 'POSITION_DRIFT');
  assert.equal(ledger.summary.position.coordinatorPositionSide, 'FLAT');
  assert.equal(ledger.summary.position.brokerPositionSide, 'SHORT');
  assert.equal(ledger.summary.blocking, 'POSITION_DRIFT');
  assert.equal(ledger.events.some((event) => event.event === 'FAULT'
    && event.reasonCode === 'MISSING_FEE'), true);
  assert.equal(ledger.events.some((event) => event.event === 'DISARMED'
    && event.outcome === 'AUTO_DISARMED'), true);
  const orphan = ledger.events.find((event) => event.outcome === 'BROKER_ONLY · ORPHAN');
  assert.equal(orphan.fillId, '129577264234');
  assert.equal(orphan.instruction, 'SELL_SHORT');
  assert.equal(orphan.reasonCode, 'NO_LANE_1_FILL_RECEIPT_OR_COORDINATOR_RECORD');
  assert.equal(orphan.qualifiedStage0Fill, false);
});

test('reconstructed entry is labeled and visible but never credited as a qualified fill', async () => {
  const audit = [row('LANE_1_FILL_RECEIPT', { type: 'OPEN_FILLED',
    identity: { instruction: 'SELL_SHORT', quantityShares: 1,
      executionActivityId: '129577264234', brokerOrderId: '1007778879812' },
    evidenceOrigin: 'BROKER_LEDGER_RECONSTRUCTION', qualifiedStage0Fill: false,
  }, '2026-09-01T13:40:00.000Z', 'receipt-recovered')];
  const state = { armed: false, stage: 'OPEN_SHORT', positionSide: 'SHORT', fault: null,
    updatedAt: '2026-09-01T13:40:00.000Z', latestUnit: { state: 'OPEN_SHARES', symbol: 'SPY',
      quantity: 1, positionSide: 'SHORT', openingFillId: '129577264234',
      openingPriceUsdPerShare: 761.98, openingFeeCents: -2,
      events: [{ eventType: 'EQUITY_FILL', fillId: '129577264234', symbol: 'SPY',
        side: 'SELL_SHORT', quantityShares: 1 }] } };
  const ledger = await lane1EventLedger(environment(audit, [], state).env, 'owner-1');
  assert.equal(ledger.summary.matrix.SELL_SHORT.fill.status, 'RECOVERED · NOT_QUALIFIED');
  assert.equal(ledger.summary.fills.total, 0);
  assert.equal(ledger.summary.fills.provenInstructions, 0);
  assert.equal(ledger.events[0].outcome, 'RECOVERED · BROKER_LEDGER_RECONSTRUCTION');
  assert.equal(ledger.events[0].qualifiedStage0Fill, false);
});

test('FAULT with unreadable broker never renders coordinator FLAT as the bot position', () => {
  const state = { armed: false, stage: 'FAULT', positionSide: 'FLAT', latestUnit: null,
    fault: { faultCode: 'BROKER_UNREACHABLE' }, updatedAt: '2026-09-01T13:40:00.000Z' };
  const summary = buildLane1BotSummary([], state, { positionProjection: {
    status: 'UNVERIFIED', positionSide: 'UNKNOWN',
    coordinator: { positionSide: 'FLAT', stage: 'FAULT', armed: false,
      updatedAt: state.updatedAt }, broker: null,
    brokerRead: { ok: false, error: 'BROKER_UNREACHABLE' },
  } });
  assert.equal(summary.position.value, 'NOT_MEASURED');
  assert.notEqual(summary.position.value, 'FLAT');
  assert.equal(summary.blocking, 'BROKER_POSITION_UNVERIFIED');
});
