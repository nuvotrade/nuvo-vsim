const DATA_FILES = Object.freeze([
  'decision.json', 'proposal.json', 'order-events.json', 'fills.json',
  'cash.json', 'shares.json', 'pnl.json',
]);
const BUNDLE_FILES = Object.freeze(['manifest.json', ...DATA_FILES]);
const encoder = new TextEncoder();

function canonical(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('RESOLVED_UNIT_EMIT:FINITE_NUMBER_REQUIRED');
    return value;
  }
  if (!value || typeof value !== 'object' || ancestors.has(value)) {
    throw new Error('RESOLVED_UNIT_EMIT:PLAIN_ACYCLIC_JSON_REQUIRED');
  }
  ancestors.add(value);
  const result = Array.isArray(value)
    ? value.map((entry) => canonical(entry, ancestors))
    : Object.fromEntries(Object.keys(value).sort().map((key) => {
      if (value[key] === undefined) throw new Error('RESOLVED_UNIT_EMIT:DEFINED_VALUE_REQUIRED');
      return [key, canonical(value[key], ancestors)];
    }));
  ancestors.delete(value);
  return result;
}

export function canonicalResolvedUnitBytes(value) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function emitResolvedUnitBundleRuntime(foldOutput) {
  const supplied = Object.keys(foldOutput ?? {}).sort();
  if (JSON.stringify(supplied) !== JSON.stringify(BUNDLE_FILES.slice().sort())) {
    throw new Error('RESOLVED_UNIT_EMIT:EXACT_BUNDLE_FILE_SET_REQUIRED');
  }
  const bytes = {};
  const files = {};
  for (const path of DATA_FILES) {
    bytes[path] = canonicalResolvedUnitBytes(foldOutput[path]);
    files[path] = {
      path,
      byteLength: encoder.encode(bytes[path]).byteLength,
      sha256: await sha256(bytes[path]),
    };
  }
  const manifest = canonical(foldOutput['manifest.json']);
  manifest.orderedFiles = manifest.orderedFiles.map((entry) => ({
    ...entry,
    byteLength: files[entry.path].byteLength,
    sha256: files[entry.path].sha256,
  }));
  bytes['manifest.json'] = canonicalResolvedUnitBytes(manifest);
  files['manifest.json'] = {
    path: 'manifest.json',
    byteLength: encoder.encode(bytes['manifest.json']).byteLength,
    sha256: await sha256(bytes['manifest.json']),
  };
  return Object.freeze({
    manifest,
    manifestHash: files['manifest.json'].sha256,
    files: Object.freeze(files),
    bytes: Object.freeze(bytes),
  });
}

export const RUNTIME_RESOLVED_UNIT_BUNDLE_FILES = BUNDLE_FILES;
