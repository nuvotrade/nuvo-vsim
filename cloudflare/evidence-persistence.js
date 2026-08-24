import { EvidencePersistence } from '../src/evidence/store.js';

/** Full immutable evidence packages live in R2; D1 holds their ordered chain index. */
export class D1R2EvidencePersistence extends EvidencePersistence {
  constructor({ db, bucket, ownerId }) {
    super();
    this.db = db;
    this.bucket = bucket;
    this.ownerId = ownerId;
  }

  get durable() { return true; }

  async load() {
    const result = await this.db.prepare(`SELECT object_key FROM evidence_index
      WHERE owner_id=? ORDER BY sequence ASC`).bind(this.ownerId).all();
    const rows = [];
    for (const index of result.results ?? []) {
      const object = await this.bucket.get(index.object_key);
      if (!object) throw new Error(`EVIDENCE_OBJECT_MISSING:${index.object_key}`);
      rows.push(JSON.parse(await object.text()));
    }
    return rows;
  }

  async append(record) {
    const objectKey = `owners/${this.ownerId}/evidence/${String(record.sequence).padStart(10, '0')}-${record.cycleId}.json`;
    const payload = JSON.stringify(record);
    if (await this.bucket.head(objectKey)) {
      throw new Error(`EVIDENCE_OBJECT_ALREADY_EXISTS:${objectKey}`);
    }
    await this.bucket.put(objectKey, payload, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { cycleId: record.cycleId, hash: record.hash, chainHash: record.chainHash },
    });
    try {
      await this.db.prepare(`INSERT INTO evidence_index
        (owner_id,cycle_id,sequence,evidence_hash,previous_hash,chain_hash,decision_fingerprint,
         decision,authority_level,object_key,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
        this.ownerId, record.cycleId, record.sequence, record.hash, record.previousHash,
        record.chainHash, record.decisionFingerprint ?? null, record.decision,
        record.authorityLevel, objectKey, new Date(record.at).toISOString(),
      ).run();
    } catch (error) {
      await this.bucket.delete(objectKey).catch(() => {});
      throw error;
    }
    return record;
  }
}
