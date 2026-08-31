import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createHash } from 'node:crypto';
import { testPublicKey, testPrivateKey } from './helpers/preview-evidence-key.js';
import { decryptPreviewOriginal } from '../cloudflare/preview-evidence-codec.js';

test('capture executes in workerd with a real local R2 binding before parser use', async () => {
  const built = await build({ stdin: { contents: `
    import {capturePreviewResponse} from './cloudflare/preview-response-evidence.js';
    export default { async fetch(request, env) {
      const capture = await capturePreviewResponse({bucket: env.EVIDENCE,
        publicKey:${JSON.stringify(testPublicKey)},
        response: new Response(request.body, {status: 400}),
        context: {ownerId:'test-owner', sourceIngressId:'test-row',
          sourceIngressCreatedAt:'2026-08-31T15:33:13.437Z',
          tvBodyBindingSha256:'a'.repeat(64), requestSha256:'b'.repeat(64), workerVersion:'local'}
      });
      return Response.json(capture);
    }};`, resolveDir: process.cwd(), sourcefile: 'capture-runtime.js' },
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:crypto'] });
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: built.outputFiles[0].text,
    compatibilityDate: '2026-08-26', compatibilityFlags: ['nodejs_compat'],
    r2Buckets: ['EVIDENCE'] }));
  try {
    const raw = '{\n "message":"whole response", "quantity":{"value":1}\n}\n';
    const response = await mf.dispatchFetch('http://local.test/capture', {method:'POST', body:raw});
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    const result = JSON.parse(responseText);
    assert.equal(result.raw, raw);
    assert.equal(result.evidence.httpStatus, 400);
    assert.equal(result.evidence.sha256, createHash('sha256').update(raw).digest('hex'));
    const bucket = await mf.getR2Bucket('EVIDENCE');
    const encrypted = await (await bucket.get(result.evidence.bodyKey)).json();
    assert.equal(Buffer.from(await decryptPreviewOriginal(encrypted, testPrivateKey)).toString(), raw);
    assert.deepEqual(await (await bucket.get(result.evidence.manifestKey)).json(), result.evidence);
    assert.equal(await bucket.put(result.evidence.bodyKey, 'overwrite', {
      onlyIf: {etagDoesNotMatch:'*'} }), null);
    assert.deepEqual(await (await bucket.get(result.evidence.bodyKey)).json(), encrypted);
    const redacted = await (await bucket.get(result.evidence.redactedKey)).text();
    assert.equal(createHash('sha256').update(redacted).digest('hex'), result.evidence.redactedSha256);
  } finally { await mf.dispose(); }
});
