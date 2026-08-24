/**
 * The Strategy Registry (§23, §24).
 *
 * NUVO's identity is permanent. Strategies are the things that live,
 * compete for capital, and die. A new idea is a new module with a new ID —
 * never a redefinition of what NUVO is.
 *
 * And critically: a strategy is KILLABLE. Rejection criteria are declared
 * up front, so termination is a measurement rather than an argument.
 */
import { isNum } from '../math/stats.js';

export const STRATEGY_STATE = Object.freeze({
  RESEARCH: 'RESEARCH',
  VALIDATED: 'VALIDATED',
  SHADOW: 'SHADOW',
  LIVE: 'LIVE',
  SUSPENDED: 'SUSPENDED',
  TERMINATED: 'TERMINATED',
  REJECTED: 'REJECTED',
});

/** Legal transitions. Anything else throws — states are not free-form. */
const TRANSITIONS = {
  RESEARCH: ['VALIDATED', 'REJECTED'],
  VALIDATED: ['SHADOW', 'REJECTED'],
  SHADOW: ['LIVE', 'SUSPENDED', 'TERMINATED'],
  LIVE: ['SUSPENDED', 'TERMINATED'],
  SUSPENDED: ['LIVE', 'TERMINATED'],
  TERMINATED: [],
  REJECTED: [],
};

export class Strategy {
  constructor({
    id, name, hypothesis, state = STRATEGY_STATE.RESEARCH,
    killCriteria, allowedStructures, allowedRegimes, dteBand = [7, 45],
    capitalShare = 0, version = 1,
  }) {
    if (!id || !name || !hypothesis) {
      throw new Error('A strategy requires an id, a name and a falsifiable hypothesis.');
    }
    if (!killCriteria) {
      throw new Error(`Strategy ${id} must declare its kill criteria before it can exist (§24).`);
    }
    Object.assign(this, {
      id, name, hypothesis, state, killCriteria, allowedStructures,
      allowedRegimes, dteBand, capitalShare, version,
    });
    this.history = [{ state, at: null, reason: 'created' }];
    this.evidence = { live: [], shadow: [] };
  }

  transition(next, reason, at = null) {
    if (!TRANSITIONS[this.state]?.includes(next)) {
      throw new Error(`Illegal strategy transition ${this.state} -> ${next} for ${this.id}.`);
    }
    if (!reason) throw new Error('Strategy transitions require a stated reason.');
    this.state = next;
    this.history.push({ state: next, at, reason });
    return this;
  }

  get tradeable() {
    return this.state === STRATEGY_STATE.LIVE;
  }

  /**
   * Evaluate the declared kill criteria against current evidence.
   *
   * Returns the breaches rather than acting — termination is performed by
   * the registry so it is always logged in one place.
   */
  checkKillCriteria(evidence) {
    const k = this.killCriteria;
    const breaches = [];
    const {
      oosExpectancy, cvarPct, calibrationSlope, brierScore,
      edgeRetained, n, maxDrawdownPct, profitFactor,
    } = evidence;

    if (isNum(n) && n >= (k.minObservations ?? 30)) {
      if (isNum(oosExpectancy) && isNum(k.maxOosExpectancy) && oosExpectancy <= k.maxOosExpectancy) {
        breaches.push(`Out-of-sample expectancy ${oosExpectancy.toFixed(2)} <= ${k.maxOosExpectancy}.`);
      }
      if (isNum(cvarPct) && isNum(k.maxCvarPct) && cvarPct > k.maxCvarPct) {
        breaches.push(`CVaR ${(cvarPct * 100).toFixed(1)}% of capital exceeds ${(k.maxCvarPct * 100).toFixed(1)}%.`);
      }
      if (isNum(calibrationSlope) && isNum(k.minCalibrationSlope) && calibrationSlope < k.minCalibrationSlope) {
        breaches.push(`Calibration slope ${calibrationSlope.toFixed(2)} below ${k.minCalibrationSlope}.`);
      }
      if (isNum(brierScore) && isNum(k.maxBrierScore) && brierScore > k.maxBrierScore) {
        breaches.push(`Brier score ${brierScore.toFixed(3)} exceeds ${k.maxBrierScore}.`);
      }
      if (isNum(edgeRetained) && isNum(k.minEdgeRetained) && edgeRetained < k.minEdgeRetained) {
        breaches.push(`Execution retains only ${(edgeRetained * 100).toFixed(0)}% of modelled edge; ${(k.minEdgeRetained * 100).toFixed(0)}% required.`);
      }
      if (isNum(maxDrawdownPct) && isNum(k.maxDrawdownPct) && maxDrawdownPct > k.maxDrawdownPct) {
        breaches.push(`Drawdown ${(maxDrawdownPct * 100).toFixed(1)}% exceeds ${(k.maxDrawdownPct * 100).toFixed(1)}%.`);
      }
      if (isNum(profitFactor) && isNum(k.minProfitFactor) && profitFactor < k.minProfitFactor) {
        breaches.push(`Profit factor ${profitFactor.toFixed(2)} below ${k.minProfitFactor}.`);
      }
    }
    return { breached: breaches.length > 0, breaches, evaluated: isNum(n) && n >= (k.minObservations ?? 30) };
  }
}

export class StrategyRegistry {
  constructor() {
    this.strategies = new Map();
    this.log = [];
  }

  register(strategy) {
    if (this.strategies.has(strategy.id)) {
      throw new Error(`Strategy ${strategy.id} already registered. A revision is a NEW id (§24).`);
    }
    this.strategies.set(strategy.id, strategy);
    this.log.push({ event: 'REGISTER', id: strategy.id, state: strategy.state });
    return strategy;
  }

  get(id) { return this.strategies.get(id) ?? null; }

  get live() {
    return [...this.strategies.values()].filter((s) => s.tradeable);
  }

  get all() { return [...this.strategies.values()]; }

  /**
   * Kill a strategy.
   *
   * The terminal state depends on how far the strategy got, because the
   * distinction is worth preserving in the record: an idea that failed in
   * research was REJECTED and never risked capital, while one that failed
   * after deployment was TERMINATED and did. Collapsing the two would make
   * the registry read as though every dead idea had cost money.
   *
   * Note what this does NOT offer: a repair path, a rename, or a refit.
   * Research may propose a successor, and that successor is a new
   * hypothesis with a new ID and its own out-of-sample burden.
   */
  terminate(id, reason, at = null) {
    const s = this.get(id);
    if (!s) throw new Error(`Unknown strategy ${id}.`);
    const deployed = ![STRATEGY_STATE.RESEARCH, STRATEGY_STATE.VALIDATED].includes(s.state);
    const target = deployed ? STRATEGY_STATE.TERMINATED : STRATEGY_STATE.REJECTED;
    s.transition(target, reason, at);
    this.log.push({ event: target, id, reason, at });
    return s;
  }

  /** Run every strategy's kill criteria and terminate those that breach. */
  enforceKillCriteria(evidenceById, at = null) {
    const terminated = [];
    for (const s of this.strategies.values()) {
      if (s.state === STRATEGY_STATE.TERMINATED || s.state === STRATEGY_STATE.REJECTED) continue;
      const ev = evidenceById[s.id];
      if (!ev) continue;
      const check = s.checkKillCriteria(ev);
      if (check.breached) {
        this.terminate(s.id, `Kill criteria breached: ${check.breaches.join(' ')}`, at);
        terminated.push({ id: s.id, breaches: check.breaches });
      }
    }
    return terminated;
  }

  /**
   * Successor strategy — explicitly a NEW hypothesis, not a repair.
   * The lineage is recorded so a family of refits is visible as such.
   */
  createSuccessor(parentId, spec) {
    const parent = this.get(parentId);
    if (!parent) throw new Error(`Unknown parent strategy ${parentId}.`);
    const child = new Strategy({
      ...spec,
      state: STRATEGY_STATE.RESEARCH,
      version: parent.version + 1,
    });
    child.parentId = parentId;
    child.lineage = [...(parent.lineage ?? []), parentId];
    this.register(child);
    this.log.push({ event: 'SUCCESSOR', parent: parentId, child: child.id });
    return child;
  }

  summary() {
    return this.all.map((s) => ({
      id: s.id, name: s.name, state: s.state, version: s.version,
      capitalShare: s.capitalShare, hypothesis: s.hypothesis,
      lineage: s.lineage ?? [],
    }));
  }
}
