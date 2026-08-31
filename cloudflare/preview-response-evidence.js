import { createHash } from 'node:crypto';
import { bytesHash, canonicalJson, encryptPreviewOriginal, redactPreviewOriginal } from './preview-evidence-codec.js';

const PARSE_LIMIT = 1_048_576;
const CAPTURE_LIMIT = 8_388_608;

async function completeResponseBytes(response) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > CAPTURE_LIMIT) {
        await reader.cancel();
        throw new Error('LANE_1_PREVIEW_CAPTURE_LIMIT_EXCEEDED');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

// Capture the complete response entity before any JSON/schema decision. Raw
// bytes stay in the existing private EVIDENCE bucket, never in UI/log output.
export async function capturePreviewResponse({ bucket, response, context, publicKey }) {
  const ownerHash = createHash('sha256').update(context.ownerId).digest('hex');
  const captureId = crypto.randomUUID();
  const prefix = `owners/${ownerHash}/lane-1-preview/${captureId}`;
  const bodyKey = `${prefix}/original.encrypted.json`;
  const redactedKey = `${prefix}/inspection.json`;
  const manifestKey = `${prefix}/manifest.json`;
  const receivedAt = new Date().toISOString();
  const metadata = {
    sourceIngressId: context.sourceIngressId,
    tvBodyBindingSha256: context.tvBodyBindingSha256,
    requestSha256: context.requestSha256,
    workerVersion: context.workerVersion,
    httpStatus: String(response.status), receivedAt,
  };
  // R2 requires a known-length body. Bound memory and refuse over-limit or
  // broken streams; never persist a prefix as though it were the whole receipt.
  const responseBytes = await completeResponseBytes(response);
  const sourceSha256 = bytesHash(responseBytes);
  const envelope = await encryptPreviewOriginal(responseBytes, {
    ...metadata, captureId, ownerHash, bodyKey,
  }, publicKey);
  const encryptedBytes = new TextEncoder().encode(canonicalJson(envelope));
  const encryptedSha256 = bytesHash(encryptedBytes);
  const stored = await bucket.put(bodyKey, encryptedBytes, {
    onlyIf: { etagDoesNotMatch: '*' },
    sha256: encryptedSha256,
    httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
    customMetadata: metadata,
  });
  if (!stored) throw new Error('LANE_1_PREVIEW_CAPTURE_WRITE_FAILED');
  const saved = await bucket.get(bodyKey);
  if (!saved?.body) throw new Error('LANE_1_PREVIEW_CAPTURE_READBACK_FAILED');
  const hash = createHash('sha256');
  let bytes = 0;
  const reader = saved.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      bytes += value.byteLength;
      if (bytes > encryptedBytes.byteLength) {
        await reader.cancel();
        throw new Error('LANE_1_PREVIEW_CAPTURE_SIZE_MISMATCH');
      }
    }
  } finally { reader.releaseLock(); }
  const savedSha256 = hash.digest('hex');
  if (bytes !== stored.size || bytes !== saved.size || savedSha256 !== encryptedSha256) {
    throw new Error('LANE_1_PREVIEW_CAPTURE_SIZE_MISMATCH');
  }
  // Only now classify a copy. Exact original is already encrypted and sealed.
  const inspection = redactPreviewOriginal(responseBytes);
  const redactedBytes = canonicalJson(inspection);
  const redactedSha256 = bytesHash(redactedBytes);
  if (!await bucket.put(redactedKey, redactedBytes, {
    onlyIf: { etagDoesNotMatch: '*' }, sha256: redactedSha256,
    httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
    customMetadata: { originalSha256: sourceSha256, redactionVersion: inspection.redactionVersion },
  })) throw new Error('LANE_1_PREVIEW_REDACTED_WRITE_FAILED');
  const evidence = {
    schema: 'LANE_1_PREVIEW_RAW_RESPONSE_V2', captureId, bodyKey, manifestKey,
    sourceIngressId: context.sourceIngressId,
    sourceIngressCreatedAt: context.sourceIngressCreatedAt,
    tvBodyBindingSha256: context.tvBodyBindingSha256,
    requestSha256: context.requestSha256,
    workerVersion: context.workerVersion,
    endpoint: '/previewOrder', httpStatus: response.status,
    contentType: response.headers.get('content-type'), receivedAt,
    bytes: responseBytes.byteLength, sha256: sourceSha256, originalSha256: sourceSha256,
    encryptedSha256, encryptedBytes: bytes, encryptionKeyId: envelope.keyId,
    redactedKey, redactedSha256, redactionVersion: inspection.redactionVersion, complete: true,
  };
  const manifest = JSON.stringify(evidence);
  if (!await bucket.put(manifestKey, manifest, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
    sha256: createHash('sha256').update(manifest).digest('hex'),
  })) throw new Error('LANE_1_PREVIEW_CAPTURE_MANIFEST_FAILED');
  if (responseBytes.byteLength > PARSE_LIMIT) return { evidence, inspection, raw: null,
    faultCode: 'LANE_1_PREVIEW_CAPTURE_TOO_LARGE_TO_PARSE' };
  try {
    return { evidence, inspection, raw: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(responseBytes) };
  } catch {
    return { evidence, inspection, raw: null, faultCode: 'LANE_1_PREVIEW_CAPTURE_INVALID_UTF8' };
  }
}
