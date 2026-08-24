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

export class EvidenceStore {
  constructor({ genesis = 'NUVO-VSIM-GENESIS' } = {}) {
    this.records = [];
    this.headHash = contentHash({ genesis });
    this.byId = new Map();
  }

  append(pkg) {
    const record = { ...pkg, previousHash: this.headHash, sequence: this.records.length };
    record.chainHash = contentHash({ previousHash: record.previousHash, payload: record.hash, sequence: record.sequence });
    this.records.push(record);
    this.headHash = record.chainHash;
    this.byId.set(pkg.cycleId, record);
    return record;
  }

  get(cycleId) { return this.byId.get(cycleId) ?? null; }

  /** Walk the whole chain and report the first break, if any. */
  verify() {
    let prev = contentHash({ genesis: 'NUVO-VSIM-GENESIS' });
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
