/**
 * Regression tests for the correctness gaps identified in external review.
 *
 * Each block names the defect it locks down. These are the tests that would
 * have caught the originals.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../src/math/sha256.js';
import { bullPutSpread, cashSecuredPut, structureGreeks, longShares } from '../src/structures/structure.js';
import { portfolioGreeks, positionGreeks, checkLimits } from '../src/portfolio/governor.js';
import { buildClusters } from '../src/portfolio/clusters.js';
import { markPosition, blackScholesRepricer } from '../src/portfolio/repricer.js';
import { buildDistribution } from '../src/pipeline/cycle.js';
import { DEFAULT_LIMITS } from '../src/constitution/limits.js';
import { EvidenceStore, JsonlPersistence, MemoryPersistence } from '../src/evidence/store.js';
import { buildEvidence, verifyEvidence, verifyFingerprint, decisionContent } from '../src/evidence/package.js';
import { contentHash } from '../src/execution/order.js';
import { FORECAST_EVENT, calibrationTag } from '../src/underwriter/probabilities.js';
import { CalibrationStore, CALIBRATION } from '../src/underwriter/probabilities.js';
import { underwrite } from '../src/underwriter/underwrite.js';
import { stressTest } from '../src/portfolio/stress.js';
import { Rng } from '../src/math/random.js';
import { AUTHORITY, validateAuthorityLevel } from '../src/constitution/authority.js';

const TEST_AUTHORITY = validateAuthorityLevel(AUTHORITY.PROPOSE, { source: 'correctness test authority' });

const P = (k, b, a, d, g) => ({
  strike: k, bid: b, ask: a, multiplier: 100, dte: 30, expiration: '2024-07-19',
  right: 'put', delta: d, gamma: g, vega: 0.10, theta: -0.04, iv: 0.30,
  openInterest: 5000, volume: 800, symbol: `X${k}P`,
});

describe('GAP: multi-leg Greeks were read from leg[0] only', () => {
  const shortPut = P(95, 1.9, 2.1, -0.25, 0.030);
  const longPut = P(90, 0.9, 1.05, -0.10, 0.018);

  test("a spread's long leg offsets the short leg", () => {
    const bps = bullPutSpread({ underlying: 'X', shortPut, longPut });
    const g = structureGreeks(bps);
    const shortLegOnly = -1 * shortPut.delta * 100; // what the old code produced
    assert.ok(g.delta > 0, 'a bull put spread is net long delta');
    assert.ok(g.delta < shortLegOnly,
      `spread delta ${g.delta} must be below the short leg alone (${shortLegOnly})`);
    assert.ok(Math.abs(g.gamma) < Math.abs(-1 * shortPut.gamma * 100),
      'the long leg must offset gamma too');
  });

  test('a CSP has no offsetting leg, so it equals its single leg', () => {
    const csp = cashSecuredPut({ underlying: 'X', put: shortPut });
    assert.equal(structureGreeks(csp).delta, -1 * shortPut.delta * 100);
  });

  test('Schwab theta is per contract while delta, gamma, and vega retain share scaling', () => {
    const schwabPut = {
      ...shortPut,
      theta: -0.42,
      greekUnits: { theta: 'DOLLARS_PER_CONTRACT_PER_DAY' },
    };
    const csp = cashSecuredPut({ underlying: 'X', put: schwabPut });
    const g = structureGreeks(csp);
    assert.equal(g.delta, -1 * schwabPut.delta * 100);
    assert.equal(g.gamma, -1 * schwabPut.gamma * 100);
    assert.equal(g.vega, -1 * schwabPut.vega * 100);
    assert.equal(g.theta, 0.42);
    assert.equal(positionGreeks({
      quantity: -6, multiplier: 100, delta: 0.25, gamma: 0.01, vega: 0.12,
      theta: -0.5733, thetaUnit: 'DOLLARS_PER_CONTRACT_PER_DAY',
    }).theta, 3.4398);
  });

  test('long shares are delta-one', () => {
    const s = longShares({ underlying: 'X', spot: 100, shares: 100 });
    assert.equal(structureGreeks(s).delta, 100);
  });

  test('position Greeks prefer legs over a flat single-leg shape', () => {
    const bps = bullPutSpread({ underlying: 'X', shortPut, longPut });
    const viaLegs = positionGreeks({ legs: bps.legs, contracts: 1 });
    assert.ok(Math.abs(viaLegs.delta - structureGreeks(bps).delta) < 1e-9);
  });

  test('scaling to N contracts scales the Greeks', () => {
    const bps = bullPutSpread({ underlying: 'X', shortPut, longPut });
    const one = structureGreeks(bps, { contracts: 1 });
    const five = structureGreeks(bps, { contracts: 5 });
    assert.ok(Math.abs(five.delta - 5 * one.delta) < 1e-9);
  });

  test('an open position scales its retained legs to the filled size', () => {
    const bps = bullPutSpread({ underlying: 'X', shortPut, longPut });
    const expected = structureGreeks(bps, { contracts: 5 });
    const actual = positionGreeks({
      legs: bps.legs, structureContracts: bps.contracts, contracts: 5,
    });
    assert.ok(Math.abs(actual.delta - expected.delta) < 1e-9);
    assert.ok(Math.abs(actual.gamma - expected.gamma) < 1e-9);
  });
});

describe('GAP: hypothetical positions carried no spot price', () => {
  test('beta-weighted delta is zero without a spot, and that is now surfaced', () => {
    const withoutSpot = portfolioGreeks(
      [{ legs: [], quantity: -1, multiplier: 100, delta: -0.2 }], { nav: 100_000 },
    );
    assert.equal(withoutSpot.positionsMissingSpot, 1,
      'an unmeasurable position must be counted, not absorbed');
  });

  test('a position with a spot contributes real dollar delta', () => {
    const g = portfolioGreeks(
      [{ quantity: -1, multiplier: 100, delta: -0.25, spot: 400, beta: 1 }], { nav: 100_000 },
    );
    assert.ok(g.betaWeightedDelta > 0);
    assert.equal(g.positionsMissingSpot, 0);
    assert.ok(Math.abs(g.betaWeightedDelta - 25 * 400) < 1e-6);
  });

  test('an unmeasurable book is flagged rather than reading as flat', () => {
    const clustering = buildClusters({ X: [] }, { sectors: {} });
    const chk = checkLimits({
      positions: [{ underlying: 'X', sector: 'S', economicCapital: 100, quantity: -1, multiplier: 100, delta: -0.3 }],
      nav: 100_000, limits: DEFAULT_LIMITS, clustering,
    });
    assert.ok(chk.violations.some((v) => v.code === 'EXPOSURE_UNMEASURABLE'));
  });
});

describe('GAP: declared limits that were never enforced', () => {
  const clustering = buildClusters({ X: [] }, { sectors: {} });

  test('the gamma limit now blocks', () => {
    const chk = checkLimits({
      positions: [{
        underlying: 'X', sector: 'S', economicCapital: 100, spot: 100, beta: 1,
        quantity: -500, multiplier: 100, delta: -0.01, gamma: 0.05, vega: 0.001,
      }],
      nav: 100_000, limits: DEFAULT_LIMITS, clustering,
    });
    assert.ok(chk.violations.some((v) => v.code === 'GAMMA_LIMIT'),
      'maxNetGammaPctNav was declared in the constitution but never checked');
  });

  test('the repricer prices a spread by its legs, not its short strike alone', () => {
    const bps = bullPutSpread({ underlying: 'X', shortPut: P(95, 1.9, 2.1, -0.25, 0.03), longPut: P(90, 0.9, 1.05, -0.10, 0.018) });
    const pos = { legs: bps.legs, contracts: 1, iv: 0.30, dte: 30, spot: 100 };
    const base = markPosition(pos, 100, 0.30);
    const crashed = markPosition(pos, 70, 0.60);
    assert.ok(Number.isFinite(base) && Number.isFinite(crashed));
    assert.ok(crashed < base, 'a crash must hurt a short put spread');
    // Defined risk: the loss is bounded by the width.
    assert.ok(base - crashed <= (95 - 90) * 100 + 1,
      'a defined-risk spread cannot lose more than its width');
  });

  test('an undefined-risk CSP loses far more than a spread in the same crash', () => {
    const csp = cashSecuredPut({ underlying: 'X', put: P(95, 1.9, 2.1, -0.25, 0.03) });
    const bps = bullPutSpread({ underlying: 'X', shortPut: P(95, 1.9, 2.1, -0.25, 0.03), longPut: P(90, 0.9, 1.05, -0.10, 0.018) });
    const loss = (s) => {
      const pos = { legs: s.legs, contracts: 1, iv: 0.30, dte: 30, spot: 100 };
      return markPosition(pos, 100, 0.30) - markPosition(pos, 60, 0.70);
    };
    assert.ok(loss(csp) > loss(bps) * 2,
      'the stress model must distinguish capped from uncapped tails');
  });

  test('an incomplete option record makes stress invalid instead of passing as shares', () => {
    const s = stressTest({
      positions: [{ id: 'bad', type: 'OPTION', spot: 100, iv: 0.3, quantity: -1 }],
      nav: 100_000, repricer: blackScholesRepricer, limits: DEFAULT_LIMITS,
    });
    assert.equal(s.valid, false);
    assert.equal(s.passed, false);
  });

  test('blackScholesRepricer satisfies the stress module signature', () => {
    const csp = cashSecuredPut({ underlying: 'X', put: P(95, 1.9, 2.1, -0.25, 0.03) });
    const v = blackScholesRepricer({ legs: csp.legs, contracts: 1, iv: 0.3, dte: 30 }, 90, 0.4);
    assert.ok(Number.isFinite(v));
  });
});

describe('GAP: the ensemble ignored the empirical bootstrap', () => {
  const returns = new Rng('r').shuffle(
    Array.from({ length: 300 }, (_, i) => Math.sin(i) * 0.01),
  );

  test('sufficient history admits the bootstrap member', () => {
    const d = buildDistribution({ spot: 100, vol: 0.3, dte: 30, returns, seed: 's', n: 2000 });
    assert.equal(d.bootstrapIncluded, true);
    assert.ok(d.dist.members.some((m) => m.dist.model === 'block-bootstrap'),
      'the history was passed in and must actually be used');
  });

  test('insufficient history omits it rather than fabricating one', () => {
    const d = buildDistribution({ spot: 100, vol: 0.3, dte: 30, returns: returns.slice(0, 20), seed: 's', n: 2000 });
    assert.equal(d.bootstrapIncluded, false);
    assert.ok(!d.dist.members.some((m) => m.dist.model === 'block-bootstrap'));
  });

  test('no history at all is handled without throwing', () => {
    const d = buildDistribution({ spot: 100, vol: 0.3, dte: 30, seed: 's', n: 1000 });
    assert.equal(d.bootstrapIncluded, false);
    assert.ok(d.dist.n > 0);
  });

  test('the default model has no undisclosed bullish drift', () => {
    const implicit = buildDistribution({ spot: 100, vol: 0.25, dte: 30, seed: 'drift', n: 5000 });
    const neutral = buildDistribution({ spot: 100, vol: 0.25, dte: 30, seed: 'drift', drift: 0, n: 5000 });
    const bullish = buildDistribution({ spot: 100, vol: 0.25, dte: 30, seed: 'drift', drift: 0.05, n: 5000 });
    assert.equal(implicit.dist.probBelow(90), neutral.dist.probBelow(90));
    assert.ok(bullish.dist.probBelow(90) < neutral.dist.probBelow(90),
      'a positive drift mechanically makes a short put look safer');
  });
});

describe('GAP: calibration mixed terminal and touch events', () => {
  test('the two events are namespaced apart', () => {
    assert.notEqual(
      calibrationTag('VSIM-001', FORECAST_EVENT.TERMINAL_BELOW_STRIKE),
      calibrationTag('VSIM-001', FORECAST_EVENT.TOUCHED_STRIKE),
    );
    assert.match(calibrationTag('V', FORECAST_EVENT.TERMINAL_BELOW_STRIKE), /\|terminal$/);
  });

  test('underwriting reads the terminal namespace that outcomes populate', () => {
    const store = new CalibrationStore({ minTotal: 3, minPerBin: 1 });
    for (const [p, successes] of [[0.1, 1], [0.5, 5], [0.9, 9]]) {
      for (let i = 0; i < 10; i += 1) store.record({
        p, outcome: i < successes,
        tag: calibrationTag('VSIM-001', FORECAST_EVENT.TERMINAL_BELOW_STRIKE),
      });
    }
    const shortPut = P(95, 1.9, 2.1, -0.25, 0.03);
    const structure = cashSecuredPut({ underlying: 'X', put: shortPut });
    const { dist, diffusionDist } = buildDistribution({
      spot: 100, vol: 0.3, dte: 30, seed: 'calibration-read', n: 2000,
    });
    const u = underwrite({
      structure, dist, diffusionDist, underlyingState: { spot: 100 },
      regime: { regime: 'FEAR', confident: true }, limits: DEFAULT_LIMITS,
      calibrationStore: store, strategyId: 'VSIM-001',
    });
    assert.notEqual(u.probabilities.calibration, CALIBRATION.UNCALIBRATED);
    assert.equal(u.probabilities.calibrationAdjusted, true);
  });
});

describe('GAP: the evidence hash was a 64-bit checksum', () => {
  test('SHA-256 matches the FIPS 180-4 vectors', () => {
    assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(
      sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  test('the digest is full width and avalanches', () => {
    assert.equal(contentHash({ a: 1 }).length, 64);
    const x = sha256('abc');
    const y = sha256('abd');
    let same = 0;
    for (let i = 0; i < x.length; i += 1) if (x[i] === y[i]) same += 1;
    assert.ok(same < 20, 'a one-character change must not preserve the digest');
  });

  test('unicode hashes stably', () => {
    assert.equal(sha256('héllo 🌍'), sha256('héllo 🌍'));
    assert.notEqual(sha256('héllo 🌍'), sha256('hello 🌍'));
  });
});

describe('GAP: evidence packages were not reconstructable', () => {
  const mk = (overrides = {}) => buildEvidence({
    cycleId: 'C1', now: 1000, decision: 'CSP', candidates: [],
    modelVersion: 'm', codeVersion: 'c', limits: { version: 'v5' }, authorityLevel: TEST_AUTHORITY,
    ...overrides,
  });

  test('a package with no raw inputs says so instead of implying replayability', () => {
    const p = mk();
    assert.equal(p.inputs.captured, false);
    assert.match(p.inputs.note, /not replayable/);
  });

  test('captured inputs are hashed and embedded', () => {
    const raw = { capturedAt: 1000, symbols: { X: { quote: { last: 100 } } } };
    const p = mk({ rawInputs: raw });
    assert.equal(p.inputs.captured, true);
    assert.equal(p.inputs.hash, contentHash(raw));
    assert.deepEqual(p.inputs.data, raw);
  });

  test('externalised inputs keep a verifiable hash without the payload', () => {
    const raw = { capturedAt: 1000, symbols: {} };
    const p = mk({ rawInputs: raw, externalizeRaw: true });
    assert.equal(p.inputs.data, null);
    assert.equal(p.inputs.externalized, true);
    assert.equal(p.inputs.hash, contentHash(raw), 'an externalised blob must still be checkable');
  });

  test('screened-out candidates are recorded, not silently dropped', () => {
    const p = mk({ screenedOut: [{ underlying: 'X', kind: 'CSP', shortStrike: 90, screenNev: -12 }] });
    assert.equal(p.screenedOutCount, 1);
    assert.equal(p.screenedOut[0].shortStrike, 90);
  });

  test('the decision fingerprint excludes provenance but covers the decision', () => {
    const a = mk({ rawInputs: { x: 1 } });
    const b = mk({ rawInputs: { x: 1 } });
    assert.equal(a.decisionFingerprint, b.decisionFingerprint);

    const c = decisionContent(a);
    assert.ok(!('truth' in c), 'source labels must not affect reproducibility');
    assert.ok('selected' in c && 'sizing' in c && 'candidates' in c);
  });

  test('a different decision produces a different fingerprint', () => {
    const a = mk({ selected: { structure: { kind: 'CSP', shortStrike: 90 }, evaluation: {}, capital: {} } });
    const b = mk({ selected: { structure: { kind: 'CSP', shortStrike: 85 }, evaluation: {}, capital: {} } });
    assert.notEqual(a.decisionFingerprint, b.decisionFingerprint);
  });

  test('both hashes verify independently', () => {
    const p = mk({ rawInputs: { x: 1 } });
    assert.equal(verifyEvidence(p), true);
    assert.equal(verifyFingerprint(p), true);
  });
});

describe('GAP: the evidence store was memory-only', () => {
  // Each test gets its own file. Sharing one path between tests lets them
  // clobber each other's chain and produces a failure that looks like a
  // persistence bug but is only test interference.
  let seq = 0;
  const tmpPath = () => `${process.env.TMPDIR ?? '/tmp'}/nuvo-evidence-${process.pid}-${seq++}.jsonl`;
  const mk = (i) => buildEvidence({
    cycleId: `C${i}`, now: 1000 + i, decision: 'CSP', candidates: [],
    modelVersion: 'm', codeVersion: 'c', limits: { version: 'v5' }, authorityLevel: TEST_AUTHORITY,
  });

  test('the memory store reports itself as not durable', () => {
    assert.equal(new EvidenceStore({ persistence: new MemoryPersistence() }).durable, false);
  });

  test('records survive a restart and the chain still verifies', async () => {
    const fs = await import('node:fs/promises');
    const tmp = tmpPath();
    await fs.rm(tmp, { force: true });

    const first = new EvidenceStore({ persistence: new JsonlPersistence(tmp) });
    assert.equal(first.durable, true);
    for (let i = 0; i < 4; i += 1) first.append(mk(i));
    await first.flush();

    const reopened = await EvidenceStore.open({ persistence: new JsonlPersistence(tmp) });
    assert.equal(reopened.length, 4);
    assert.equal(reopened.verify().valid, true);
    assert.equal(reopened.headHash, first.headHash);

    reopened.append(mk(99));
    await reopened.flush();
    assert.equal(reopened.verify().valid, true, 'the chain must extend across a restart');

    await fs.rm(tmp, { force: true });
  });

  test('concurrent appends are persisted in chain order', async () => {
    // Regression: unserialised appendFile calls raced and persisted records
    // out of sequence, which broke the hash chain on reload about half the
    // time. Appends here are deliberately fired without awaiting each one.
    const fs = await import('node:fs/promises');
    const tmp = tmpPath();
    await fs.rm(tmp, { force: true });

    const store = new EvidenceStore({ persistence: new JsonlPersistence(tmp) });
    for (let i = 0; i < 25; i += 1) store.append(mk(i));
    await store.flush();

    const rows = (await fs.readFile(tmp, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(rows.length, 25);
    for (let i = 0; i < rows.length; i += 1) {
      assert.equal(rows[i].sequence, i, `record ${i} was persisted out of order`);
    }
    const reopened = await EvidenceStore.open({ persistence: new JsonlPersistence(tmp) });
    assert.equal(reopened.verify().valid, true);
    await fs.rm(tmp, { force: true });
  });

  test('reopening a tampered chain is refused', async () => {
    const fs = await import('node:fs/promises');
    const tmp = tmpPath();
    await fs.rm(tmp, { force: true });
    const s = new EvidenceStore({ persistence: new JsonlPersistence(tmp) });
    for (let i = 0; i < 3; i += 1) s.append(mk(i));
    await s.flush();

    const lines = (await fs.readFile(tmp, 'utf8')).split('\n').filter(Boolean);
    const bad = JSON.parse(lines[1]);
    bad.decision = 'TAMPERED';
    lines[1] = JSON.stringify(bad);
    await fs.writeFile(tmp, `${lines.join('\n')}\n`);

    await assert.rejects(
      () => EvidenceStore.open({ persistence: new JsonlPersistence(tmp) }),
      /chain is broken/,
    );
    await fs.rm(tmp, { force: true });
  });
});
