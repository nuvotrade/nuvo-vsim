import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createPositionContract, capturedFraction, adverseSigma, POSITION_STATE } from '../src/lifecycle/contract.js';
import { decide, evClose, onAssignment, ACTION } from '../src/lifecycle/engine.js';
import { cashSecuredPut } from '../src/structures/structure.js';
import { jumpDiffusionTerminal, lognormalTerminal } from '../src/math/distribution.js';
import { DEFAULT_LIMITS } from '../src/constitution/limits.js';
import { DEFAULT_COSTS } from '../src/underwriter/costs.js';
import { DEFAULT_LAMBDAS } from '../src/underwriter/ev.js';
import { dteToT } from '../src/math/black_scholes.js';
import { buildOrder, OrderBook, contentHash, fillQuality, ORDER_STATE } from '../src/execution/order.js';
import { PaperBroker } from '../src/execution/broker/paper.js';
import { AUTHORITY, validateAuthorityLevel } from '../src/constitution/authority.js';

const put = {
  symbol: 'X240703P95', strike: 95, bid: 2.40, ask: 2.60, multiplier: 100,
  dte: 30, expiration: '2024-07-03', right: 'put', delta: -0.28, iv: 0.30,
  gamma: 0.03, vega: 0.1, theta: -0.05, openInterest: 5000, volume: 900,
};
const structure = cashSecuredPut({ underlying: 'X', put });
const candidate = {
  underlying: 'X', structure,
  evaluation: { ev: 120, nev: 95, expectedLoss: 200, cvar: 600, pLoss: 0.2, costs: { slippage: 7 } },
  capital: { economicCapital: 600, raroc: 0.25 },
  probabilities: { confidence: 0.5, pModel: 0.18 },
};

function makePosition() {
  const p = createPositionContract({
    underlying: 'X', structure, candidate, sizing: { contracts: 1 },
    regime: { regime: 'FEAR' }, limits: DEFAULT_LIMITS, strategyId: 'VSIM-001',
    modelVersion: 'm1', codeVersion: 'c1', thesis: 'downside VRP rich', now: 0,
  });
  p.entrySpot = 100;
  return p;
}

describe('position contracts are complete before entry (§12)', () => {
  test('a missing field is refused rather than defaulted', () => {
    assert.throws(() => createPositionContract({
      underlying: 'X', structure, candidate, regime: { regime: 'FEAR' },
      limits: DEFAULT_LIMITS, modelVersion: 'm1', thesis: 't', now: 0,
    }), /requires 'strategyId'/);
  });

  test('a thesis is mandatory', () => {
    assert.throws(() => createPositionContract({
      underlying: 'X', structure, candidate, regime: { regime: 'FEAR' },
      limits: DEFAULT_LIMITS, strategyId: 'V1', modelVersion: 'm1', now: 0,
    }), /requires 'thesis'/);
  });

  test('lifecycle rules are frozen so a losing position cannot rewrite them', () => {
    const p = makePosition();
    assert.equal(Object.isFrozen(p.rules), true);
    assert.throws(() => { p.rules.profitExitPct = 0.99; }, TypeError);
    assert.equal(p.rules.profitExitPct, DEFAULT_LIMITS.harvestProfitPct);
  });

  test('the underwriting terms are recorded at inception', () => {
    const p = makePosition();
    assert.equal(p.cvar, 600);
    assert.equal(p.rarocAtEntry, 0.25);
    assert.equal(p.regimeAtEntry, 'FEAR');
    assert.equal(p.state, POSITION_STATE.PENDING);
  });

  test('captured fraction and adverse sigma compute correctly', () => {
    const p = makePosition();
    assert.ok(Math.abs(capturedFraction(p, p.entryCredit * 0.25) - 0.75) < 1e-9);
    assert.ok(adverseSigma({ entrySpot: 100, currentSpot: 95, iv: 0.3, daysElapsed: 20 }) < 0);
    assert.ok(adverseSigma({ entrySpot: 100, currentSpot: 105, iv: 0.3, daysElapsed: 20 }) > 0);
  });
});

describe('lifecycle decisions are anchor-free (§13)', () => {
  const mkDist = (spot, vol, dte) => ({
    dist: jumpDiffusionTerminal({ spot, vol, t: dteToT(dte), n: 20_000, seed: 'lc' }),
    diffusionDist: lognormalTerminal({ spot, vol, t: dteToT(dte), n: 20_000, seed: 'lc' }),
  });

  test('the harvest rule fires at the pre-registered threshold', () => {
    const p = makePosition();
    const { dist, diffusionDist } = mkDist(101, 0.28, 15);
    const d = decide({
      position: p, structure, dist, diffusionDist,
      currentMarkDebit: p.entryCredit * 0.2, currentSpot: 101, currentIv: 0.28,
      daysElapsed: 15, exitCost: 5, costs: DEFAULT_COSTS, lambdas: DEFAULT_LAMBDAS,
      limits: DEFAULT_LIMITS, now: 1,
    });
    assert.equal(d.action, ACTION.HARVEST);
    assert.equal(d.ruleTriggered, 'profitExitPct');
  });

  test('a strike breach forces an explicit re-underwriting, never a silent hold', () => {
    const p = makePosition();
    const { dist, diffusionDist } = mkDist(91, 0.42, 10);
    const d = decide({
      position: p, structure, dist, diffusionDist, currentMarkDebit: 520,
      currentSpot: 91, currentIv: 0.42, daysElapsed: 20, exitCost: 12,
      costs: DEFAULT_COSTS, lambdas: DEFAULT_LAMBDAS, limits: DEFAULT_LIMITS, now: 2,
    });
    assert.equal(d.breached, true);
    assert.notEqual(d.action, ACTION.HOLD, 'holding through a breach must be a recorded decision');
    assert.match(d.reason, /breached/);
  });

  test('the decision does not depend on the entry price', () => {
    const { dist, diffusionDist } = mkDist(93, 0.38, 12);
    const args = {
      structure, dist, diffusionDist, currentMarkDebit: 400, currentSpot: 93,
      currentIv: 0.38, daysElapsed: 18, exitCost: 10, costs: DEFAULT_COSTS,
      lambdas: DEFAULT_LAMBDAS, limits: DEFAULT_LIMITS, now: 3,
    };
    const cheap = makePosition();
    const dear = makePosition();
    dear.entryCredit = cheap.entryCredit * 4; // same position, different history

    const a = decide({ ...args, position: cheap });
    const b = decide({ ...args, position: dear });
    const closeA = a.comparison.find((c) => c.action === ACTION.CLOSE);
    const closeB = b.comparison.find((c) => c.action === ACTION.CLOSE);
    const holdA = a.comparison.find((c) => c.action === ACTION.HOLD);
    const holdB = b.comparison.find((c) => c.action === ACTION.HOLD);
    assert.equal(closeA.nev, closeB.nev, 'closing value cannot depend on what was paid');
    assert.ok(Math.abs(holdA.nev - holdB.nev) < 1e-6,
      'holding value cannot depend on what was paid — that is the sunk cost §13 removes');
    assert.equal(a.anchorFree, true);
  });

  test('rolling into a position that fails underwriting is rejected', () => {
    const p = makePosition();
    const { dist, diffusionDist } = mkDist(93, 0.38, 12);
    const d = decide({
      position: p, structure, dist, diffusionDist, currentMarkDebit: 400,
      currentSpot: 93, currentIv: 0.38, daysElapsed: 18, exitCost: 10,
      rollCandidate: { admissible: false, violations: [{ message: 'RAROC below hurdle' }] },
      costs: DEFAULT_COSTS, lambdas: DEFAULT_LAMBDAS, limits: DEFAULT_LIMITS, now: 4,
    });
    const roll = d.comparison.find((c) => c.action === ACTION.ROLL);
    assert.ok(roll.rejected, 'a roll must stand on its own merits, not on the old position');
  });

  test('closing has zero CVaR — certainty is part of the comparison', () => {
    const c = evClose({ currentMarkDebit: 300, exitCost: 8, freedCapital: 9000 });
    assert.equal(c.cvar, 0);
    assert.equal(c.forwardEv, -308);
  });
});

describe('assignment runs a fresh decision (§11)', () => {
  test('assignment does not default to a covered call', () => {
    const p = makePosition();
    const a = onAssignment({
      position: p, shares: 100, costBasis: 95, currentSpot: 88,
      alternatives: {
        coveredCall: {
          evaluation: { ev: 40, nev: -15 }, capital: { raroc: 0.05 },
          admissible: false, violations: [{ message: 'RAROC below hurdle' }],
        },
      },
    });
    assert.notEqual(a.recommended, 'COVERED_CALL');
    assert.match(a.note, /Yesterday/);
  });

  test('a covered call that clears underwriting on its own merits can win', () => {
    const p = makePosition();
    const a = onAssignment({
      position: p, shares: 100, costBasis: 95, currentSpot: 88,
      alternatives: {
        coveredCall: {
          evaluation: { ev: 400, nev: 350 }, capital: { raroc: 0.6 },
          admissible: true, violations: [],
        },
      },
    });
    assert.equal(a.recommended, 'COVERED_CALL');
  });

  test('cost basis is reported but does not drive the recommendation', () => {
    const p = makePosition();
    const cheap = onAssignment({ position: p, shares: 100, costBasis: 50, currentSpot: 88, alternatives: {} });
    const dear = onAssignment({ position: p, shares: 100, costBasis: 200, currentSpot: 88, alternatives: {} });
    assert.equal(cheap.recommended, dear.recommended);
  });
});

describe('execution', () => {
  const now = Date.UTC(2024, 5, 3, 15, 0);
  const build = (contracts, at = now) => buildOrder({
    candidate, sizing: { contracts },
    authorityLevel: validateAuthorityLevel(AUTHORITY.AUTO_ENTRY, { source: 'lifecycle test authority' }),
    limits: DEFAULT_LIMITS,
    now: at, strategyId: 'VSIM-001', modelVersion: 'm1', codeVersion: 'c1',
  });

  test('a retry of the same intent hashes identically', () => {
    assert.equal(build(3).order.clientOrderId, build(3, now + 8000).order.clientOrderId);
  });

  test('a different size is a different order', () => {
    assert.notEqual(build(3).order.clientOrderId, build(4).order.clientOrderId);
  });

  test('the same order on a different day is a different order', () => {
    assert.notEqual(build(3).order.clientOrderId, build(3, now + 86_400_000).order.clientOrderId);
  });

  test('the order book rejects duplicate submission', () => {
    const book = new OrderBook();
    const o = build(2).order;
    assert.equal(book.submit(o).ok, true);
    const dup = book.submit(o);
    assert.equal(dup.ok, false);
    assert.equal(dup.duplicate, true);
  });

  test('the broker also rejects duplicates, so a retry cannot double a position', async () => {
    const b = new PaperBroker({ cash: 100_000, seed: 'dup', now: () => now });
    const o = build(2).order;
    assert.ok(!(await b.submit(o)).error);
    assert.ok((await b.submit(o)).error, 'defence in depth: the broker must refuse too');
  });

  test('an order with no size is refused', () => {
    const r = build(0);
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.code === 'NO_SIZE'));
  });

  test('the price ladder walks toward the market without crossing past the cap', () => {
    const ladder = build(1).order.ladder;
    for (let i = 1; i < ladder.length; i += 1) {
      assert.ok(ladder[i].price <= ladder[i - 1].price, 'selling concedes progressively');
    }
    assert.ok(ladder[ladder.length - 1].aggression <= 0.75);
  });

  test('fill quality measures how much modelled edge survived', () => {
    const o = build(2).order;
    const q = fillQuality({ order: o, fill: { credit: o.expectation.credit * 0.9, at: now + 1500 } });
    assert.ok(q.slippage > 0);
    assert.ok(q.edgeRetained < 1);
    assert.equal(q.latencyMs, 1500);
  });

  test('content hashing is stable across key ordering', () => {
    assert.equal(contentHash({ a: 1, b: 2 }), contentHash({ b: 2, a: 1 }));
    assert.notEqual(contentHash({ a: 1 }), contentHash({ a: 2 }));
  });
});
