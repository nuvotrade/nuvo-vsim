import assert from 'node:assert/strict';
import { syntheticSnapshot, syntheticPositionPacket, syntheticClaim,
  syntheticOrder } from '../fixtures/lane-1-synthetic-state.js';

const at = Date.parse('2026-08-31T19:00:00Z');
const exact = (message) => ({ message });
export const stateGuardProbes = [
  ['missing positions never means FLAT', (g) => {
    for (const packet of [undefined, null, {}, { securitiesAccount: {} },
      { securitiesAccount: { positions: null } }, { securitiesAccount: { positions: {} } }]) {
      assert.throws(() => g.readLane1SpyPosition(packet), exact('LANE_1_POSITION_STATE_DRIFT:BROKER_POSITION_UNKNOWN:positions'));
    }
  }],
  ['missing symbol cannot hide a SPY position', (g) => {
    const packet = syntheticPositionPacket('LONG');
    delete packet.securitiesAccount.positions[0].instrument.symbol;
    assert.throws(() => g.readLane1SpyPosition(packet), exact('LANE_1_POSITION_STATE_DRIFT:BROKER_POSITION_UNKNOWN:symbol'));
  }],
  ['missing and nonnumeric long/short quantities refuse without coercion', (g) => {
    for (const field of ['longQuantity', 'shortQuantity']) {
      for (const value of [undefined, null, '1', '0', false, NaN, Infinity, -1]) {
        const packet = syntheticPositionPacket('LONG');
        assert.ok(Object.hasOwn(packet.securitiesAccount.positions[0], field));
        packet.securitiesAccount.positions[0][field] = value;
        assert.throws(() => g.readLane1SpyPosition(packet),
          exact(`LANE_1_POSITION_STATE_DRIFT:BROKER_POSITION_UNKNOWN:${field}`));
      }
    }
  }],
  ['gross and fractional exposure cannot net to an allowed position', (g) => {
    for (const [longQuantity, shortQuantity] of [[2, 1], [1, 1], [0.5, 0.5], [0, 2], [2, 0]]) {
      const packet = syntheticPositionPacket('LONG');
      Object.assign(packet.securitiesAccount.positions[0], { longQuantity, shortQuantity });
      assert.throws(() => g.readLane1SpyPosition(packet), exact('LANE_1_POSITION_LIMIT_FAULT'));
    }
  }],
  ['known coordinator/broker disagreement refuses', (g) => {
    assert.throws(() => g.assertLane1PositionAgreement('LONG', syntheticSnapshot('FLAT', at)),
      exact('LANE_1_POSITION_STATE_DRIFT:COORDINATOR_BROKER_DISAGREEMENT'));
  }],
  ['unknown coordinator or internally inconsistent broker projection refuses', (g) => {
    for (const side of [undefined, null, 'UNKNOWN', '', 0]) {
      assert.throws(() => g.assertLane1PositionAgreement(side, syntheticSnapshot('FLAT', at)),
        exact('LANE_1_POSITION_STATE_DRIFT:COORDINATOR_POSITION_UNKNOWN'));
    }
    for (const field of ['longQuantity', 'shortQuantity', 'netQuantity']) {
      const position = syntheticSnapshot('LONG', at);
      assert.ok(Object.hasOwn(position, field)); delete position[field];
      assert.throws(() => g.assertLane1PositionAgreement('LONG', position),
        exact('LANE_1_POSITION_STATE_DRIFT:BROKER_POSITION_UNKNOWN:quantities'));
    }
  }],
  ['instruction quantity is numeric one only', (g) => {
    for (const quantity of [undefined, null, '1', 0, 2, -1, NaN]) {
      assert.throws(() => g.assertLane1InstructionState({ instruction: 'BUY', positionSide: 'FLAT', quantity }),
        exact('LANE_1_QUANTITY_MUST_BE_ONE'));
    }
  }],
  ['aliases and unknown instructions are not accepted by the internal state machine', (g) => {
    for (const instruction of ['LONG', 'SHORT', 'EXIT', 'buy', '__proto__', undefined]) {
      assert.throws(() => g.assertLane1InstructionState({ instruction, positionSide: 'FLAT', quantity: 1 }),
        exact('LANE_1_INSTRUCTION_UNKNOWN'));
    }
  }],
  ['working and pending SPY orders block', (g) => {
    for (const status of ['WORKING', 'PENDING_CANCEL', 'PENDING_REPLACE', 'AWAITING_PARENT_ORDER',
      'AWAITING_CONDITION', 'QUEUED', 'PARTIALLY_FILLED', 'ACCEPTED']) {
      assert.throws(() => g.lane1OrderState([syntheticOrder(status)]), exact('LANE_1_WORKING_ORDER_PRESENT'));
    }
  }],
  ['unknown working-order result/status/leg refuses', (g) => {
    for (const orders of [undefined, null, {}, [syntheticOrder('ALIEN_STATUS')],
      [{ ...syntheticOrder(), orderLegCollection: null }],
      [{ ...syntheticOrder(), orderLegCollection: [{ instrument: {} }] }]]) {
      assert.throws(() => g.lane1OrderState(orders), exact('LANE_1_WORKING_ORDER_STATE_UNKNOWN'));
    }
  }],
  ['SPY in a second leg or child of a terminal parent cannot be skipped', (g) => {
    const parent = syntheticOrder('FILLED', 'QQQ');
    parent.childOrderStrategies = [syntheticOrder('WORKING')];
    assert.throws(() => g.lane1OrderState([parent]), exact('LANE_1_WORKING_ORDER_PRESENT'));
    const mixed = syntheticOrder('WORKING', 'QQQ');
    mixed.orderLegCollection.push(...syntheticOrder().orderLegCollection);
    assert.throws(() => g.lane1OrderState([mixed]), exact('LANE_1_WORKING_ORDER_PRESENT'));
  }],
  ['capped order result is not proof of no working orders', (g) => {
    assert.throws(() => g.lane1OrderState(Array.from({ length: 3000 }, () => syntheticOrder('FILLED'))),
      exact('LANE_1_ORDER_READ_LIMIT_REACHED'));
  }],
  ['final account or position change refuses', (g) => {
    const before = syntheticSnapshot('FLAT', at);
    assert.throws(() => g.assertLane1SnapshotUnchanged(before, { ...before, accountHash: 'OTHER' }, at),
      exact('LANE_1_POSITION_STATE_DRIFT:ACCOUNT_CHANGED'));
    assert.throws(() => g.assertLane1SnapshotUnchanged(before, syntheticSnapshot('LONG', at), at),
      exact('LANE_1_POSITION_STATE_DRIFT:PRE_DISPATCH_POSITION_CHANGED'));
  }],
  ['changed terminal order history or query window refuses even while flat', (g) => {
    const before = syntheticSnapshot('FLAT', at);
    for (const after of [{ ...before, orderStateSha256: 'a'.repeat(64) },
      { ...before, ordersFrom: new Date(at - 86_400_000).toISOString() }]) {
      assert.throws(() => g.assertLane1SnapshotUnchanged(before, after, at),
        exact('LANE_1_PRE_DISPATCH_ORDER_STATE_CHANGED'));
    }
  }],
  ['slow future or invalid final reads refuse', (g) => {
    const before = syntheticSnapshot('FLAT', at);
    for (const now of [at + 5001, at - 1, NaN]) {
      assert.throws(() => g.assertLane1SnapshotUnchanged(before, before, now),
        exact('LANE_1_PRE_DISPATCH_READ_STALE'));
    }
  }],
  ['final DISARM wins over an earlier armed snapshot', (g) => {
    const state = { ...syntheticClaim('BUY', 'CLIENT-1', at), armed: false };
    assert.throws(() => g.assertLane1DispatchCoordinator(state,
      { instruction: 'BUY', clientOrderId: 'CLIENT-1', positionSide: 'FLAT' }, at), exact('LANE_1_DISARMED'));
  }],
  ['expired or missing final ARM window refuses', (g) => {
    for (const expiresAt of [undefined, null, new Date(at).toISOString()]) {
      const state = { ...syntheticClaim('BUY', 'CLIENT-1', at), expiresAt };
      assert.throws(() => g.assertLane1DispatchCoordinator(state,
        { instruction: 'BUY', clientOrderId: 'CLIENT-1', positionSide: 'FLAT' }, at),
        exact('LANE_1_ARM_WINDOW_EXPIRED'));
    }
  }],
  ['final coordinator position drift refuses', (g) => {
    const state = { ...syntheticClaim('BUY', 'CLIENT-1', at), positionSide: 'LONG' };
    assert.throws(() => g.assertLane1DispatchCoordinator(state,
      { instruction: 'BUY', clientOrderId: 'CLIENT-1', positionSide: 'FLAT' }, at),
      exact('LANE_1_POSITION_STATE_DRIFT:PRE_DISPATCH_COORDINATOR_CHANGED'));
  }],
  ['changed claim stage identity instruction or accepted order refuses', (g) => {
    const state = syntheticClaim('BUY', 'CLIENT-1', at);
    for (const changed of [{ ...state, stage: 'FLAT' },
      { ...state, open: { seal: { ...state.open.seal, clientOrderId: 'OTHER' } } },
      { ...state, open: { seal: { ...state.open.seal, brokerInstruction: 'SELL_SHORT' } } },
      { ...state, open: { ...state.open, brokerOrderId: 'ALREADY-SENT' } }]) {
      assert.throws(() => g.assertLane1DispatchCoordinator(changed,
        { instruction: 'BUY', clientOrderId: 'CLIENT-1', positionSide: 'FLAT' }, at),
        exact('LANE_1_DISPATCH_CLAIM_CHANGED'));
    }
  }],
];

// Enumerate every cell independently of the production transition table.
const expected = {
  FLAT: { BUY: 'LONG', SELL_SHORT: 'SHORT', SELL: 'LANE_1_SELL_REQUIRES_LONG', BUY_TO_COVER: 'LANE_1_BUY_TO_COVER_REQUIRES_SHORT' },
  LONG: { SELL: 'FLAT', BUY: 'LANE_1_BUY_REQUIRES_FLAT', SELL_SHORT: 'LANE_1_SELL_SHORT_REQUIRES_FLAT', BUY_TO_COVER: 'LANE_1_BUY_TO_COVER_REQUIRES_SHORT' },
  SHORT: { BUY_TO_COVER: 'FLAT', BUY: 'LANE_1_BUY_REQUIRES_FLAT', SELL: 'LANE_1_SELL_REQUIRES_LONG', SELL_SHORT: 'LANE_1_SELL_SHORT_REQUIRES_FLAT' },
  UNKNOWN: Object.fromEntries(['BUY', 'SELL', 'SELL_SHORT', 'BUY_TO_COVER'].map((instruction) => [instruction, 'LANE_1_POSITION_STATE_DRIFT:POSITION_UNKNOWN'])),
};
for (const [positionSide, instructions] of Object.entries(expected)) {
  for (const [instruction, result] of Object.entries(instructions)) {
    stateGuardProbes.push([`${positionSide} + ${instruction} => ${result}`, (g) => {
      const input = { positionSide, instruction, quantity: 1 };
      if (result.startsWith('LANE_1_')) assert.throws(() => g.assertLane1InstructionState(input), exact(result));
      else assert.equal(g.assertLane1InstructionState(input), result);
    }]);
  }
}
