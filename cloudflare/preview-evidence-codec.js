import { createHash } from 'node:crypto';
import { PREVIEW_EVIDENCE_PUBLIC_KEY } from './preview-evidence-public-key.js';

const encoder = new TextEncoder();
export const REDACTION_VERSION = 'SCHWAB_PREVIEW_ALLOWLIST_V1';
export const bytesHash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
const base64 = (bytes) => Buffer.from(bytes).toString('base64');
const unbase64 = (value) => new Uint8Array(Buffer.from(value, 'base64'));

export async function encryptPreviewOriginal(bytes, binding, publicKey = PREVIEW_EVIDENCE_PUBLIC_KEY) {
  const spki = unbase64(publicKey);
  const key = await crypto.subtle.importKey('spki', spki,
    { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const rawAes = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aes = await crypto.subtle.importKey('raw', rawAes, 'AES-GCM', false, ['encrypt']);
  const originalSha256 = bytesHash(bytes);
  const aad = canonicalJson({ ...binding, originalSha256 });
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
    additionalData: encoder.encode(aad), tagLength: 128 }, aes, bytes);
  const wrappedKey = await crypto.subtle.encrypt('RSA-OAEP', key, rawAes);
  rawAes.fill(0);
  return { schema: 'NUVO_PREVIEW_ENCRYPTED_V1', algorithm: 'RSA-OAEP-SHA256+A256GCM',
    keyId: bytesHash(spki), originalSha256, originalBytes: bytes.byteLength, aad,
    iv: base64(iv), wrappedKey: base64(wrappedKey), ciphertext: base64(ciphertext) };
}

// Used by offline inspection/tests only; no private key or decrypt route exists
// in the Worker. The deployment bundler removes this unused export.
export async function decryptPreviewOriginal(envelope, privateKey) {
  if (envelope.schema !== 'NUVO_PREVIEW_ENCRYPTED_V1'
    || envelope.algorithm !== 'RSA-OAEP-SHA256+A256GCM') throw new Error('PREVIEW_ENCRYPTION_SCHEMA');
  const rawAes = await crypto.subtle.decrypt('RSA-OAEP', privateKey, unbase64(envelope.wrappedKey));
  const aes = await crypto.subtle.importKey('raw', rawAes, 'AES-GCM', false, ['decrypt']);
  new Uint8Array(rawAes).fill(0);
  const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM',
    iv: unbase64(envelope.iv), additionalData: encoder.encode(envelope.aad), tagLength: 128 },
  aes, unbase64(envelope.ciphertext)));
  if (bytesHash(bytes) !== envelope.originalSha256 || bytes.length !== envelope.originalBytes
    || JSON.parse(envelope.aad).originalSha256 !== envelope.originalSha256) {
    throw new Error('PREVIEW_ORIGINAL_HASH_MISMATCH');
  }
  return bytes;
}

// Positive path allowlist, NOT a regex/string scrub. Free-form messages and
// unknown fields are omitted; original ciphertext preserves all of them.
const scalar = 'scalar';
const message = { code: scalar, activityCode: scalar, severity: scalar, originalSeverity: scalar };
const validation = { rejects: [message], reviews: [message], warns: [message], alerts: [message] };
const instrument = { symbol: scalar, assetType: scalar, type: scalar };
const leg = { instruction: scalar, quantity: scalar, finalSymbol: scalar, symbol: scalar,
  assetType: scalar, quantityType: scalar, legId: scalar, instrument };
const order = { orderType: scalar, orderStrategyType: scalar, session: scalar,
  duration: scalar, quantity: scalar, quantityType: scalar, orderLegs: [leg],
  orderLegCollection: [leg], childOrderStrategies: [] };
const policy = { orderStrategy: order, orderLegs: [leg], orderValidationResult: validation,
  orderRejections: [message], review: [message] };
const OMIT = Symbol('omit');
const pointer = (key) => String(key).replaceAll('~', '~0').replaceAll('/', '~1');

export function redactPreviewOriginal(bytes) {
  const removedPaths = [];
  function project(value, rule, path) {
    if (value === null) return null;
    if (rule === scalar && ['string', 'number', 'boolean'].includes(typeof value)) return value;
    if (Array.isArray(rule) && Array.isArray(value)) {
      return value.map((entry, index) => {
        if (!rule[0]) { removedPaths.push(`${path}/${index}`); return null; }
        const item = project(entry, rule[0], `${path}/${index}`);
        // Array indices must remain stable; null placeholders are explicitly
        // named in removedPaths and must not be confused with broker nulls.
        return item === OMIT ? null : item;
      });
    }
    if (rule && typeof rule === 'object' && !Array.isArray(rule)
      && value && typeof value === 'object' && !Array.isArray(value)) {
      const output = {};
      for (const key of Object.keys(value).sort()) {
        const childPath = `${path}/${pointer(key)}`;
        if (!Object.hasOwn(rule, key)) { removedPaths.push(childPath); continue; }
        const child = project(value[key], rule[key], childPath);
        if (child !== OMIT) output[key] = child;
      }
      return output;
    }
    removedPaths.push(path || '/');
    return OMIT;
  }
  let body = null;
  let parseStatus = 'JSON';
  try {
    const original = JSON.parse(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes));
    const projected = project(original, policy, '');
    body = projected === OMIT ? null : projected;
  } catch { parseStatus = 'NOT_JSON_OR_UTF8'; removedPaths.push('/'); }
  return { redactionVersion: REDACTION_VERSION, originalSha256: bytesHash(bytes),
    removedPaths: [...new Set(removedPaths)].sort(), parseStatus, body };
}
