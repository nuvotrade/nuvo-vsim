import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cashSecuredPut, bullPutSpread, coveredCall, longShares, noTrade, realisticFill, STRUCTURE } from '../src/structures/structure.js';
import {
  evaluate, conditionalLoss, cspWheelCompatibility, DEFAULT_LAMBDAS, gapRisk,
  collateralOpportunityCost,
} from '../src/underwriter/ev.js';
import { capitalProfile, economicCapital, UNDEFINED_RISK_CAPITAL_FLOOR } from '../src/underwriter/capital.js';
import { CalibrationStore, probabilitySet, marketProbability, modelProbability, CALIBRATION, confidenceFrom } from '../src/underwriter/probabilities.js';
import { structureCost, DEFAULT_COSTS } from '../src/underwriter/costs.js';
import { lognormalTerminal, jumpDiffusionTerminal } from '../src/math/distribution.js';
import { dteToT, price } from '../src/math/black_scholes.js';
import { Rng } from '../src/math/random.js';
import { screenAndRefine, selectBest } from '../src/structures/optimizer.js';

const DTE = 30;
const T = dteToT(DTE);
const SPOT = 100;
const mkPut = (strike, iv, spread = 0.08) => {
  const m = price({ type: 'put', spot: SPOT, strike, vol: iv, t: T, rate: 0.045 });
  return {
    symbol: `X${strike}P`, strike, right: 'put', dte: DTE, expiration: '2024-07-03',
    bid: +Math.max(0.02, m - spread / 2).toFixed(2), ask: +(m + spread / 2).toFixed(2),
    multiplier: 100, iv, delta: -0.25, gamma: 0.03, vega: 0.1, theta: -0.04,
    openInterest: 5000, volume: 800,
  };
};
const dist = jumpDiffusionTerminal({ spot: SPOT, vol: 0.30, t: T, n: 40_000, seed: 'u', drift: 0.05, jumpIntensity: 2, jumpMean: -0.06, jumpVol: 0.1 });
const diffusion = lognormalTerminal({ spot: SPOT, vol: 0.30, t: T, n: 40_000, seed: 'u', drift: 0.05 });

describe('structures', () => {
  test('CSP max loss is strike-to-zero, not a comfortable approximation', () => {
    const s = cashSecuredPut({ underlying: 'X', put: mkPut(95, 0.32) });
    assert.ok(Math.abs(-s.payoff(0) - s.maxLoss) < 1e-6);
    assert.ok(s.maxLoss > 9000, 'a 95-strike CSP risks roughly the whole strike');
    assert.equal(s.definedRisk, false);
  });

  test('spread max loss equals width minus credit and matches payoff at zero', () => {
    const s = bullPutSpread({ underlying: 'X', shortPut: mkPut(95, 0.32), longPut: mkPut(90, 0.35) });
    assert.ok(Math.abs(-s.payoff(0) - s.maxLoss) < 1e-6);
    assert.equal(s.definedRisk, true);
    assert.ok(s.buyingPower < 600);
  });

  test('realistic fill is worse than mid for the taker on both sides', () => {
    const c = mkPut(95, 0.32);
    const mid = (c.bid + c.ask) / 2;
    assert.ok(realisticFill(c, 'sell', 0.35) < mid, 'selling receives less than mid');
    assert.ok(realisticFill(c, 'buy', 0.35) > mid, 'buying pays more than mid');
  });

  test('covered call caps upside at the strike', () => {
    const call = { ...mkPut(105, 0.28), right: 'call', strike: 105 };
    const s = coveredCall({ underlying: 'X', call, shares: 100, costBasis: 98 });
    assert.equal(s.payoff(200), s.payoff(105), 'upside is capped above the strike');
    assert.equal(s.buyingPower, 0, 'shares already held consume no new buying power');
  });

  test('NO_TRADE is a real competitor with zero EV and zero capital', () => {
    const n = noTrade();
    assert.equal(n.payoff(1), 0);
    assert.equal(n.buyingPower, 0);
    assert.equal(n.maxLoss, 0);
    assert.equal(n.kind, STRUCTURE.NO_TRADE);
  });

  test('a spread with no net credit is refused rather than built', () => {
    const inverted = bullPutSpread({
      underlying: 'X', shortPut: mkPut(90, 0.30), longPut: mkPut(95, 0.30),
    });
    assert.equal(inverted, null);
  });
});

describe('costs are charged before an edge is believed', () => {
  test('CSP all-in cost charges embedded entry slippage exactly once', () => {
    const put = {
      ...mkPut(95, 0.32), bid: 1.00, ask: 1.20, multiplier: 100,
    };
    const s = cashSecuredPut({ underlying: 'X', put, aggression: 0.35 });
    const c = structureCost(s, DEFAULT_COSTS);
    // Half-spread is $0.10. At 35% aggression one side costs
    // $0.10 × 0.35 × 100 = $3.50. Entry is embedded in the executable
    // credit; only the $3.50 exit slippage is charged again. Round-trip
    // commissions are 2 × ($0.65 + $0.15) = $1.60.
    assert.ok(Math.abs(c.embeddedEntrySlippage - 3.50) < 1e-9);
    assert.ok(Math.abs(c.exitSlippage - 3.50) < 1e-9);
    assert.ok(Math.abs(c.commissions - 1.60) < 1e-9);
    assert.ok(Math.abs(c.total - 5.10) < 1e-9,
      'only exit slippage and round-trip fees are subtracted after executable entry');
    assert.ok(Math.abs(c.allInTotal - 8.60) < 1e-9,
      'all-in cost includes one entry side, one exit side, and round-trip fees');
    assert.equal(c.trips, 2, 'positions are managed, not merely expired');
    assert.equal(c.modelVersion, 'execution-cost-v2');
  });

  test('a two-leg structure costs more than a one-leg one', () => {
    const csp = cashSecuredPut({ underlying: 'X', put: mkPut(95, 0.32) });
    const bps = bullPutSpread({ underlying: 'X', shortPut: mkPut(95, 0.32), longPut: mkPut(90, 0.35) });
    assert.ok(structureCost(bps).total > structureCost(csp).total);
  });
});

describe('NEV penalises what an expectation cannot see', () => {
  test('a CSP charges risk-free plus four percent on full strike collateral inside NEV', () => {
    const s = cashSecuredPut({ underlying: 'X', put: mkPut(92, 0.40) });
    const hurdle = collateralOpportunityCost({ structure: s, annualRate: 0.085 });
    const e = evaluate({ structure: s, dist, diffusionDist: diffusion, collateralHurdleRate: 0.085 });
    assert.ok(Math.abs(hurdle.collateral - 9200) < 1e-9);
    assert.ok(Math.abs((e.nevBeforeCollateral - e.nev) - hurdle.value) < 1e-9);
    assert.equal(e.collateralOpportunity.annualRate, 0.085);
  });

  test('the CSP collateral hurdle is not charged to a defined-risk spread', () => {
    const s = bullPutSpread({ underlying: 'X', shortPut: mkPut(92, 0.40), longPut: mkPut(87, 0.44) });
    assert.equal(collateralOpportunityCost({ structure: s, annualRate: 0.085 }).value, 0);
  });
  test('NEV is always below EV when there is any tail', () => {
    const s = cashSecuredPut({ underlying: 'X', put: mkPut(92, 0.40) });
    const e = evaluate({ structure: s, dist, diffusionDist: diffusion });
    assert.ok(e.nev < e.ev, 'risk charges must reduce expectation');
    assert.ok(e.cvar > 0);
  });

  test('gap risk is isolated as the jump-vs-diffusion CVaR difference', () => {
    const s = cashSecuredPut({ underlying: 'X', put: mkPut(92, 0.40) });
    const g = gapRisk({ structure: s, dist, diffusionDist: diffusion });
    assert.ok(g.value > 0, 'a short put must carry positive gap risk');
    assert.ok(g.share > 0 && g.share < 1);
  });

  test('a defined-risk spread carries far less gap risk than a CSP', () => {
    const csp = cashSecuredPut({ underlying: 'X', put: mkPut(92, 0.40) });
    const bps = bullPutSpread({ underlying: 'X', shortPut: mkPut(92, 0.40), longPut: mkPut(87, 0.44) });
    const gc = gapRisk({ structure: csp, dist, diffusionDist: diffusion });
    const gb = gapRisk({ structure: bps, dist, diffusionDist: diffusion });
    assert.ok(gb.share < gc.share, 'capping the tail must cap the gap exposure');
  });

  test('NEV rises monotonically with the premium received', () => {
    let prev = -Infinity;
    for (const iv of [0.24, 0.30, 0.36, 0.44, 0.52]) {
      const s = cashSecuredPut({ underlying: 'X', put: mkPut(92, iv) });
      const e = evaluate({ structure: s, dist, diffusionDist: diffusion });
      assert.ok(e.nev > prev, `NEV must increase with IV: ${iv}`);
      prev = e.nev;
    }
  });

  test('an unpaid tail produces negative NEV', () => {
    const s = cashSecuredPut({ underlying: 'X', put: mkPut(92, 0.20) }); // IV far below realised
    assert.ok(evaluate({ structure: s, dist, diffusionDist: diffusion }).nev < 0);
  });

  test('conditional loss is reported given the strike is breached', () => {
    const s = cashSecuredPut({ underlying: 'X', put: mkPut(92, 0.36) });
    const cl = conditionalLoss({ structure: s, dist });
    assert.ok(cl.pBreach > 0 && cl.pBreach < 1);
    assert.ok(cl.expectedLoss > 0);
    assert.ok(cl.worstGivenBreach >= cl.expectedLoss);
  });
});

describe('CSP selection and evidence use the same net objective', () => {
  const candidate = ({ nev, dte, raroc, strike }) => ({
    underlying: 'X', admissible: true, dte, score: raroc,
    structure: { kind: STRUCTURE.CSP, shortStrike: strike, buyingPower: strike * 100, contracts: 1 },
    evaluation: { nev }, capital: { raroc }, violations: [],
  });

  test('CSP-only ranking uses NEV per calendar day instead of annualized RAROC', () => {
    const highGrossRatio = candidate({ nev: 20, dte: 20, raroc: 0.50, strike: 90 });
    const higherNetDaily = candidate({ nev: 18, dte: 9, raroc: 0.20, strike: 91 });
    const result = selectBest([highGrossRatio, higherNetDaily], {});
    assert.equal(result.selected.structure.shortStrike, 91);
  });

  test('puts excluded before underwriting remain in the evidence ledger with a reason code', () => {
    const result = screenAndRefine({
      underlyingState: { spot: 100 },
      chain: { underlying: 'X', contracts: [{ right: 'put', strike: 80, delta: -0.02, dte: 14, expiration: '2026-09-09' }] },
      regime: { regime: 'NORMAL' }, limits: {}, allowedStructures: [STRUCTURE.CSP],
      screenParams: { dist: null, diffusionDist: null }, fullParams: { dist: null, diffusionDist: null },
    });
    assert.equal(result.candidates.length, 0);
    assert.equal(result.screenedOut[0].shortStrike, 80);
    assert.equal(result.screenedOut[0].reasonCode, 'DELTA_OUT_OF_BAND');
  });
});

describe('CSP wheel compatibility is a path geometry test', () => {
  test('reports the conditional fraction of assignment paths needing excessive recovery', () => {
    const result = cspWheelCompatibility({
      structure: { kind: STRUCTURE.CSP, shortStrike: 100, breakeven: 95 },
      dist: { samples: [99, 96, 94, 90, 80, 101] },
      forwardVol: 0.20,
      ccDte: 14,
      recoverySigmaThreshold: 1,
    });
    assert.equal(result.assignmentPathCount, 5);
    assert.equal(result.strandedPathCount, 2);
    assert.equal(result.strandedFraction, 0.4);
    assert.equal(result.wheelCompatibleFraction, 0.6);
    assert.equal(result.forwardVol, 0.20);
    assert.equal(result.ccDte, 14);
    assert.equal(result.recoverySigmaThreshold, 1);
    assert.equal(result.recoveryDistanceSigmas.length, 5);
    assert.ok(result.recoveryDistanceSigmas.every(Number.isFinite));
    assert.match(result.interpretation, /no future option quote/u);
  });

  test('fails measurement when the observed volatility needed for recovery distance is absent', () => {
    const result = cspWheelCompatibility({
      structure: { kind: STRUCTURE.CSP, shortStrike: 100, breakeven: 95 },
      dist: { samples: [90] },
      forwardVol: null,
    });
    assert.equal(result.measurable, false);
  });
});

describe('economic capital resists the deep-wing pathology', () => {
  test('CSP profiles do not compute or expose the retired ROC/RAROC metrics', () => {
    for (const K of [95, 90, 85, 80, 75, 70, 65]) {
      const s = cashSecuredPut({ underlying: 'X', put: mkPut(K, 0.30 + (100 - K) / 100 * 0.9) });
      const e = evaluate({ structure: s, dist, diffusionDist: diffusion });
      const c = capitalProfile({ evaluation: e, structure: s, dte: DTE, dist });
      assert.equal(Object.hasOwn(c, 'raroc'), false);
      assert.equal(Object.hasOwn(c, 'roc'), false);
      assert.equal(c.decisionMetric, 'NEV_PER_CALENDAR_DAY');
      assert.equal(c.decisionValue, e.nev / DTE);
      assert.ok(c.economicCapital > 0);
    }
  });

  test('undefined risk never claims less than a tenth of locked buying power', () => {
    const s = cashSecuredPut({ underlying: 'X', put: mkPut(60, 1.2) }); // absurdly far OTM
    const e = evaluate({ structure: s, dist, diffusionDist: diffusion });
    const ec = economicCapital({ evaluation: e, structure: s, dist });
    assert.ok(ec >= s.buyingPower * UNDEFINED_RISK_CAPITAL_FLOOR - 1e-6,
      `economic capital ${ec} fell below the buying-power floor`);
  });

  test('economic capital never exceeds what can actually be lost', () => {
    const s = bullPutSpread({ underlying: 'X', shortPut: mkPut(95, 0.32), longPut: mkPut(90, 0.35) });
    const e = evaluate({ structure: s, dist, diffusionDist: diffusion });
    assert.ok(economicCapital({ evaluation: e, structure: s, dist }) <= s.maxLoss + 1e-6);
  });

  test('RAROC remains available for non-CSP structures only', () => {
    const s = bullPutSpread({ underlying: 'X', shortPut: mkPut(92, 0.40), longPut: mkPut(87, 0.44) });
    const e = evaluate({ structure: s, dist, diffusionDist: diffusion });
    const short = capitalProfile({ evaluation: e, structure: s, dte: 7, dist });
    const long = capitalProfile({ evaluation: e, structure: s, dte: 45, dist });
    assert.ok(short.raroc !== long.raroc, 'non-CSP annualised returns remain tenor-sensitive');
    assert.equal(short.decisionMetric, 'RAROC');
  });
});

describe('three probabilities and calibration', () => {
  test('an empty store is UNCALIBRATED and does not invent a correction', () => {
    const s = new CalibrationStore();
    assert.equal(s.status(), CALIBRATION.UNCALIBRATED);
    const c = s.calibrate(0.9);
    assert.equal(c.p, 0.9, 'raw probability must pass through unchanged');
    assert.equal(c.adjusted, false);
  });

  test('a truthful forecaster is recognised as calibrated', () => {
    const s = new CalibrationStore();
    const r = new Rng('good');
    for (let i = 0; i < 600; i += 1) {
      const p = r.uniform(0.05, 0.95);
      s.record({ p, outcome: r.next() < p });
    }
    assert.equal(s.status(), CALIBRATION.CALIBRATED);
    assert.ok(Math.abs(s.slope().slope - 1) < 0.25, `slope ${s.slope().slope}`);
    assert.ok(s.skillScore() > 0, 'must beat quoting the base rate');
  });

  test('an overconfident forecaster is detected and shrunk', () => {
    const s = new CalibrationStore();
    const r = new Rng('bad');
    for (let i = 0; i < 600; i += 1) {
      const p = r.uniform(0.05, 0.95);
      s.record({ p, outcome: r.next() < 0.5 + 0.45 * (p - 0.5) }); // truth compressed toward 0.5
    }
    assert.equal(s.status(), CALIBRATION.DEGRADED);
    assert.ok(s.slope().slope < 0.7, 'slope below 1 indicates overconfidence');
    assert.ok(s.calibrate(0.90).p < 0.80, 'a claimed 90% must be shrunk');
  });

  test('p_market uses the strike IV, not ATM, so skew is not discarded', () => {
    const atmVol = marketProbability({ spot: 100, strike: 92, strikeIv: 0.30, dte: 30 });
    const skewed = marketProbability({ spot: 100, strike: 92, strikeIv: 0.38, dte: 30 });
    assert.ok(skewed.p > atmVol.p, 'a higher strike IV must imply a higher risk-neutral P(ITM)');
  });

  test('confidence falls with uncalibrated status and with model disagreement', () => {
    assert.ok(confidenceFrom(CALIBRATION.CALIBRATED, 0) > confidenceFrom(CALIBRATION.UNCALIBRATED, 0));
    assert.ok(confidenceFrom(CALIBRATION.CALIBRATED, 0) > confidenceFrom(CALIBRATION.CALIBRATED, 0.10));
    assert.ok(confidenceFrom(CALIBRATION.DEGRADED, 0.2) < 0.2);
  });

  test('edge is positive when the market prices more risk than the model sees', () => {
    const ps = probabilitySet({
      market: marketProbability({ spot: 100, strike: 92, strikeIv: 0.42, dte: 30 }),
      model: modelProbability({ dist: diffusion, strike: 92 }),
      store: new CalibrationStore(),
    });
    assert.ok(ps.edge > 0);
    assert.ok(Math.abs(ps.disagreement + ps.edge) < 1e-9, 'edge and disagreement are mirror images');
    assert.equal(ps.calibration, CALIBRATION.UNCALIBRATED);
  });
});
