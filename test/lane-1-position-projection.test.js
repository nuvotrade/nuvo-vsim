import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLane1PositionProjection,
  Lane1PositionRefreshGate } from '../src/lane/lane-1-position-projection.js';

const coordinator = (positionSide = 'FLAT', stage = positionSide === 'FLAT' ? 'FLAT' : `OPEN_${positionSide}`) => ({
  positionSide, stage, armed: false, updatedAt: '2026-09-01T13:35:10.000Z',
});
const broker = (positionSide = 'FLAT') => ({ positionSide, acquiredAt: '2026-09-01T13:35:11.000Z',
  accountHash: 'ACCOUNT-HASH', workingOrderCount: 0 });

test('shared position projection reports agreement only when coordinator and broker agree', () => {
  for (const side of ['FLAT', 'LONG', 'SHORT']) {
    const result = buildLane1PositionProjection({ coordinatorState: coordinator(side),
      brokerSnapshot: broker(side), brokerRead: { ok: true } });
    assert.equal(result.status, 'AGREE');
    assert.equal(result.positionSide, side);
    assert.equal(result.coordinator.positionSide, side);
    assert.equal(result.broker.positionSide, side);
  }
});

test('broker SHORT against coordinator FLAT is prominent POSITION_DRIFT with both timestamps', () => {
  const result = buildLane1PositionProjection({ coordinatorState: coordinator('FLAT'),
    brokerSnapshot: broker('SHORT'), brokerRead: { ok: true,
      attemptedAt: '2026-09-01T13:35:11.000Z' } });
  assert.equal(result.status, 'POSITION_DRIFT');
  assert.equal(result.positionSide, 'UNKNOWN');
  assert.equal(result.coordinator.positionSide, 'FLAT');
  assert.equal(result.coordinator.updatedAt, '2026-09-01T13:35:10.000Z');
  assert.equal(result.broker.positionSide, 'SHORT');
  assert.equal(result.broker.acquiredAt, '2026-09-01T13:35:11.000Z');
});

test('a coordinator fault does not fabricate POSITION_DRIFT when both positions agree', () => {
  const result = buildLane1PositionProjection({ coordinatorState: coordinator('SHORT', 'FAULT'),
    brokerSnapshot: broker('SHORT'), brokerRead: { ok: true } });
  assert.equal(result.status, 'AGREE');
  assert.equal(result.positionSide, 'SHORT');
  assert.equal(result.coordinator.stage, 'FAULT');
});

test('broker failure labels coordinator belief unverified and coordinator FAULT never renders FLAT', () => {
  const unverified = buildLane1PositionProjection({ coordinatorState: coordinator('SHORT'),
    brokerSnapshot: broker('SHORT'), brokerRead: { ok: false, error: 'BROKER_UNREACHABLE',
      attemptedAt: '2026-09-01T13:36:00.000Z' } });
  assert.equal(unverified.status, 'UNVERIFIED');
  assert.equal(unverified.positionSide, 'SHORT');
  assert.equal(unverified.brokerRead.error, 'BROKER_UNREACHABLE');
  const fault = buildLane1PositionProjection({ coordinatorState: coordinator('FLAT', 'FAULT'),
    brokerSnapshot: null, brokerRead: { ok: false, error: 'BROKER_UNREACHABLE' } });
  assert.equal(fault.status, 'UNVERIFIED');
  assert.equal(fault.positionSide, 'UNKNOWN');
  assert.notEqual(fault.positionSide, 'FLAT');
});

test('a fresh broker LONG never renders the stale coordinator FLAT claim', () => {
  const result = buildLane1PositionProjection({ coordinatorState: coordinator('FLAT', 'FAULT'),
    brokerSnapshot: broker('LONG'), brokerRead: { ok: true } });
  assert.equal(result.status, 'POSITION_DRIFT');
  assert.equal(result.positionSide, 'UNKNOWN');
  assert.equal(result.coordinator.positionSide, 'FLAT');
  assert.equal(result.broker.positionSide, 'LONG');
});

test('ten simultaneous refreshes make one broker call and the gate releases after failure', async () => {
  const gate = new Lane1PositionRefreshGate();
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const results = Array.from({ length: 10 }, () => gate.run(async () => {
    calls += 1; await pending; return 'fresh';
  }));
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await Promise.all(results), Array(10).fill('fresh'));

  await assert.rejects(() => gate.run(async () => { calls += 1; throw new Error('SCHWAB_DOWN'); }),
    /SCHWAB_DOWN/u);
  assert.equal(await gate.run(async () => { calls += 1; return 'recovered'; }), 'recovered');
  assert.equal(calls, 3);
});
