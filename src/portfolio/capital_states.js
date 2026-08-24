/**
 * Explicit capital states (§16).
 *
 * Every dollar belongs to exactly one state. NUVO must never infer
 * "available" by subtraction — that is precisely how a reconciliation gap
 * becomes an oversized position.
 */
import { isNum } from '../math/stats.js';

export const CAPITAL_STATE = Object.freeze({
  RESERVE: 'RESERVE',         // constitutionally undeployable
  AVAILABLE: 'AVAILABLE',     // genuinely free to commit
  COMMITTED: 'COMMITTED',     // pledged to working orders
  AT_RISK: 'AT_RISK',         // backing open obligations
  ASSIGNED: 'ASSIGNED',       // converted into shares
  QUARANTINED: 'QUARANTINED', // locked pending reconciliation
});

export class CapitalLedger {
  constructor({ nav, limits }) {
    if (!isNum(nav) || nav <= 0) throw new RangeError('CapitalLedger requires a positive NAV.');
    this.nav = nav;
    this.limits = limits;
    this.buckets = {
      RESERVE: nav * limits.minReservePct,
      AVAILABLE: nav * (1 - limits.minReservePct),
      COMMITTED: 0,
      AT_RISK: 0,
      ASSIGNED: 0,
      QUARANTINED: 0,
    };
    this.journal = [];
  }

  /** Move capital between states. Refuses to overdraw — no negative buckets. */
  move(from, to, amount, reason) {
    if (!isNum(amount) || amount < 0) throw new RangeError('Capital moves must be non-negative.');
    if (this.buckets[from] === undefined || this.buckets[to] === undefined) {
      throw new RangeError(`Unknown capital state: ${from} -> ${to}`);
    }
    if (this.buckets[from] + 1e-9 < amount) {
      return {
        ok: false,
        reason: `Insufficient ${from}: ${this.buckets[from].toFixed(2)} < ${amount.toFixed(2)}`,
      };
    }
    this.buckets[from] -= amount;
    this.buckets[to] += amount;
    this.journal.push({ from, to, amount, reason });
    return { ok: true };
  }

  get total() {
    return Object.values(this.buckets).reduce((a, b) => a + b, 0);
  }

  /**
   * Deployable capital. Note it is NOT simply AVAILABLE: the authority tier
   * caps how much of the book an unvalidated model may command (§15, §17).
   */
  deployable({ authorityFraction = 1 }) {
    const cap = this.nav * this.limits.maxDeployedPct * authorityFraction;
    const deployed = this.buckets.COMMITTED + this.buckets.AT_RISK + this.buckets.ASSIGNED;
    return Math.max(0, Math.min(this.buckets.AVAILABLE, cap - deployed));
  }

  /** Quarantine everything unencumbered. Called on reconciliation failure. */
  quarantine(reason) {
    const amt = this.buckets.AVAILABLE;
    this.buckets.AVAILABLE = 0;
    this.buckets.QUARANTINED += amt;
    this.journal.push({ from: 'AVAILABLE', to: 'QUARANTINED', amount: amt, reason });
    return amt;
  }

  release(reason) {
    const amt = this.buckets.QUARANTINED;
    this.buckets.QUARANTINED = 0;
    this.buckets.AVAILABLE += amt;
    this.journal.push({ from: 'QUARANTINED', to: 'AVAILABLE', amount: amt, reason });
    return amt;
  }

  snapshot() {
    return {
      nav: this.nav,
      ...this.buckets,
      deployedPct: (this.buckets.COMMITTED + this.buckets.AT_RISK + this.buckets.ASSIGNED) / this.nav,
      reservePct: this.buckets.RESERVE / this.nav,
      consistent: Math.abs(this.total - this.nav) < 0.01,
    };
  }
}
