import { bytesHash, canonicalJson, encryptPreviewOriginal } from './preview-evidence-codec.js';

const CAPTURE_LIMIT = 8_388_608;

async function responseBytes(response) {
  if (!response?.body) return new Uint8Array();
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
        throw new Error('LANE_1_FILL_CAPTURE_LIMIT_EXCEEDED');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function hashStream(object, expectedBytes) {
  if (!object?.body) throw new Error('LANE_1_FILL_CAPTURE_READBACK_FAILED');
  const reader = object.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > expectedBytes) {
        await reader.cancel();
        throw new Error('LANE_1_FILL_CAPTURE_SIZE_MISMATCH');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { size, sha256: bytesHash(bytes) };
}

/**
 * Capture exact Schwab bytes before JSON parsing or economic classification.
 * Only encrypted originals and a bounded manifest are written to R2.
 */
export async function captureLane1FillBytes({ bucket, bytes, context, publicKey }) {
  if (!bucket?.put || !bucket?.get) throw new Error('LANE_1_FILL_CAPTURE_BUCKET_REQUIRED');
  if (!(bytes instanceof Uint8Array)) throw new Error('LANE_1_FILL_CAPTURE_BYTES_REQUIRED');
  if (bytes.byteLength > CAPTURE_LIMIT) throw new Error('LANE_1_FILL_CAPTURE_LIMIT_EXCEEDED');
  const ownerHash = bytesHash(new TextEncoder().encode(String(context.ownerId)));
  const captureId = crypto.randomUUID();
  const source = String(context.source ?? 'SCHWAB_WIRE_RESPONSE');
  const endpoint = String(context.endpoint ?? 'UNKNOWN');
  const prefix = `owners/${ownerHash}/lane-1-fill/${captureId}`;
  const bodyKey = `${prefix}/original.encrypted.json`;
  const manifestKey = `${prefix}/manifest.json`;
  const receivedAt = String(context.receivedAt ?? new Date().toISOString());
  const originalSha256 = bytesHash(bytes);
  const binding = {
    captureId, ownerHash, bodyKey, source, endpoint, receivedAt,
    workerVersion: context.workerVersion ?? 'local',
    brokerOrderId: context.brokerOrderId ?? null,
    clientOrderId: context.clientOrderId ?? null,
    instruction: context.instruction ?? null,
    attempt: Number.isSafeInteger(context.attempt) ? context.attempt : null,
    httpStatus: Number.isSafeInteger(context.httpStatus) ? context.httpStatus : null,
  };
  const envelope = await encryptPreviewOriginal(bytes, binding, publicKey);
  const encryptedBytes = new TextEncoder().encode(canonicalJson(envelope));
  const encryptedSha256 = bytesHash(encryptedBytes);
  const stored = await bucket.put(bodyKey, encryptedBytes, {
    onlyIf: { etagDoesNotMatch: '*' }, sha256: encryptedSha256,
    httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
    customMetadata: { source, endpoint, receivedAt, originalSha256,
      brokerOrderId: String(context.brokerOrderId ?? '') },
  });
  if (!stored) throw new Error('LANE_1_FILL_CAPTURE_WRITE_FAILED');
  const saved = await bucket.get(bodyKey);
  const readback = await hashStream(saved, encryptedBytes.byteLength);
  if (readback.size !== encryptedBytes.byteLength || readback.size !== stored.size
    || readback.size !== saved.size || readback.sha256 !== encryptedSha256) {
    throw new Error('LANE_1_FILL_CAPTURE_READBACK_MISMATCH');
  }
  const evidence = {
    schema: 'LANE_1_FILL_RAW_RESPONSE_V1', captureId, source, endpoint,
    bodyKey, manifestKey, receivedAt, originalSha256, sha256: originalSha256,
    bytes: bytes.byteLength, encryptedSha256, encryptedBytes: encryptedBytes.byteLength,
    encryptionKeyId: envelope.keyId, complete: true,
    workerVersion: binding.workerVersion,
    brokerOrderId: binding.brokerOrderId, clientOrderId: binding.clientOrderId,
    instruction: binding.instruction, attempt: binding.attempt,
    httpStatus: binding.httpStatus,
  };
  const manifest = canonicalJson(evidence);
  const manifestBytes = new TextEncoder().encode(manifest);
  const manifestSha256 = bytesHash(manifestBytes);
  const manifestStored = await bucket.put(manifestKey, manifestBytes, {
    onlyIf: { etagDoesNotMatch: '*' }, sha256: manifestSha256,
    httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
  });
  if (!manifestStored) throw new Error('LANE_1_FILL_CAPTURE_MANIFEST_FAILED');
  const savedManifest = await bucket.get(manifestKey);
  const manifestReadback = await hashStream(savedManifest, manifestBytes.byteLength);
  if (manifestReadback.size !== manifestBytes.byteLength
    || manifestReadback.size !== manifestStored.size
    || manifestReadback.size !== savedManifest.size
    || manifestReadback.sha256 !== manifestSha256) {
    throw new Error('LANE_1_FILL_CAPTURE_MANIFEST_READBACK_MISMATCH');
  }
  return { evidence, raw: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
}

export async function captureLane1FillResponse({ bucket, response, context, publicKey }) {
  const bytes = await responseBytes(response);
  return captureLane1FillBytes({ bucket, bytes, context: {
    ...context, httpStatus: response.status,
  }, publicKey });
}
