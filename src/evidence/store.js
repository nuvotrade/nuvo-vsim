/**
 * Evidence store — append-only, hash-chained.
 *
 * Each record carries the hash of its predecessor, so a record cannot be
 * quietly edited or removed after the fact without breaking the chain.
 * This is what makes NUVO an auditable financial system rather than a
 * dashboard with a log file.
 */
import { contentHash } from '../execution/order.js';
import { verifyEvidence } from './package.js';

/**
 * Persistence port.
 *
 * The chain is only an audit trail if it outlives the process. This is the
 * seam a durable backend plugs into — a JSONL file, D1, R2, anything that
 * can append and enumerate. Implementations must be append-only: an adapter
 * that supports update or delete can silently defeat the chain it stores.
 */
export class EvidencePersistence {
  /* eslint-disable no-unused-vars */
  async append(record) { throw new Error('not implemented'); }
  async load() { throw new Error('not implemented'); }
  /* eslint-enable no-unused-vars */
}

/** In-memory only. The default, and explicitly not durable. */
export class MemoryPersistence extends EvidencePersistence {
  constructor() { super(); this.rows = []; }
  async append(record) { this.rows.push(record); return record; }
  async load() { return this.rows.slice(); }
  get durable() { return false; }
}

/**
 * Newline-delimited JSON on a filesystem.
 *
 * Kept behind a lazily-imported `node:fs` so the module stays loadable in a
 * Worker, where the memory adapter is used instead.
 *
 * Writes are SERIALISED through a promise chain. Concurrent appendFile
 * calls to one path are not ordered by the runtime, so a store that fires
 * them in parallel can persist records out of sequence — and an out-of-order
 * hash chain fails verification on reload, turning a healthy audit trail
 * into an unopenable one. This was observed failing roughly half of runs
 * before the queue was added.
 */
export class JsonlPersistence extends EvidencePersistence {
  constructor(path) {
    super();
    this.path = path;
    this._tail = Promise.resolve();
  }

  get durable() { return true; }

  async _fs() {
    if (!this._fsMod) this._fsMod = await import('node:fs/promises');
    return this._fsMod;
  }

  append(record) {
    // Chain onto the previous write so ordering is guaranteed. Errors are
    // re-thrown to the caller but must not poison the queue for later writes.
    const queued = this._tail.then(async () => {
      const fs = await this._fs();
      await fs.appendFile(this.path, `${JSON.stringify(record)}\n`, 'utf8');
      return record;
    });
    this._tail = queued.catch(() => {});
    return queued;
  }

  async load() {
    const fs = await this._fs();
    let text;
    try {
      text = await fs.readFile(this.path, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
}

export class EvidenceStore {
  constructor({ genesis = 'NUVO-VSIM-GENESIS', persistence = null } = {}) {
    this.records = [];
    this.genesis = genesis;
    this.headHash = contentHash({ genesis });
    this.byId = new Map();
    this.persistence = persistence ?? new MemoryPersistence();
    this.pendingWrites = [];
  }

  /** Rehydrate from durable storage and verify the chain before use. */
  static async open({ persistence, genesis = 'NUVO-VSIM-GENESIS' }) {
    const store = new EvidenceStore({ genesis, persistence });
    const rows = await persistence.load();
    for (const r of rows) {
      store.records.push(r);
      store.byId.set(r.cycleId, r);
      store.headHash = r.chainHash;
    }
    const v = store.verify();
    if (!v.valid) {
      throw new Error(
        `Stored evidence chain is broken at record ${v.brokenAt} (${v.reason}). `
        + 'Refusing to append to a chain that cannot be trusted.',
      );
    }
    return store;
  }

  /** Await every queued durable write. Call before shutdown. */
  async flush() {
    const pending = this.pendingWrites;
    this.pendingWrites = [];
    await Promise.all(pending);
    return this.records.length;
  }

  get durable() { return Boolean(this.persistence?.durable); }

  append(pkg) {
    if (!verifyEvidence(pkg)) throw new Error('Refusing to append an invalid evidence package.');
    if (this.byId.has(pkg.cycleId)) {
      throw new Error(`Evidence cycle ${pkg.cycleId} is already filed.`);
    }
    const record = {
      ...structuredClone(pkg), previousHash: this.headHash, sequence: this.records.length,
    };
    record.chainHash = contentHash({ previousHash: record.previousHash, payload: record.hash, sequence: record.sequence });
    this.records.push(record);
    this.headHash = record.chainHash;
    this.byId.set(pkg.cycleId, record);
    // Durable write is queued rather than awaited so the decision path is
    // never blocked on IO; flush() before shutdown makes it observable.
    this.pendingWrites.push(
      Promise.resolve(this.persistence.append(record)).catch((e) => {
        this.persistenceError = e;
      }),
    );
    return record;
  }

  get(cycleId) { return this.byId.get(cycleId) ?? null; }

  /** Walk the whole chain and report the first break, if any. */
  verify() {
    let prev = contentHash({ genesis: this.genesis });
    for (const [i, r] of this.records.entries()) {
      if (r.previousHash !== prev) {
        return { valid: false, brokenAt: i, reason: 'previousHash mismatch' };
      }
      const expected = contentHash({ previousHash: r.previousHash, payload: r.hash, sequence: r.sequence });
      if (r.chainHash !== expected) return { valid: false, brokenAt: i, reason: 'chainHash mismatch' };
      const { previousHash, sequence, chainHash, ...pkg } = r;
      if (!verifyEvidence(pkg)) return { valid: false, brokenAt: i, reason: 'payload altered' };
      prev = r.chainHash;
    }
    return { valid: true, length: this.records.length, head: this.headHash };
  }

  /** Records matching a filter, for scoreboard construction. */
  query(fn) { return this.records.filter(fn); }

  get length() { return this.records.length; }
}
