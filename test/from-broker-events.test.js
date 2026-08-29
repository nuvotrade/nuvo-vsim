import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitResolvedUnitBundle } from '../src/economic/emit-resolved-unit-bundle.js';
import { foldResolvedEpisode } from '../src/economic/fold-resolved-unit.js';
import { fromBrokerEvents } from '../src/economic/from-broker-events.js';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EPISODE_ID = 'EP-FIXTURE-E3-000001';
const FIRST_UNIT_ID = 'RU-FIXTURE-E3-000001';
const CALL_UNIT_ID = 'RU-FIXTURE-E3-CC-000002';
const LOT_IDS = Object.freeze(['LOT-FIXTURE-SPY-000001', 'LOT-FIXTURE-SPY-000002']);

function rawEventStream() {
  const events = [
    {
      eventType: 'UNIT_OPENED', economicEpisodeId: EPISODE_ID, resolvedUnitId: FIRST_UNIT_ID,
      strategy: 'CASH_SECURED_PUT', accountId: 'ACCT-FIXTURE-CASH-0001', symbol: 'SPY',
      lifecycleId: 'LC-FIXTURE-E3-000001', positionId: 'POS-FIXTURE-E3-000001',
      terminalEventId: 'TERM-FIXTURE-E3-FINAL-000001', pnlRecordId: 'PNL-FIXTURE-E3-000001',
    },
    {
      eventType: 'DECISION_SEALED', economicEpisodeId: EPISODE_ID, resolvedUnitId: FIRST_UNIT_ID,
      decisionId: 'DEC-FIXTURE-E3-000001', decisionAt: '2026-09-01T14:29:55.000Z',
      sealedAt: '2026-09-01T14:29:56.000Z',
    },
    {
      eventType: 'PROPOSAL_SEALED', economicEpisodeId: EPISODE_ID, resolvedUnitId: FIRST_UNIT_ID,
      proposalId: 'PROP-FIXTURE-E3-000001', proposalHash: '1'.repeat(64),
      positionContractId: 'PC-FIXTURE-SPY-20260918-P50', positionContractHash: '2'.repeat(64),
      sealedAt: '2026-09-01T14:29:58.000Z',
      contract: {
        contractMultiplierShares: 100, expirationDate: '2026-09-18',
        occSymbol: 'SPY260918P00050000', openingSide: 'SELL_TO_OPEN',
        quantityContracts: 3, right: 'PUT', strikeUsdPerShare: 50, symbol: 'SPY',
      },
      orderInstruction: { duration: 'DAY', limitUsdPerShare: 1.1, type: 'LIMIT' },
    },
    {
      eventType: 'ORDER_SUBMITTED', resolvedUnitId: FIRST_UNIT_ID,
      authorizationRecordId: 'AUTH-FIXTURE-HUMAN-000001',
      brokerAdapterVersion: 'FIXTURE_BROKER_ADAPTER_V1',
      brokerOrderId: 'BOID-FIXTURE-E3-900001', clientOrderId: 'COID-FIXTURE-E3-000001',
      canonicalRequestSha256: '5'.repeat(64), submittedAt: '2026-09-01T14:30:00.000Z',
    },
    {
      eventType: 'BROKER_FILL', resolvedUnitId: FIRST_UNIT_ID,
      brokerEventId: 'BEVT-FIXTURE-FILL-000002', fillId: 'FILL-FIXTURE-E3-000002',
      brokerExecutionId: 'EXEC-FIXTURE-E3-700002', brokerOrderId: 'BOID-FIXTURE-E3-900001',
      clientOrderId: 'COID-FIXTURE-E3-000001', brokerAdapterVersion: 'FIXTURE_BROKER_ADAPTER_V1',
      brokerOccurredAt: '2026-09-01T14:30:07.000Z', acquiredAt: '2026-09-01T14:30:08.000Z',
      quantityContracts: 2, executionPriceUsdPerShare: 1.15, feeUsd: -1.3,
      premiumCashEntryId: 'CASH-FIXTURE-PREMIUM-000002',
      feeCashEntryId: 'CASH-FIXTURE-FILL-FEE-000002',
      canonicalDeduplicationSha256: '6'.repeat(63) + '2',
      rawBrokerEvidenceSha256: '7'.repeat(63) + '2',
    },
    {
      eventType: 'BROKER_ACKNOWLEDGEMENT', resolvedUnitId: FIRST_UNIT_ID,
      brokerEventId: 'BEVT-FIXTURE-ACK-000001', brokerOrderId: 'BOID-FIXTURE-E3-900001',
      clientOrderId: 'COID-FIXTURE-E3-000001', acknowledgedQuantityContracts: 3,
      brokerOccurredAt: '2026-09-01T14:30:04.000Z', acquiredAt: '2026-09-01T14:30:09.000Z',
    },
    {
      eventType: 'BROKER_FILL', resolvedUnitId: FIRST_UNIT_ID, redelivery: true,
      brokerEventId: 'BEVT-FIXTURE-FILL-000002', fillId: 'FILL-FIXTURE-E3-000002',
      brokerExecutionId: 'EXEC-FIXTURE-E3-700002', brokerOrderId: 'BOID-FIXTURE-E3-900001',
      clientOrderId: 'COID-FIXTURE-E3-000001', brokerAdapterVersion: 'FIXTURE_BROKER_ADAPTER_V1',
      brokerOccurredAt: '2026-09-01T14:30:07.000Z', acquiredAt: '2026-09-01T14:30:08.000Z',
      quantityContracts: 2, executionPriceUsdPerShare: 1.15, feeUsd: -1.3,
      premiumCashEntryId: 'CASH-FIXTURE-PREMIUM-000002',
      feeCashEntryId: 'CASH-FIXTURE-FILL-FEE-000002',
      canonicalDeduplicationSha256: '6'.repeat(63) + '2',
      rawBrokerEvidenceSha256: '7'.repeat(63) + '2',
    },
    {
      eventType: 'BROKER_FILL', resolvedUnitId: FIRST_UNIT_ID,
      brokerEventId: 'BEVT-FIXTURE-FILL-000001', fillId: 'FILL-FIXTURE-E3-000001',
      brokerExecutionId: 'EXEC-FIXTURE-E3-700001', brokerOrderId: 'BOID-FIXTURE-E3-900001',
      clientOrderId: 'COID-FIXTURE-E3-000001', brokerAdapterVersion: 'FIXTURE_BROKER_ADAPTER_V1',
      brokerOccurredAt: '2026-09-01T14:30:05.000Z', acquiredAt: '2026-09-01T14:30:10.000Z',
      quantityContracts: 1, executionPriceUsdPerShare: 1.2, feeUsd: -0.65,
      premiumCashEntryId: 'CASH-FIXTURE-PREMIUM-000001',
      feeCashEntryId: 'CASH-FIXTURE-FILL-FEE-000001',
      canonicalDeduplicationSha256: '6'.repeat(63) + '1',
      rawBrokerEvidenceSha256: '7'.repeat(63) + '1',
    },
    {
      eventType: 'PUT_ASSIGNMENT', resolvedUnitId: FIRST_UNIT_ID,
      terminalEventId: 'TERM-FIXTURE-E3-ASSIGN-000001',
      sourceEventId: 'BROKER-FIXTURE-ASSIGN-800001', sourceEvidenceSha256: '8'.repeat(64),
      assignedContracts: 2, strikeUsdPerShare: 50, assignmentFeeUsd: -5,
      shareLotIds: LOT_IDS.slice(),
      shareMovementIds: ['SHARE-MOVE-FIXTURE-000001', 'SHARE-MOVE-FIXTURE-000002'],
      strikeCashEntryId: 'CASH-FIXTURE-ASSIGN-DEBIT-000001',
      assignmentFeeCashEntryId: 'CASH-FIXTURE-ASSIGN-FEE-000001',
      effectiveAt: '2026-09-18T01:30:00.000Z', acquiredAt: '2026-09-18T01:31:10.000Z',
    },
    {
      eventType: 'OPTION_EXPIRY', resolvedUnitId: FIRST_UNIT_ID,
      terminalEventId: 'TERM-FIXTURE-E3-EXPIRE-000001',
      sourceEventId: 'BROKER-FIXTURE-EXPIRE-800001', sourceEvidenceSha256: '9'.repeat(64),
      expiredContracts: 1, effectiveAt: '2026-09-18T20:00:00.000Z',
      acquiredAt: '2026-09-18T20:02:00.000Z',
    },
    {
      eventType: 'MARK_OBSERVED', resolvedUnitId: FIRST_UNIT_ID,
      markEvidenceId: 'MARK-FIXTURE-SPY-000001', markUsdPerShare: 49,
      marketAdapterVersion: 'FIXTURE_MARKET_ADAPTER_V1', rawEvidenceSha256: 'a'.repeat(64),
      vendorAsOf: '2026-09-18T20:01:00.000Z', acquiredAt: '2026-09-18T20:01:01.000Z',
    },
    {
      eventType: 'UNIT_OPENED', economicEpisodeId: EPISODE_ID, resolvedUnitId: CALL_UNIT_ID,
      parentResolvedUnitId: FIRST_UNIT_ID, strategy: 'COVERED_CALL',
      accountId: 'ACCT-FIXTURE-CASH-0001', symbol: 'SPY',
      lifecycleId: 'LC-FIXTURE-E3-CC-000002', positionId: 'POS-FIXTURE-E3-CC-000002',
      terminalEventId: 'TERM-FIXTURE-E3-CC-FINAL-000002', pnlRecordId: 'PNL-FIXTURE-E3-CC-000002',
    },
    {
      eventType: 'DECISION_SEALED', economicEpisodeId: EPISODE_ID, resolvedUnitId: CALL_UNIT_ID,
      decisionId: 'DEC-FIXTURE-E3-CC-000002', decisionAt: '2026-09-21T14:29:55.000Z',
      sealedAt: '2026-09-21T14:29:56.000Z', thirdCallContracts: 3,
      faultId: 'FAULT-FIXTURE-E3-CC-000001',
      proposalAttemptId: 'PROP-ATTEMPT-FIXTURE-E3-CC-000003',
    },
    {
      eventType: 'PROPOSAL_SEALED', economicEpisodeId: EPISODE_ID, resolvedUnitId: CALL_UNIT_ID,
      proposalId: 'PROP-FIXTURE-E3-CC-000002', proposalHash: 'c'.repeat(64),
      positionContractId: 'PC-FIXTURE-SPY-20261016-C55', positionContractHash: 'd'.repeat(64),
      sealedAt: '2026-09-21T14:29:58.000Z',
      contract: {
        contractMultiplierShares: 100, expirationDate: '2026-10-16',
        occSymbol: 'SPY261016C00055000', openingSide: 'SELL_TO_OPEN',
        quantityContracts: 2, right: 'CALL', strikeUsdPerShare: 55, symbol: 'SPY',
      },
      orderInstruction: { duration: 'DAY', limitUsdPerShare: 0.75, type: 'LIMIT' },
    },
    {
      eventType: 'SHARES_RESERVED', resolvedUnitId: CALL_UNIT_ID,
      shareLotIds: LOT_IDS.slice(),
      shareMovementIds: ['SHARE-RESERVE-FIXTURE-CC-000001', 'SHARE-RESERVE-FIXTURE-CC-000002'],
      effectiveAt: '2026-09-21T14:29:59.000Z',
    },
    {
      eventType: 'ORDER_SUBMITTED', resolvedUnitId: CALL_UNIT_ID,
      authorizationRecordId: 'AUTH-FIXTURE-HUMAN-CC-000002',
      brokerAdapterVersion: 'FIXTURE_BROKER_ADAPTER_V1',
      brokerOrderId: 'BOID-FIXTURE-E3-CC-900002', clientOrderId: 'COID-FIXTURE-E3-CC-000002',
      canonicalRequestSha256: 'f'.repeat(64), submittedAt: '2026-09-21T14:30:00.000Z',
    },
    {
      eventType: 'BROKER_ACKNOWLEDGEMENT', resolvedUnitId: CALL_UNIT_ID,
      brokerEventId: 'BEVT-FIXTURE-CC-ACK-000002', brokerOrderId: 'BOID-FIXTURE-E3-CC-900002',
      clientOrderId: 'COID-FIXTURE-E3-CC-000002', acknowledgedQuantityContracts: 2,
      brokerOccurredAt: '2026-09-21T14:30:02.000Z', acquiredAt: '2026-09-21T14:30:03.000Z',
    },
    {
      eventType: 'BROKER_FILL', resolvedUnitId: CALL_UNIT_ID,
      brokerEventId: 'BEVT-FIXTURE-CC-FILL-000001', fillId: 'FILL-FIXTURE-E3-CC-000001',
      brokerExecutionId: 'EXEC-FIXTURE-E3-CC-700001',
      brokerOrderId: 'BOID-FIXTURE-E3-CC-900002', clientOrderId: 'COID-FIXTURE-E3-CC-000002',
      brokerAdapterVersion: 'FIXTURE_BROKER_ADAPTER_V1',
      brokerOccurredAt: '2026-09-21T14:30:05.000Z', acquiredAt: '2026-09-21T14:30:06.000Z',
      quantityContracts: 2, executionPriceUsdPerShare: 0.8, feeUsd: -1.3,
      premiumCashEntryId: 'CASH-FIXTURE-CC-PREMIUM-000001',
      feeCashEntryId: 'CASH-FIXTURE-CC-FILL-FEE-000001',
      canonicalDeduplicationSha256: '12'.repeat(32), rawBrokerEvidenceSha256: '13'.repeat(32),
    },
    {
      eventType: 'BROKER_FILL', resolvedUnitId: CALL_UNIT_ID, redelivery: true,
      brokerEventId: 'BEVT-FIXTURE-CC-FILL-000001', fillId: 'FILL-FIXTURE-E3-CC-000001',
      brokerExecutionId: 'EXEC-FIXTURE-E3-CC-700001',
      brokerOrderId: 'BOID-FIXTURE-E3-CC-900002', clientOrderId: 'COID-FIXTURE-E3-CC-000002',
      brokerAdapterVersion: 'FIXTURE_BROKER_ADAPTER_V1',
      brokerOccurredAt: '2026-09-21T14:30:05.000Z', acquiredAt: '2026-09-21T14:30:06.000Z',
      quantityContracts: 2, executionPriceUsdPerShare: 0.8, feeUsd: -1.3,
      premiumCashEntryId: 'CASH-FIXTURE-CC-PREMIUM-000001',
      feeCashEntryId: 'CASH-FIXTURE-CC-FILL-FEE-000001',
      canonicalDeduplicationSha256: '12'.repeat(32), rawBrokerEvidenceSha256: '13'.repeat(32),
    },
    {
      eventType: 'CALL_EXPIRY', resolvedUnitId: CALL_UNIT_ID,
      terminalEventId: 'TERM-FIXTURE-E3-CC-EXPIRE-000002',
      sourceEventId: 'BROKER-FIXTURE-CC-EXPIRE-800002', sourceEvidenceSha256: '14'.repeat(32),
      expiredContracts: 2,
      releaseShareMovementIds: ['SHARE-RELEASE-FIXTURE-CC-000001', 'SHARE-RELEASE-FIXTURE-CC-000002'],
      effectiveAt: '2026-10-16T20:00:00.000Z', acquiredAt: '2026-10-16T20:02:00.000Z',
    },
    {
      eventType: 'MARK_OBSERVED', resolvedUnitId: CALL_UNIT_ID,
      markEvidenceId: 'MARK-FIXTURE-SPY-CC-000002', markUsdPerShare: 52,
      marketAdapterVersion: 'FIXTURE_MARKET_ADAPTER_V1', rawEvidenceSha256: '15'.repeat(32),
      vendorAsOf: '2026-10-16T20:01:00.000Z', acquiredAt: '2026-10-16T20:01:01.000Z',
    },
  ];
  return events.map((event, index) => ({
    ...event,
    streamEventId: `RAW-FIXTURE-E3-${String(index + 1).padStart(6, '0')}`,
    streamSequence: index + 1,
  }));
}

function forbiddenKeyPaths(value, path = '$', found = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => forbiddenKeyPaths(entry, `${path}[${index}]`, found));
    return found;
  }
  if (value === null || typeof value !== 'object') return found;
  for (const [key, entry] of Object.entries(value)) {
    if (/forecast|calibration/iu.test(key)) found.push(`${path}.${key}`);
    forbiddenKeyPaths(entry, `${path}.${key}`, found);
  }
  return found;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('raw append stream becomes fold inputs once per fill and preserves economic continuity', () => {
  const stream = rawEventStream();
  const before = JSON.parse(JSON.stringify(stream));
  const inputs = fromBrokerEvents(stream);
  assert.deepEqual(stream, before, 'adapter must not mutate the append-only input');

  assert.deepEqual(inputs[0]['order-events.json'].appendLog.map((event) => event.eventId), [
    'BEVT-FIXTURE-FILL-000002',
    'BEVT-FIXTURE-ACK-000001',
    'BEVT-FIXTURE-FILL-000001',
  ]);
  assert.deepEqual(inputs[0]['fills.json'].fillIds, [
    'FILL-FIXTURE-E3-000002', 'FILL-FIXTURE-E3-000001',
  ]);
  assert.equal(inputs[0]['fills.json'].fills.length, 2, 'redelivered fill is applied once');
  assert.deepEqual(inputs[0]['shares.json'].shareLotIds, LOT_IDS);
  assert.deepEqual(inputs[0]['shares.json'].lots.map((lot) => lot.costPerShareUsd),
    [50.025, 50.025]);
  assert.deepEqual(inputs[1]['proposal.json'].coverage.referencedShareLotIds, LOT_IDS);
  assert.deepEqual(inputs[1]['shares.json'].openingShareLotIds, LOT_IDS);
  assert.equal(inputs[1]['decision.json'].thirdCallFault.outcome, 'FAULT');
  assert.equal(inputs[1]['decision.json'].thirdCallFault.shortfallShares, 100);
  assert.deepEqual(forbiddenKeyPaths(inputs), []);

  const { firstUnit, coveredCallContinuation } = foldResolvedEpisode(inputs);
  assert.equal(firstUnit['cash.json'].summary.netCashMovementUsd, -9656.95);
  assert.equal(firstUnit['pnl.json'].summary.optionRealizedPnlUsd, 348.05);
  assert.equal(firstUnit['shares.json'].summary.sharesRemaining, 200);
  assert.equal(coveredCallContinuation['cash.json'].summary.continuationNetCashMovementUsd, 158.70);
  assert.equal(coveredCallContinuation['cash.json'].summary.cumulativeEpisodeNetCashMovementUsd,
    -9498.25);
  assert.equal(coveredCallContinuation['shares.json'].summary.newShareLotsCreated, 0);
  assert.equal(coveredCallContinuation['shares.json'].summary.sharesRemaining, 200);
});

test('conflicting fill redelivery faults and forecast-shaped input is rejected', () => {
  const conflicting = rawEventStream();
  const duplicate = conflicting.find((event) => event.redelivery
    && event.resolvedUnitId === FIRST_UNIT_ID);
  duplicate.executionPriceUsdPerShare = 1.16;
  assert.throws(() => fromBrokerEvents(conflicting), /CONFLICTING_DUPLICATE/u);

  const contaminated = rawEventStream();
  contaminated[0].forecastHash = 'not-permitted';
  assert.throws(() => fromBrokerEvents(contaminated), /FORBIDDEN_KEYS/u);
});

test('event-derived fold output emits and both unchanged replay scripts exit zero', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'nuvo-e3-broker-events-'));
  try {
    const [firstInput, continuationInput] = fromBrokerEvents(rawEventStream());
    const { firstUnit, coveredCallContinuation } = foldResolvedEpisode([
      firstInput, continuationInput,
    ]);
    const firstEmission = emitResolvedUnitBundle(
      firstUnit,
      join(temporaryRoot, 'docs', 'E3_FIRST_UNIT_FIXTURE_BUNDLE'),
    );
    emitResolvedUnitBundle(
      coveredCallContinuation,
      join(temporaryRoot, 'docs', 'E3_CC_CONTINUATION_BUNDLE'),
      { parentEmission: firstEmission },
    );

    mkdirSync(join(temporaryRoot, 'tools'), { recursive: true });
    for (const script of ['replay-e3-fixture.mjs', 'replay-e3-cc.mjs']) {
      const source = join(REPOSITORY_ROOT, 'tools', script);
      const destination = join(temporaryRoot, 'tools', script);
      copyFileSync(source, destination);
      assert.equal(sha256(readFileSync(destination)), sha256(readFileSync(source)));
    }

    const fixture = spawnSync(process.execPath,
      [join(temporaryRoot, 'tools', 'replay-e3-fixture.mjs')],
      { cwd: temporaryRoot, encoding: 'utf8' });
    const continuation = spawnSync(process.execPath,
      [join(temporaryRoot, 'tools', 'replay-e3-cc.mjs')],
      { cwd: temporaryRoot, encoding: 'utf8' });

    process.stdout.write(`broker-event replay-e3-fixture exit=${fixture.status}\n${fixture.stdout}`);
    if (fixture.stderr) process.stdout.write(fixture.stderr);
    process.stdout.write(`broker-event replay-e3-cc exit=${continuation.status}\n${continuation.stdout}`);
    if (continuation.stderr) process.stdout.write(continuation.stderr);

    assert.equal(fixture.status, 0, fixture.stderr || fixture.stdout);
    assert.match(fixture.stdout, /E3 fixture replay: PASS/u);
    assert.equal(continuation.status, 0, continuation.stderr || continuation.stdout);
    assert.match(continuation.stdout, /E3 CC continuation replay: PASS/u);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
