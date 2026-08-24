import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { verify, auditChain, Fact, VERDICT, TruthViolationError, REQUIRED_FACTS } from '../src/truth/contract.js';
import { reconcile, RECON } from '../src/truth/reconciliation.js';
import { NullProvider } from '../src/truth/providers/provider.js';
import { SyntheticProvider, surfaceIv, generatePath } from '../src/truth/providers/synthetic.js';
import { DEFAULT_LIMITS } from '../src/constitution/limits.js';
import { logReturns, stdev } from '../src/math/stats.js';

const NOW = 1_700_000_000_000;
const fresh = (value) => ({ value, asOf: NOW - 1000, source: 'test' });

function fullSnapshot(overrides = {}) {
  const s = {};
  for (const f of REQUIRED_FACTS) s[f] = fresh(f === 'positions' || f === 'openOrders' ? [] : 1);
  return { ...s, ...overrides };
}

describe('the truth contract fails closed', () => {
  test('a complete fresh snapshot is tradeable', () => {
    const r = verify(fullSnapshot(), { limits: DEFAULT_LIMITS, now: NOW });
    assert.equal(r.verdict, VERDICT.VERIFIED);
    assert.equal(r.tradeable, true);
  });

  test('a missing fact removes trading authority but not observability', () => {
    const r = verify(fullSnapshot({ optionChain: undefined }), { limits: DEFAULT_LIMITS, now: NOW });
    assert.equal(r.tradeable, false);
    assert.equal(r.observable, true, 'the dashboard stays up; only authority is withdrawn');
    assert.ok(r.summary().missing.includes('optionChain'));
  });

  test('a stale fact is treated as unverified', () => {
    const stale = { value: 1, asOf: NOW - 10 * 60 * 1000, source: 'test' };
    const r = verify(fullSnapshot({ underlyingQuote: stale }), { limits: DEFAULT_LIMITS, now: NOW });
    assert.equal(r.tradeable, false);
    assert.ok(r.violations.some((v) => v.code === 'FACT_STALE'));
  });

  test('reading an unverified fact throws rather than returning a default', () => {
    const f = new Fact('greeks', { error: 'provider timeout' });
    assert.throws(() => f.require(), TruthViolationError);
    assert.equal(f.peek(), undefined);
    assert.equal(f.ok, false);
  });

  test('requireTradeable refuses to proceed on a degraded snapshot', () => {
    const r = verify(fullSnapshot({ buyingPower: undefined }), { limits: DEFAULT_LIMITS, now: NOW });
    assert.throws(() => r.requireTradeable(), TruthViolationError);
  });

  test('an unconfigured provider refuses everything', async () => {
    const p = new NullProvider();
    for (const m of ['quote', 'optionChain', 'history', 'events', 'accountState']) {
      const r = await p[m]();
      assert.ok(r.error, `${m} must refuse, not return a value`);
      assert.equal(r.value, undefined);
    }
  });
});

describe('chain audit', () => {
  const base = { contracts: [], asOf: NOW - 1000 };

  test('an empty chain is rejected', () => {
    const p = auditChain(base, { limits: DEFAULT_LIMITS, now: NOW });
    assert.ok(p.some((v) => v.code === 'CHAIN_EMPTY'));
  });

  test('crossed markets are caught', () => {
    const chain = { ...base, contracts: [{ bid: 2.0, ask: 1.5, delta: -0.2, iv: 0.3 }] };
    assert.ok(auditChain(chain, { limits: DEFAULT_LIMITS, now: NOW }).some((v) => v.code === 'CHAIN_CROSSED'));
  });

  test('a chain missing Greeks is incomplete, not usable', () => {
    const contracts = Array.from({ length: 10 }, () => ({ bid: 1, ask: 1.1 })); // no delta/iv
    const p = auditChain({ ...base, contracts }, { limits: DEFAULT_LIMITS, now: NOW });
    assert.ok(p.some((v) => v.code === 'CHAIN_INCOMPLETE'));
  });

  test('a stale chain is caught even when structurally sound', () => {
    const contracts = [{ bid: 1, ask: 1.1, delta: -0.2, iv: 0.3 }];
    const p = auditChain({ contracts, asOf: NOW - 600_000 }, { limits: DEFAULT_LIMITS, now: NOW });
    assert.ok(p.some((v) => v.code === 'CHAIN_STALE'));
  });
});

describe('reconciliation quarantines on disagreement', () => {
  const pos = (underlying, quantity) => ({ underlying, type: 'OPTION', expiration: '2024-07-19', strike: 95, right: 'put', quantity });

  test('identical books pass', () => {
    const r = reconcile({
      engine: { positions: [pos('X', -1)], cash: 100, buyingPower: 1000, openOrders: [] },
      broker: { positions: [pos('X', -1)], cash: 100, buyingPower: 1000, openOrders: [] },
    });
    assert.equal(r.status, RECON.PASS);
  });

  test('a position the engine does not know about quarantines', () => {
    const r = reconcile({
      engine: { positions: [], cash: 100, buyingPower: 1000, openOrders: [] },
      broker: { positions: [pos('X', -1)], cash: 100, buyingPower: 1000, openOrders: [] },
    });
    assert.equal(r.status, RECON.QUARANTINE);
    assert.ok(r.problems.some((p) => p.code === 'POSITION_UNKNOWN'));
  });

  test('a phantom position the broker does not hold quarantines', () => {
    const r = reconcile({
      engine: { positions: [pos('X', -1)], cash: 100, buyingPower: 1000, openOrders: [] },
      broker: { positions: [], cash: 100, buyingPower: 1000, openOrders: [] },
    });
    assert.equal(r.status, RECON.QUARANTINE);
    assert.ok(r.problems.some((p) => p.code === 'POSITION_PHANTOM'));
  });

  test('a quantity mismatch quarantines', () => {
    const r = reconcile({
      engine: { positions: [pos('X', -1)], cash: 100, buyingPower: 1000, openOrders: [] },
      broker: { positions: [pos('X', -2)], cash: 100, buyingPower: 1000, openOrders: [] },
    });
    assert.equal(r.status, RECON.QUARANTINE);
  });

  test('an order the engine never issued quarantines', () => {
    const r = reconcile({
      engine: { positions: [], cash: 100, buyingPower: 1000, openOrders: [] },
      broker: { positions: [], cash: 100, buyingPower: 1000, openOrders: [{ id: 'X1' }] },
    });
    assert.equal(r.status, RECON.QUARANTINE);
    assert.ok(r.problems.some((p) => p.code === 'ORDER_UNKNOWN'));
  });

  test('small cash drift is tolerated as DRIFT, not quarantine', () => {
    const r = reconcile({
      engine: { positions: [], cash: 100.4, buyingPower: 1000, openOrders: [] },
      broker: { positions: [], cash: 100, buyingPower: 1000, openOrders: [] },
    }, { cashTolerance: 0.2 });
    assert.equal(r.status, RECON.DRIFT);
  });
});

describe('synthetic market is internally consistent', () => {
  test('realised vol tracks the configured level', () => {
    const bars = generatePath({ spot: 100, days: 600, seed: 'v', targetVol: 0.25, drift: 0.05, jumpsPerYear: 0 });
    const rv = stdev(logReturns(bars.map((b) => b.c))) * Math.sqrt(252);
    assert.ok(Math.abs(rv - 0.25) < 0.06, `realised ${rv} should be near 0.25`);
  });

  test('put IV rises as strikes fall (downside skew)', () => {
    const atm = surfaceIv({ moneyness: 1.0, dte: 30, atmIv: 0.20 });
    const otm = surfaceIv({ moneyness: 0.90, dte: 30, atmIv: 0.20 });
    const deep = surfaceIv({ moneyness: 0.80, dte: 30, atmIv: 0.20 });
    assert.ok(deep > otm && otm > atm, `skew must be monotone: ${atm} ${otm} ${deep}`);
  });

  test('skew steepens into shorter tenors', () => {
    const near = surfaceIv({ moneyness: 0.9, dte: 7, atmIv: 0.2 }) - surfaceIv({ moneyness: 1, dte: 7, atmIv: 0.2 });
    const far = surfaceIv({ moneyness: 0.9, dte: 45, atmIv: 0.2 }) - surfaceIv({ moneyness: 1, dte: 45, atmIv: 0.2 });
    assert.ok(near > far, `7d skew ${near} should exceed 45d skew ${far}`);
  });

  test('an unknown symbol produces an error, never a price', async () => {
    const p = new SyntheticProvider({ symbols: { SPY: { spot: 400 } } });
    const r = await p.quote('DOES_NOT_EXIST');
    assert.ok(r.error);
    assert.equal(r.value, undefined);
  });

  test('chains carry Greeks and a two-sided market', async () => {
    const p = new SyntheticProvider({ symbols: { SPY: { spot: 400, atmIv: 0.18 } } });
    const { value: chain } = await p.optionChain('SPY', { expirations: [30] });
    assert.ok(chain.contracts.length > 0);
    for (const c of chain.contracts) {
      assert.ok(c.ask >= c.bid, 'no crossed markets');
      assert.ok(Number.isFinite(c.delta) && Number.isFinite(c.iv));
    }
  });
});
