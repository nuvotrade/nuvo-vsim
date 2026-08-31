import { createHash } from 'node:crypto';

export function previewEvidenceBucket() {
  const objects = new Map();
  return { objects,
    async put(key, value, options = {}) {
      if (options.onlyIf?.etagDoesNotMatch === '*' && objects.has(key)) return null;
      const bytes = new Uint8Array(await new Response(value).arrayBuffer());
      if (options.sha256 && createHash('sha256').update(bytes).digest('hex') !== options.sha256) {
        throw new Error('CHECKSUM_MISMATCH');
      }
      objects.set(key, { bytes, options });
      return { key, size: bytes.byteLength };
    },
    async get(key) {
      const stored = objects.get(key);
      return stored ? { size: stored.bytes.byteLength,
        body: new Response(stored.bytes).body } : null;
    },
  };
}
