import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSchwabFillEvidence } from '../src/economic/schwab-fill-identity.js';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CBRS_RAW_PATH = join(REPOSITORY_ROOT, 'artifacts', 'SCHWAB_FILL_IDENTITY',
  'CBRS_2026-08-28_0640_PDT.raw.redacted.json');
const CBRS_TRANSACTION_PATH = join(REPOSITORY_ROOT, 'artifacts', 'SCHWAB_FILL_IDENTITY',
  'CBRS_2026-08-28_0640_PDT.transaction.raw.redacted.json');

function orderWith(activity, orderId = '1007726846305') {
  return { orderId, orderActivityCollection: [activity] };
}

test('06:40 CBRS evidence uses Schwab activityId and refuses the absent fee', () => {
  const activity = JSON.parse(readFileSync(CBRS_RAW_PATH, 'utf8'));
  const result = resolveSchwabFillEvidence(orderWith(activity));
  assert.equal(result.ok, false);
  assert.equal(result.faultCode, 'MISSING_FEE');
  assert.deepEqual(result.detail, {
    fillId: '129165944988',
    identitySource: 'ACTIVITY_ID',
    activityIndex: 0,
    legIndex: 0,
  });
  assert.equal(activity.executionLegs[0].quantity, 5);
  assert.equal(activity.executionLegs[0].price, 0.56);
});

test('commission and fee evidence is summed from the matched raw Schwab transaction array', () => {
  const activity = JSON.parse(readFileSync(CBRS_RAW_PATH, 'utf8'));
  const transaction = JSON.parse(readFileSync(CBRS_TRANSACTION_PATH, 'utf8'));
  assert.equal(transaction.accountNumber, '[REDACTED]');
  const order = orderWith(activity);
  order.transactionActivityCollection = [transaction];
  const result = resolveSchwabFillEvidence(order);
  assert.equal(result.ok, true);
  assert.deepEqual(result.fills[0], {
    activityIndex: 0,
    legIndex: 0,
    fillId: '129165944988',
    identitySource: 'ACTIVITY_ID',
    feeUsd: -3.35,
    feeSource: 'SCHWAB_COMMISSION_FEE_ARRAY',
    quantity: 5,
    price: 0.56,
  });
});

test('real-field identity precedence is executionId, activityId, orderLegExecutionId, canonical key', () => {
  const activity = {
    activityType: 'EXECUTION',
    activityId: 'ACT-1',
    executionLegs: [{
      executionId: 'EXEC-1', orderLegExecutionId: 'LEG-EXEC-1',
      quantity: 1, price: 550, fee: 0, time: '2026-08-28T14:00:00Z',
    }],
  };
  assert.equal(resolveSchwabFillEvidence(orderWith(activity, 'ORDER-1')).fills[0].fillId,
    'EXEC-1');
  delete activity.executionLegs[0].executionId;
  assert.equal(resolveSchwabFillEvidence(orderWith(activity, 'ORDER-1')).fills[0].fillId,
    'ACT-1');
  delete activity.activityId;
  assert.equal(resolveSchwabFillEvidence(orderWith(activity, 'ORDER-1')).fills[0].fillId,
    'LEG-EXEC-1');
  delete activity.executionLegs[0].orderLegExecutionId;
  assert.equal(resolveSchwabFillEvidence(orderWith(activity, 'ORDER-1')).fills[0].fillId,
    'SCHWAB_FILL_CANONICAL|orderId=ORDER-1|executedAt=2026-08-28T14%3A00%3A00Z|qty=1');
});

test('non-unique identity and absent quantity or price fail closed', () => {
  const duplicate = {
    activityType: 'EXECUTION', activityId: 'ACT-DUPLICATE',
    executionLegs: [
      { quantity: 1, price: 1, fee: 0, time: '2026-08-28T14:00:00Z' },
      { quantity: 1, price: 1, fee: 0, time: '2026-08-28T14:00:00Z' },
    ],
  };
  assert.equal(resolveSchwabFillEvidence(orderWith(duplicate, 'ORDER-1')).faultCode,
    'MISSING_FILL_ID');

  const one = structuredClone(duplicate);
  one.executionLegs.length = 1;
  one.executionLegs[0].executionId = 'EXEC-ONE';
  delete one.executionLegs[0].quantity;
  assert.equal(resolveSchwabFillEvidence(orderWith(one, 'ORDER-1')).faultCode,
    'MISSING_FILL_QUANTITY');
  one.executionLegs[0].quantity = 1;
  delete one.executionLegs[0].price;
  assert.equal(resolveSchwabFillEvidence(orderWith(one, 'ORDER-1')).faultCode,
    'MISSING_FILL_PRICE');
});

test('normalized fixture fillId and fee remain byte-for-byte identifiers', () => {
  const order = orderWith({
    activityType: 'EXECUTION', activityId: 'ACTIVITY-FIXTURE',
    executionLegs: [{
      fillId: 'FILL-FIXTURE-E3-000001', executionId: 'EXEC-FIXTURE-E3-000001',
      quantity: 1, price: 1.23, fee: -0.65, time: '2026-08-28T14:00:00Z',
    }],
  }, 'ORDER-FIXTURE-E3-000001');
  const result = resolveSchwabFillEvidence(order);
  assert.equal(result.ok, true);
  assert.equal(result.fills[0].fillId, 'FILL-FIXTURE-E3-000001');
  assert.equal(result.fills[0].identitySource, 'NORMALIZED_FILL_ID');
  assert.equal(result.fills[0].feeUsd, -0.65);
});
