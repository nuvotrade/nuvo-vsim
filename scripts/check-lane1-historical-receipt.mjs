// Offline evidence check, not a production receipt reader or a broker preview.
// The private, pre-existing export is read in place and is never copied to Git.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { latestLane1ReplayIngress, previewStoredLane1Ingress } from '../cloudflare/lane-1-runtime.js';
import { bindLane1V21ReplayBody } from '../src/lane/lane-1-spy-v2.js';

const path = process.argv[2];
if (!path) throw new Error('Supply the existing private VALIDATION_RECEIPT.json path');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bytes = readFileSync(path);
const expectedHash = '16510810bc0badb255128c4bb0d80c83d0a99c8e289a18241311bc0e6d9fdc05';
assert.equal(hash(bytes), expectedHash);
assert.equal(bytes.length, 6053);
const receipt = JSON.parse(bytes);
const before = structuredClone(receipt);
assert.equal(receipt.id, 'eba4d1ac-3e3f-4735-92bb-0309732c1f52');
assert.equal(receipt.event_type, 'LANE_1_ORDER_PREVIEW');
assert.equal(receipt.detail.signal, 'LONG'); // Historical internal label, not a wire token.
assert.equal(receipt.detail.brokerInstruction, 'BUY');
assert.equal(receipt.detail.quantity, 1);
assert.equal(typeof receipt.detail.quantity, 'number');
assert.equal(receipt.detail.orderContract.actual.symbol, 'SPY');
assert.equal(receipt.detail.orderContract.actual.quantity, 1);
for (const key of ['rawMessage', 'acceptedInstruction', 'signalContract']) {
  assert.equal(Object.hasOwn(receipt.detail, key), false); // Unrecorded, not a rejection.
}
// A JSON round trip is storage-format proof only; it is not a dashboard read.
assert.deepEqual(JSON.parse(JSON.stringify(receipt.detail)), receipt.detail);
const binding = await bindLane1V21ReplayBody(receipt.detail.replayBody);
assert.equal(binding.tvBodyBindingSha256, receipt.detail.tvBodyBindingSha256);
assert.equal(binding.replayBody.side, 'BUY');

const runtimePath = 'cloudflare/lane-1-runtime.js';
const runtime = readFileSync(new URL('../' + runtimePath, import.meta.url), 'utf8');
const baseline = execFileSync('git', ['show',
  'ed08909f3b3cdab2404a790d2a2a777e1b9d8afb:' + runtimePath], { encoding: 'utf8' });
const projection = (text) => {
  const start = text.indexOf('function previewOrderContractEvidence(');
  const end = text.indexOf('async function replayBindingFromIngressDetail(', start);
  assert.ok(start >= 0 && end > start);
  return text.slice(start, end);
};
assert.equal(projection(runtime), projection(baseline)); // Writer, NOT a reader.

let networkCalls = 0;
let writeCalls = 0;
const queries = [];
const oldFetch = globalThis.fetch;
globalThis.fetch = async () => { networkCalls++; throw new Error('OFFLINE_ONLY'); };
// Only a historical receipt exists in this local fixture. Enforce actual SQL predicates.
const row = { id: receipt.id, owner_id: 'LOCAL_AUDIT', event_type: receipt.event_type,
  detail_json: JSON.stringify(receipt.detail), created_at: receipt.created_at };
const db = { prepare(sql) {
  queries.push(sql);
  assert.match(sql, /^SELECT /u);
  assert.match(sql, /event_type='LANE_1_TV_INGRESS'/u);
  return { bind() { return {
    async all() { return { results: row.event_type === 'LANE_1_TV_INGRESS' ? [row] : [] }; },
    async first() { return row.event_type === 'LANE_1_TV_INGRESS' ? row : null; },
    async run() { writeCalls++; throw new Error('NO_WRITES'); },
  }; } };
} };
let lookup;
try {
  const env = { DB: db, NUVO_LANE_1_SPY_ARMED: 'OFF' };
  assert.equal(await latestLane1ReplayIngress(env, 'LOCAL_AUDIT'), null);
  lookup = await previewStoredLane1Ingress({ env, ownerId: 'LOCAL_AUDIT', ingressId: receipt.id });
  assert.equal(lookup.status, 404);
  assert.equal(lookup.body.faultCode, 'LANE_1_PREVIEW_SOURCE_NOT_FOUND');
  assert.equal(lookup.body.sent, false);
} finally { globalThis.fetch = oldFetch; }
assert.equal(networkCalls, 0);
assert.equal(writeCalls, 0);
assert.deepEqual(receipt, before);
assert.equal(hash(readFileSync(path)), expectedHash);

console.log(JSON.stringify({
  mode: 'OFFLINE_ARCHIVE_AND_INGRESS_ISOLATION_CHECK_NOT_A_RECEIPT_READER',
  id: receipt.id, eventType: receipt.event_type, createdAt: receipt.created_at,
  sourceArtifact: path, artifactBytes: bytes.length, artifactSha256: expectedHash,
  provenance: 'Saved parsed-detail JSON export; not original D1 detail_json wire bytes or a fresh D1 read.',
  archiveDecodeAndRoundTrip: 'PASS', archiveUnchanged: true,
  preserved: { signal: receipt.detail.signal, brokerInstruction: receipt.detail.brokerInstruction,
    quantity: receipt.detail.quantity, quantityType: typeof receipt.detail.quantity,
    symbol: receipt.detail.orderContract.actual.symbol,
    replayBodySide: receipt.detail.replayBody.side,
    tvBodyBindingSha256: binding.tvBodyBindingSha256 },
  newDiagnosticFields: 'ABSENT_UNRECORDED_NOT_NULL_REJECTION',
  previewProjectionWriter: { unchangedVsProduction: true, sha256: hash(projection(runtime)) },
  runtimeIngressSelector: 'EXCLUDES_PREVIEW_RECEIPT',
  receiptIdAsIngress: { status: lookup.status, faultCode: lookup.body.faultCode },
  queries, networkCalls, writeCalls,
  historicalPreviewReceiptReader: 'NONE_FOUND_IN_CURRENT_WORKER_OR_DASHBOARD',
  backwardReadThroughProductionReader: 'NOT_PROVEN_NO_SUCH_READER',
}, null, 2));
