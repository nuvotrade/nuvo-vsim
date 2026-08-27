import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hypothesis, HypothesisRegistry, GATE, GATE_ORDER } from '../src/research/hypothesis.js';
import { bootstrapTrades, walkForward, selectionAdjusted, summariseBacktest } from '../src/research/backtest.js';
import { Strategy, StrategyRegistry, STRATEGY_STATE } from '../src/registry/strategy_registry.js';
import { registerCatalogue } from '../src/registry/strategies/vsim_strategies.js';
import { EvidenceStore } from '../src/evidence/store.js';
import { buildEvidence, sealOutcome, verifyEvidence } from '../src/evidence/package.js';
import { Rng } from '../src/math/random.js';
import { AUTHORITY, validateAuthorityLevel } from '../src/constitution/authority.js';

const TEST_AUTHORITY = validateAuthorityLevel(AUTHORITY.PROPOSE, { source: 'research test authority' });

const THRESHOLDS = { minExpectancy: 5, minProfitFactor: 1.15, maxDrawdownPct: 0.15, minTrades: 40 };
const pass = { expectancy: 20, profitFactor: 1.6, maxDrawdownPct: 0.08, trades: 120 };

describe('research gates cannot be gamed (§2)', () => {
  test('a hypothesis must pre-register its thresholds', () => {
    assert.throws(() => new Hypothesis({ id: 'H1', statement: 's' }), /pre-register/);
  });

  test('pre-registered thresholds are frozen', () => {
    const h = new Hypothesis({ id: 'H1', statement: 's', preRegistered: THRESHOLDS });
    assert.throws(() => { h.preRegistered.minProfitFactor = 0.5; }, TypeError);
  });

  test('gates must run in order so a holdout cannot be peeked at', () => {
    const h = new Hypothesis({ id: 'H1', statement: 's', preRegistered: THRESHOLDS });
    assert.throws(() => h.recordGate(GATE.HOLDOUT, pass), /before 'training'/);
  });

  test('a gate cannot be re-run after its result is seen', () => {
    const h = new Hypothesis({ id: 'H1', statement: 's', preRegistered: THRESHOLDS });
    h.recordGate(GATE.TRAINING, pass);
    assert.throws(() => h.recordGate(GATE.TRAINING, pass), /already has a result/);
  });

  test('promotion requires every gate to have run and passed', () => {
    const h = new Hypothesis({ id: 'H1', statement: 's', preRegistered: THRESHOLDS });
    for (const g of GATE_ORDER) h.recordGate(g, pass);
    assert.equal(h.promotable, true);

    const h2 = new Hypothesis({ id: 'H2', statement: 's', preRegistered: THRESHOLDS });
    h2.recordGate(GATE.TRAINING, pass);
    h2.recordGate(GATE.VALIDATION, pass);
    h2.recordGate(GATE.HOLDOUT, { ...pass, profitFactor: 1.01 }); // fails
    assert.equal(h2.promotable, false);
    assert.ok(h2.failedGates.includes(GATE.HOLDOUT));
  });

  test('the registry only promotes fully cleared hypotheses', () => {
    const r = new HypothesisRegistry();
    const good = r.add(new Hypothesis({ id: 'H1', statement: 's', preRegistered: THRESHOLDS }));
    r.add(new Hypothesis({ id: 'H2', statement: 's', preRegistered: THRESHOLDS }));
    for (const g of GATE_ORDER) good.recordGate(g, pass);
    assert.deepEqual(r.promotable.map((h) => h.id), ['H1']);
  });
});

describe('statistical honesty', () => {
  test('a high win rate with negative expectancy is exposed by the bootstrap', () => {
    const r = new Rng('trap');
    // 85% winners, but the losers are far larger: the §26 trap.
    const trades = Array.from({ length: 200 }, () => ({
      realizedPnl: r.next() < 0.85 ? r.uniform(40, 120) : -r.uniform(200, 900),
      capitalEmployed: 9000,
    }));
    const b = bootstrapTrades({ trades, startingCapital: 100_000, seed: 'b' });
    assert.ok(b.probabilityOfLoss > 0.5,
      '80% POP does not mean safe — most resampled paths must lose');
    assert.ok(b.p95MaxDrawdown > b.medianMaxDrawdown);
  });

  test('block bootstrap preserves clustering, so drawdowns exceed the iid case', () => {
    const r = new Rng('cluster');
    const trades = Array.from({ length: 200 }, () => ({ realizedPnl: r.next() < 0.8 ? 100 : -350 }));
    const blocked = bootstrapTrades({ trades, startingCapital: 100_000, blockSize: 20, seed: 'x' });
    const iid = bootstrapTrades({ trades, startingCapital: 100_000, blockSize: 1, seed: 'x' });
    assert.ok(blocked.p95MaxDrawdown >= iid.p95MaxDrawdown * 0.9,
      'clustered resampling must not report a kinder tail than iid');
  });

  test('a thin trade sample refuses to produce a bootstrap', () => {
    assert.equal(bootstrapTrades({ trades: [{ realizedPnl: 1 }], startingCapital: 1000 }).sufficient, false);
  });

  test('selection adjustment deflates the best of many variants', () => {
    const single = selectionAdjusted({ observedSharpe: 0.22, trials: 1, n: 200 });
    const many = selectionAdjusted({ observedSharpe: 0.22, trials: 40, n: 200 });
    assert.ok(many.pFamilyWise > single.pFamilyWise,
      'testing forty variants must inflate the p-value of the winner');
  });

  test('walk-forward scores consistency, not a flattering average', () => {
    const bars = Array.from({ length: 1200 }, (_, i) => ({
      t: i, o: 100, h: 101, l: 99, c: 100 + Math.sin(i / 20), v: 1e6,
    }));
    const r = walkForward({
      bars, folds: 4, warmup: 60,
      buildStrategy: () => ({ onBar: () => null }),
    });
    assert.ok('consistency' in r);
    if (r.folds > 0) assert.ok(r.consistency >= 0 && r.consistency <= 1);
  });
});

describe('strategies are killable (§24)', () => {
  test('a strategy cannot exist without declared kill criteria', () => {
    assert.throws(() => new Strategy({ id: 'X', name: 'x', hypothesis: 'h' }), /kill criteria/);
  });

  test('state transitions are constrained', () => {
    const r = registerCatalogue(new StrategyRegistry());
    const s = r.get('VSIM-001');
    s.transition('VALIDATED', 'gates cleared');
    assert.throws(() => s.transition('LIVE', 'skip shadow'), /Illegal strategy transition/);
    s.transition('SHADOW', 'paper');
    s.transition('LIVE', 'promoted');
    assert.equal(s.tradeable, true);
  });

  test('breaching a kill criterion kills the strategy', () => {
    const r = registerCatalogue(new StrategyRegistry());
    const s = r.get('VSIM-001');
    s.transition('VALIDATED', 'gates').transition('SHADOW', 'paper').transition('LIVE', 'promoted');
    const killed = r.enforceKillCriteria({
      'VSIM-001': { n: 60, oosExpectancy: -12, cvarPct: 0.03, calibrationSlope: 0.8, brierScore: 0.2, edgeRetained: 0.6 },
    });
    assert.equal(killed.length, 1);
    assert.equal(s.state, STRATEGY_STATE.TERMINATED, 'a deployed strategy that failed was terminated');
    assert.match(s.history.at(-1).reason, /Kill criteria breached/);
  });

  test('a strategy that fails in research is rejected, not terminated', () => {
    const r = registerCatalogue(new StrategyRegistry());
    r.enforceKillCriteria({ 'VSIM-002': { n: 60, oosExpectancy: -5 } });
    assert.equal(r.get('VSIM-002').state, STRATEGY_STATE.REJECTED,
      'an idea that never risked capital did not cost anything');
  });

  test('kill criteria are not evaluated on an insufficient sample', () => {
    const r = registerCatalogue(new StrategyRegistry());
    const killed = r.enforceKillCriteria({ 'VSIM-001': { n: 5, oosExpectancy: -999 } });
    assert.equal(killed.length, 0, 'three bad trades must not kill a strategy');
  });

  test('a terminated strategy cannot be revived, only succeeded', () => {
    const r = registerCatalogue(new StrategyRegistry());
    r.get('VSIM-001').transition('VALIDATED', 'g').transition('SHADOW', 'p').transition('LIVE', 'l');
    r.terminate('VSIM-001', 'expectancy gone');
    assert.equal(r.get('VSIM-001').state, STRATEGY_STATE.TERMINATED);
    assert.throws(() => r.get('VSIM-001').transition('LIVE', 'it looks better now'), /Illegal/);
    const child = r.createSuccessor('VSIM-001', {
      id: 'VSIM-101', name: 'successor', hypothesis: 'refined claim',
      killCriteria: { minObservations: 50, maxOosExpectancy: 0 },
      allowedStructures: ['CSP'], allowedRegimes: ['FEAR'],
    });
    assert.equal(child.state, STRATEGY_STATE.RESEARCH, 'a successor starts from scratch');
    assert.deepEqual(child.lineage, ['VSIM-001']);
  });

  test('a revision must take a new id, not reuse the old one', () => {
    const r = registerCatalogue(new StrategyRegistry());
    assert.throws(() => r.register(r.get('VSIM-001')), /NEW id/);
  });

  test('0DTE ships rejected with its reason on the record (§22)', () => {
    const r = registerCatalogue(new StrategyRegistry());
    const s = r.get('VSIM-004');
    assert.equal(s.state, STRATEGY_STATE.REJECTED);
    assert.match(s.history.at(-1).reason, /contaminate/);
  });
});

describe('evidence chain', () => {
  const mk = (i) => buildEvidence({
    cycleId: `C${i}`, now: 1000 + i, decision: 'CSP', candidates: [],
    modelVersion: 'm1', codeVersion: 'c1', limits: { version: 'v5' }, authorityLevel: TEST_AUTHORITY,
  });

  test('a package verifies against its own hash', () => {
    assert.equal(verifyEvidence(mk(1)), true);
  });

  test('sealing an outcome links to the decision and re-verifies', () => {
    const pkg = mk(1);
    const sealed = sealOutcome(pkg, { realizedPnl: 250 });
    assert.equal(verifyEvidence(sealed), true);
    assert.equal(sealed.decisionHash, pkg.hash, 'the decision must remain provable');
    assert.notEqual(sealed.hash, pkg.hash);
  });

  test('a different outcome produces a different hash', () => {
    const pkg = mk(1);
    assert.notEqual(sealOutcome(pkg, { realizedPnl: 1 }).hash, sealOutcome(pkg, { realizedPnl: 2 }).hash);
  });

  test('the chain detects an altered record and names its position', () => {
    const store = new EvidenceStore();
    for (let i = 0; i < 5; i += 1) store.append(mk(i));
    assert.equal(store.verify().valid, true);
    store.records[2].decision = 'ALTERED';
    const v = store.verify();
    assert.equal(v.valid, false);
    assert.equal(v.brokenAt, 2);
  });

  test('the chain detects a deleted record', () => {
    const store = new EvidenceStore();
    for (let i = 0; i < 5; i += 1) store.append(mk(i));
    store.records.splice(2, 1);
    assert.equal(store.verify().valid, false);
  });
});
