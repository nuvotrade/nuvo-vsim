import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SchwabD1Client } from '../cloudflare/schwab-client.js';
import { createLane1Runtime } from '../cloudflare/lane-1-runtime.js';
import { syntheticPositionPacket, syntheticClaim, syntheticOrder } from './fixtures/lane-1-synthetic-state.js';

// All HTTP is intercepted. Even positive cases produce only synthetic receipts.
async function harness(instruction, exercise) {
  const originalFetch = globalThis.fetch;
  const side = instruction === 'SELL' ? 'LONG' : instruction === 'BUY_TO_COVER' ? 'SHORT' : 'FLAT';
  const scenario = { packet: syntheticPositionPacket(side), orders: [],
    state: syntheticClaim(instruction), accountHash: 'ACCOUNT-HASH', calls: [], mutationCount: 0 };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    scenario.calls.push(`${method} ${u.pathname}${u.search}`);
    if (u.origin !== 'https://api.schwabapi.com') throw new Error('UNEXPECTED_TEST_DESTINATION');
    if (method === 'POST' && u.pathname === '/trader/v1/accounts/ACCOUNT-HASH/orders') {
      scenario.mutationCount += 1;
      assert.equal(JSON.parse(init.body).orderLegCollection[0].instruction, instruction);
      return new Response(null, { status: 201,
        headers: { location: '/trader/v1/accounts/ACCOUNT-HASH/orders/FAKE-ORDER' } });
    }
    assert.equal(method, 'GET');
    if (u.pathname.endsWith('/ACCOUNT-HASH') && u.searchParams.get('fields') === 'positions') {
      if (scenario.positionReadError) return new Response('{}', { status: 503 });
      return Response.json(scenario.packet);
    }
    if (u.pathname.endsWith('/ACCOUNT-HASH/orders')) {
      if (scenario.orderReadError) return new Response('{}', { status: 503 });
      assert.equal(u.searchParams.get('maxResults'), '3000');
      assert.equal(u.searchParams.has('status'), false);
      return Response.json(scenario.orders, { status: scenario.orderStatus ?? 200, headers: scenario.orderHeaders ?? {} });
    }
    throw new Error('UNEXPECTED_TEST_PATH');
  };
  try {
    const client = new SchwabD1Client({ NUVO_LANE_1_SPY_ARMED: 'OFF' });
    client.configured = () => true;
    client._laneAccountHash = async () => ({ accountHash: scenario.accountHash, token: 'SYNTHETIC' });
    const expectedSnapshot = await client.lane1V21SendSnapshot('SYNTHETIC-OWNER');
    const context = { durableArm: true, expectedSnapshot,
      readCoordinator: async () => { scenario.calls.push('coordinator'); return scenario.state; } };
    const send = (overrides = {}) => client.placeLane1V21Market('SYNTHETIC-OWNER',
      { instruction, clientOrderId: 'CLIENT-1' }, { ...context, ...overrides });
    await exercise({ client, scenario, send, expectedSnapshot });
  } finally { globalThis.fetch = originalFetch; }
}

for (const instruction of ['BUY', 'SELL', 'SELL_SHORT', 'BUY_TO_COVER']) {
  test(`dispatch recheck: synthetic ${instruction} rereads both endpoints and coordinator before one fake POST`, async () => {
    await harness(instruction, async ({ scenario, send }) => {
      const receipt = await send();
      assert.equal(receipt.brokerOrderId, 'FAKE-ORDER');
      assert.equal(scenario.mutationCount, 1);
      assert.equal(scenario.calls.filter((call) => call.includes('?fields=positions')).length, 2);
      const reads = scenario.calls.filter((call) => call.startsWith('GET') && call.includes('/orders?'));
      assert.equal(reads.length, 2);
      const floor = (call) => new URL(`https://api.schwabapi.com${call.slice(4)}`).searchParams.get('fromEnteredTime');
      assert.equal(floor(reads[0]), floor(reads[1]));
      assert.equal(scenario.calls.at(-2), 'coordinator');
      assert.equal(scenario.calls.at(-1), 'POST /trader/v1/accounts/ACCOUNT-HASH/orders');
    });
  });
}

const refusalCases = [
  ['position changes after initial read', (s) => { s.packet = syntheticPositionPacket('LONG'); },
    'LANE_1_POSITION_STATE_DRIFT:PRE_DISPATCH_POSITION_CHANGED'],
  ['positions disappear after initial read', (s) => { s.packet = { securitiesAccount: {} }; },
    'LANE_1_POSITION_STATE_DRIFT:BROKER_POSITION_UNKNOWN:positions'],
  ['working order appears after initial read', (s) => { s.orders = [syntheticOrder()]; }, 'LANE_1_WORKING_ORDER_PRESENT'],
  ['pending cancellation is still a working order', (s) => { s.orders = [syntheticOrder('PENDING_CANCEL')]; }, 'LANE_1_WORKING_ORDER_PRESENT'],
  ['filled external round trip leaves FLAT but changes order history', (s) => { s.orders = [syntheticOrder('FILLED')]; }, 'LANE_1_PRE_DISPATCH_ORDER_STATE_CHANGED'],
  ['malformed order body', (s) => { s.orders = {}; }, 'LANE_1_WORKING_ORDER_STATE_UNKNOWN'],
  ['unknown order status', (s) => { s.orders = [syntheticOrder('FUTURE_STATUS')]; }, 'LANE_1_WORKING_ORDER_STATE_UNKNOWN'],
  ['account switches during credential selection', (s) => { s.accountHash = 'OTHER'; }, 'LANE_1_POSITION_STATE_DRIFT:ACCOUNT_CHANGED'],
  ['Principal disarms during broker reads', (s) => { s.state.armed = false; }, 'LANE_1_DISARMED'],
  ['coordinator position changes', (s) => { s.state.positionSide = 'LONG'; }, 'LANE_1_POSITION_STATE_DRIFT:PRE_DISPATCH_COORDINATOR_CHANGED'],
  ['claim belongs to another signal', (s) => { s.state.open.seal.clientOrderId = 'OTHER'; }, 'LANE_1_DISPATCH_CLAIM_CHANGED'],
  ['ARM expires during broker reads', (s) => { s.state.expiresAt = new Date(Date.now() - 1).toISOString(); }, 'LANE_1_ARM_WINDOW_EXPIRED'],
  ['position endpoint fails', (s) => { s.positionReadError = true; }, 'SCHWAB_READ_503:/accounts/ACCOUNT-HASH'],
  ['orders endpoint fails', (s) => { s.orderReadError = true; }, 'SCHWAB_READ_503:/accounts/ACCOUNT-HASH/orders'],
  ['partial HTTP 206 list', (s) => { s.orderStatus = 206; }, 'LANE_1_ORDER_READ_INCOMPLETE'],
  ['pagination Link header', (s) => { s.orderHeaders = { link: '</orders?page=2>; rel="next"' }; }, 'LANE_1_ORDER_READ_INCOMPLETE'],
  ['total count exceeds returned rows', (s) => { s.orderHeaders = { 'x-total-count': '1' }; }, 'LANE_1_ORDER_READ_INCOMPLETE'],
  ['truncation header', (s) => { s.orderHeaders = { 'x-truncated': 'true' }; }, 'LANE_1_ORDER_READ_INCOMPLETE'],
  ['3000-row response cap', (s) => { s.orders = Array.from({ length: 3000 }, () => syntheticOrder('FILLED')); }, 'LANE_1_ORDER_READ_LIMIT_REACHED'],
];
for (const [name, change, message] of refusalCases) {
  test(`dispatch recheck: ${name} => exact refusal and zero POST`, async () => {
    await harness('BUY', async ({ scenario, send }) => {
      change(scenario);
      await assert.rejects(send, { message });
      assert.equal(scenario.mutationCount, 0);
      assert.equal(scenario.calls.some((call) => call.startsWith('POST')), false);
    });
  });
}

test('dispatch recheck: missing baseline or final coordinator reader refuses before network', async () => {
  await harness('BUY', async ({ scenario, send }) => {
    const count = scenario.calls.length;
    await assert.rejects(() => send({ expectedSnapshot: null }),
      { message: 'LANE_1_POSITION_STATE_DRIFT:BROKER_POSITION_UNKNOWN' });
    await assert.rejects(() => send({ readCoordinator: null }), { message: 'LANE_1_DISPATCH_COORDINATOR_REQUIRED' });
    assert.equal(scenario.calls.length, count);
    assert.equal(scenario.mutationCount, 0);
  });
});

test('dispatch recheck: original position reader also rejects missing positions', async () => {
  await harness('BUY', async ({ client, scenario }) => {
    scenario.packet = { securitiesAccount: {} };
    await assert.rejects(() => client.lane1V2NetSpyPosition('SYNTHETIC-OWNER'),
      { message: 'LANE_1_POSITION_STATE_DRIFT:BROKER_POSITION_UNKNOWN:positions' });
    assert.equal(scenario.mutationCount, 0);
  });
});

test('production runtime wiring carries snapshot and claim identity through to the final recheck', async () => {
  const proto = SchwabD1Client.prototype;
  const original = { configured: proto.configured, _laneAccountHash: proto._laneAccountHash,
    marketHours: proto.marketHours, _waitForLane1Fill: proto._waitForLane1Fill };
  try {
    await harness('BUY', async ({ scenario }) => {
      proto.configured = () => true;
      proto._laneAccountHash = async () => ({ accountHash: 'ACCOUNT-HASH', token: 'SYNTHETIC' });
      proto.marketHours = async () => ({ equity: { isOpen: true, sessionHours: {} } });
      proto._waitForLane1Fill = async () => { throw new Error('SYNTHETIC_STOP_AFTER_FAKE_POST'); };
      const fetchMock = globalThis.fetch;
      globalThis.fetch = async (url, init) => new URL(url).hostname === 'discord.com'
        ? new Response(null, { status: 204 }) : fetchMock(url, init);
      let state = { ...syntheticClaim(), stage: 'FLAT', open: null };
      const stub = {
        laneV2Ensure: async () => structuredClone(state),
        laneV2Status: async () => structuredClone(state),
        laneV2Claim: async ({ signal, seal }) => {
          state.stage = `${signal}_SENDING`; state.open = { seal };
          return { claimed: true, state: structuredClone(state) };
        },
        laneV2RecordAccepted: async () => structuredClone(state),
        laneV2RecordFault: async (detail) => {
          state = { ...state, armed: false, stage: 'FAULT', fault: detail }; return state;
        },
      };
      const runtime = createLane1Runtime({ NUVO_LANE_1_SPY_ARMED: 'OFF',
        LANE_1_TV_WEBHOOK_SECRET: 'SYNTHETIC-TEST-ONLY',
        NUVO_LANE_1_DISCORD_SERVER: 'NUVO VSIM', NUVO_LANE_1_DISCORD_CHANNEL: 'test',
        LANE_1_DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/SYNTHETIC/NEVER-SENT',
        ACCOUNT_COORDINATOR: { getByName: () => stub }, EVIDENCE: {} }, 'SYNTHETIC-OWNER');
      const result = await runtime.signal({ ticker: 'SPY', side: 'BUY', qty: 1, secret: 'SYNTHETIC-TEST-ONLY' });
      assert.equal(result.body.faultCode, 'SYNTHETIC_STOP_AFTER_FAKE_POST');
      assert.equal(scenario.mutationCount, 1);
      // Harness baseline + runtime baseline + mandatory final live-read mock.
      assert.equal(scenario.calls.filter((call) => call.includes('?fields=positions')).length, 3);
      assert.equal(scenario.calls.filter((call) => call.startsWith('GET') && call.includes('/orders?')).length, 3);
      assert.equal(state.open.seal.brokerInstruction, 'BUY');
      assert.equal(typeof state.open.seal.clientOrderId, 'string');
    });
  } finally { Object.assign(proto, original); }
});
