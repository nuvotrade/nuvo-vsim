import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, encryptPreviewOriginal, decryptPreviewOriginal,
  redactPreviewOriginal, bytesHash } from '../cloudflare/preview-evidence-codec.js';
import { testPublicKey, testPrivateKey } from './helpers/preview-evidence-key.js';

test('encrypted exact original decrypts byte-for-byte; ciphertext and metadata tampering fail', async () => {
  const bytes = Buffer.from('{\n"accountNumber":"PRIVATE-ACCOUNT", "quantity":"1"\n}\n');
  const envelope = await encryptPreviewOriginal(bytes, {sourceIngressId:'test-row'}, testPublicKey);
  assert.equal(JSON.stringify(envelope).includes('PRIVATE-ACCOUNT'), false);
  assert.deepEqual(await decryptPreviewOriginal(envelope, testPrivateKey), new Uint8Array(bytes));
  const corrupted = structuredClone(envelope);
  const ciphertext = Buffer.from(corrupted.ciphertext, 'base64'); ciphertext[0] ^= 1;
  corrupted.ciphertext = ciphertext.toString('base64');
  await assert.rejects(decryptPreviewOriginal(corrupted, testPrivateKey));
  await assert.rejects(decryptPreviewOriginal({...envelope, aad:'{}'}, testPrivateKey));
  await assert.rejects(decryptPreviewOriginal({...envelope, originalSha256:'a'.repeat(64)}, testPrivateKey));
});

test('redaction is deterministic, parent-linked and preserves allowed values and types', () => {
  const raw = Buffer.from(JSON.stringify({accountNumber:'PRIVATE-ACCOUNT', access_token:'PRIVATE-TOKEN',
    unknown:{credential:'PRIVATE-TOKEN'}, orderStrategy:{session:'NORMAL', orderLegs:[{
      instruction:'BUY', quantity:'1', finalSymbol:'SPY', assetType:'COLLECTIVE_INVESTMENT',
      accountHash:'PRIVATE-HASH', unexpected:'PRIVATE-VALUE'}]},
    orderValidationResult:{rejects:null, reviews:[], warns:[{activityMessage:'Account PRIVATE-ACCOUNT',originalSeverity:'WARN'}]}}));
  const one = redactPreviewOriginal(raw), two = redactPreviewOriginal(raw);
  assert.equal(canonicalJson(one), canonicalJson(two));
  assert.equal(bytesHash(canonicalJson(one)), bytesHash(canonicalJson(two)));
  assert.equal(one.originalSha256, bytesHash(raw));
  assert.equal(one.redactionVersion, 'SCHWAB_PREVIEW_ALLOWLIST_V1');
  assert.deepEqual(one.removedPaths, ['/access_token','/accountNumber',
    '/orderStrategy/orderLegs/0/accountHash','/orderStrategy/orderLegs/0/unexpected',
    '/orderValidationResult/warns/0/activityMessage','/unknown']);
  assert.equal(one.body.orderStrategy.orderLegs[0].quantity, '1');
  assert.equal(typeof one.body.orderStrategy.orderLegs[0].quantity, 'string');
  assert.equal(one.body.orderValidationResult.rejects, null);
  assert.deepEqual(one.body.orderValidationResult.reviews, []);
  assert.equal(canonicalJson(one).includes('PRIVATE-'), false);
});

test('unknown nested quantity is omitted with a named path, never confused with broker null', () => {
  const copy = redactPreviewOriginal(Buffer.from('{"orderLegs":[{"quantity":{"value":1},"symbol":"SPY"}]}'));
  assert.equal(Object.hasOwn(copy.body.orderLegs[0], 'quantity'), false);
  assert.deepEqual(copy.removedPaths, ['/orderLegs/0/quantity']);
});

test('malformed raw body is not exposed as a free-text inspection value', () => {
  const copy = redactPreviewOriginal(Buffer.from('Account PRIVATE-ACCOUNT: failed'));
  assert.equal(copy.body, null); assert.deepEqual(copy.removedPaths, ['/']);
  assert.equal(copy.parseStatus, 'NOT_JSON_OR_UTF8');
  assert.equal(canonicalJson(copy).includes('PRIVATE-ACCOUNT'), false);
});
