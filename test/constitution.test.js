import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTHORITY, can, requireCapability, evaluatePromotion, evaluateDemotion,
  CAPITAL_AUTHORITY_FRACTION, authorityValue, validateAuthorityLevel,
} from '../src/constitution/authority.js';
import { KillSwitchBoard, SWITCH } from '../src/constitution/killswitch.js';
import { DEFAULT_LIMITS, amend } from '../src/constitution/limits.js';
import { TIER, violation, governingTier, bySeverity } from '../src/constitution/hierarchy.js';

const authority = (level) => validateAuthorityLevel(level, { source: 'test authority' });

describe('hierarchy: TRUTH > SURVIVAL > EXPECTANCY > CAPITAL EFFICIENCY > INCOME', () => {
  test('tiers are strictly ordered', () => {
    assert.ok(TIER.TRUTH < TIER.SURVIVAL);
    assert.ok(TIER.SURVIVAL < TIER.EXPECTANCY);
    assert.ok(TIER.EXPECTANCY < TIER.CAPITAL_EFFICIENCY);
    assert.ok(TIER.CAPITAL_EFFICIENCY < TIER.INCOME);
  });

  test('the governing tier is always the most fundamental violation', () => {
    const vs = [
      violation(TIER.INCOME, 'A', 'a'),
      violation(TIER.TRUTH, 'B', 'b'),
      violation(TIER.SURVIVAL, 'C', 'c'),
    ];
    assert.equal(governingTier(vs), TIER.TRUTH);
    assert.equal(vs.sort(bySeverity)[0].code, 'B');
  });

  test('a violation always carries an attributable reason', () => {
    const v = violation(TIER.SURVIVAL, 'CLUSTER_LIMIT', 'Cluster C1 too large.', { pct: 0.31 });
    assert.match(String(v), /SURVIVAL\/CLUSTER_LIMIT/);
    assert.equal(v.detail.pct, 0.31);
  });
});

describe('authority tiers', () => {
  test('research-only cannot rank, propose, or submit', () => {
    assert.equal(can(authority(AUTHORITY.RESEARCH_ONLY), 'rank'), false);
    assert.equal(can(authority(AUTHORITY.RESEARCH_ONLY), 'submit'), false);
  });

  test('shadow may rank but never submit', () => {
    assert.equal(can(authority(AUTHORITY.SHADOW), 'rank'), true);
    assert.equal(can(authority(AUTHORITY.SHADOW), 'submit'), false);
    assert.match(String(requireCapability(authority(AUTHORITY.SHADOW), 'submit')), /AUTHORITY_INSUFFICIENT/);
  });

  test('propose builds orders but requires approval', () => {
    assert.equal(can(authority(AUTHORITY.PROPOSE), 'propose'), true);
    assert.equal(can(authority(AUTHORITY.PROPOSE), 'submit'), false);
  });

  test('only lifecycle authority manages positions autonomously', () => {
    assert.equal(can(authority(AUTHORITY.AUTO_ENTRY), 'manage'), false);
    assert.equal(can(authority(AUTHORITY.AUTO_LIFECYCLE), 'manage'), true);
  });

  test('capital authority increases monotonically with tier', () => {
    const fracs = Object.keys(CAPITAL_AUTHORITY_FRACTION).map(Number).sort((a, b) => a - b)
      .map((k) => CAPITAL_AUTHORITY_FRACTION[k]);
    for (let i = 1; i < fracs.length; i += 1) assert.ok(fracs[i] >= fracs[i - 1]);
    assert.equal(CAPITAL_AUTHORITY_FRACTION[AUTHORITY.RESEARCH_ONLY], 0);
    assert.equal(CAPITAL_AUTHORITY_FRACTION[AUTHORITY.SHADOW], 0);
  });

  test('shadow promotion requires an explicit Principal amendment, not an observation count', () => {
    const evidenceAlone = evaluatePromotion(authority(AUTHORITY.SHADOW), {
      liveObservations: 10_000, brierScore: 0.01, calibrationSlope: 1,
    });
    assert.equal(evidenceAlone.eligible, false);
    assert.ok(evidenceAlone.failures.some((failure) => failure.includes('Principal')));
    const amended = evaluatePromotion(authority(AUTHORITY.SHADOW), {
      principalConstitutionAmendment: true,
    });
    assert.equal(amended.eligible, true);
    assert.equal(authorityValue(amended.target), AUTHORITY.PROPOSE);
  });

  test('promotion is one step at a time', () => {
    const r = evaluatePromotion(authority(AUTHORITY.SHADOW), {
      principalConstitutionAmendment: true,
      liveObservations: 10_000, brierScore: 0.01, calibrationSlope: 1.0,
      executionEdgeRetained: 0.99, constitutionalBreaches: 0, maxDrawdownPct: 0.01, profitFactor: 9,
    });
    assert.equal(authorityValue(r.target), AUTHORITY.PROPOSE, 'cannot leap past PROPOSE');
  });

  test('autonomy demands proven execution, not just proven theory', () => {
    const r = evaluatePromotion(authority(AUTHORITY.PROPOSE), {
      liveObservations: 200, brierScore: 0.15, calibrationSlope: 0.95,
      executionEdgeRetained: 0.10, constitutionalBreaches: 0,
    });
    assert.equal(r.eligible, false);
    assert.ok(r.failures.some((f) => f.includes('executionEdgeRetained')));
  });

  test('a single constitutional breach costs autonomy immediately', () => {
    const d = evaluateDemotion(authority(AUTHORITY.AUTO_LIFECYCLE), { constitutionalBreaches: 1 });
    assert.equal(d.demote, true);
    assert.equal(authorityValue(d.target), AUTHORITY.PROPOSE);
  });

  test('a data-integrity failure costs everything', () => {
    const d = evaluateDemotion(authority(AUTHORITY.AUTO_PORTFOLIO), { dataIntegrityFailure: true });
    assert.equal(authorityValue(d.target), AUTHORITY.RESEARCH_ONLY);
  });

  test('authority must be explicit, integral, and within the constitutional ladder', () => {
    assert.throws(() => validateAuthorityLevel(undefined, { source: 'NUVO_AUTHORITY_LEVEL' }),
      (error) => error.code === 'AUTHORITY_CONFIG_MISSING');
    for (const invalid of ['', 'not-a-level', NaN, -1, 2.5, 6]) {
      assert.throws(() => validateAuthorityLevel(invalid, { source: 'NUVO_AUTHORITY_LEVEL' }),
        (error) => error.code === (invalid === '' ? 'AUTHORITY_CONFIG_MISSING' : 'AUTHORITY_CONFIG_INVALID'));
    }
  });

  test('behavioral guards reject plain numbers as a system fault', () => {
    assert.throws(() => can(AUTHORITY.AUTO_PORTFOLIO, 'submit'),
      (error) => error.code === 'AUTHORITY_VALUE_UNVALIDATED');
  });

  test('an invalid authority cannot suppress automatic demotion', () => {
    assert.throws(
      () => evaluateDemotion(Number.NaN, { dataIntegrityFailure: true }),
      (error) => error.code === 'AUTHORITY_VALUE_UNVALIDATED',
    );
    const demotion = evaluateDemotion(authority(AUTHORITY.AUTO_PORTFOLIO), {
      dataIntegrityFailure: true,
    });
    assert.equal(demotion.demote, true);
    assert.equal(authorityValue(demotion.target), AUTHORITY.RESEARCH_ONLY);
  });
});

describe('kill switches', () => {
  test('any tripped switch blocks new exposure', () => {
    const b = new KillSwitchBoard(() => 1);
    assert.equal(b.blocksNewExposure(), false);
    b.trip(SWITCH.DRAWDOWN, 'peak-to-trough 11%');
    assert.equal(b.blocksNewExposure(), true);
  });

  test('a drawdown halt still permits closing positions', () => {
    const b = new KillSwitchBoard(() => 1);
    b.trip(SWITCH.DRAWDOWN, 'halt');
    assert.equal(b.blocksRiskReduction(), false,
      'a drawdown halt that prevented de-risking would be self-defeating');
  });

  test('losing broker truth blocks even risk reduction', () => {
    const b = new KillSwitchBoard(() => 1);
    b.trip(SWITCH.BROKER_DISCONNECT, 'no session');
    assert.equal(b.blocksRiskReduction(), true);
  });

  test('tripping is idempotent and keeps the first cause', () => {
    const b = new KillSwitchBoard(() => 1);
    b.trip(SWITCH.MANUAL, 'first');
    b.trip(SWITCH.MANUAL, 'second');
    assert.equal(b.active.get(SWITCH.MANUAL).reason, 'first');
    assert.equal(b.tripped.length, 1);
  });

  test('clearing requires a stated reason', () => {
    const b = new KillSwitchBoard(() => 1);
    b.trip(SWITCH.MANUAL, 'x');
    assert.throws(() => b.clear(SWITCH.MANUAL), /requires a stated reason/);
    assert.ok(b.clear(SWITCH.MANUAL, 'condition verified resolved'));
    assert.equal(b.isTripped(SWITCH.MANUAL), false);
  });
});

describe('limits', () => {
  test('amendments require a reason and are recorded', () => {
    assert.throws(() => amend(DEFAULT_LIMITS, { maxClusterPct: 0.9 }), /require a stated reason/);
    const next = amend(DEFAULT_LIMITS, { maxClusterPct: 0.30 }, { reason: 'evidence from 200 trades' });
    assert.equal(next.maxClusterPct, 0.30);
    assert.equal(next.amendments.length, 1);
    assert.equal(DEFAULT_LIMITS.maxClusterPct, 0.25, 'the original must be unchanged');
  });

  test('the constitution is frozen against direct mutation', () => {
    assert.throws(() => { DEFAULT_LIMITS.maxClusterPct = 0.99; }, TypeError);
  });

  test('key survival limits hold their stated values', () => {
    assert.equal(DEFAULT_LIMITS.maxClusterPct, 0.25, 'no correlated cluster > 25% of capital');
    assert.equal(DEFAULT_LIMITS.maxSingleUnderlyingPct, 0.20, 'Principal mandate single-name cap');
    assert.equal(DEFAULT_LIMITS.maxExpirationPct, 0.25, 'Principal mandate per-expiration cap');
    assert.equal(DEFAULT_LIMITS.harvestProfitPct, 0.75, 'harvest at 75% of premium');
    assert.equal(DEFAULT_LIMITS.reassessAdverseSigma, 0.5);
    assert.equal(DEFAULT_LIMITS.minDte, 7);
    assert.equal(DEFAULT_LIMITS.maxDte, 45);
    assert.equal(DEFAULT_LIMITS.minNev, 0, 'NEV must be strictly positive to trade');
  });
});
