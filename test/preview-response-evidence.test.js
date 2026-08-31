import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { capturePreviewResponse as capture } from '../cloudflare/preview-response-evidence.js';
import { previewEvidenceBucket } from './helpers/preview-evidence-bucket.js';
import { testPublicKey, decryptStored } from './helpers/preview-evidence-key.js';
const capturePreviewResponse = (options) => capture({...options, publicKey:testPublicKey});

const context = { ownerId: 'test-owner', sourceIngressId: 'test-ingress',
  sourceIngressCreatedAt: '2026-08-31T15:33:13.437Z',
  tvBodyBindingSha256: 'ab'.repeat(32), requestSha256: 'cd'.repeat(32), workerVersion: 'capture-test' };

for (const [name, raw, status] of [
  ['valid JSON', '{\n "x": "é", "nested": {"quantity":1}\n}\n', 200],
  ['malformed JSON', '<!doctype html>\nfull upstream failure\n', 500],
  ['broker error', '{"error":"bad request"}', 400],
  ['empty', '', 204],
]) test(`capture preserves ${name} byte-for-byte with HTTP status`, async () => {
  const bucket = previewEvidenceBucket();
  const bytes = Buffer.from(raw);
  const response = new Response(status === 204 ? null : bytes, { status,
    headers: { 'content-type': 'application/json', 'set-cookie': 'DO-NOT-PERSIST' } });
  const { evidence, raw: captured } = await capturePreviewResponse({ bucket, response, context });
  assert.equal(captured, raw);
  assert.equal(evidence.httpStatus, status);
  assert.equal(evidence.bytes, bytes.length);
  assert.equal(evidence.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(await decryptStored(bucket, evidence.bodyKey), new Uint8Array(bytes));
  const inspectionBytes = bucket.objects.get(evidence.redactedKey).bytes;
  assert.equal(createHash('sha256').update(inspectionBytes).digest('hex'), evidence.redactedSha256);
  assert.equal(JSON.parse(Buffer.from(inspectionBytes)).originalSha256, evidence.sha256);
  assert.equal(JSON.stringify(evidence).includes('DO-NOT-PERSIST'), false);
});

test('oversized response is saved whole and hashed, but never parsed as a truncated body', async () => {
  const bucket = previewEvidenceBucket();
  const bytes = Buffer.alloc(1_048_577, 65);
  const result = await capturePreviewResponse({ bucket, response: new Response(bytes), context });
  assert.equal(result.raw, null);
  assert.equal(result.faultCode, 'LANE_1_PREVIEW_CAPTURE_TOO_LARGE_TO_PARSE');
  assert.equal(result.evidence.bytes, bytes.length);
  assert.equal(result.evidence.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal((await decryptStored(bucket, result.evidence.bodyKey)).length, bytes.length);
});

test('invalid UTF8 remains exact private evidence and cannot become a normalized success', async () => {
  const bucket = previewEvidenceBucket();
  const bytes = new Uint8Array([0xff, 0xfe, 0x7b]);
  const result = await capturePreviewResponse({ bucket, response: new Response(bytes), context });
  assert.equal(result.faultCode, 'LANE_1_PREVIEW_CAPTURE_INVALID_UTF8');
  assert.deepEqual(await decryptStored(bucket, result.evidence.bodyKey), bytes);
});

test('each capture is append-only, even for the same source row and same response', async () => {
  const bucket = previewEvidenceBucket();
  const a = await capturePreviewResponse({ bucket, response: new Response('{}'), context });
  const b = await capturePreviewResponse({ bucket, response: new Response('{}'), context });
  assert.notEqual(a.evidence.bodyKey, b.evidence.bodyKey);
  assert.equal(bucket.objects.size, 6);
});

test('missing R2 readback fails rather than claiming capture success', async () => {
  const bucket = previewEvidenceBucket(); bucket.get = async () => null;
  await assert.rejects(capturePreviewResponse({ bucket, response: new Response('{}'), context }),
    /CAPTURE_READBACK_FAILED/);
});

test('capture memory limit refuses without saving a truncated receipt', async () => {
  const bucket = previewEvidenceBucket();
  await assert.rejects(capturePreviewResponse({ bucket,
    response: new Response(Buffer.alloc(8_388_609)), context }), /CAPTURE_LIMIT_EXCEEDED/);
  assert.equal(bucket.objects.size, 0);
});
