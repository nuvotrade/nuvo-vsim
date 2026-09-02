import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  armExistingLane1FromDashboard, reconcileLane1OpenFromBrokerLedger,
  resumeLane1PendingFill,
} from '../cloudflare/lane-1-runtime.js';
import { appendLane1V2BrokerEvents, lane1V2ProposalSeal,
  materializeLane1V2Unit } from '../src/lane/lane-1-spy-v2.js';
import { syntheticSnapshot } from './fixtures/lane-1-synthetic-state.js';

const hash = (digit = 'a') => digit.repeat(64);
function reconstructedCapture(sourceId) {
  return { schema: 'LANE_1_FILL_RAW_RESPONSE_V1', complete: true,
    captureId: sourceId, source: 'BROKER_LEDGER_RECONSTRUCTION',
    bodyKey: `owners/x/${sourceId}/original.encrypted.json`, originalSha256: hash('b'),
    receivedAt: '2026-09-01T13:35:04.100Z', brokerOrderId: '1007778879812',
    clientOrderId: 'CLIENT-SHORT-1', instruction: 'SELL_SHORT' };
}
function reconstructedFill(overrides = {}) {
  return { fillId: '129577264234', executionActivityId: '129577264234',
    transactionActivityId: '129577264235', brokerOrderId: '1007778879812',
    clientOrderId: 'CLIENT-SHORT-1', symbol: 'SPY', side: 'SELL_SHORT',
    quantityShares: 1, executionPriceUsdPerShare: 761.98, feeUsd: -0.02,
    brokerOccurredAt: '2026-09-01T13:35:04.000Z', acquiredAt: '2026-09-01T13:35:05.000Z',
    rawBrokerEvidenceSha256: hash('c'), accountHash: 'ACCOUNT-HASH',
    evidenceOrigin: 'BROKER_LEDGER_RECONSTRUCTION', captureEvidence: {
      order: reconstructedCapture('RECOVERY-ORDER'),
      transaction: reconstructedCapture('RECOVERY-TRANSACTION'),
    }, ...overrides };
}

function wireCapture(captureId, source, instruction, brokerOrderId, clientOrderId) {
  return { schema: 'LANE_1_FILL_RAW_RESPONSE_V1', complete: true, captureId, source,
    bodyKey: `owners/x/${captureId}/original.encrypted.json`, originalSha256: hash('f'),
    receivedAt: '2026-09-01T13:40:04.100Z', brokerOrderId, clientOrderId, instruction };
}

async function recoveryFixture() {
  const seal = await lane1V2ProposalSeal({ signal: 'SHORT', rawSignalSide: 'SELL_SHORT',
    tvBodyBindingSha256: hash(), positionSide: 'FLAT', now: Date.parse('2026-09-01T13:35:00.000Z'),
    uuid: (() => { let value = 0; return () => `00000000-0000-4000-8000-${String(++value).padStart(12, '0')}`; })() });
  // The live recovered row retains the original client order identity.
  seal.clientOrderId = 'CLIENT-SHORT-1';
  const state = { armed: false, stage: 'FAULT', positionSide: 'FLAT',
    open: { seal, brokerOrderId: '1007778879812', acceptedAt: '2026-09-01T13:35:03.000Z' },
    latestUnit: null, entryIdentity: null, pendingFill: null,
    fault: { faultCode: 'MISSING_FEE', brokerOrderId: '1007778879812' },
    updatedAt: '2026-09-01T13:35:05.000Z' };
  return { seal, state };
}

test('broker-ledger reconstruction reads broker first, creates a strict recovered entry, and never qualifies it', async () => {
  const fixture = await recoveryFixture();
  const calls = []; const receipts = []; const notices = [];
  let current = fixture.state;
  const brokerSnapshot = syntheticSnapshot('SHORT', Date.now());
  const client = {
    async lane1V21SendSnapshot() { calls.push('broker'); return brokerSnapshot; },
    async lane1V2RecoverableStoredFill(_ownerId, options) {
      calls.push(options.capture === false ? 'candidate' : 'reconstruct');
      return reconstructedFill();
    },
  };
  const coordinator = {
    async status() { calls.push('coordinator'); return current; },
    async recoverOpen(payload) {
      calls.push('transition');
      assert.equal(payload.evidenceOrigin, 'BROKER_LEDGER_RECONSTRUCTION');
      assert.equal(payload.principalConfirmation, 'RECONCILE_BROKER_LEDGER_OPEN');
      assert.equal(payload.identity.transactionActivityId, '129577264235');
      assert.equal(payload.unit.openingFeeCents, -2);
      current = { ...current, stage: 'OPEN_SHORT', positionSide: 'SHORT',
        latestUnit: payload.unit, fault: null, entryIdentity: {
          identity: payload.identity, evidenceOrigin: payload.evidenceOrigin,
          captureEvidence: payload.captureEvidence, receiptId: payload.receiptId } };
      return current;
    },
  };
  const dependencies = { client, coordinator,
    bundleStore: { async write() { calls.push('bundle'); return { objectPrefix: 'r2/recovered' }; } },
    receiptStore: { async write(receipt) { calls.push('receipt'); receipts.push(receipt);
      return { id: 'RECEIPT-1' }; } },
    notifier: { async send(notice) { calls.push('discord'); notices.push(notice); } },
  };
  const first = await reconcileLane1OpenFromBrokerLedger({ env: {}, ownerId: 'OWNER',
    principalConfirmation: 'RECONCILE_BROKER_LEDGER_OPEN', dependencies });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.disposition, 'BROKER_LEDGER_RECONSTRUCTION');
  assert.equal(first.body.qualifiedStage0Fill, false);
  assert.deepEqual(calls.slice(0, 2), ['broker', 'coordinator']);
  assert.ok(calls.indexOf('receipt') < calls.indexOf('transition'));
  assert.equal(receipts[0].qualifiedStage0Fill, false);
  assert.equal(receipts[0].evidenceOrigin, 'BROKER_LEDGER_RECONSTRUCTION');
  assert.equal(notices[0].evidenceOrigin, 'BROKER_LEDGER_RECONSTRUCTION');

  calls.length = 0;
  const second = await reconcileLane1OpenFromBrokerLedger({ env: {}, ownerId: 'OWNER',
    principalConfirmation: 'RECONCILE_BROKER_LEDGER_OPEN', dependencies });
  assert.equal(second.body.disposition, 'BROKER_LEDGER_RECONSTRUCTION · IDEMPOTENT_NO_OP');
  assert.deepEqual(calls, ['broker', 'coordinator', 'candidate']);
  assert.equal(receipts.length, 1);
});

test('broker failure makes no reconstruction or coordinator correction', async () => {
  let coordinatorReads = 0; let writes = 0;
  const result = await reconcileLane1OpenFromBrokerLedger({ env: {}, ownerId: 'OWNER',
    principalConfirmation: 'RECONCILE_BROKER_LEDGER_OPEN', dependencies: {
      client: { async lane1V21SendSnapshot() { throw new Error('SCHWAB_DOWN'); } },
      coordinator: { async status() { coordinatorReads += 1; }, async recoverOpen() { writes += 1; } },
    } });
  assert.equal(result.status, 503);
  assert.equal(result.body.state, 'UNKNOWN');
  assert.equal(result.body.faultCode, 'BROKER_UNREACHABLE');
  assert.equal(coordinatorReads, 0);
  assert.equal(writes, 0);
});

test('pending fee is durable and bounded; expiry becomes FILL_ECONOMICS_TIMEOUT', async () => {
  const base = { armed: false, stage: 'FILL_PENDING_FEE', positionSide: 'SHORT',
    pendingFill: { ownerId: 'OWNER', signal: 'EXIT', side: 'BUY_TO_COVER',
      brokerOrderId: 'ORDER-COVER', clientOrderId: 'CLIENT-COVER', accountHash: 'ACCOUNT-HASH',
      seal: { clientOrderId: 'CLIENT-COVER', tvBodyBindingSha256: hash() }, accepted: {},
      tvBodyBindingSha256: hash(), pendingReason: 'MISSING_FEE', startedAt: '2026-09-01T13:35:00.000Z',
      deadlineAt: '2026-09-01T13:37:00.000Z' } };
  let fault = null;
  const expired = await resumeLane1PendingFill({ env: {}, ownerId: 'OWNER',
    now: () => Date.parse('2026-09-01T13:37:00.001Z'), coordinator: {
      async status() { return base; }, async recordFault(value) { fault = value;
        return { stage: 'FAULT' }; },
    }, dependencies: {} });
  assert.equal(expired.faultCode, 'FILL_ECONOMICS_TIMEOUT');
  assert.equal(fault.faultCode, 'FILL_ECONOMICS_TIMEOUT');

  let rescheduled = null; let faulted = false;
  const pendingError = new Error('FILL_PENDING_FEE');
  pendingError.pendingFill = { attempt: 4, pendingReason: 'MISSING_FEE' };
  const stillPending = await resumeLane1PendingFill({ env: {}, ownerId: 'OWNER',
    now: () => Date.parse('2026-09-01T13:36:00.000Z'), coordinator: {
      async status() { return base; }, async recordPendingFill(value) { rescheduled = value;
        return { stage: 'FILL_PENDING_FEE' }; }, async recordFault() { faulted = true; },
    }, dependencies: { client: { async waitForLane1V2RecordedFill() { throw pendingError; } } } });
  assert.equal(stillPending.terminal, false);
  assert.equal(stillPending.status, 'FILL_PENDING_FEE');
  assert.equal(rescheduled.startedAt, base.pendingFill.startedAt);
  assert.equal(rescheduled.deadlineAt, base.pendingFill.deadlineAt);
  assert.equal(faulted, false);
});

test('a pending autonomous cover records real P&L and receipt before coordinator FLAT and Discord', async () => {
  const uuid = (() => { let value = 20; return () =>
    `00000000-0000-4000-8000-${String(++value).padStart(12, '0')}`; })();
  const openSeal = await lane1V2ProposalSeal({ signal: 'SHORT', rawSignalSide: 'SELL_SHORT',
    tvBodyBindingSha256: hash(), positionSide: 'FLAT', now: Date.parse('2026-09-01T13:35:00.000Z'), uuid });
  const openingFill = reconstructedFill();
  const bundles = [];
  const bundleStore = { async write(emission) { bundles.push(emission);
    return { objectPrefix: `r2/unit-${bundles.length}` }; } };
  const openingEvents = appendLane1V2BrokerEvents({ latestUnit: null }, openSeal,
    { brokerOrderId: openingFill.brokerOrderId, acceptedAt: '2026-09-01T13:35:03.000Z' },
    openingFill);
  const openingUnit = await materializeLane1V2Unit({ events: openingEvents, fill: openingFill,
    stop: null, bundleStore });
  assert.equal(openingUnit.state, 'OPEN_SHORT');
  assert.equal(openingUnit.positionSide, 'SHORT');
  assert.equal(openingUnit.openingFeeCents, -2);

  const exitSeal = await lane1V2ProposalSeal({ signal: 'EXIT', rawSignalSide: 'BUY_TO_COVER',
    tvBodyBindingSha256: hash('d'), positionSide: 'SHORT',
    now: Date.parse('2026-09-01T13:40:00.000Z'), uuid, prior: openSeal });
  const brokerOrderId = 'ORDER-COVER';
  const accepted = { brokerOrderId, acceptedAt: '2026-09-01T13:40:03.000Z',
    orderAcceptanceEvidence: wireCapture('WIRE-ACCEPTANCE-COVER',
      'SCHWAB_ORDER_ACCEPTANCE_RESPONSE', 'BUY_TO_COVER', brokerOrderId, exitSeal.clientOrderId) };
  const pending = { ownerId: 'OWNER', signal: 'EXIT', side: 'BUY_TO_COVER', brokerOrderId,
    clientOrderId: exitSeal.clientOrderId, accountHash: 'ACCOUNT-HASH', seal: exitSeal, accepted,
    tvBodyBindingSha256: hash('d'), pendingReason: 'MISSING_FEE',
    startedAt: '2026-09-01T13:40:03.000Z', deadlineAt: '2026-09-01T13:42:03.000Z' };
  const state = { armed: false, stage: 'FILL_PENDING_FEE', positionSide: 'SHORT',
    latestUnit: openingUnit, pendingFill: pending };
  const coverFill = { ...reconstructedFill(), fillId: 'EXECUTION-COVER',
    executionActivityId: 'EXECUTION-COVER', transactionActivityId: 'TRANSACTION-COVER',
    brokerOrderId, clientOrderId: exitSeal.clientOrderId, side: 'BUY_TO_COVER',
    executionPriceUsdPerShare: 760, feeUsd: -0.02,
    brokerOccurredAt: '2026-09-01T13:40:04.000Z', acquiredAt: '2026-09-01T13:40:05.000Z',
    evidenceOrigin: 'SCHWAB_WIRE_CAPTURE', captureEvidence: {
      order: wireCapture('WIRE-ORDER-COVER', 'SCHWAB_ORDER_RESPONSE',
        'BUY_TO_COVER', brokerOrderId, exitSeal.clientOrderId),
      transaction: wireCapture('WIRE-TRANSACTION-COVER', 'SCHWAB_TRANSACTION_RESPONSE',
        'BUY_TO_COVER', brokerOrderId, exitSeal.clientOrderId),
    } };
  const calls = []; const receipts = []; const notices = [];
  const result = await resumeLane1PendingFill({ env: {}, ownerId: 'OWNER',
    now: () => Date.parse('2026-09-01T13:40:06.000Z'), coordinator: {
      async status() { return state; }, async recordExit(payload) { calls.push('coordinator-flat');
        assert.equal(payload.unit.positionSide, 'FLAT');
        assert.equal(payload.unit.realizedPnlCents, 194);
        assert.equal(payload.unit.openingFeeCents, -2);
        assert.equal(payload.unit.closingFeeCents, -2);
        assert.equal(payload.evidenceOrigin, 'SCHWAB_WIRE_CAPTURE');
        return { stage: 'FLAT', positionSide: 'FLAT' }; },
    }, dependencies: {
      client: { async waitForLane1V2RecordedFill() { calls.push('broker-fill'); return coverFill; } },
      bundleStore,
      receiptStore: { async write(receipt) { calls.push('receipt'); receipts.push(receipt);
        return { id: 'RECEIPT-COVER' }; } },
      notifier: { async send(notice) { calls.push('discord'); notices.push(notice); } },
    } });
  assert.equal(result.status, 'FLAT');
  assert.equal(result.receiptId, 'RECEIPT-COVER');
  assert.equal(receipts[0].type, 'EXIT_FILLED');
  assert.equal(receipts[0].realizedPnlCents, 194);
  assert.equal(receipts[0].evidenceOrigin, 'SCHWAB_WIRE_CAPTURE');
  assert.equal(notices[0].type, 'EXITED');
  assert.equal(notices[0].netCents, 194);
  assert.deepEqual(calls, ['broker-fill', 'receipt', 'coordinator-flat', 'discord']);
});

test('arm-existing reads broker first and preserves SHORT with BUY_TO_COVER as the only allowed instruction', async () => {
  const calls = [];
  const snapshot = syntheticSnapshot('SHORT', Date.now());
  const result = await armExistingLane1FromDashboard({ env: {}, ownerId: 'OWNER',
    principalConfirmation: 'ARM_EXISTING_SHORT_1_SPY', dependencies: {
      client: { async lane1V21SendSnapshot() { calls.push('broker'); return snapshot; } },
      coordinator: { async principalArmExisting(value) { calls.push('coordinator');
        assert.equal(value.brokerSnapshot.positionSide, 'SHORT');
        assert.equal(value.principalConfirmation, 'ARM_EXISTING_SHORT_1_SPY');
        return { armed: true, stage: 'OPEN_SHORT', positionSide: 'SHORT',
          expiresAt: value.expiresAt }; } },
    } });
  assert.equal(result.status, 200);
  assert.equal(result.body.state, 'OPEN_SHORT');
  assert.equal(result.body.positionSide, 'SHORT');
  assert.equal(result.body.instructionAllowed, 'BUY_TO_COVER');
  assert.deepEqual(calls, ['broker', 'coordinator']);
});
