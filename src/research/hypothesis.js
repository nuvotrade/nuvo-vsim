/**
 * The Research Lab (§2).
 *
 * "This system discovers whether an edge actually exists. It is forbidden
 * from trading."
 *
 * The prohibition is enforced structurally: nothing in src/research/ can
 * reach an execution path, and a hypothesis carries an explicit gate list
 * it must clear IN ORDER before it may be promoted.
 */
export const GATE = Object.freeze({
  TRAINING: 'training',
  VALIDATION: 'validation',
  HOLDOUT: 'holdout',
  WALK_FORWARD: 'walkForward',
  MONTE_CARLO: 'monteCarlo',
  COST_SIMULATION: 'costSimulation',
  SHADOW: 'shadow',
});

/** The order is mandatory — holdout cannot be run before validation. */
export const GATE_ORDER = [
  GATE.TRAINING, GATE.VALIDATION, GATE.HOLDOUT,
  GATE.WALK_FORWARD, GATE.MONTE_CARLO, GATE.COST_SIMULATION, GATE.SHADOW,
];

/**
 * A hypothesis under test.
 *
 * `preRegistered` holds the thresholds declared BEFORE any result is seen.
 * They cannot be modified afterwards — the setter throws — which is the
 * entire defence against fitting the criteria to the outcome.
 */
export class Hypothesis {
  constructor({ id, statement, strategyId, preRegistered, dataSpec }) {
    if (!id || !statement) throw new Error('A hypothesis requires an id and a falsifiable statement.');
    if (!preRegistered) throw new Error(`Hypothesis ${id} must pre-register its success thresholds.`);
    this.id = id;
    this.statement = statement;
    this.strategyId = strategyId ?? null;
    this.dataSpec = dataSpec ?? null;
    this.preRegistered = Object.freeze({ ...preRegistered });
    this.results = {};
    this.log = [];
  }

  /** Record a gate result. Refuses to run gates out of order. */
  recordGate(gate, result) {
    const idx = GATE_ORDER.indexOf(gate);
    if (idx < 0) throw new Error(`Unknown gate '${gate}'.`);
    for (let i = 0; i < idx; i += 1) {
      if (!this.results[GATE_ORDER[i]]) {
        throw new Error(
          `Cannot record '${gate}' before '${GATE_ORDER[i]}'. `
          + 'Gates run in order so a holdout cannot be peeked at early.',
        );
      }
    }
    if (this.results[gate]) {
      throw new Error(
        `Gate '${gate}' already has a result for ${this.id}. `
        + 'Re-running a gate after seeing its outcome is how thresholds get fitted; '
        + 'create a new hypothesis id instead (§24).',
      );
    }
    const passed = this.evaluateGate(gate, result);
    this.results[gate] = { ...result, passed, gate };
    this.log.push({ gate, passed, at: result.at ?? null });
    return this.results[gate];
  }

  /** Compare a gate's result against the PRE-REGISTERED thresholds only. */
  evaluateGate(gate, result) {
    const t = this.preRegistered;
    const checks = [];
    if (t.minExpectancy !== undefined) checks.push((result.expectancy ?? -Infinity) >= t.minExpectancy);
    if (t.minProfitFactor !== undefined) checks.push((result.profitFactor ?? 0) >= t.minProfitFactor);
    if (t.maxDrawdownPct !== undefined) checks.push((result.maxDrawdownPct ?? Infinity) <= t.maxDrawdownPct);
    if (t.minTrades !== undefined) checks.push((result.trades ?? 0) >= t.minTrades);
    if (t.minSharpe !== undefined && result.sharpe !== undefined) checks.push(result.sharpe >= t.minSharpe);
    if (t.maxCvarPct !== undefined && result.cvarPct !== undefined) checks.push(result.cvarPct <= t.maxCvarPct);
    return checks.length > 0 && checks.every(Boolean);
  }

  get clearedGates() {
    return GATE_ORDER.filter((g) => this.results[g]?.passed);
  }

  get failedGates() {
    return GATE_ORDER.filter((g) => this.results[g] && !this.results[g].passed);
  }

  /** Promotion requires every gate to have run AND passed. */
  get promotable() {
    return GATE_ORDER.every((g) => this.results[g]?.passed === true);
  }

  status() {
    return {
      id: this.id,
      strategyId: this.strategyId,
      cleared: this.clearedGates,
      failed: this.failedGates,
      pending: GATE_ORDER.filter((g) => !this.results[g]),
      promotable: this.promotable,
      preRegistered: this.preRegistered,
    };
  }
}

/** Registry of hypotheses, keyed H1, H2, H3... as §2 describes. */
export class HypothesisRegistry {
  constructor() { this.items = new Map(); }

  add(h) {
    if (this.items.has(h.id)) throw new Error(`Hypothesis ${h.id} already exists.`);
    this.items.set(h.id, h);
    return h;
  }

  get(id) { return this.items.get(id) ?? null; }
  get all() { return [...this.items.values()]; }
  get promotable() { return this.all.filter((h) => h.promotable); }
}
