import { createHash } from 'node:crypto';

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
export async function capturePreviewResponse({ bucket, response, context }) {
  const ownerHash = createHash('sha256').update(context.ownerId).digest('hex');
  const captureId = crypto.randomUUID();
  const prefix = `owners/${ownerHash}/lane-1-preview/${captureId}`;
  const bodyKey = `${prefix}/response.body`;
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
  const sourceSha256 = createHash('sha256').update(responseBytes).digest('hex');
  const stored = await bucket.put(bodyKey, responseBytes, {
    onlyIf: { etagDoesNotMatch: '*' },
    sha256: sourceSha256,
    httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'no-store' },
    customMetadata: metadata,
  });
  if (!stored) throw new Error('LANE_1_PREVIEW_CAPTURE_WRITE_FAILED');
  const saved = await bucket.get(bodyKey);
  if (!saved?.body) throw new Error('LANE_1_PREVIEW_CAPTURE_READBACK_FAILED');
  const hash = createHash('sha256');
  const chunks = [];
  let bytes = 0;
  const reader = saved.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      bytes += value.byteLength;
      // Hash the entire stored object, but do not buffer unbounded broker data.
      if (bytes <= PARSE_LIMIT) chunks.push(value);
      else chunks.length = 0;
    }
  } finally { reader.releaseLock(); }
  const savedSha256 = hash.digest('hex');
  if (bytes !== stored.size || bytes !== saved.size || savedSha256 !== sourceSha256) {
    throw new Error('LANE_1_PREVIEW_CAPTURE_SIZE_MISMATCH');
  }
  const evidence = {
    schema: 'LANE_1_PREVIEW_RAW_RESPONSE_V1', captureId, bodyKey, manifestKey,
    sourceIngressId: context.sourceIngressId,
    sourceIngressCreatedAt: context.sourceIngressCreatedAt,
    tvBodyBindingSha256: context.tvBodyBindingSha256,
    requestSha256: context.requestSha256,
    workerVersion: context.workerVersion,
    endpoint: '/previewOrder', httpStatus: response.status,
    contentType: response.headers.get('content-type'), receivedAt,
    bytes, sha256: savedSha256, complete: true,
  };
  const manifest = JSON.stringify(evidence);
  if (!await bucket.put(manifestKey, manifest, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
    sha256: createHash('sha256').update(manifest).digest('hex'),
  })) throw new Error('LANE_1_PREVIEW_CAPTURE_MANIFEST_FAILED');
  if (bytes > PARSE_LIMIT) return { evidence, raw: null,
    faultCode: 'LANE_1_PREVIEW_CAPTURE_TOO_LARGE_TO_PARSE' };
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return { evidence, raw: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(joined) };
  } catch {
    return { evidence, raw: null, faultCode: 'LANE_1_PREVIEW_CAPTURE_INVALID_UTF8' };
  }
}
