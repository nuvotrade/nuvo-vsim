import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLane1SpyController } from '../src/lane/lane-1-spy.js';

const ARMED_AT = '2026-08-28T13:30:00.000Z';
const NOW = Date.parse('2026-08-28T14:00:00.000Z');
const SECRET = 'lane-test-secret';

function coordinator({ stage = 'ARMED_BUY', timeline = [], justArmed = false } = {}) {
  let current = {
    armed: stage !== 'DISARMED',
    armedAt: ARMED_AT,
    expiresAt: '2026-08-29T13:30:00.000Z',
    stage,
    buy: null,
    sell: null,
    latestUnit: null,
  };
  return {
    async ensure() {
      const result = { ...structuredClone(current), ...(justArmed ? { justArmed: true } : {}) };
      justArmed = false;
      return result;
    },
    async claimSignal({ side, seal }) {
      const expected = side === 'BUY' ? 'ARMED_BUY' : 'AWAITING_SELL';
      if (!current.armed || current.stage !== expected) {
        return { claimed: false, state: structuredClone(current) };
      }
      timeline.push(`seal:${side}:${seal.clientOrderId}`);
      current = {
        ...current,
        stage: `${side}_SENDING`,
        [side.toLowerCase()]: { seal },
      };
      return { claimed: true, state: structuredClone(current) };
    },
    async recordBrokerAccepted({ side, brokerOrderId }) {
      timeline.push(`accepted:${side}:${brokerOrderId}`);
      current[side.toLowerCase()].brokerOrderId = brokerOrderId;
      return structuredClone(current);
    },
    async recordUnit({ side, unit }) {
      timeline.push(`diary:${side}:${unit.manifestHash}`);
      current.latestUnit = structuredClone(unit);
      current.stage = side === 'BUY' ? 'AWAITING_SELL' : 'DISARMED';
      current.armed = side === 'BUY';
      return structuredClone(current);
    },
    async recordFault({ faultCode }) {
      timeline.push(`fault:${faultCode}`);
      current.stage = 'FAULT';
      current.armed = false;
      return structuredClone(current);
    },
    async disarm({ reason }) {
      timeline.push(`disarm:${reason}`);
      current.stage = 'DISARMED';
      current.armed = false;
      return structuredClone(current);
    },
    async status() { return structuredClone(current); },
  };
}

function broker({ fills = [], timeline = [] } = {}) {
  let index = 0;
  return {
    calls: [],
    async placeEquityOrder(order) {
      timeline.push(`broker:${order.side}:${order.clientOrderId}`);
      this.calls.push(structuredClone(order));
      return {
        brokerOrderId: `BROKER-${order.side}-1`,
        acceptedAt: new Date(NOW).toISOString(),
      };
    },
    async waitForFill({ side, brokerOrderId, clientOrderId }) {
      const supplied = fills[index++] ?? {};
      return {
        brokerOrderId,
        clientOrderId,
        side,
        symbol: 'SPY',
        quantityShares: 1,
        executionPriceUsdPerShare: side === 'BUY' ? 550 : 551,
        feeUsd: 0,
        brokerOccurredAt: new Date(NOW + index * 1_000).toISOString(),
        acquiredAt: new Date(NOW + index * 1_000 + 100).toISOString(),
        rawBrokerEvidenceSha256: String(index).padStart(64, '0'),
        ...supplied,
      };
    },
  };
}

function harness({
  stage = 'ARMED_BUY', fills = [{ fillId: 'FILL-BUY-1' }],
  secret = SECRET, marketSession = 'RTH', now = NOW, armed = true,
  notificationsReady = true, justArmed = false,
} = {}) {
  const timeline = [];
  const laneCoordinator = coordinator({ stage, timeline, justArmed });
  const laneBroker = broker({ fills, timeline });
  const writes = [];
  const notices = [];
  const controller = createLane1SpyController({
    config: {
      armed,
      armedAt: ARMED_AT,
      ownerId: 'OWNER-1',
      secret,
      ttlMs: 86_400_000,
      notificationsReady,
    },
    coordinator: laneCoordinator,
    broker: laneBroker,
    bundleStore: {
      async write(bundle) {
        writes.push(structuredClone(bundle));
        return { objectPrefix: `lane/${bundle.manifest.resolvedUnitId}` };
      },
    },
    notifier: {
      async send(message) {
        timeline.push(`notify:${message.type}`);
        notices.push(structuredClone(message));
      },
    },
    marketSession: async () => marketSession,
    now: () => now,
    uuid: (() => { let sequence = 0; return () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`; })(),
  });
  return { controller, laneCoordinator, laneBroker, writes, notices, timeline };
}

function signal(overrides = {}) {
  return { ticker: 'SPY', side: 'BUY', qty: 1, secret: SECRET, ...overrides };
}

test('wrong secret, qty 2, QQQ, extra fields, and premarket all refuse before send', async () => {
  for (const body of [
    signal({ secret: 'wrong' }),
    signal({ qty: 2 }),
    signal({ ticker: 'QQQ' }),
    { ...signal(), comment: 'must be rejected' },
  ]) {
    const h = harness();
    const result = await h.controller.signal(body);
    assert.equal(result.status, 400);
    assert.equal(h.laneBroker.calls.length, 0);
    assert.equal(h.writes.length, 0);
  }

  const premarket = harness({ marketSession: 'PRE' });
  const result = await premarket.controller.signal(signal());
  assert.equal(result.status, 409);
  assert.equal(result.body.faultCode, 'LANE_1_RTH_REQUIRED');
  assert.equal(premarket.laneBroker.calls.length, 0);
});

test('default OFF and missing #test destination cannot send', async () => {
  const off = harness({ armed: false });
  const ignored = await off.controller.signal(signal());
  assert.equal(ignored.status, 202);
  assert.equal(off.laneBroker.calls.length, 0);

  const noDiscord = harness({ notificationsReady: false });
  const refused = await noDiscord.controller.signal(signal());
  assert.equal(refused.status, 503);
  assert.equal(refused.body.faultCode, 'LANE_1_DISCORD_NOT_READY');
  assert.equal(noDiscord.laneBroker.calls.length, 0);
});

test('proposal and clientOrderId are durably sealed before Schwab placement', async () => {
  const h = harness({ justArmed: true });
  const result = await h.controller.signal(signal());
  assert.equal(result.status, 200);
  assert.equal(result.body.state, 'AWAITING_SELL');
  assert.equal(h.timeline[0], 'notify:ARMED');
  assert.match(h.timeline[1], /^seal:BUY:LANE1-SPY-/u);
  assert.match(h.timeline[2], /^broker:BUY:LANE1-SPY-/u);
  assert.equal(h.laneBroker.calls[0].symbol, 'SPY');
  assert.equal(h.laneBroker.calls[0].quantity, 1);
  assert.equal(h.laneBroker.calls[0].assetType, 'EQUITY');
  assert.equal(h.laneBroker.calls[0].session, 'NORMAL');
  assert.equal(h.laneBroker.calls[0].duration, 'DAY');
  assert.equal(h.timeline.at(-1), 'notify:BOUGHT');
  assert.ok(h.timeline.findIndex((entry) => entry.startsWith('diary:BUY:'))
    < h.timeline.findIndex((entry) => entry === 'notify:BOUGHT'));
});

test('missing fillId creates named FAULT without a fabricated diary bundle', async () => {
  const h = harness({ fills: [{}] });
  const result = await h.controller.signal(signal());
  assert.equal(result.status, 422);
  assert.equal(result.body.faultCode, 'MISSING_FILL_ID');
  assert.equal(h.laneBroker.calls.length, 1, 'the fault occurs only after the accepted order is polled');
  assert.equal(h.writes.length, 0, 'no fill identity means no resolved-unit bundle');
  assert.ok(h.timeline.includes('fault:MISSING_FILL_ID'));
  assert.ok(h.timeline.indexOf('fault:MISSING_FILL_ID') < h.timeline.indexOf('notify:FAULT'));
});

test('DISARM persists before notification and never calls Schwab', async () => {
  const h = harness();
  const result = await h.controller.disarm({ secret: SECRET });
  assert.equal(result.status, 200);
  assert.equal(result.body.state, 'DISARMED');
  assert.equal(h.laneBroker.calls.length, 0);
  assert.deepEqual(h.timeline, ['disarm:PRINCIPAL_COMMAND', 'notify:DISARMED']);

  const after = await h.controller.signal(signal());
  assert.equal(after.status, 202);
  assert.equal(after.body.state, 'DISARMED');
  assert.equal(h.laneBroker.calls.length, 0);
});

test('BUY then SELL uses one episode, writes both diary states, and disarms', async () => {
  const h = harness({ fills: [{ fillId: 'FILL-BUY-1' }, { fillId: 'FILL-SELL-1' }] });
  const bought = await h.controller.signal(signal());
  assert.equal(bought.body.state, 'AWAITING_SELL');

  const sold = await h.controller.signal(signal({ side: 'SELL' }));
  assert.equal(sold.status, 200);
  assert.equal(sold.body.state, 'DISARMED');
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[0].manifest.economicEpisodeId, h.writes[1].manifest.economicEpisodeId);
  assert.equal(h.writes[1].manifest.status, 'RESOLVED_FLAT');
  assert.deepEqual(JSON.parse(h.writes[1].bytes['decision.json']).authority, {
    level: 2,
    name: 'PROPOSE_ONLY',
    executionException: 'LANE_1_SPY_PRINCIPAL_SIGNED_2026-08-28T01:30:00-07:00',
  });
  assert.doesNotMatch(JSON.stringify(h.writes), /forecast|calibration/iu);
  assert.deepEqual(h.notices.map((notice) => notice.type), ['BOUGHT', 'SOLD', 'DISARMED']);
  assert.deepEqual(h.notices[0], {
    type: 'BOUGHT', symbol: 'SPY', quantity: 1, fillId: 'FILL-BUY-1',
    manifestHash: h.writes[0].manifestHash,
    priceUsdPerShare: 550, feesCents: 0, netCents: -55000,
  });
  assert.deepEqual(h.notices[1], {
    type: 'SOLD', symbol: 'SPY', quantity: 1, fillId: 'FILL-SELL-1',
    manifestHash: h.writes[1].manifestHash,
    priceUsdPerShare: 551, feesCents: 0, netCents: 100,
  });

  const ignored = await h.controller.signal(signal());
  assert.equal(ignored.status, 202);
  assert.equal(h.laneBroker.calls.length, 2);
});

test('24-hour TTL disarms before evaluating a valid signal', async () => {
  const h = harness({ now: Date.parse('2026-08-29T13:30:00.001Z') });
  const result = await h.controller.signal(signal());
  assert.equal(result.status, 202);
  assert.equal(result.body.state, 'DISARMED');
  assert.equal(result.body.reason, 'TTL_EXPIRED');
  assert.equal(h.laneBroker.calls.length, 0);
  assert.deepEqual(h.notices.map((notice) => notice.type), ['DISARMED']);
});
