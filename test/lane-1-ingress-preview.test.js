import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleLane1PreviewRequest, handleLane1TvWebhook, latestLane1ReplayIngress,
  previewStoredLane1Ingress,
} from '../cloudflare/lane-1-runtime.js';

const OWNER = 'OWNER-1';
const INGRESS_ID = '11111111-1111-4111-8111-111111111111';
const SECRET = 'real-tv-secret';

function memoryDb(seed = []) {
  const rows = structuredClone(seed);
  return {
    rows,
    prepare(sql) {
      return { bind(...params) {
        return {
          async run() {
            if (!sql.includes('INSERT INTO operational_audit')) throw new Error('UNEXPECTED_RUN');
            const [id, ownerId, eventType, detailJson, createdAt] = params;
            rows.push({ id, owner_id: ownerId, event_type: eventType,
              detail_json: detailJson, created_at: createdAt });
            return { success: true, meta: { changes: 1 } };
          },
          async all() {
            if (!sql.includes("event_type='LANE_1_TV_INGRESS'")) throw new Error('UNEXPECTED_ALL');
            const [ownerId] = params;
            return { success: true, results: rows.filter((row) => row.owner_id === ownerId
              && row.event_type === 'LANE_1_TV_INGRESS')
              .sort((left, right) => right.created_at.localeCompare(left.created_at)).slice(0, 50) };
          },
          async first() {
            const [id, ownerId] = params;
            return rows.find((row) => row.id === id && row.owner_id === ownerId
              && row.event_type === 'LANE_1_TV_INGRESS') ?? null;
          },
        };
      } };
    },
  };
}

function disarmedState() {
  return { armed: false, stage: 'DISARMED', positionSide: 'FLAT', open: null,
    exit: null, stop: null, latestUnit: null, fault: null,
    updatedAt: '2026-08-28T23:46:00.000Z' };
}

function webhookEnv(db) {
  const state = disarmedState();
  return { DB: db, LANE_1_TV_WEBHOOK_SECRET: SECRET, NUVO_LANE_1_SPY_ARMED: 'OFF',
    EVIDENCE: {}, CF_VERSION_METADATA: { id: 'candidate-version' },
    ACCOUNT_COORDINATOR: { getByName: () => ({
      laneV2Ensure: async () => structuredClone(state),
    }) } };
}

test('existing disarmed /lane/tv behavior is unchanged while storing the replay binding', async () => {
  const db = memoryDb();
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  let response;
  try {
    globalThis.fetch = async () => {
      networkCalls += 1;
      return new Response(JSON.stringify({ error: 'UNEXPECTED_NETWORK' }), { status: 500 });
    };
    response = await handleLane1TvWebhook({
      request: new Request('https://vsim.nuvotrade.co/lane/tv', { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticker: 'SPY', side: 'BUY', qty: 1, secret: SECRET }) }),
      env: webhookEnv(db), ownerId: OWNER,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual({ state: payload.state, disposition: payload.disposition, sent: payload.sent },
    { state: 'DISARMED', disposition: 'disarmed', sent: false });
  assert.equal(networkCalls, 0);
  const ingress = db.rows.find((row) => row.event_type === 'LANE_1_TV_INGRESS');
  assert.ok(ingress, 'authenticated ingress remains append-only in operational_audit');
  const detail = JSON.parse(ingress.detail_json);
  assert.equal(detail.replayEligible, true);
  assert.deepEqual(detail.replayBody, { ticker: 'SPY', side: 'BUY', qty: 1 });
  assert.equal(JSON.stringify(detail).includes(SECRET), false);
  assert.match(detail.tvBodyBindingSha256, /^[a-f0-9]{64}$/u);
  assert.equal(payload.tvBodyBindingSha256, detail.tvBodyBindingSha256);
  const latest = await latestLane1ReplayIngress({ DB: db }, OWNER);
  assert.equal(latest.ingressId, ingress.id);
  assert.equal(latest.tvBodyBindingSha256, detail.tvBodyBindingSha256);
});

test('stored-ingress preview binds that TV body to one Schwab preview without claiming or arming', async () => {
  const tvBodyBindingSha256 = 'ab'.repeat(32);
  const source = { id: INGRESS_ID, owner_id: OWNER, event_type: 'LANE_1_TV_INGRESS',
    created_at: '2026-08-28T23:47:37.284Z', detail_json: JSON.stringify({
      replayEligible: true, replayBody: { ticker: 'SPY', side: 'BUY', qty: 1 },
      tvBodyBindingSha256,
    }) };
  const db = memoryDb([source]);
  const state = disarmedState();
  let statusReads = 0; let previewCalls = 0;
  const binding = await import('../src/lane/lane-1-spy-v2.js')
    .then((module) => module.bindLane1V21ReplayBody({ ticker: 'SPY', side: 'BUY', qty: 1 }));
  source.detail_json = JSON.stringify({ ...JSON.parse(source.detail_json),
    tvBodyBindingSha256: binding.tvBodyBindingSha256 });
  db.rows[0].detail_json = source.detail_json;
  const result = await previewStoredLane1Ingress({
    env: { DB: db, NUVO_LANE_1_SPY_ARMED: 'OFF',
      CF_VERSION_METADATA: { id: 'candidate-version' } },
    ownerId: OWNER, ingressId: INGRESS_ID,
    now: () => Date.parse('2026-08-28T23:50:00.000Z'),
    uuid: () => '22222222-2222-4222-8222-222222222222',
    dependencies: {
      coordinator: { async status() { statusReads += 1; return structuredClone(state); } },
      client: { async previewLane1V21Market(_ownerId, order) {
        previewCalls += 1; assert.deepEqual(order, { instruction: 'BUY' });
        return { status: 'CLEAR', requestSha256: 'cd'.repeat(32),
          rawResponseSha256: 'ef'.repeat(32), accountMask: '•4315' };
      } },
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.disposition, 'previewed');
  assert.equal(result.body.sent, false);
  assert.equal(result.body.armStillDisarmed, true);
  assert.equal(result.body.tvBodyBindingSha256, binding.tvBodyBindingSha256);
  assert.equal(previewCalls, 1); assert.equal(statusReads, 2);
  const proof = db.rows.find((row) => row.event_type === 'LANE_1_ORDER_PREVIEW');
  const detail = JSON.parse(proof.detail_json);
  assert.equal(detail.sourceIngressId, INGRESS_ID);
  assert.equal(detail.tvBodyBindingSha256, binding.tvBodyBindingSha256);
  assert.equal(detail.schwabEndpoint, '/previewOrder');
  assert.equal(detail.sent, false); assert.equal(detail.test, true);
  assert.deepEqual(detail.coordinatorBefore, detail.coordinatorAfter);
});

test('preview refuses both armed keys and non-replayable rows before Schwab', async () => {
  const oldRow = { id: INGRESS_ID, owner_id: OWNER, event_type: 'LANE_1_TV_INGRESS',
    created_at: '2026-08-28T23:47:37.284Z',
    detail_json: JSON.stringify({ receivedAt: '2026-08-28T23:47:37.284Z', side: 'BUY' }) };
  const db = memoryDb([oldRow]); let calls = 0;
  const client = { async previewLane1V21Market() { calls += 1; return { status: 'CLEAR' }; } };
  const coordinator = { async status() { return disarmedState(); } };
  const envArmed = await previewStoredLane1Ingress({ env: { DB: db,
    NUVO_LANE_1_SPY_ARMED: 'ON' }, ownerId: OWNER, ingressId: INGRESS_ID,
  dependencies: { client, coordinator } });
  assert.equal(envArmed.body.faultCode, 'LANE_1_MARKET_PREVIEW_REQUIRES_ARMED_OFF');
  const old = await previewStoredLane1Ingress({ env: { DB: db,
    NUVO_LANE_1_SPY_ARMED: 'OFF' }, ownerId: OWNER, ingressId: INGRESS_ID,
  dependencies: { client, coordinator } });
  assert.equal(old.body.faultCode, 'LANE_1_PREVIEW_SOURCE_NOT_REPLAYABLE');
  const binding = await import('../src/lane/lane-1-spy-v2.js')
    .then((module) => module.bindLane1V21ReplayBody({ ticker: 'SPY', side: 'BUY', qty: 1 }));
  db.rows[0].detail_json = JSON.stringify({ replayEligible: true,
    replayBody: binding.replayBody, tvBodyBindingSha256: binding.tvBodyBindingSha256 });
  const durableArmed = await previewStoredLane1Ingress({ env: { DB: db,
    NUVO_LANE_1_SPY_ARMED: 'OFF' }, ownerId: OWNER, ingressId: INGRESS_ID,
  dependencies: { client, coordinator: { async status() {
    return { ...disarmedState(), armed: true, stage: 'FLAT' };
  } } } });
  assert.equal(durableArmed.body.faultCode, 'LANE_1_PREVIEW_REQUIRES_DURABLE_DISARMED');
  assert.equal(calls, 0);
});

test('authenticated preview route accepts only ingressId and returns a named inline fault', async () => {
  const badShape = await handleLane1PreviewRequest({
    request: new Request('https://vsim.nuvotrade.co/api/lane-1-spy/preview-ingress', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ingressId: INGRESS_ID, ticker: 'SPY' }),
    }), env: { NUVO_LANE_1_SPY_ARMED: 'OFF' }, ownerId: OWNER,
  });
  assert.equal(badShape.status, 400);
  assert.equal((await badShape.json()).faultCode, 'LANE_1_PREVIEW_REQUEST_INVALID');
  const failed = await handleLane1PreviewRequest({
    request: new Request('https://vsim.nuvotrade.co/api/lane-1-spy/preview-ingress', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ingressId: INGRESS_ID }),
    }), env: { NUVO_LANE_1_SPY_ARMED: 'OFF', DB: { prepare() {
      throw new Error('D1_PREVIEW_READ_FAILED:detail');
    } } }, ownerId: OWNER,
  });
  assert.equal(failed.status, 422);
  assert.equal((await failed.json()).faultCode, 'D1_PREVIEW_READ_FAILED');
});
