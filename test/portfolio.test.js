import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CapitalLedger, CAPITAL_STATE } from '../src/portfolio/capital_states.js';
import { buildClusters, clusterOf } from '../src/portfolio/clusters.js';
import { checkLimits, exposures, portfolioGreeks } from '../src/portfolio/governor.js';
import {
  qualityMultiplier, confidenceMultiplier, regimeMultiplier, diversificationMultiplier, sizePosition,
} from '../src/portfolio/sizing.js';
import { stressTest, ruinProbability, STRESS_SCENARIOS } from '../src/portfolio/stress.js';
import { DEFAULT_LIMITS } from '../src/constitution/limits.js';
import { AUTHORITY } from '../src/constitution/authority.js';
import { classify, REGIME } from '../src/market/regime.js';
import { Rng } from '../src/math/random.js';

describe('capital states', () => {
  test('every dollar is in exactly one state and the total is conserved', () => {
    const l = new CapitalLedger({ nav: 100_000, limits: DEFAULT_LIMITS });
    assert.equal(l.snapshot().consistent, true);
    l.move('AVAILABLE', 'AT_RISK', 25_000, 'open');
    assert.equal(l.snapshot().consistent, true);
    assert.equal(l.total, 100_000);
  });

  test('the reserve is carved out before anything is deployable', () => {
    const l = new CapitalLedger({ nav: 100_000, limits: DEFAULT_LIMITS });
    assert.equal(l.buckets.RESERVE, 20_000);
    assert.ok(l.deployable({ authorityFraction: 1 }) <= 80_000);
  });

  test('capital cannot be overdrawn', () => {
    const l = new CapitalLedger({ nav: 100_000, limits: DEFAULT_LIMITS });
    const r = l.move('AVAILABLE', 'AT_RISK', 999_999, 'too much');
    assert.equal(r.ok, false);
    assert.ok(l.buckets.AT_RISK === 0);
  });

  test('authority caps deployable capital independently of what is available', () => {
    const l = new CapitalLedger({ nav: 100_000, limits: DEFAULT_LIMITS });
    assert.ok(l.deployable({ authorityFraction: 0.20 }) < l.deployable({ authorityFraction: 1.0 }));
  });

  test('quarantine removes all deployable capital until explicitly released', () => {
    const l = new CapitalLedger({ nav: 100_000, limits: DEFAULT_LIMITS });
    l.quarantine('reconciliation failed');
    assert.equal(l.deployable({ authorityFraction: 1 }), 0);
    assert.ok(l.buckets.QUARANTINED > 0);
    l.release('reconciliation passed');
    assert.ok(l.deployable({ authorityFraction: 1 }) > 0);
  });

  test('a NAV of zero or less is refused', () => {
    assert.throws(() => new CapitalLedger({ nav: 0, limits: DEFAULT_LIMITS }), RangeError);
  });
});

describe('correlation clustering (§14)', () => {
  const r = new Rng('cluster');
  const factor = [...Array(200)].map(() => r.normal(0, 0.01));
  const load = (l) => factor.map((x) => l * x + Math.sqrt(1 - l * l) * r.normal(0, 0.01));

  test('correlated names collapse into one cluster', () => {
    const rets = { AAPL: load(0.92), MSFT: load(0.91), NVDA: load(0.90), XOM: load(0.05) };
    const sectors = { AAPL: 'TECH', MSFT: 'TECH', NVDA: 'TECH', XOM: 'ENERGY' };
    const c = buildClusters(rets, { threshold: 0.65, sectors });
    const tech = clusterOf(c, 'AAPL');
    assert.equal(tech.members.length, 3, 'three correlated tech names are one trade');
    assert.ok(!tech.members.includes('XOM'));
  });

  test('same sector forces a cluster even when the sample says otherwise', () => {
    const rets = { A: load(0.05), B: load(0.05) };
    const c = buildClusters(rets, { threshold: 0.65, sectors: { A: 'TECH', B: 'TECH' } });
    assert.equal(c.clusters.length, 1, 'a short history must not be read as independence');
  });

  test('ten correlated short puts breach the 25% cluster limit', () => {
    const symbols = Array.from({ length: 10 }, (_, i) => `T${i}`);
    const rets = Object.fromEntries(symbols.map((s) => [s, load(0.9)]));
    const sectors = Object.fromEntries(symbols.map((s) => [s, 'TECH']));
    const clustering = buildClusters(rets, { threshold: 0.65, sectors });
    const positions = symbols.map((s, i) => ({
      id: `P${i}`, underlying: s, sector: 'TECH', economicCapital: 4000,
      quantity: -1, multiplier: 100, delta: -0.2, vega: 0.1, spot: 100, beta: 1,
      expiration: '2024-07-19',
    }));
    const chk = checkLimits({ positions, nav: 100_000, limits: DEFAULT_LIMITS, clustering });
    assert.equal(chk.passed, false);
    assert.ok(chk.violations.some((v) => v.code === 'CLUSTER_LIMIT'),
      'ten correlated positions are one enormous short-vol trade');
  });

  test('expiration concentration is caught separately from sector', () => {
    const positions = ['A', 'B', 'C'].map((s, i) => ({
      id: `P${i}`, underlying: s, sector: `S${i}`, economicCapital: 14_000,
      quantity: -1, multiplier: 100, delta: -0.1, vega: 0.05, spot: 100, beta: 1,
      expiration: '2024-07-19',
    }));
    const clustering = buildClusters({ A: [], B: [], C: [] }, { sectors: {} });
    const chk = checkLimits({ positions, nav: 100_000, limits: DEFAULT_LIMITS, clustering });
    assert.ok(chk.violations.some((v) => v.code === 'EXPIRATION_LIMIT'));
  });
});

describe('sizing multipliers can only reduce', () => {
  test('quality is zero when RAROC does not beat the hurdle', () => {
    assert.equal(qualityMultiplier(0.05, 0.08), 0);
    assert.ok(qualityMultiplier(0.20, 0.08) > 0);
  });

  test('quality saturates rather than rewarding implausible RAROC', () => {
    assert.ok(qualityMultiplier(50, 0.08) <= 1);
    assert.ok(qualityMultiplier(500, 0.08) <= 1);
  });

  test('every multiplier is bounded at or below one', () => {
    assert.ok(confidenceMultiplier(99) <= 1);
    assert.ok(diversificationMultiplier({ clusterExposure: 0, clusterLimit: 1000, correlation: 0 }) <= 1);
  });

  test('diversification reaches zero at the cluster limit', () => {
    assert.equal(diversificationMultiplier({ clusterExposure: 1000, clusterLimit: 1000, correlation: 0.5 }), 0);
  });

  test('an uncalibrated model is sized smaller than a calibrated one', () => {
    assert.ok(confidenceMultiplier(0.35) < confidenceMultiplier(1.0));
  });

  test('regime multiplier is highest in FEAR and lowest in DISLOCATION', () => {
    const m = (regime) => regimeMultiplier({ sizeMultiplier: { CALM: 0.5, NORMAL: 1, FEAR: 1.25, PANIC: 0.7, DISLOCATION: 0.35 }[regime] });
    assert.ok(m('FEAR') > m('NORMAL'));
    assert.ok(m('DISLOCATION') < m('PANIC'));
  });

  test('sizing names its binding constraint and explains a zero', () => {
    const ledger = new CapitalLedger({ nav: 100_000, limits: DEFAULT_LIMITS });
    const candidate = {
      capital: { raroc: 0.5, economicCapital: 50_000 },
      structure: { contracts: 1, buyingPower: 90_000 },
      probabilities: { confidence: 0.35 },
      hurdle: 0.08,
    };
    const s = sizePosition({
      candidate, nav: 100_000, ledger, regime: { sizeMultiplier: 1 },
      clusterExposure: 0, clusterCorrelation: null, limits: DEFAULT_LIMITS,
      authorityLevel: AUTHORITY.AUTO_ENTRY,
    });
    assert.equal(s.contracts, 0);
    assert.ok(s.zeroReason, 'a zero size must be explained');
    assert.ok(s.binding);
  });

  test('research-only authority can never deploy capital', () => {
    const ledger = new CapitalLedger({ nav: 100_000, limits: DEFAULT_LIMITS });
    const candidate = {
      capital: { raroc: 5, economicCapital: 100 },
      structure: { contracts: 1, buyingPower: 500 },
      probabilities: { confidence: 1 },
      hurdle: 0.08,
    };
    const s = sizePosition({
      candidate, nav: 100_000, ledger, regime: { sizeMultiplier: 1.25 },
      clusterExposure: 0, clusterCorrelation: null, limits: DEFAULT_LIMITS,
      authorityLevel: AUTHORITY.RESEARCH_ONLY,
    });
    assert.equal(s.contracts, 0);
    assert.match(s.zeroReason, /Authority/);
  });
});

describe('stress and ruin', () => {
  const repricer = (pos, spot, vol) => -Math.max(0, pos.strike - spot) * 100 * Math.abs(pos.quantity)
    - vol * 10 * Math.abs(pos.quantity);
  const positions = [{ id: 'p1', underlying: 'X', spot: 100, iv: 0.25, strike: 95, quantity: -5 }];

  test('the mandated set shocks price and volatility together', () => {
    for (const s of STRESS_SCENARIOS) {
      if (s.priceShock < 0) assert.ok(s.volShock > 0, `${s.id} must shock vol alongside price`);
    }
  });

  test('a large short-put book fails the stress limit', () => {
    const r = stressTest({ positions, nav: 20_000, repricer, limits: DEFAULT_LIMITS });
    assert.ok(r.worst.pnl < 0);
    assert.equal(r.passed, false);
    assert.ok(r.breaches.length > 0);
  });

  test('the same book passes with enough capital behind it', () => {
    const r = stressTest({ positions, nav: 5_000_000, repricer, limits: DEFAULT_LIMITS });
    assert.equal(r.passed, true);
  });

  test('ruin probability is reported with its standard error', () => {
    const rng = new Rng('ruin');
    const r = ruinProbability({
      perCyclePnl: Array.from({ length: 100 }, (_, i) => (i % 7 === 0 ? -9000 : 400)),
      nav: 100_000, trials: 500, cycles: 52, rng,
    });
    assert.ok(r.probability >= 0 && r.probability <= 1);
    assert.ok(Number.isFinite(r.standardError), 'a ruin probability without an error bar is false precision');
  });

  test('a thin P&L sample is flagged as indicative rather than measured', () => {
    const rng = new Rng('thin');
    const r = ruinProbability({ perCyclePnl: [100, -50, 30], nav: 100_000, trials: 100, rng });
    assert.equal(r.sufficient, false);
    assert.ok(r.note);
  });
});

describe('regime engine', () => {
  const CASES = {
    CALM: { vix: 12, vix3m: 14, realizedVol: 0.10, impliedVol: 0.14, indexDrawdown: -0.01, breadthCorrelation: 0.25, gapFrequency: 0.01, crossAssetStress: 0.1, liquidityScore: 0.95, volOfVol: 0.5 },
    NORMAL: { vix: 17, vix3m: 18, realizedVol: 0.14, impliedVol: 0.17, indexDrawdown: -0.04, breadthCorrelation: 0.42, gapFrequency: 0.03, crossAssetStress: 0.2, liquidityScore: 0.85, volOfVol: 0.7 },
    FEAR: { vix: 25, vix3m: 24, realizedVol: 0.22, impliedVol: 0.26, indexDrawdown: -0.09, breadthCorrelation: 0.68, gapFrequency: 0.08, crossAssetStress: 0.45, liquidityScore: 0.6, volOfVol: 1.1 },
    PANIC: { vix: 40, vix3m: 33, realizedVol: 0.48, impliedVol: 0.42, indexDrawdown: -0.19, breadthCorrelation: 0.88, gapFrequency: 0.20, crossAssetStress: 0.8, liquidityScore: 0.45, volOfVol: 2.2 },
    DISLOCATION: { vix: 60, vix3m: 45, realizedVol: 0.75, impliedVol: 0.65, indexDrawdown: -0.32, breadthCorrelation: 0.95, gapFrequency: 0.30, crossAssetStress: 0.95, liquidityScore: 0.15, volOfVol: 3.0 },
  };

  for (const [name, inputs] of Object.entries(CASES)) {
    test(`the ${name} reference state classifies as ${name}`, () => {
      assert.equal(classify(inputs).regime, REGIME[name]);
    });
  }

  test('sparse inputs produce an unconfident call, not a confident NORMAL', () => {
    const r = classify({ vix: 17 });
    assert.equal(r.confident, false);
    assert.ok(r.coverage < 0.5);
  });

  test('an unknown regime forbids every structure', async () => {
    const { stanceFor, STANCE } = await import('../src/market/regime.js');
    for (const s of ['CSP', 'BULL_PUT_SPREAD', 'SHARES', 'COVERED_CALL']) {
      assert.equal(stanceFor(null, s), STANCE.FORBIDDEN);
    }
  });

  test('a restricted stance demands more expectancy, not less', async () => {
    const { hurdleFor } = await import('../src/market/regime.js');
    assert.ok(hurdleFor('CALM', 'CSP', 0.08).hurdle > hurdleFor('FEAR', 'CSP', 0.08).hurdle);
  });
});
