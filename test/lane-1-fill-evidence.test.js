import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureLane1FillBytes } from '../cloudflare/lane-1-fill-evidence.js';
import { previewEvidenceBucket } from './helpers/preview-evidence-bucket.js';

test('fill capture verifies encrypted body and manifest by readback before reporting complete', async () => {
  const bucket = previewEvidenceBucket();
  const result = await captureLane1FillBytes({ bucket,
    bytes: new TextEncoder().encode('{"status":"FILLED"}'),
    context: { ownerId: 'OWNER', source: 'SCHWAB_ORDER_RESPONSE', endpoint: '/orders/1',
      brokerOrderId: 'ORDER-1', clientOrderId: 'CLIENT-1', instruction: 'BUY' } });
  assert.equal(result.evidence.complete, true);
  assert.equal(bucket.objects.size, 2);
  const corrupt = previewEvidenceBucket();
  const originalGet = corrupt.get;
  let reads = 0;
  corrupt.get = async (key) => {
    const object = await originalGet(key); reads += 1;
    if (reads !== 1) return object;
    return { ...object, body: new Response('corrupted').body, size: object.size };
  };
  await assert.rejects(() => captureLane1FillBytes({ bucket: corrupt,
    bytes: new TextEncoder().encode('{"status":"FILLED"}'),
    context: { ownerId: 'OWNER', source: 'BROKER_LEDGER_RECONSTRUCTION',
      endpoint: 'D1/order', brokerOrderId: 'ORDER-1', clientOrderId: 'CLIENT-1',
      instruction: 'BUY' } }), /READBACK|SIZE_MISMATCH/u);
});
