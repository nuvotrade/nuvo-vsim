import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SchwabD1Client, buildLane1SchwabMarketOrder } from '../cloudflare/schwab-client.js';
import { bindLane1V21ReplayBody } from '../src/lane/lane-1-spy-v2.js';
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

async function previewReceiptFixture(t, raw, { status = 200, failWrite = false } = {}) {
  const binding = await bindLane1V21ReplayBody({ ticker: 'SPY', side: 'BUY', qty: 1 });
  const db = memoryDb([{ id: INGRESS_ID, owner_id: OWNER, event_type: 'LANE_1_TV_INGRESS',
    created_at: '2026-08-31T15:33:13.437Z', detail_json: JSON.stringify({
      replayEligible: true, replayBody: binding.replayBody,
      tvBodyBindingSha256: binding.tvBodyBindingSha256,
    }) }]);
  const sourceBefore = structuredClone(db.rows[0]);
  if (failWrite) {
    const prepare = db.prepare;
    db.prepare = (sql) => {
      if (sql.includes('INSERT')) throw new Error('D1_RECEIPT_UNAVAILABLE');
      return prepare(sql);
    };
  }
  const state = disarmedState(); const before = structuredClone(state);
  let claims = 0;
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) });
    assert.ok(url.endsWith('/previewOrder'), 'no /orders request may reach the network');
    return new Response(raw, { status });
  };
  const env = { DB: db, NUVO_LANE_1_SPY_ARMED: 'OFF',
    CF_VERSION_METADATA: { id: 'receipt-candidate' } };
  const client = new SchwabD1Client(env);
  client.configured = () => true;
  client._laneAccountHash = async () => ({ accountHash: 'PRIVATE-ACCOUNT', token: 'PRIVATE-TOKEN' });
  const result = await previewStoredLane1Ingress({ env, ownerId: OWNER, ingressId: INGRESS_ID,
    dependencies: { client, coordinator: {
      async status() { return structuredClone(state); },
      async claim() { claims += 1; throw new Error('UNEXPECTED_CLAIM'); },
    } },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, buildLane1SchwabMarketOrder({ instruction: 'BUY' }));
  assert.equal(calls[0].method, 'POST');
  assert.equal(claims, 0);
  assert.deepEqual(state, before);
  assert.deepEqual(db.rows[0], sourceBefore, 'stored ingress is never edited');
  assert.equal(result.body.sent, false);
  return { db, result, binding };
}

for (const [name, validation, expectedTypes] of [
  ['reject', { rejects: [{ message: 'Broker reject sentence' }], reviews: [], warns: [], alerts: [] },
    { rejects: 'array', reviews: 'array', warns: 'array', alerts: 'array' }],
  ['review', { rejects: [], reviews: [{ message: 'Broker review sentence' }], warns: ['Warning'], alerts: [] },
    { rejects: 'array', reviews: 'array', warns: 'array', alerts: 'array' }],
  ['missing arrays', { warns: ['Warning only; required arrays absent'] },
    { rejects: 'missing', reviews: 'missing', warns: 'array', alerts: 'missing' }],
  ['null and malformed arrays', { rejects: null, reviews: 'Not an array' },
    { rejects: 'null', reviews: 'string', warns: 'missing', alerts: 'missing' }],
  ['missing validation', undefined,
    { rejects: 'missing', reviews: 'missing', warns: 'missing', alerts: 'missing' }],
]) {
  test(`failed preview saves ${name} and exact raw hash without relaxing the gate`, async (t) => {
    const raw = JSON.stringify({ orderValidationResult: validation,
      orderStrategy: buildLane1SchwabMarketOrder({ instruction: 'BUY' }),
      access_token: 'PRIVATE-TOKEN', accountNumber: 'PRIVATE-ACCOUNT', secret: SECRET });
    const { db, result, binding } = await previewReceiptFixture(t, raw);
    assert.equal(result.status, 422);
    assert.equal(result.body.faultCode, 'SCHWAB_LANE_MARKET_PREVIEW_LONG_NOT_CLEAR');
    const rows = db.rows.filter((row) => row.event_type === 'LANE_1_ORDER_PREVIEW_REFUSED');
    assert.equal(rows.length, 1);
    assert.equal(db.rows.some((row) => row.event_type === 'LANE_1_ORDER_PREVIEW'), false);
    assert.equal(result.body.previewProofId, rows[0].id);
    assert.equal(result.body.ingressId, INGRESS_ID);
    const proof = JSON.parse(rows[0].detail_json);
    assert.equal(proof.sourceIngressId, INGRESS_ID);
    assert.equal(proof.tvBodyBindingSha256, binding.tvBodyBindingSha256);
    assert.equal(proof.rawResponseSha256, createHash('sha256').update(raw).digest('hex'));
    assert.equal(proof.workerVersion, 'receipt-candidate');
    assert.deepEqual(proof.validationFieldTypes, expectedTypes);
    for (const key of ['rejects', 'reviews', 'warns', 'alerts']) {
      assert.deepEqual(proof[key], validation?.[key] ?? null);
    }
    assert.equal(proof.validationPresent, validation !== undefined);
    assert.equal(proof.responseObjectPresent, true);
    assert.equal(proof.schwabEndpoint, '/previewOrder');
    assert.equal(proof.quantity, 1);
    assert.equal(proof.sent, false);
    for (const secret of ['PRIVATE-TOKEN', 'PRIVATE-ACCOUNT', SECRET, 'rawResponseBody']) {
      assert.equal(rows[0].detail_json.includes(secret), false);
      assert.equal(JSON.stringify(result).includes(secret), false);
    }
  });
}

test('failed preview saves malformed JSON hash without inventing empty rejects or reviews', async (t) => {
  const raw = 'not JSON';
  const { db, result } = await previewReceiptFixture(t, raw);
  assert.equal(result.body.faultCode, 'SCHWAB_LANE_MARKET_PREVIEW_LONG_MALFORMED_JSON');
  const proof = JSON.parse(db.rows[1].detail_json);
  assert.equal(proof.rawResponseSha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(proof.responseObjectPresent, false);
  assert.equal(proof.validationPresent, false);
  assert.equal(proof.rejects, null); assert.equal(proof.reviews, null);
});

test('failed preview saves broker rejection fields on non-2xx without changing its refusal code', async (t) => {
  const raw = JSON.stringify({ orderValidationResult: {
    rejects: [{ message: 'Broker refused request' }], reviews: [],
  } });
  const { db, result } = await previewReceiptFixture(t, raw, { status: 400 });
  assert.equal(result.body.faultCode, 'SCHWAB_LANE_MARKET_PREVIEW_LONG_400');
  assert.deepEqual(JSON.parse(db.rows[1].detail_json).rejects, [{ message: 'Broker refused request' }]);
});

test('receipt storage failure is explicit, remains disarmed, and never claims a proof', async (t) => {
  const raw = JSON.stringify({ orderValidationResult: { rejects: [], reviews: ['Review'] } });
  const { db, result } = await previewReceiptFixture(t, raw, { failWrite: true });
  assert.equal(result.status, 422);
  assert.equal(result.body.faultCode, 'LANE_1_PREVIEW_RECEIPT_WRITE_FAILED');
  assert.equal(result.body.previewFaultCode, 'SCHWAB_LANE_MARKET_PREVIEW_LONG_NOT_CLEAR');
  assert.equal(result.body.previewProofId, undefined);
  assert.equal(result.body.state, 'DISARMED');
  assert.equal(db.rows.length, 1);
});

test('warnings alone still clear an exact preview; success does not write a refusal receipt', async (t) => {
  const raw = JSON.stringify({ orderValidationResult: {
    rejects: [], reviews: [], warns: ['Informational warning'], alerts: ['Informational alert'],
  }, orderStrategy: buildLane1SchwabMarketOrder({ instruction: 'BUY' }) });
  const { db, result } = await previewReceiptFixture(t, raw);
  assert.equal(result.status, 200);
  assert.equal(result.body.disposition, 'previewed');
  assert.equal(result.body.armStillDisarmed, true);
  assert.equal(db.rows.filter((row) => row.event_type === 'LANE_1_ORDER_PREVIEW').length, 1);
  assert.equal(db.rows.some((row) => row.event_type === 'LANE_1_ORDER_PREVIEW_REFUSED'), false);
});
