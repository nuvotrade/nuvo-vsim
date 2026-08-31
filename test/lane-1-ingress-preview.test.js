import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SchwabD1Client, buildLane1SchwabMarketOrder } from '../cloudflare/schwab-client.js';
import { liveDerivedPreviewOrder, livePreviewBody, livePreviewInspection } from './helpers/schwab-preview-order.js';
import { previewEvidenceBucket } from './helpers/preview-evidence-bucket.js';
import { testPublicKey, decryptStored } from './helpers/preview-evidence-key.js';
import { canonicalJson, redactPreviewOriginal } from '../cloudflare/preview-evidence-codec.js';
import { bindLane1V21ReplayBody } from '../src/lane/lane-1-spy-v2.js';
import {
  handleLane1PreviewRequest, handleLane1TvWebhook, latestLane1ReplayIngress,
  previewStoredLane1Ingress,
} from '../cloudflare/lane-1-runtime.js';

const OWNER = 'OWNER-1';
const INGRESS_ID = '11111111-1111-4111-8111-111111111111';
const SECRET = 'real-tv-secret';

function assertClearContract(contract) {
  const { assetType, instrumentAssetType, ...actual } = contract.actual;
  assert.deepEqual(actual, contract.expected);
  assert.deepEqual(contract.assetPolicy, {
    allowed: ['EQUITY', 'COLLECTIVE_INVESTMENT'], bothPathsMustAgree: true,
  });
  assert.ok(contract.assetPolicy.allowed.includes(assetType));
  assert.equal(assetType, instrumentAssetType);
  assert.equal(contract.mappedPaths.quantity, 'orderStrategy.quantity');
  assert.equal(contract.mappedPaths.symbol, 'orderStrategy.orderLegs[0].instrument.symbol');
  assert.deepEqual(contract.fieldTypes, { quantity: 'number', symbol: 'string',
    assetType: 'string', instrumentAssetType: 'string' });
}

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
    env: { DB: db, EVIDENCE: previewEvidenceBucket(), NUVO_LANE_1_SPY_ARMED: 'OFF',
      CF_VERSION_METADATA: { id: 'candidate-version' } },
    ownerId: OWNER, ingressId: INGRESS_ID,
    now: () => Date.parse('2026-08-28T23:50:00.000Z'),
    uuid: () => '22222222-2222-4222-8222-222222222222',
    dependencies: {
      coordinator: { async status() { statusReads += 1; return structuredClone(state); } },
      client: { async previewLane1V21Market(_ownerId, order, { captureResponse }) {
        previewCalls += 1; assert.deepEqual(order, { instruction: 'BUY' });
        await captureResponse(new Response('{}'), { requestSha256: 'cd'.repeat(32) });
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

async function previewReceiptFixture(t, raw, { status = 200, failWrite = false,
  failCapture = false } = {}) {
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
  const bucket = previewEvidenceBucket();
  if (failCapture) bucket.put = async () => { throw new Error('R2_UNAVAILABLE'); };
  const env = { DB: db, EVIDENCE: bucket, NUVO_LANE_1_SPY_ARMED: 'OFF',
    CF_VERSION_METADATA: { id: 'receipt-candidate' } };
  const client = new SchwabD1Client(env);
  client.configured = () => true;
  client._laneAccountHash = async () => ({ accountHash: 'PRIVATE-ACCOUNT', token: 'PRIVATE-TOKEN' });
  const result = await previewStoredLane1Ingress({ env, ownerId: OWNER, ingressId: INGRESS_ID,
    dependencies: { client, previewEvidencePublicKey:testPublicKey, coordinator: {
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
  return { db, result, binding, bucket };
}

test('complete broker response is saved before refusal, not just our scalar summary', async (t) => {
  const raw = '{\n  "orderStrategy": {"orderLegs":[{"quantity":{"value":1},"symbol":"SPY"}]},\n'
    + '  "unknownBrokerField": {"nested":"preserve me"}, "accountNumber":"PRIVATE-ACCOUNT"\n}\n';
  const { db, result, bucket } = await previewReceiptFixture(t, raw);
  assert.equal(result.status, 422);
  const proof = JSON.parse(db.rows[1].detail_json);
  const ref = proof.rawResponseEvidence;
  assert.equal(ref.complete, true);
  assert.equal(ref.httpStatus, 200);
  assert.equal(ref.sourceIngressId, INGRESS_ID);
  assert.equal(ref.bytes, Buffer.byteLength(raw));
  assert.equal(ref.sha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(Buffer.from(await decryptStored(bucket, ref.bodyKey)).toString(), raw);
  assert.deepEqual(JSON.parse(Buffer.from(bucket.objects.get(ref.manifestKey).bytes)), ref);
  assert.equal(JSON.stringify(result).includes('PRIVATE-ACCOUNT'), false);
  assert.equal(db.rows[1].detail_json.includes('PRIVATE-ACCOUNT'), false);
});

test('capture failure never clears a preview and never retries Schwab', async (t) => {
  const raw = JSON.stringify({ orderValidationResult: {}, orderStrategy: liveDerivedPreviewOrder() });
  const { result, db } = await previewReceiptFixture(t, raw, { failCapture: true });
  assert.equal(result.status, 422);
  assert.equal(result.body.faultCode, 'LANE_1_PREVIEW_CAPTURE_FAILED');
  assert.equal(JSON.parse(db.rows[1].detail_json).rawResponseEvidence, null);
});

test('D1 failure cannot discard the already saved complete broker response', async (t) => {
  const raw = '{"orderValidationResult":{"reviews":["Needs review"]}}';
  const { result, bucket } = await previewReceiptFixture(t, raw, { failWrite: true });
  assert.equal(result.body.faultCode, 'LANE_1_PREVIEW_RECEIPT_WRITE_FAILED');
  const key = [...bucket.objects.keys()].find((key) => key.endsWith('/original.encrypted.json'));
  assert.equal(Buffer.from(await decryptStored(bucket, key)).toString(), raw);
});

for (const [name, validation, expectedTypes] of [
  ['reject', { rejects: [{ message: 'Broker reject sentence' }], reviews: [], warns: [], alerts: [] },
    { rejects: 'array', reviews: 'array', warns: 'array', alerts: 'array' }],
  ['review', { rejects: [], reviews: [{ message: 'Broker review sentence' }], warns: ['Warning'], alerts: [] },
    { rejects: 'array', reviews: 'array', warns: 'array', alerts: 'array' }],
  ['null and malformed arrays', { rejects: null, reviews: 'Not an array' },
    { rejects: 'null', reviews: 'string', warns: 'missing', alerts: 'missing' }],
  ['missing validation', undefined,
    { rejects: 'missing', reviews: 'missing', warns: 'missing', alerts: 'missing' }],
]) {
  test(`failed preview saves ${name} and exact raw hash without relaxing the gate`, async (t) => {
    const raw = JSON.stringify({ orderValidationResult: validation,
      orderStrategy: liveDerivedPreviewOrder(),
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
      assert.deepEqual(proof[key], redactPreviewOriginal(Buffer.from(raw)).body?.orderValidationResult?.[key] ?? null);
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
  assert.deepEqual(JSON.parse(db.rows[1].detail_json).rejects, [{}]);
  assert.ok(JSON.parse(db.rows[1].detail_json).removedPaths.includes('/orderValidationResult/rejects/0/message'));
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
  }, orderStrategy: liveDerivedPreviewOrder() });
  const { db, result } = await previewReceiptFixture(t, raw);
  assert.equal(result.status, 200);
  assert.equal(result.body.disposition, 'previewed');
  assert.equal(result.body.armStillDisarmed, true);
  assert.equal(db.rows.filter((row) => row.event_type === 'LANE_1_ORDER_PREVIEW').length, 1);
  assert.equal(db.rows.some((row) => row.event_type === 'LANE_1_ORDER_PREVIEW_REFUSED'), false);
  const proof = JSON.parse(db.rows[1].detail_json);
  assert.deepEqual(proof.warns, [null]);
  assert.deepEqual(proof.alerts, [null]);
  assert.ok(proof.removedPaths.includes('/orderValidationResult/warns/0'));
  assert.ok(proof.removedPaths.includes('/orderValidationResult/alerts/0'));
  assertClearContract(proof.orderContract);
});

for (const [name, validation] of [
  ['both rejects and reviews omitted', { warns: [{ activityMessage: 'Market-order price warning', originalSeverity: 'WARN' }] }],
  ['only rejects omitted', { reviews: [] }],
  ['only reviews omitted', { rejects: [] }],
  ['all optional lists omitted', {}],
]) {
  test(`exact preview clears with ${name}; receipt retains omission, warning, and raw hash`, async (t) => {
    const raw = JSON.stringify({ orderValidationResult: validation,
      orderStrategy: liveDerivedPreviewOrder(),
      accountNumber: 'PRIVATE-ACCOUNT', access_token: 'PRIVATE-TOKEN', secret: SECRET });
    const { db, result, binding } = await previewReceiptFixture(t, raw);
    assert.equal(result.status, 200);
    assert.equal(result.body.disposition, 'previewed');
    assert.equal(result.body.armStillDisarmed, true);
    const proofRows = db.rows.filter((row) => row.event_type === 'LANE_1_ORDER_PREVIEW');
    assert.equal(proofRows.length, 1);
    assert.equal(db.rows.some((row) => row.event_type === 'LANE_1_ORDER_PREVIEW_REFUSED'), false);
    const proof = JSON.parse(proofRows[0].detail_json);
    assert.equal(proof.sourceIngressId, INGRESS_ID);
    assert.equal(proof.tvBodyBindingSha256, binding.tvBodyBindingSha256);
    assert.equal(proof.rawResponseSha256, createHash('sha256').update(raw).digest('hex'));
    assertClearContract(proof.orderContract);
    assert.deepEqual(proof.coordinatorBefore, proof.coordinatorAfter);
    for (const key of ['rejects', 'reviews', 'warns', 'alerts']) {
      assert.deepEqual(proof[key], redactPreviewOriginal(Buffer.from(raw)).body?.orderValidationResult?.[key] ?? null);
      assert.equal(proof.validationFieldTypes[key], validation[key] === undefined ? 'missing' : 'array');
    }
    for (const secret of ['PRIVATE-ACCOUNT', 'PRIVATE-TOKEN', SECRET, 'rawResponseBody']) {
      assert.equal(proofRows[0].detail_json.includes(secret), false);
      assert.equal(JSON.stringify(result).includes(secret), false);
    }
  });
}

for (const field of ['rejects', 'reviews', 'warns', 'alerts']) {
  for (const value of [null, 'not an array', {}, 0, false]) {
    test(`preview refuses explicit ${field}=${JSON.stringify(value)} instead of treating it as omitted`, async (t) => {
      const raw = JSON.stringify({ orderValidationResult: { [field]: value },
        orderStrategy: liveDerivedPreviewOrder() });
      const { db, result } = await previewReceiptFixture(t, raw);
      assert.equal(result.status, 422);
      assert.equal(result.body.faultCode, 'SCHWAB_LANE_MARKET_PREVIEW_LONG_NOT_CLEAR');
      assert.equal(db.rows[1].event_type, 'LANE_1_ORDER_PREVIEW_REFUSED');
      const proof = JSON.parse(db.rows[1].detail_json);
      assert.equal(proof[field], null);
      assert.equal(proof.validationFieldTypes[field], value === null ? 'null' : typeof value);
      if (value !== null) assert.ok(proof.removedPaths.includes(`/orderValidationResult/${field}`));
    });
  }
}

for (const validation of [null, [], 'malformed validation', true, 42]) {
  test(`preview refuses a non-object validation result ${JSON.stringify(validation)}`, async (t) => {
    const raw = JSON.stringify({ orderValidationResult: validation,
      orderStrategy: liveDerivedPreviewOrder() });
    const { result } = await previewReceiptFixture(t, raw);
    assert.equal(result.status, 422);
    assert.equal(result.body.faultCode, 'SCHWAB_LANE_MARKET_PREVIEW_LONG_NOT_CLEAR');
  });
}

for (const field of ['rejects', 'reviews']) {
  test(`a nonempty ${field} list blocks even when the other list is omitted and severity says WARN`, async (t) => {
    const note = { activityMessage: 'Not automatically waived', originalSeverity: 'WARN' };
    const raw = JSON.stringify({ orderValidationResult: { [field]: [note] },
      orderStrategy: liveDerivedPreviewOrder() });
    const { db, result } = await previewReceiptFixture(t, raw);
    assert.equal(result.status, 422);
    assert.equal(result.body.faultCode, 'SCHWAB_LANE_MARKET_PREVIEW_LONG_NOT_CLEAR');
    assert.deepEqual(JSON.parse(db.rows[1].detail_json)[field], [{originalSeverity:'WARN'}]);
    assert.ok(JSON.parse(db.rows[1].detail_json).removedPaths.includes(`/orderValidationResult/${field}/0/activityMessage`));
  });
}

for (const [name, mutate, field, actual] of [
  ['LIMIT order', (o) => { o.orderType = 'LIMIT'; }, 'orderType', 'LIMIT'],
  ['TRIGGER strategy', (o) => { o.orderStrategyType = 'TRIGGER'; }, 'orderStrategyType', 'TRIGGER'],
  ['extended session', (o) => { o.session = 'SEAMLESS'; }, 'session', 'SEAMLESS'],
  ['GTC duration', (o) => { o.duration = 'GOOD_TILL_CANCEL'; }, 'duration', 'GOOD_TILL_CANCEL'],
  ['second leg', (o) => { o.orderLegs.push(structuredClone(o.orderLegs[0])); }, 'legCount', 2],
  ['child order', (o) => { o.childOrderStrategies = [{}]; }, 'childCount', 1],
  ['SELL instruction', (o) => { o.orderLegs[0].instruction = 'SELL'; }, 'instruction', 'SELL'],
  ['quantity two', (o) => { o.quantity = 2; }, 'quantity', 2],
  ['wrong symbol', (o) => { o.orderLegs[0].instrument.symbol = 'WRONG'; }, 'symbol', 'WRONG'],
  ['option asset', (o) => { o.orderLegs[0].assetType = 'OPTION'; }, 'assetType', 'OPTION'],
  ['missing symbol', (o) => { delete o.orderLegs[0].instrument.symbol; }, 'symbol', null],
]) {
  test(`omitted lists cannot bypass echoed contract: ${name}; mismatch is retained`, async (t) => {
    const order = liveDerivedPreviewOrder();
    mutate(order);
    order.accountNumber = 'PRIVATE-ACCOUNT';
    const raw = JSON.stringify({ orderValidationResult: {}, orderStrategy: order });
    const { db, result } = await previewReceiptFixture(t, raw);
    assert.equal(result.status, 422);
    assert.equal(result.body.faultCode, 'SCHWAB_LANE_MARKET_PREVIEW_LONG_CONTRACT_UNVERIFIED');
    const proof = JSON.parse(db.rows[1].detail_json);
    assert.equal(proof.orderContract.actual[field], actual);
    assert.notEqual(proof.orderContract.expected[field], actual);
    assert.equal(proof.rawResponseSha256, createHash('sha256').update(raw).digest('hex'));
    assert.equal(db.rows[1].detail_json.includes('PRIVATE-ACCOUNT'), false);
  });
}

test('omitted validation lists cannot make a missing echoed order clear', async (t) => {
  const { db, result } = await previewReceiptFixture(t, JSON.stringify({ orderValidationResult: {} }));
  assert.equal(result.status, 422);
  assert.equal(result.body.faultCode, 'SCHWAB_LANE_MARKET_PREVIEW_LONG_CONTRACT_UNVERIFIED');
  assert.equal(JSON.parse(db.rows[1].detail_json).orderContract.actual.orderType, null);
});

test('production-byte mapping: unchanged redacted live BUY SPY one-share body with warns only clears', async (t) => {
  // Compatibility gate is the captured live body's redacted projection, not a
  // request echo. The original and inspection hashes remain distinct.
  const raw = JSON.stringify(livePreviewBody());
  const { db, result } = await previewReceiptFixture(t, raw);
  assert.equal(result.status, 200);
  assert.equal(result.body.disposition, 'previewed');
  assert.equal(db.rows[1].event_type, 'LANE_1_ORDER_PREVIEW');
  const proof = JSON.parse(db.rows[1].detail_json);
  assert.equal(proof.orderContract.responseLegSource, 'orderStrategy.orderLegs');
  assertClearContract(proof.orderContract);
  assert.equal(proof.orderContract.actual.symbol, 'SPY');
  assert.equal(proof.orderContract.actual.quantity, 1);
  assert.equal(proof.orderContract.actual.assetType, 'COLLECTIVE_INVESTMENT');
  assert.deepEqual(proof.validationFieldTypes, {
    rejects: 'missing', reviews: 'missing', warns: 'array', alerts: 'missing',
  });
  assert.deepEqual(proof.warns, [{ originalSeverity: 'WARN' }]);
  assert.equal(proof.rejects, null);
  assert.equal(proof.reviews, null);
});

for (const [name, mutate] of [
  ...[true, '1', 0, 1.1, null].map((value) => [`quantity ${JSON.stringify(value)}`,
    (order) => { order.quantity = value; }]),
  ...[null, {}, []].map((value) => [`legs ${JSON.stringify(value)}`,
    (order) => { order.orderLegs = value; }]),
  ...[null, {}, false].map((value) => [`malformed children ${JSON.stringify(value)}`,
    (order) => { order.childOrderStrategies = value; }]),
  ['legacy-only request-shaped echo', (order) => {
    delete order.orderLegs;
    order.orderLegCollection = buildLane1SchwabMarketOrder({ instruction: 'BUY' }).orderLegCollection;
  }],
  ['mixed response and request leg shapes', (order) => {
    order.orderLegCollection = buildLane1SchwabMarketOrder({ instruction: 'SELL' }).orderLegCollection;
  }],
]) {
  test(`live-derived response mapping fails closed on ${name}`, async (t) => {
    const order = liveDerivedPreviewOrder(); mutate(order);
    const { db, result } = await previewReceiptFixture(t, JSON.stringify({
      orderValidationResult: {}, orderStrategy: order,
    }));
    assert.equal(result.status, 422);
    assert.equal(result.body.faultCode, 'SCHWAB_LANE_MARKET_PREVIEW_LONG_CONTRACT_UNVERIFIED');
    assert.equal(db.rows[1].event_type, 'LANE_1_ORDER_PREVIEW_REFUSED');
  });
}

test('live inspection fixture reproduces its canonical hash and names the encrypted original parent', () => {
  assert.equal(createHash('sha256').update(canonicalJson(livePreviewInspection)).digest('hex'),
    'ee10f96829bee206f98ed6013b0bd6b8ab143a49078d71da157412b05d02131f');
  assert.equal(livePreviewInspection.originalSha256,
    '73646c14e46642dee8d9dd752cc11efb561d70501eb34c13b611439697ccd3a4');
  assert.equal(livePreviewInspection.redactionVersion, 'SCHWAB_PREVIEW_ALLOWLIST_V1');
  const leg = livePreviewBody().orderStrategy.orderLegs[0];
  assert.equal(Object.hasOwn(leg, 'quantity'), false);
  assert.equal(Object.hasOwn(leg, 'finalSymbol'), false);
  assert.equal(livePreviewInspection.removedPaths.includes('/orderStrategy/orderLegs/0/quantity'), false);
  assert.equal(livePreviewInspection.removedPaths.includes('/orderStrategy/orderLegs/0/finalSymbol'), false);
});

test('two live-derived legs with order-level quantity exactly one refuse', async (t) => {
  const body = livePreviewBody();
  body.orderStrategy.orderLegs.push(structuredClone(body.orderStrategy.orderLegs[0]));
  assert.equal(body.orderStrategy.quantity, 1);
  const { db, result } = await previewReceiptFixture(t, JSON.stringify(body));
  assert.equal(result.status, 422);
  assert.equal(result.body.faultCode, 'SCHWAB_LANE_MARKET_PREVIEW_LONG_CONTRACT_UNVERIFIED');
  const proof = JSON.parse(db.rows[1].detail_json);
  assert.equal(proof.orderContract.actual.quantity, 1);
  assert.equal(proof.orderContract.actual.legCount, 2);
});

for (const field of ['rejects', 'reviews']) {
  test(`nonempty ${field} added to the live warns-only body refuses`, async (t) => {
    const body = livePreviewBody();
    body.orderValidationResult[field] = [{ originalSeverity: 'WARN' }];
    const { db, result } = await previewReceiptFixture(t, JSON.stringify(body));
    assert.equal(result.status, 422);
    assert.equal(result.body.faultCode, 'SCHWAB_LANE_MARKET_PREVIEW_LONG_NOT_CLEAR');
    assert.equal(db.rows[1].event_type, 'LANE_1_ORDER_PREVIEW_REFUSED');
  });
}

test('explicit EQUITY on both live-derived asset paths also clears', async (t) => {
  const body = livePreviewBody();
  const leg = body.orderStrategy.orderLegs[0];
  leg.assetType = 'EQUITY'; leg.instrument.assetType = 'EQUITY';
  const { db, result } = await previewReceiptFixture(t, JSON.stringify(body));
  assert.equal(result.status, 200);
  assertClearContract(JSON.parse(db.rows[1].detail_json).orderContract);
});

for (const [name, mutate] of [
  ['missing order quantity', (o) => { delete o.quantity; }],
  ['legacy leg quantity cannot replace missing order quantity', (o) => {
    delete o.quantity; o.orderLegs[0].quantity = 1;
  }],
  ['legacy finalSymbol cannot replace missing instrument symbol', (o) => {
    delete o.orderLegs[0].instrument.symbol; o.orderLegs[0].finalSymbol = 'SPY';
  }],
  ['symbol number', (o) => { o.orderLegs[0].instrument.symbol = 1; }],
  ['symbol lowercase', (o) => { o.orderLegs[0].instrument.symbol = 'spy'; }],
  ['symbol array', (o) => { o.orderLegs[0].instrument.symbol = ['SPY']; }],
  ['quantity object', (o) => { o.quantity = { value: 1 }; }],
  ['empty legs', (o) => { o.orderLegs = []; }],
  ['missing instrument', (o) => { delete o.orderLegs[0].instrument; }],
  ['null instrument', (o) => { o.orderLegs[0].instrument = null; }],
  ['missing leg asset', (o) => { delete o.orderLegs[0].assetType; }],
  ['missing instrument asset', (o) => { delete o.orderLegs[0].instrument.assetType; }],
  ['unknown assets agree', (o) => {
    o.orderLegs[0].assetType = 'NEW_ASSET'; o.orderLegs[0].instrument.assetType = 'NEW_ASSET';
  }],
  ['OPTION assets agree', (o) => {
    o.orderLegs[0].assetType = 'OPTION'; o.orderLegs[0].instrument.assetType = 'OPTION';
  }],
  ['leg asset null', (o) => { o.orderLegs[0].assetType = null; }],
  ['instrument asset array', (o) => { o.orderLegs[0].instrument.assetType = ['EQUITY']; }],
  ['allowed assets disagree leg EQUITY', (o) => { o.orderLegs[0].assetType = 'EQUITY'; }],
  ['allowed assets disagree instrument EQUITY', (o) => { o.orderLegs[0].instrument.assetType = 'EQUITY'; }],
]) {
  test(`live-body negative mutation refuses: ${name}`, async (t) => {
    const body = livePreviewBody(); mutate(body.orderStrategy);
    const { db, result } = await previewReceiptFixture(t, JSON.stringify(body));
    assert.equal(result.status, 422);
    assert.equal(result.body.faultCode, 'SCHWAB_LANE_MARKET_PREVIEW_LONG_CONTRACT_UNVERIFIED');
    assert.equal(db.rows[1].event_type, 'LANE_1_ORDER_PREVIEW_REFUSED');
    const proof = JSON.parse(db.rows[1].detail_json);
    const value = body.orderStrategy.quantity;
    assert.equal(proof.orderContract.fieldTypes.quantity, value === undefined ? 'missing'
      : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
  });
}
