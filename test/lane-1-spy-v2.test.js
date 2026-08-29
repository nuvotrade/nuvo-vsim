import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bindLane1V21ReplayBody, createLane1SpyV2Controller, normalizeLane1V21Signal,
  replayBodyFromAuthenticatedLane1V21Signal,
} from '../src/lane/lane-1-spy-v2.js';

const SECRET = 'v2-secret';
const NOW = Date.parse('2026-08-28T15:00:00.000Z');
function signal(side, extra = {}) {
  return { ticker: 'SPY', side, qty: 1, secret: SECRET, ...extra };
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
  market = 'RTH', claimable = true, placeFault = null } = {}) {
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
    async recordOpen({ signal: requested, unit }) {
      state = { ...state, stage: 'OPEN_' + requested, positionSide: requested,
        latestUnit: structuredClone(unit), stop: null };
      return structuredClone(state);
    },
    async recordExit({ unit }) {
      state = { ...state, stage: 'FLAT', positionSide: 'FLAT', open: null, exit: null,
        latestUnit: structuredClone(unit), stop: null };
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
    async position() { calls.push('position:' + brokerSide); return { positionSide: brokerSide }; },
    async placeMarket({ instruction, durableArm }) {
      calls.push('market:' + instruction + ':' + Boolean(durableArm));
      if (placeFault) throw new Error(placeFault);
      orderSequence += 1;
      return { brokerOrderId: 'TV-ORDER-' + orderSequence,
        acceptedAt: new Date(NOW + orderSequence * 1_000).toISOString() };
    },
    async waitForFill({ side, brokerOrderId, clientOrderId }) {
      fillSequence += 1; calls.push('fill:' + side);
      if (side === 'BUY') brokerSide = 'LONG';
      if (side === 'SELL_SHORT') brokerSide = 'SHORT';
      if (side === 'SELL' || side === 'BUY_TO_COVER') brokerSide = 'FLAT';
      const opening = ['BUY', 'SELL_SHORT'].includes(side);
      return { fillId: 'FILL-' + fillSequence, brokerOrderId, clientOrderId, side, symbol: 'SPY',
        quantityShares: 1, executionPriceUsdPerShare: opening ? 771.785 : 774.305,
        feeUsd: opening ? 0 : -0.02,
        brokerOccurredAt: new Date(NOW + fillSequence * 1_000).toISOString(),
        acquiredAt: new Date(NOW + fillSequence * 1_000 + 1).toISOString(),
        rawBrokerEvidenceSha256: String(fillSequence).padStart(64, '0') };
    },
  };
  const controller = createLane1SpyV2Controller({
    config: { armed: configArmed, armedAt: state.armedAt, ttlMs: 86_400_000, secret: SECRET,
      notificationsReady: true }, coordinator, broker,
    bundleStore: { async write(bundle) { writes.push(bundle); return { objectPrefix: 'test/unit' }; } },
    notifier: { async send(message) { notices.push(message); } },
    marketSession: async () => market, now: () => NOW,
    uuid: (() => { let n = 0; return () => '00000000-0000-4000-8000-' + String(++n).padStart(12, '0'); })(),
  });
  return { controller, calls, writes, notices, state: () => structuredClone(state) };
}

test('TV vocabulary is locked and SELL or EXIT flattens either side', () => {
  assert.deepEqual(normalizeLane1V21Signal('BUY'), { signal: 'LONG', exitScope: null });
  assert.deepEqual(normalizeLane1V21Signal('LONG'), { signal: 'LONG', exitScope: null });
  assert.deepEqual(normalizeLane1V21Signal('SHORT'), { signal: 'SHORT', exitScope: null });
  assert.deepEqual(normalizeLane1V21Signal('EXIT'), { signal: 'EXIT', exitScope: 'ANY' });
  assert.deepEqual(normalizeLane1V21Signal('SELL'), { signal: 'EXIT', exitScope: 'ANY' });
});

test('every valid no-send TV alert returns 200 and never an order conflict', async () => {
  for (const [positionSide, requested, disposition] of [
    ['FLAT', 'EXIT', 'already-flat'], ['FLAT', 'SELL', 'already-flat'],
    ['LONG', 'BUY', 'already-in'], ['LONG', 'LONG', 'already-in'],
    ['SHORT', 'SHORT', 'already-in'], ['LONG', 'SHORT', 'must-exit-first'],
    ['SHORT', 'LONG', 'must-exit-first'],
  ]) {
    const h = makeHarness({ positionSide });
    const result = await h.controller.signal(signal(requested));
    assert.equal(result.status, 200); assert.equal(result.body.disposition, disposition);
    assert.equal(result.body.sent, false);
    assert.equal(h.calls.some((entry) => entry.startsWith('market:')), false);
  }
  const off = makeHarness({ armed: false });
  assert.equal((await off.controller.signal(signal('BUY'))).status, 200);
  const closed = makeHarness({ market: 'CLOSED' });
  assert.equal((await closed.controller.signal(signal('LONG'))).body.disposition, 'market-closed');
  const duplicate = makeHarness({ claimable: false });
  assert.equal((await duplicate.controller.signal(signal('LONG'))).body.disposition, 'duplicate-in-flight');
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

test('SHORT opens from flat and SELL covers it without a preview gate', async () => {
  const h = makeHarness();
  const opened = await h.controller.signal(signal('SHORT'));
  assert.equal(opened.body.brokerOrderId, 'TV-ORDER-1');
  const exited = await h.controller.signal(signal('SELL'));
  assert.equal(exited.body.brokerOrderId, 'TV-ORDER-2');
  assert.deepEqual(h.calls.filter((entry) => entry.startsWith('market:')),
    ['market:SELL_SHORT:true', 'market:BUY_TO_COVER:true']);
  assert.equal(exited.body.positionSide, 'FLAT');
});

test('ARM remains live after EXIT and a later opening starts a new episode', async () => {
  const h = makeHarness();
  assert.equal((await h.controller.signal(signal('LONG'))).body.disposition, 'opened');
  assert.equal((await h.controller.signal(signal('EXIT'))).body.disposition, 'exited');
  const reopened = await h.controller.signal(signal('SHORT'));
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.disposition, 'opened');
  assert.equal(reopened.body.positionSide, 'SHORT');
  assert.equal(h.writes.length, 3);
  const reopenedEvents = JSON.parse(h.writes[2].bytes['order-events.json']).appendLog;
  assert.equal(reopenedEvents.filter((row) => row.eventType === 'EQUITY_FILL').length, 1);
  assert.equal(reopenedEvents.find((row) => row.eventType === 'PROPOSAL_SEALED').signal, 'SHORT');
});

test('a valid TV body reports faults with HTTP 200; malformed bodies remain 400', async () => {
  const faulted = makeHarness({ placeFault: 'SCHWAB_LANE_MARKET_ORDER_BUY_500' });
  const fault = await faulted.controller.signal(signal('LONG'));
  assert.equal(fault.status, 200); assert.equal(fault.body.state, 'FAULT');
  assert.equal(fault.body.faultCode, 'SCHWAB_LANE_MARKET_ORDER_BUY_500');
  assert.equal((await makeHarness().controller.signal(signal('BUY', { ticker: 'QQQ' }))).status, 400);
  assert.equal((await makeHarness().controller.signal(signal('BUY', { qty: 2 }))).status, 400);
  assert.equal((await makeHarness().controller.signal({ ...signal('EXIT'), comment: 'no' })).status, 400);
});

test('custody drift blocks before either market order', async () => {
  const h = makeHarness({ positionSide: 'LONG', custodySide: 'FLAT' });
  const result = await h.controller.signal(signal('EXIT'));
  assert.equal(result.status, 200); assert.equal(result.body.disposition, 'reconciliation-required');
  assert.equal(result.body.faultCode, 'LANE_1_POSITION_STATE_DRIFT');
  assert.equal(h.calls.some((entry) => entry.startsWith('market:')), false);
});

test('durable Principal ARM enables LONG and EXIT while environment stays OFF', async () => {
  const h = makeHarness({ armed: true, configArmed: false });
  const opened = await h.controller.signal(signal('LONG'));
  assert.equal(opened.status, 200); assert.equal(opened.body.brokerOrderId, 'TV-ORDER-1');
  const exited = await h.controller.signal(signal('EXIT'));
  assert.equal(exited.status, 200); assert.equal(exited.body.brokerOrderId, 'TV-ORDER-2');
  assert.deepEqual(h.calls.filter((entry) => entry.startsWith('market:')),
    ['market:BUY:true', 'market:SELL:true']);
  assert.equal(h.state().armed, true);
});
