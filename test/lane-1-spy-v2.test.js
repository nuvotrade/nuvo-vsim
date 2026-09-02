import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bindLane1V21ReplayBody, createLane1SpyV2Controller, lane1V2ProposalSeal, normalizeLane1V21Signal,
  replayBodyFromAuthenticatedLane1V21Signal,
} from '../src/lane/lane-1-spy-v2.js';
import { syntheticSnapshot } from './fixtures/lane-1-synthetic-state.js';

const SECRET = 'v2-secret';
const NOW = Date.parse('2026-08-28T15:00:00.000Z');
function signal(side, extra = {}) {
  return { ticker: 'SPY', side, qty: 1, secret: SECRET, ...extra };
}

function capture(source, brokerOrderId, clientOrderId, instruction, id) {
  return { schema: 'LANE_1_FILL_RAW_RESPONSE_V1', captureId: `CAPTURE-${id}`,
    source, endpoint: source, bodyKey: `body-${id}`, manifestKey: `manifest-${id}`,
    receivedAt: new Date(NOW + id).toISOString(), originalSha256: String(id).padStart(64, 'a'),
    complete: true, brokerOrderId, clientOrderId, instruction };
}

test('TV replay body preserves the authored ticket without persisting the secret', async () => {
  const original = signal('BUY');
  const replayBody = replayBodyFromAuthenticatedLane1V21Signal(original);
  assert.deepEqual(replayBody, { ticker: 'SPY', side: 'BUY', qty: 1 });
  assert.equal(Object.hasOwn(replayBody, 'secret'), false);
  const first = await bindLane1V21ReplayBody(replayBody);
  const second = await bindLane1V21ReplayBody(structuredClone(replayBody));
  assert.equal(first.tvBodyBindingSha256, second.tvBodyBindingSha256);
  assert.match(first.tvBodyBindingSha256, /^[a-f0-9]{64}$/u);
  assert.equal(replayBodyFromAuthenticatedLane1V21Signal({ ...original, note: 'extra' }), null);
  await assert.rejects(() => bindLane1V21ReplayBody({ ticker: 'SPY', side: 'BUY', qty: 2 }),
    /LANE_1_REPLAY_BODY_INVALID/u);
});

function makeHarness({ armed = true, configArmed = armed,
  positionSide = 'FLAT', custodySide = positionSide,
  market = 'RTH', claimable = true, placeFault = null, fillFault = null,
  snapshotChange = null } = {}) {
  const calls = []; const writes = []; const notices = [];
  let brokerSide = custodySide; let orderSequence = 0; let fillSequence = 0;
  let state = { armed, stage: positionSide === 'FLAT' ? 'FLAT' : 'OPEN_' + positionSide,
    positionSide, armedAt: '2026-08-28T14:30:00.000Z',
    expiresAt: '2026-08-29T14:30:00.000Z', open: null, exit: null, stop: null,
    marketValidation: null,
    latestUnit: null };
  const coordinator = {
    async ensure() { return structuredClone(state); },
    async status() { return structuredClone(state); },
    async claim({ signal: requested, seal }) {
      calls.push('claim:' + requested);
      if (!claimable) return { claimed: false, state: structuredClone(state) };
      const expected = requested === 'EXIT' ? 'OPEN_' + state.positionSide : 'FLAT';
      if (!state.armed || state.stage !== expected) return { claimed: false, state: structuredClone(state) };
      state.stage = requested + '_SENDING';
      if (requested === 'EXIT') state.exit = { seal }; else state.open = { seal };
      return { claimed: true, state: structuredClone(state) };
    },
    async recordAccepted({ signal: requested, brokerOrderId, acceptedAt }) {
      const field = requested === 'EXIT' ? 'exit' : 'open';
      state[field] = { ...state[field], brokerOrderId, acceptedAt };
      return structuredClone(state);
    },
    async recordPendingFill(pending) {
      state = { ...state, stage: pending.pendingReason === 'MISSING_FEE'
        ? 'FILL_PENDING_FEE' : 'FILL_PENDING_EXECUTION', pendingFill: structuredClone(pending) };
      return structuredClone(state);
    },
    async recordOpen({ signal: requested, unit }) {
      state = { ...state, stage: 'OPEN_' + requested, positionSide: requested,
        latestUnit: structuredClone(unit), stop: null, pendingFill: null };
      return structuredClone(state);
    },
    async recordExit({ unit }) {
      state = { ...state, stage: 'FLAT', positionSide: 'FLAT', open: null, exit: null,
        latestUnit: structuredClone(unit), stop: null, pendingFill: null };
      return structuredClone(state);
    },
    async recordFault(detail) {
      state = { ...state, armed: false, stage: 'FAULT', fault: detail };
      return structuredClone(state);
    },
    async disarm() {
      state = { ...state, armed: false, stage: 'DISARMED' }; return structuredClone(state);
    },
  };
  const broker = {
    async position() { calls.push('position:' + brokerSide); return syntheticSnapshot(brokerSide, NOW); },
    async sendSnapshot() {
      const snapshot = await this.position();
      if (snapshotChange) snapshotChange(snapshot);
      return snapshot;
    },
    async placeMarket({ instruction, clientOrderId, durableArm, expectedSnapshot }) {
      assert.deepEqual(expectedSnapshot, syntheticSnapshot(brokerSide, NOW));
      calls.push('market:' + instruction + ':' + Boolean(durableArm));
      if (placeFault) throw new Error(placeFault);
      orderSequence += 1;
      return { brokerOrderId: 'TV-ORDER-' + orderSequence,
        accountHash: 'ACCOUNT-HASH',
        acceptedAt: new Date(NOW + orderSequence * 1_000).toISOString(),
        orderAcceptanceEvidence: capture('SCHWAB_ORDER_ACCEPTANCE_RESPONSE', null,
          clientOrderId, instruction, orderSequence * 10) };
    },
    async waitForFill({ side, brokerOrderId, clientOrderId }) {
      fillSequence += 1; calls.push('fill:' + side);
      if (fillFault) {
        const error = new Error(fillFault);
        error.pendingFill = { brokerOrderId, clientOrderId, side, accountHash: 'ACCOUNT-HASH',
          startedAt: new Date(NOW + fillSequence * 1_000).toISOString(),
          deadlineAt: new Date(NOW + fillSequence * 1_000 + 120_000).toISOString(),
          attempt: 0, evidenceOrigin: 'SCHWAB_WIRE_CAPTURE' };
        throw error;
      }
      if (side === 'BUY') brokerSide = 'LONG';
      if (side === 'SELL_SHORT') brokerSide = 'SHORT';
      if (side === 'SELL' || side === 'BUY_TO_COVER') brokerSide = 'FLAT';
      const opening = ['BUY', 'SELL_SHORT'].includes(side);
      const fillId = 'FILL-' + fillSequence;
      return { fillId, executionActivityId: fillId,
        transactionActivityId: 'TX-' + fillSequence, accountHash: 'ACCOUNT-HASH',
        brokerOrderId, clientOrderId, side, symbol: 'SPY',
        quantityShares: 1, executionPriceUsdPerShare: opening ? 771.785 : 774.305,
        feeUsd: opening ? 0 : -0.02,
        brokerOccurredAt: new Date(NOW + fillSequence * 1_000).toISOString(),
        acquiredAt: new Date(NOW + fillSequence * 1_000 + 1).toISOString(),
        rawBrokerEvidenceSha256: String(fillSequence).padStart(64, '0'),
        evidenceOrigin: 'SCHWAB_WIRE_CAPTURE', captureEvidence: {
          order: capture('SCHWAB_ORDER_RESPONSE', brokerOrderId, clientOrderId, side,
            fillSequence * 10 + 1),
          transaction: capture('SCHWAB_TRANSACTION_RESPONSE', brokerOrderId, clientOrderId, side,
            fillSequence * 10 + 2),
        } };
    },
  };
  const controller = createLane1SpyV2Controller({
    config: { armed: configArmed, armedAt: state.armedAt, ttlMs: 86_400_000,
      ownerId: 'owner-1', secret: SECRET,
      notificationsReady: true }, coordinator, broker,
    bundleStore: { async write(bundle) { writes.push(bundle); return { objectPrefix: 'test/unit' }; } },
    notifier: { async send(message) { notices.push(message); } },
    receiptStore: { async write(receipt) { return { id: `RECEIPT-${receipt.identity.executionActivityId}` }; } },
    marketSession: async () => market, now: () => NOW,
    uuid: (() => { let n = 0; return () => '00000000-0000-4000-8000-' + String(++n).padStart(12, '0'); })(),
  });
  return { controller, calls, writes, notices, state: () => structuredClone(state) };
}

test('TV vocabulary is exactly four broker instructions with explicit exit intent', () => {
  assert.deepEqual(normalizeLane1V21Signal('BUY'), { signal: 'LONG', exitScope: null });
  assert.deepEqual(normalizeLane1V21Signal('SELL_SHORT'), { signal: 'SHORT', exitScope: null });
  assert.deepEqual(normalizeLane1V21Signal('SELL'), { signal: 'EXIT', exitScope: 'LONG' });
  assert.deepEqual(normalizeLane1V21Signal('BUY_TO_COVER'), { signal: 'EXIT', exitScope: 'SHORT' });
  for (const alias of ['LONG', 'SHORT', 'EXIT', 'COVER']) {
    assert.equal(normalizeLane1V21Signal(alias), null);
  }
});

test('contradictory TV instructions return named refusals before any claim or send', async () => {
  for (const [positionSide, requested, faultCode] of [
    ['FLAT', 'SELL', 'LANE_1_SELL_REQUIRES_LONG'],
    ['FLAT', 'BUY_TO_COVER', 'LANE_1_BUY_TO_COVER_REQUIRES_SHORT'],
    ['LONG', 'BUY', 'LANE_1_BUY_REQUIRES_FLAT'],
    ['SHORT', 'SELL_SHORT', 'LANE_1_SELL_SHORT_REQUIRES_FLAT'],
    ['LONG', 'SELL_SHORT', 'LANE_1_SELL_SHORT_REQUIRES_FLAT'],
    ['SHORT', 'BUY', 'LANE_1_BUY_REQUIRES_FLAT'],
    ['SHORT', 'SELL', 'LANE_1_SELL_REQUIRES_LONG'],
    ['LONG', 'BUY_TO_COVER', 'LANE_1_BUY_TO_COVER_REQUIRES_SHORT'],
  ]) {
    const h = makeHarness({ positionSide });
    const result = await h.controller.signal(signal(requested));
    assert.equal(result.status, 200); assert.equal(result.body.faultCode, faultCode);
    assert.equal(result.body.sent, false);
    assert.equal(result.body.disposition, 'instruction-state-refused');
    assert.equal(h.state().armed, true);
    assert.equal(h.state().stage, positionSide === 'FLAT' ? 'FLAT' : 'OPEN_' + positionSide);
    assert.equal(h.notices.length, 0);
    assert.equal(h.calls.some((entry) => /^(claim|market):/u.test(entry)), false);
  }
  const off = makeHarness({ armed: false });
  assert.equal((await off.controller.signal(signal('BUY'))).status, 200);
  const closed = makeHarness({ market: 'CLOSED' });
  assert.equal((await closed.controller.signal(signal('BUY'))).body.disposition, 'market-closed');
  const duplicate = makeHarness({ claimable: false });
  assert.equal((await duplicate.controller.signal(signal('BUY'))).body.disposition, 'duplicate-in-flight');
});

test('TV BUY then TV SELL creates two market order ids and resolves flat while ARM remains Principal-controlled', async () => {
  const h = makeHarness();
  const opened = await h.controller.signal(signal('BUY'));
  assert.equal(opened.status, 200); assert.equal(opened.body.brokerOrderId, 'TV-ORDER-1');
  assert.equal(opened.body.positionSide, 'LONG');
  assert.match(opened.body.tvBodyBindingSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(h.calls.filter((entry) => entry.startsWith('market:')), ['market:BUY:true']);
  const openingEvents = JSON.parse(h.writes[0].bytes['order-events.json']).appendLog;
  const openingProposal = openingEvents.find((row) => row.eventType === 'PROPOSAL_SEALED').proposal;
  assert.equal(openingProposal.signalSource, 'TRADINGVIEW_WEBHOOK');
  assert.equal(openingProposal.rawSignalSide, 'BUY');
  assert.equal(openingProposal.tvBodyBindingSha256, opened.body.tvBodyBindingSha256);

  const exited = await h.controller.signal(signal('SELL'));
  assert.equal(exited.status, 200); assert.equal(exited.body.brokerOrderId, 'TV-ORDER-2');
  assert.equal(exited.body.positionSide, 'FLAT'); assert.equal(exited.body.realizedPnlCents, 250);
  assert.deepEqual(h.calls.filter((entry) => entry.startsWith('market:')),
    ['market:BUY:true', 'market:SELL:true']);
  assert.equal(h.writes[1].manifest.status, 'RESOLVED_FLAT');
  assert.equal(JSON.parse(h.writes[1].bytes['shares.json']).summary.sharesRemaining, 0);
  assert.deepEqual(h.notices.map((row) => row.type), ['OPENED', 'EXITED']);
  assert.equal(h.notices[0].brokerOrderId, 'TV-ORDER-1');
  assert.equal(h.notices[1].brokerOrderId, 'TV-ORDER-2');
  assert.equal(h.state().armed, true);
});

test('SELL_SHORT opens and only BUY_TO_COVER closes the synthetic short round trip', async () => {
  const h = makeHarness();
  const opened = await h.controller.signal(signal('SELL_SHORT'));
  assert.equal(opened.body.brokerOrderId, 'TV-ORDER-1');
  const exited = await h.controller.signal(signal('BUY_TO_COVER'));
  assert.equal(exited.body.brokerOrderId, 'TV-ORDER-2');
  assert.deepEqual(h.calls.filter((entry) => entry.startsWith('market:')),
    ['market:SELL_SHORT:true', 'market:BUY_TO_COVER:true']);
  assert.equal(exited.body.positionSide, 'FLAT');
});

test('ARM remains live after explicit SELL and a later opening starts a new episode', async () => {
  const h = makeHarness();
  assert.equal((await h.controller.signal(signal('BUY'))).body.disposition, 'opened');
  assert.equal((await h.controller.signal(signal('SELL'))).body.disposition, 'exited');
  const reopened = await h.controller.signal(signal('SELL_SHORT'));
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.disposition, 'opened');
  assert.equal(reopened.body.positionSide, 'SHORT');
  assert.equal(h.writes.length, 3);
  const reopenedEvents = JSON.parse(h.writes[2].bytes['order-events.json']).appendLog;
  assert.equal(reopenedEvents.filter((row) => row.eventType === 'EQUITY_FILL').length, 1);
  assert.equal(reopenedEvents.find((row) => row.eventType === 'PROPOSAL_SEALED').signal, 'SHORT');
});

test('MISSING_FEE is durable FILL_PENDING_FEE and never a terminal fault', async () => {
  const h = makeHarness({ fillFault: 'FILL_PENDING_FEE' });
  const result = await h.controller.signal(signal('SELL_SHORT'));
  assert.equal(result.status, 200);
  assert.equal(result.body.state, 'FILL_PENDING_FEE');
  assert.equal(result.body.disposition, 'fill-pending-fee');
  assert.equal(result.body.faultCode, null);
  assert.equal(result.body.sent, true);
  assert.equal(h.state().armed, true);
  assert.equal(h.state().pendingFill.pendingReason, 'MISSING_FEE');
  assert.equal(h.notices.some((notice) => notice.type === 'FAULT'), false);
});

test('a valid TV body reports faults with HTTP 200; malformed bodies remain 400', async () => {
  const faulted = makeHarness({ placeFault: 'SCHWAB_LANE_MARKET_ORDER_BUY_500' });
  const fault = await faulted.controller.signal(signal('BUY'));
  assert.equal(fault.status, 200); assert.equal(fault.body.state, 'FAULT');
  assert.equal(fault.body.faultCode, 'SCHWAB_LANE_MARKET_ORDER_BUY_500');
  assert.equal((await makeHarness().controller.signal(signal('BUY', { ticker: 'QQQ' }))).status, 400);
  assert.equal((await makeHarness().controller.signal(signal('BUY', { qty: 2 }))).status, 400);
  assert.equal((await makeHarness().controller.signal({ ...signal('SELL'), comment: 'no' })).status, 400);
});

test('custody drift blocks before either market order', async () => {
  const h = makeHarness({ positionSide: 'LONG', custodySide: 'FLAT' });
  const result = await h.controller.signal(signal('SELL'));
  assert.equal(result.status, 200); assert.equal(result.body.disposition, 'reconciliation-required');
  assert.equal(result.body.faultCode, 'LANE_1_POSITION_STATE_DRIFT');
  assert.equal(h.calls.some((entry) => entry.startsWith('market:')), false);
});

test('durable Principal ARM enables BUY and SELL while environment stays OFF', async () => {
  const h = makeHarness({ armed: true, configArmed: false });
  const opened = await h.controller.signal(signal('BUY'));
  assert.equal(opened.status, 200); assert.equal(opened.body.brokerOrderId, 'TV-ORDER-1');
  const exited = await h.controller.signal(signal('SELL'));
  assert.equal(exited.status, 200); assert.equal(exited.body.brokerOrderId, 'TV-ORDER-2');
  assert.deepEqual(h.calls.filter((entry) => entry.startsWith('market:')),
    ['market:BUY:true', 'market:SELL:true']);
  assert.equal(h.state().armed, true);
});

test('unknown broker projection records named drift and never claims or dispatches', async () => {
  const h = makeHarness({ snapshotChange: (snapshot) => { delete snapshot.longQuantity; } });
  const result = await h.controller.signal(signal('BUY'));
  assert.equal(result.status, 200);
  assert.equal(result.body.sent, false);
  assert.equal(result.body.faultCode, 'LANE_1_POSITION_STATE_DRIFT');
  assert.equal(h.state().fault.detail, 'LANE_1_POSITION_STATE_DRIFT:BROKER_POSITION_UNKNOWN:quantities');
  assert.equal(h.state().armed, false);
  assert.equal(h.calls.some((call) => /^(claim|market):/u.test(call)), false);
});

test('unknown coordinator position records named drift instead of defaulting FLAT', async () => {
  const h = makeHarness({ positionSide: null, custodySide: 'FLAT' });
  const result = await h.controller.signal(signal('BUY'));
  assert.equal(result.body.sent, false);
  assert.equal(result.body.faultCode, 'LANE_1_POSITION_STATE_DRIFT');
  assert.equal(h.state().fault.detail, 'LANE_1_POSITION_STATE_DRIFT:COORDINATOR_POSITION_UNKNOWN');
  assert.equal(h.calls.some((call) => /^(claim|market):/u.test(call)), false);
});

test('DISARMED ignores the send snapshot and still returns the unchanged ingress disposition', async () => {
  const h = makeHarness({ armed: false, snapshotChange: () => { throw new Error('MUST_NOT_READ'); } });
  const result = await h.controller.signal(signal('BUY'));
  assert.equal(result.status, 200);
  assert.equal(result.body.disposition, 'disarmed');
  assert.equal(result.body.sent, false);
  assert.equal(h.calls.length, 0);
});

test('reconciliation reports unknown coordinator state instead of skipping it', async () => {
  const h = makeHarness({ positionSide: null, custodySide: 'FLAT' });
  const result = await h.controller.reconcile();
  assert.ok(result);
  assert.equal(result.body.faultCode, 'LANE_1_POSITION_STATE_DRIFT');
  assert.equal(result.body.sent, false);
  assert.equal(h.state().fault.detail, 'LANE_1_POSITION_STATE_DRIFT:COORDINATOR_POSITION_UNKNOWN');
  assert.equal(h.state().armed, false);
});

test('reconciliation reports unknown broker state instead of calling it an external flatten', async () => {
  const h = makeHarness({ positionSide: 'LONG', custodySide: null });
  const result = await h.controller.reconcile();
  assert.ok(result);
  assert.equal(result.body.faultCode, 'LANE_1_POSITION_STATE_DRIFT');
  assert.equal(h.state().fault.detail, 'LANE_1_POSITION_STATE_DRIFT:BROKER_POSITION_UNKNOWN');
  assert.equal(result.body.sent, false);
  assert.equal(h.state().armed, false);
});

// These are synthetic contract/guard tests, not TradingView deliveries or fills.
for (const token of ['LONG', 'SHORT', 'EXIT', 'COVER']) {
  test(`four-action: legacy ${token} refuses before state access`, async () => {
    const h = makeHarness();
    assert.equal(normalizeLane1V21Signal(token), null);
    const result = await h.controller.signal(signal(token));
    assert.deepEqual(result, { status: 400,
      body: { faultCode: 'LANE_1_INVALID_SIGNAL', sent: false } });
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.notices, []);
    assert.deepEqual(h.writes, []);
  });
}

test('four-action: case folding trimming and coercion are forbidden', async () => {
  for (const side of ['buy', 'sell', 'sell_short', 'buy_to_cover', 'Buy', ' BUY', 'BUY ',
    '\tSELL', 'SELL\n', 'SELL SHORT', ' BUY_TO_COVER ', '', null, undefined, 1, true,
    ['BUY'], { side: 'BUY' }, '__proto__', 'constructor']) {
    const h = makeHarness();
    assert.equal(normalizeLane1V21Signal(side), null);
    assert.deepEqual(await h.controller.signal(signal(side)), { status: 400,
      body: { faultCode: 'LANE_1_INVALID_SIGNAL', sent: false } });
    assert.deepEqual(h.calls, []);
  }
});

test('four-action: numeric one exact SPY and exact body keys remain required', async () => {
  for (const change of [{ qty: '1' }, { qty: null }, { qty: true }, { qty: 0 }, { qty: 2 },
    { ticker: 'spy' }, { ticker: ' SPY' }, { ticker: 'SPY ' }, { ticker: 'SOFI' },
    { action: 'BUY' }, { side: undefined }, { extra: true }, { secret: 'WRONG' }]) {
    const h = makeHarness();
    assert.deepEqual(await h.controller.signal(signal('BUY', change)), { status: 400,
      body: { faultCode: 'LANE_1_INVALID_SIGNAL', sent: false } });
    assert.deepEqual(h.calls, []);
  }
});

test('four-action: SELL while SHORT refuses without faulting or constructing a cover dispatch', async () => {
  const h = makeHarness({ positionSide: 'SHORT' });
  const result = await h.controller.signal(signal('SELL'));
  assert.equal(result.status, 200);
  assert.equal(result.body.state, 'OPEN_SHORT');
  assert.equal(result.body.disposition, 'instruction-state-refused');
  assert.equal(result.body.faultCode, 'LANE_1_SELL_REQUIRES_LONG');
  assert.equal(result.body.sent, false);
  assert.equal(h.state().armed, true);
  assert.equal(h.state().fault, undefined);
  assert.deepEqual(h.calls, ['position:SHORT']);
  assert.deepEqual(h.writes, []);
});

test('four-action: seal preserves every exact instruction independently of position', async () => {
  for (const [rawSignalSide, signal] of [['BUY', 'LONG'], ['SELL', 'EXIT'],
    ['SELL_SHORT', 'SHORT'], ['BUY_TO_COVER', 'EXIT']]) {
    for (const positionSide of ['FLAT', 'LONG', 'SHORT', 'UNKNOWN', null, undefined]) {
      // Construction is shared with preview. Position is not fabricated here,
      // and construction alone is NOT permission to dispatch this instruction.
      const seal = await lane1V2ProposalSeal({ signal, rawSignalSide, positionSide,
        tvBodyBindingSha256: 'a'.repeat(64), now: NOW, uuid: () => 'SYNTHETIC' });
      assert.equal(seal.brokerInstruction, rawSignalSide);
      assert.equal(seal.rawSignalSide, rawSignalSide);
      assert.equal(seal.positionSide, positionSide ?? null);
      assert.equal(seal.quantityShares, 1);
      assert.equal(seal.orderType, 'MARKET');
      assert.equal(seal.duration, 'DAY');
      assert.equal(seal.session, 'NORMAL');
    }
  }
});

test('four-action: seal refuses missing aliases and contradictory normalized direction', async () => {
  const input = { signal: 'LONG', rawSignalSide: 'BUY', positionSide: 'FLAT',
    tvBodyBindingSha256: 'a'.repeat(64), now: NOW, uuid: () => 'SYNTHETIC' };
  for (const rawSignalSide of [undefined, 'LONG', 'SHORT', 'EXIT', 'COVER', 'buy']) {
    await assert.rejects(() => lane1V2ProposalSeal({ ...input, rawSignalSide }),
      { message: 'LANE_1_INVALID_SIGNAL' });
  }
  for (const [rawSignalSide, wrongSignal] of [['BUY', 'SHORT'], ['SELL', 'LONG'],
    ['SELL_SHORT', 'LONG'], ['BUY_TO_COVER', 'SHORT']]) {
    await assert.rejects(() => lane1V2ProposalSeal({ ...input, rawSignalSide, signal: wrongSignal }),
      { message: 'LANE_1_INSTRUCTION_BINDING_MISMATCH' });
  }
});

test('four-action: Monday BUY binding remains identical and aliases are not replayable', async () => {
  const binding = await bindLane1V21ReplayBody({ ticker: 'SPY', side: 'BUY', qty: 1 });
  assert.equal(binding.tvBodyBindingSha256,
    '21baaecb3006248b6bf21c186684c855d55e5255b5c004970033221762a2188c');
  for (const side of ['LONG', 'SHORT', 'EXIT', 'COVER']) {
    await assert.rejects(() => bindLane1V21ReplayBody({ ticker: 'SPY', side, qty: 1 }),
      { message: 'LANE_1_REPLAY_BODY_INVALID' });
  }
});

for (const instruction of ['BUY', 'SELL', 'SELL_SHORT', 'BUY_TO_COVER']) {
  test(`four-action: ${instruction} remains exact through synthetic controller seal and receipt`, async () => {
    const h = makeHarness();
    if (instruction === 'SELL' || instruction === 'BUY_TO_COVER') {
      const opening = instruction === 'SELL' ? 'BUY' : 'SELL_SHORT';
      assert.equal((await h.controller.signal(signal(opening))).body.disposition, 'opened');
      h.calls.length = 0;
    }
    const result = await h.controller.signal(signal(instruction));
    assert.equal(result.status, 200);
    assert.equal(result.body.sent, true, 'synthetic dispatch, not a live fill');
    assert.deepEqual(h.calls.filter((entry) => entry.startsWith('market:')),
      [`market:${instruction}:true`]);
    const proposals = JSON.parse(h.writes.at(-1).bytes['order-events.json']).appendLog
      .filter((row) => row.eventType === 'PROPOSAL_SEALED');
    const seal = proposals.at(-1).proposal;
    assert.equal(seal.brokerInstruction, instruction);
    assert.equal(seal.rawSignalSide, instruction);
    const binding = await bindLane1V21ReplayBody({ ticker: 'SPY', side: instruction, qty: 1 });
    assert.equal(seal.tvBodyBindingSha256, binding.tvBodyBindingSha256);
    assert.equal(result.body.tvBodyBindingSha256, binding.tvBodyBindingSha256);
  });

  test(`four-action: DISARMED ${instruction} never reads positions claims or sends`, async () => {
    const h = makeHarness({ armed: false });
    const result = await h.controller.signal(signal(instruction));
    assert.equal(result.status, 200);
    assert.equal(result.body.disposition, 'disarmed');
    assert.equal(result.body.sent, false);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.notices, []);
  });

  test(`four-action: UNKNOWN position refuses ${instruction} before claim`, async () => {
    const h = makeHarness({ positionSide: 'UNKNOWN', custodySide: 'FLAT' });
    const result = await h.controller.signal(signal(instruction));
    assert.equal(result.status, 200);
    assert.equal(result.body.sent, false);
    assert.equal(result.body.faultCode, 'LANE_1_POSITION_STATE_DRIFT');
    assert.equal(h.state().fault.detail, 'LANE_1_POSITION_STATE_DRIFT:COORDINATOR_POSITION_UNKNOWN');
    assert.equal(h.calls.some((call) => /^(claim|market):/u.test(call)), false);
  });
}
