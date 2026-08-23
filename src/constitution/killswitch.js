/**
 * Kill switches (§18, §24).
 *
 * A kill switch removes trading authority without removing observability.
 * The UI stays up; the order path does not. Anything else converts an
 * outage into a position.
 */
import { TIER, violation } from './hierarchy.js';

export const SWITCH = Object.freeze({
  DATA_INTEGRITY: 'DATA_INTEGRITY',
  BROKER_DISCONNECT: 'BROKER_DISCONNECT',
  RECONCILIATION: 'RECONCILIATION',
  DRAWDOWN: 'DRAWDOWN',
  RUIN_RISK: 'RUIN_RISK',
  CALIBRATION: 'CALIBRATION',
  MANUAL: 'MANUAL',
  STRATEGY_TERMINATED: 'STRATEGY_TERMINATED',
});

export class KillSwitchBoard {
  constructor(clock = () => Date.now()) {
    this.clock = clock;
    this.active = new Map();
    this.history = [];
  }

  /** Trip a switch. Idempotent: re-tripping an active switch keeps the first cause. */
  trip(name, reason, detail = {}) {
    if (this.active.has(name)) return this.active.get(name);
    const rec = { name, reason, detail, at: this.clock(), clearedAt: null };
    this.active.set(name, rec);
    this.history.push({ ...rec, event: 'TRIP' });
    return rec;
  }

  /**
   * Clearing requires an explicit reason. Switches do not time out on their
   * own: the condition that tripped them has to be shown to be gone.
   */
  clear(name, reason) {
    if (!reason) throw new Error('Clearing a kill switch requires a stated reason.');
    const rec = this.active.get(name);
    if (!rec) return null;
    this.active.delete(name);
    const cleared = { ...rec, clearedAt: this.clock(), clearReason: reason };
    this.history.push({ ...cleared, event: 'CLEAR' });
    return cleared;
  }

  isTripped(name) {
    return this.active.has(name);
  }

  get tripped() {
    return [...this.active.values()];
  }

  /** Any active switch blocks new exposure. */
  blocksNewExposure() {
    return this.active.size > 0;
  }

  /**
   * Some switches block RISK-REDUCING actions too, some do not.
   * Losing broker truth blocks everything; a drawdown halt still allows
   * closing positions — that is the whole point of a drawdown halt.
   */
  blocksRiskReduction() {
    return [SWITCH.BROKER_DISCONNECT, SWITCH.RECONCILIATION, SWITCH.DATA_INTEGRITY]
      .some((n) => this.active.has(n));
  }

  violations() {
    return this.tripped.map((r) =>
      violation(TIER.TRUTH, `KILL_${r.name}`, `Kill switch ${r.name} active: ${r.reason}`, r.detail));
  }
}
