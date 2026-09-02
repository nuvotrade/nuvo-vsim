import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertLane1FillEvidence, assertLane1FillIdentity, lane1FillIdentity,
  lane1NextFillPollAt, LANE_1_FILL_IDENTITY_FIELDS, LANE_1_FILL_POLL_OFFSETS_MS,
  sameLane1FillIdentity,
} from '../src/lane/lane-1-fill-contract.js';

const hash = (digit = 'a') => digit.repeat(64);
const identity = (overrides = {}) => ({
  accountHash: 'ACCOUNT-HASH', brokerOrderId: 'ORDER-1', clientOrderId: 'CLIENT-1',
  executionActivityId: 'EXECUTION-1', instruction: 'SELL_SHORT',
  occurredAt: '2026-09-01T13:35:04.000Z', priceUsdPerShare: 761.98,
  quantityShares: 1, symbol: 'SPY', transactionActivityId: 'TRANSACTION-1',
  tvBodyBindingSha256: hash(), ...overrides,
});
const capture = (source, captureId, overrides = {}) => ({
  schema: 'LANE_1_FILL_RAW_RESPONSE_V1', complete: true, captureId,
  source, bodyKey: `owners/x/${captureId}/original.encrypted.json`,
  originalSha256: hash(captureId.at(-1) === '1' ? 'b' : captureId.at(-1) === '2' ? 'c' : 'd'),
  receivedAt: '2026-09-01T13:35:04.100Z', clientOrderId: 'CLIENT-1',
  instruction: 'SELL_SHORT', brokerOrderId: 'ORDER-1', ...overrides,
});

test('fill identity is exact on all eleven broker and binding fields', () => {
  const value = lane1FillIdentity({ fill: {
    accountHash: 'ACCOUNT-HASH', brokerOrderId: 'ORDER-1', clientOrderId: 'CLIENT-1',
    executionActivityId: 'EXECUTION-1', side: 'SELL_SHORT',
    brokerOccurredAt: '2026-09-01T13:35:04.000Z', executionPriceUsdPerShare: 761.98,
    quantityShares: 1, symbol: 'SPY', transactionActivityId: 'TRANSACTION-1',
  }, tvBodyBindingSha256: hash() });
  assert.deepEqual(Object.keys(value).sort(), [...LANE_1_FILL_IDENTITY_FIELDS].sort());
  assert.deepEqual(value, identity());
  assert.throws(() => assertLane1FillIdentity({ ...value, extra: true }), /SHAPE_INVALID/u);
  for (const field of LANE_1_FILL_IDENTITY_FIELDS) {
    const changed = { ...value, [field]: field === 'quantityShares' ? 2
      : field === 'priceUsdPerShare' ? 0 : null };
    assert.throws(() => assertLane1FillIdentity(changed));
  }
});

test('wire and reconstructed fill evidence require complete bound immutable captures', () => {
  const value = identity();
  const wire = {
    acceptance: capture('SCHWAB_ORDER_ACCEPTANCE_RESPONSE', 'CAPTURE-1', { brokerOrderId: null }),
    order: capture('SCHWAB_ORDER_RESPONSE', 'CAPTURE-2'),
    transaction: capture('SCHWAB_TRANSACTION_RESPONSE', 'CAPTURE-3'),
  };
  assert.equal(assertLane1FillEvidence(wire, 'SCHWAB_WIRE_CAPTURE', value), wire);
  const recovered = {
    order: capture('BROKER_LEDGER_RECONSTRUCTION', 'RECOVERY-2'),
    transaction: capture('BROKER_LEDGER_RECONSTRUCTION', 'RECOVERY-3'),
  };
  assert.equal(assertLane1FillEvidence(recovered, 'BROKER_LEDGER_RECONSTRUCTION', value), recovered);
  assert.throws(() => assertLane1FillEvidence({ ...wire,
    transaction: { ...wire.transaction, complete: false } }, 'SCHWAB_WIRE_CAPTURE', value),
  /CAPTURE_INCOMPLETE/u);
  assert.throws(() => assertLane1FillEvidence({ ...wire,
    transaction: { ...wire.transaction, captureId: wire.order.captureId } },
  'SCHWAB_WIRE_CAPTURE', value), /CAPTURE_IDENTITY_DUPLICATE/u);
  assert.throws(() => assertLane1FillEvidence({ ...wire,
    order: { ...wire.order, brokerOrderId: 'OTHER' } }, 'SCHWAB_WIRE_CAPTURE', value),
  /CAPTURE_ORDER_MISMATCH/u);
  assert.throws(() => assertLane1FillEvidence(recovered, 'SCHWAB_WIRE_CAPTURE', value),
  /CAPTURE_INCOMPLETE/u);
});

test('recovery idempotency compares every identity field and never accepts a differing fill', () => {
  const left = identity();
  assert.equal(sameLane1FillIdentity(left, { ...left }), true);
  for (const field of LANE_1_FILL_IDENTITY_FIELDS) {
    const right = { ...left, [field]: field === 'quantityShares' ? 2
      : field === 'priceUsdPerShare' ? 762.01 : `${left[field]}-DIFFERENT` };
    if (field === 'tvBodyBindingSha256') right[field] = hash('f');
    if (field === 'occurredAt') right[field] = '2026-09-01T13:35:05.000Z';
    if (field === 'instruction') right[field] = 'BUY';
    if (['quantityShares', 'symbol'].includes(field)) {
      assert.throws(() => sameLane1FillIdentity(left, right), /IDENTITY_VALUE_INVALID/u, field);
    } else assert.equal(sameLane1FillIdentity(left, right), false, field);
  }
});

test('fill economics polling uses the exact bounded 120-second schedule', () => {
  const start = Date.parse('2026-09-01T13:35:00.000Z');
  const startedAt = new Date(start).toISOString();
  const deadlineAt = new Date(start + 120_000).toISOString();
  assert.deepEqual(LANE_1_FILL_POLL_OFFSETS_MS,
    [0, 2, 5, 10, 20, 40, 60, 90, 120].map((value) => value * 1_000));
  assert.equal(lane1NextFillPollAt({ startedAt, deadlineAt, now: start - 1 }), start);
  assert.equal(lane1NextFillPollAt({ startedAt, deadlineAt, now: start }), start + 2_000);
  assert.equal(lane1NextFillPollAt({ startedAt, deadlineAt, now: start + 60_000 }), start + 90_000);
  assert.equal(lane1NextFillPollAt({ startedAt, deadlineAt, now: start + 119_999 }), start + 120_000);
  assert.equal(lane1NextFillPollAt({ startedAt, deadlineAt, now: start + 500_000 }), start + 120_000);
  assert.throws(() => lane1NextFillPollAt({ startedAt,
    deadlineAt: new Date(start + 121_000).toISOString(), now: start }), /POLL_WINDOW_INVALID/u);
});
