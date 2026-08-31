import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as guards from '../src/lane/lane-1-position-guards.js';
import { stateGuardProbes } from './helpers/lane-1-state-probes.js';
import { syntheticSnapshot, syntheticPositionPacket, syntheticOrder,
  syntheticClaim } from './fixtures/lane-1-synthetic-state.js';

for (const [name, probe] of stateGuardProbes) test(`state guard: ${name}`, () => probe(guards));

test('state guard positives discriminate real FLAT/LONG/SHORT numeric projections', () => {
  for (const side of ['FLAT', 'LONG', 'SHORT']) {
    const actual = guards.readLane1SpyPosition(syntheticPositionPacket(side));
    assert.deepEqual(actual, { symbol: 'SPY', positionSide: side,
      longQuantity: side === 'LONG' ? 1 : 0, shortQuantity: side === 'SHORT' ? 1 : 0,
      netQuantity: side === 'LONG' ? 1 : side === 'SHORT' ? -1 : 0 });
    assert.doesNotThrow(() => guards.assertLane1PositionAgreement(side, actual));
  }
});

test('state guard positives allow unchanged fresh snapshots and exact four synthetic claims', () => {
  const at = Date.now(); const before = syntheticSnapshot('FLAT', at);
  assert.doesNotThrow(() => guards.assertLane1SnapshotUnchanged(before, structuredClone(before), at));
  for (const instruction of ['BUY', 'SELL', 'SELL_SHORT', 'BUY_TO_COVER']) {
    const state = syntheticClaim(instruction, 'CLIENT-1', at);
    assert.doesNotThrow(() => guards.assertLane1DispatchCoordinator(state,
      { instruction, clientOrderId: 'CLIENT-1', positionSide: state.positionSide }, at));
  }
});

test('terminal SPY identities are stable under response reordering; unrelated orders do not block', () => {
  const a = syntheticOrder('FILLED', 'SPY', 'A');
  const b = syntheticOrder('CANCELED', 'SPY', 'B');
  assert.deepEqual(guards.lane1OrderState([b, a, syntheticOrder('WORKING', 'QQQ')]),
    [{ orderId: 'A', status: 'FILLED' }, { orderId: 'B', status: 'CANCELED' }]);
  assert.deepEqual(guards.lane1OrderState([a, b]), guards.lane1OrderState([b, a]));
  assert.deepEqual(guards.lane1OrderState([]), []);
});
