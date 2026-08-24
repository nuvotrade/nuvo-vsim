import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Rng } from '../src/math/random.js';
import {
  conditionalVaR, valueAtRisk, normInv, normCdf, quantile, mean, stdev, correlation, brierScore,
} from '../src/math/stats.js';
import {
  price, greeks, impliedVol, probItm, probTouch, dteToT,
} from '../src/math/black_scholes.js';
import {
  lognormalTerminal, jumpDiffusionTerminal, studentTTerminal, ensembleTerminal, modelSpread,
  bootstrapTerminal,
} from '../src/math/distribution.js';

describe('determinism', () => {
  test('the same seed produces the same stream', () => {
    const a = [...Array(50)].map(() => new Rng('x').next());
    assert.equal(new Set(a).size, 1, 'fresh Rng with same seed must restart identically');
    const r1 = new Rng('seed'); const r2 = new Rng('seed');
    for (let i = 0; i < 100; i += 1) assert.equal(r1.next(), r2.next());
  });

  test('different seeds diverge', () => {
    assert.notEqual(new Rng('a').next(), new Rng('b').next());
  });

  test('forked generators are deterministic and distinct', () => {
    const base = new Rng('root');
    assert.equal(base.fork('a').next(), new Rng('root:a').next());
    assert.notEqual(base.fork('a').next(), base.fork('b').next());
  });

  test('normal draws have the right moments', () => {
    const r = new Rng('moments');
    const xs = [...Array(200_000)].map(() => r.normal());
    assert.ok(Math.abs(mean(xs)) < 0.01, `mean ${mean(xs)}`);
    assert.ok(Math.abs(stdev(xs) - 1) < 0.01, `sd ${stdev(xs)}`);
  });

  test('studentT is standardised to unit variance', () => {
    const r = new Rng('t');
    const xs = [...Array(100_000)].map(() => r.studentT(5));
    assert.ok(Math.abs(stdev(xs) - 1) < 0.05, `sd ${stdev(xs)}`);
  });
});

describe('tail statistics', () => {
  test('CVaR is at least VaR and both are positive magnitudes', () => {
    const xs = [-100, -50, -20, -5, 0, 5, 10, 20, 30, 40];
    assert.ok(conditionalVaR(xs, 0.9) >= valueAtRisk(xs, 0.9));
    assert.ok(conditionalVaR(xs, 0.9) > 0);
  });

  test('CVaR never optimistic when the tail bucket is empty', () => {
    assert.equal(conditionalVaR([-500, 1, 2], 0.99), 500);
  });

  test('normInv inverts normCdf', () => {
    for (const p of [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) {
      assert.ok(Math.abs(normCdf(normInv(p)) - p) < 1e-6);
    }
  });

  test('quantile matches known values', () => {
    assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
    assert.equal(quantile([1, 2, 3, 4], 0), 1);
    assert.equal(quantile([1, 2, 3, 4], 1), 4);
  });

  test('correlation recovers a perfect relationship', () => {
    const xs = [1, 2, 3, 4, 5];
    assert.ok(Math.abs(correlation(xs, xs.map((x) => 2 * x + 1)) - 1) < 1e-9);
    assert.ok(Math.abs(correlation(xs, xs.map((x) => -x)) + 1) < 1e-9);
  });

  test('brier score is zero for perfect forecasts', () => {
    assert.equal(brierScore([{ p: 1, outcome: true }, { p: 0, outcome: false }]), 0);
  });
});

describe('black-scholes', () => {
  const t = dteToT(30);

  test('put-call parity holds exactly', () => {
    const c = price({ type: 'call', spot: 100, strike: 95, vol: 0.3, t, rate: 0.04 });
    const p = price({ type: 'put', spot: 100, strike: 95, vol: 0.3, t, rate: 0.04 });
    assert.ok(Math.abs(c - p - (100 - 95 * Math.exp(-0.04 * t))) < 1e-9);
  });

  test('implied vol round-trips', () => {
    for (const vol of [0.1, 0.25, 0.5, 1.0]) {
      const px = price({ type: 'put', spot: 100, strike: 95, vol, t, rate: 0.04 });
      const iv = impliedVol({ type: 'put', marketPrice: px, spot: 100, strike: 95, t, rate: 0.04 });
      assert.ok(Math.abs(iv - vol) < 1e-4, `${vol} -> ${iv}`);
    }
  });

  test('implied vol refuses prices below intrinsic rather than guessing', () => {
    const iv = impliedVol({ type: 'put', marketPrice: 0.01, spot: 100, strike: 150, t, rate: 0 });
    assert.ok(Number.isNaN(iv));
  });

  test('greeks have the right signs for a short-dated put', () => {
    const g = greeks({ type: 'put', spot: 100, strike: 95, vol: 0.3, t, rate: 0.04 });
    assert.ok(g.delta < 0 && g.delta > -1);
    assert.ok(g.gamma > 0);
    assert.ok(g.vega > 0);
    assert.ok(g.theta < 0);
  });

  test('probability of touch is at least probability of finishing ITM', () => {
    for (const K of [90, 95, 99]) {
      const pt = probTouch({ spot: 100, strike: K, vol: 0.3, t });
      const pi = probItm({ type: 'put', spot: 100, strike: K, vol: 0.3, t });
      assert.ok(pt >= pi - 1e-9, `K=${K}: touch ${pt} < itm ${pi}`);
      assert.ok(pt <= 1 && pt >= 0);
    }
  });

  test('missing inputs return NaN rather than a default', () => {
    assert.ok(Number.isNaN(price({ type: 'put', spot: NaN, strike: 95, vol: 0.3, t })));
    assert.ok(Number.isNaN(greeks({ type: 'put', spot: 100, strike: 95, vol: NaN, t }).delta));
  });
});

describe('forward distributions', () => {
  const spot = 100; const vol = 0.3; const t = dteToT(30);

  test('lognormal Monte Carlo matches the analytic probability', () => {
    const d = lognormalTerminal({ spot, vol, t, n: 80_000, seed: 'm' });
    const analytic = probItm({ type: 'put', spot, strike: 95, vol, t });
    assert.ok(Math.abs(d.probBelow(95) - analytic) < 0.01,
      `MC ${d.probBelow(95)} vs analytic ${analytic}`);
  });

  test('jump diffusion has a fatter left tail than pure diffusion', () => {
    const ln = lognormalTerminal({ spot, vol, t, n: 80_000, seed: 'm' });
    const jd = jumpDiffusionTerminal({ spot, vol, t, n: 80_000, seed: 'm', jumpIntensity: 2, jumpMean: -0.06, jumpVol: 0.1 });
    assert.ok(jd.probBelow(80) > ln.probBelow(80),
      `jump ${jd.probBelow(80)} should exceed diffusion ${ln.probBelow(80)}`);
  });

  test('ensemble spread rises when members disagree', () => {
    const ln = lognormalTerminal({ spot, vol, t, n: 30_000, seed: 'a' });
    const jd = jumpDiffusionTerminal({ spot, vol, t, n: 30_000, seed: 'a', jumpIntensity: 4, jumpMean: -0.12, jumpVol: 0.15 });
    const agree = ensembleTerminal([{ dist: ln }, { dist: lognormalTerminal({ spot, vol, t, n: 30_000, seed: 'b' }) }]);
    const disagree = ensembleTerminal([{ dist: ln }, { dist: jd }]);
    assert.ok(modelSpread(disagree, 85) > modelSpread(agree, 85));
  });

  test('bootstrap removes the sample period drift unless explicitly requested', () => {
    const trending = Array(252).fill(0.0005);
    const neutral = bootstrapTerminal({
      spot, returns: trending, horizonDays: 30, n: 1000, seed: 'centered',
    });
    const bullish = bootstrapTerminal({
      spot, returns: trending, horizonDays: 30, drift: 0.05, n: 1000, seed: 'centered',
    });
    assert.ok(Math.abs(neutral.params.sampleAnnualizedLogReturn - 0.126) < 1e-12);
    assert.equal(neutral.params.drift, 0);
    assert.ok(neutral.samples.every((sample) => Math.abs(sample - spot) < 1e-12));
    assert.ok(bullish.samples[0] > neutral.samples[0]);
  });

  test('bootstrap converts calendar DTE to trading sessions', () => {
    const dist = bootstrapTerminal({
      spot, returns: Array(252).fill(0), horizonDays: 30, n: 10, seed: 'calendar',
    });
    assert.equal(dist.params.tradingSessions, 21);
    assert.equal(dist.t, 30 / 365);
  });

  test('payoff stats are internally consistent', () => {
    const d = studentTTerminal({ spot, vol, t, n: 40_000, seed: 'p' });
    const s = d.payoffStats((S) => Math.min(0, S - 95) * 100 + 200);
    assert.ok(s.worst <= s.p05 || s.worst <= s.ev);
    assert.ok(s.cvar >= s.var, 'CVaR must be at least VaR');
    assert.ok(s.pLoss >= 0 && s.pLoss <= 1);
    assert.ok(s.best >= s.ev && s.ev >= s.worst);
  });

  test('distributions are reproducible from their seed', () => {
    const a = lognormalTerminal({ spot, vol, t, n: 5000, seed: 'repro' });
    const b = lognormalTerminal({ spot, vol, t, n: 5000, seed: 'repro' });
    assert.deepEqual(a.samples, b.samples);
  });
});
