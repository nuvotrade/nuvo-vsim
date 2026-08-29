import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitResolvedUnitBundle } from '../src/economic/emit-resolved-unit-bundle.js';
import { foldResolvedEpisode } from '../src/economic/fold-resolved-unit.js';
import { fromBrokerEvents } from '../src/economic/from-broker-events.js';
import { schwabExecutionToEvents } from '../src/economic/schwab-execution-to-events.js';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readBundle(name) {
  const directory = join(REPOSITORY_ROOT, 'docs', name);
  return Object.fromEntries(readdirSync(directory)
    .filter((path) => path.endsWith('.json'))
    .map((path) => [path, JSON.parse(readFileSync(join(directory, path), 'utf8'))]));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function executionOrder(bundle) {
  const orderRecord = bundle['order-events.json'];
  const fills = bundle['fills.json'].fills;
  const fillEvents = new Map(orderRecord.appendLog
    .filter((event) => event.eventType === 'FILL')
    .map((event) => [event.fillId, event]));
  const acknowledgement = orderRecord.appendLog
    .find((event) => event.eventType === 'ACKNOWLEDGEMENT');
  return {
    orderId: orderRecord.order.brokerOrderId,
    clientOrderId: orderRecord.order.clientOrderId,
    enteredTime: orderRecord.order.submittedAt,
    status: 'FILLED',
    quantity: orderRecord.order.quantityContracts,
    price: orderRecord.order.limitUsdPerShare,
    orderLegCollection: [{
      legId: 1,
      instruction: 'SELL_TO_OPEN',
      quantity: orderRecord.order.quantityContracts,
      instrument: { assetType: 'OPTION', symbol: bundle['proposal.json'].contract.occSymbol },
    }],
    acknowledgement: {
      acquiredSequence: acknowledgement.appendSequence,
      eventId: acknowledgement.eventId,
      quantity: acknowledgement.acknowledgedQuantityContracts,
      time: acknowledgement.brokerOccurredAt,
      acquiredAt: acknowledgement.acquiredAt,
    },
    orderActivityCollection: [{
      activityType: 'EXECUTION',
      activityId: `ACTIVITY-${orderRecord.order.brokerOrderId}`,
      executionLegs: fills.map((fill) => {
        const event = fillEvents.get(fill.fillId);
        return {
          acquiredSequence: event.appendSequence,
          eventId: event.eventId,
          fillId: fill.fillId,
          executionId: fill.brokerExecutionId,
          legId: 1,
          quantity: fill.quantityContracts,
          price: fill.executionPriceUsdPerShare,
          fee: fill.feeUsd,
          time: fill.brokerOccurredAt,
          acquiredAt: fill.acquiredAt,
          premiumCashEntryId: fill.premiumCashEntryId,
          feeCashEntryId: fill.feeCashEntryId,
          canonicalDeduplicationSha256: fill.canonicalDeduplicationSha256,
          rawBrokerEvidenceSha256: fill.rawBrokerEvidenceSha256,
        };
      }),
    }],
  };
}

function unitContext(bundle, { parentResolvedUnitId = null } = {}) {
  const manifest = bundle['manifest.json'];
  const decision = bundle['decision.json'];
  const proposal = bundle['proposal.json'];
  const order = bundle['order-events.json'].order;
  const lifecycle = bundle['fills.json'].lifecycle;
  const mark = bundle['pnl.json'].markEvidence;
  const reservationMovements = (bundle['shares.json'].movements ?? [])
    .filter((movement) => movement.action === 'RESERVE_COVERED_CALL');
  return {
    economicEpisodeId: manifest.economicEpisodeId,
    resolvedUnitId: manifest.resolvedUnitId,
    ...(parentResolvedUnitId ? { parentResolvedUnitId } : {}),
    strategy: decision.strategy,
    accountId: decision.accountId,
    symbol: decision.symbol,
    lifecycleId: lifecycle.lifecycleId,
    positionId: lifecycle.positionId,
    terminalEventId: lifecycle.terminalSummary.terminalEventId,
    pnlRecordId: bundle['pnl.json'].pnlRecordId,
    brokerAdapterVersion: order.brokerAdapterVersion,
    authorizationRecordId: order.authorizationRecordId,
    canonicalRequestSha256: order.canonicalRequestSha256,
    decision: {
      decisionId: decision.decisionId,
      decisionAt: decision.decisionAt,
      sealedAt: decision.sealedAt,
      ...(decision.thirdCallFault ? {
        thirdCallContracts: decision.thirdCallFault.requestedContracts,
        faultId: decision.thirdCallFault.faultId,
        proposalAttemptId: decision.thirdCallFault.proposalAttemptId,
      } : {}),
    },
    proposal: {
      proposalId: proposal.proposalId,
      proposalHash: proposal.proposalHash,
      positionContractId: proposal.positionContractId,
      positionContractHash: proposal.positionContractHash,
      sealedAt: proposal.sealedAt,
      contract: clone(proposal.contract),
      orderInstruction: clone(proposal.orderInstruction),
    },
    ...(reservationMovements.length ? {
      reservation: {
        shareLotIds: reservationMovements.map((movement) => movement.shareLotId),
        shareMovementIds: reservationMovements.map((movement) => movement.shareMovementId),
        effectiveAt: reservationMovements[0].effectiveAt,
      },
    } : {}),
    mark: clone(mark),
  };
}

function terminalActivities(bundle) {
  return bundle['fills.json'].lifecycle.terminalEvents.map((event) => {
    if (event.eventType === 'PARTIAL_PUT_ASSIGNMENT') {
      return {
        activityType: 'PUT_ASSIGNMENT',
        activityId: event.sourceEventId,
        terminalEventId: event.terminalEventId,
        rawBrokerEvidenceSha256: event.sourceEvidenceSha256,
        assignedContracts: event.assignedContracts,
        strikePrice: event.strikeUsdPerShare,
        fee: event.assignmentFeeUsd,
        shareLots: event.shareLotIds.map((shareLotId, index) => ({
          shareLotId,
          shareMovementId: event.shareMovementIds[index],
        })),
        strikeCashEntryId: event.cashEntryIds[0],
        assignmentFeeCashEntryId: event.cashEntryIds[1],
        effectiveAt: event.effectiveAt,
        acquiredAt: event.acquiredAt,
      };
    }
    return {
      activityType: event.eventType === 'COVERED_CALL_EXPIRY'
        ? 'CALL_EXPIRATION' : 'OPTION_EXPIRATION',
      activityId: event.sourceEventId,
      terminalEventId: event.terminalEventId,
      rawBrokerEvidenceSha256: event.sourceEvidenceSha256,
      expiredContracts: event.expiredContracts,
      ...(event.releaseShareMovementIds
        ? { releaseShareMovementIds: event.releaseShareMovementIds.slice() }
        : {}),
      effectiveAt: event.effectiveAt,
      acquiredAt: event.acquiredAt,
    };
  });
}

function schwabPayload() {
  const first = readBundle('E3_FIRST_UNIT_FIXTURE_BUNDLE');
  const continuation = readBundle('E3_CC_CONTINUATION_BUNDLE');
  return {
    snapshotId: 'SCHWAB-EXECUTION-FIXTURE-000001',
    units: [
      {
        context: unitContext(first),
        order: executionOrder(first),
        terminalActivities: terminalActivities(first),
      },
      {
        context: unitContext(continuation, {
          parentResolvedUnitId: first['manifest.json'].resolvedUnitId,
        }),
        order: executionOrder(continuation),
        terminalActivities: terminalActivities(continuation),
      },
    ],
  };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('maps identified Schwab executions to the append-only E3 stream', () => {
  const payload = schwabPayload();
  const before = clone(payload);
  const result = schwabExecutionToEvents(payload);
  assert.equal(result.ok, true);
  assert.equal(result.mutationEligible, false);
  assert.deepEqual(payload, before, 'mapping must not mutate sealed Schwab payloads');
  assert.deepEqual(result.events.map((event) => event.streamSequence),
    result.events.map((_, index) => index + 1));

  const inputs = fromBrokerEvents(result.events);
  assert.deepEqual(inputs[0]['order-events.json'].appendLog.map((event) => event.eventId), [
    'BEVT-FIXTURE-FILL-000002',
    'BEVT-FIXTURE-ACK-000001',
    'BEVT-FIXTURE-FILL-000001',
  ]);
  assert.deepEqual(inputs[0]['fills.json'].fillIds, [
    'FILL-FIXTURE-E3-000002', 'FILL-FIXTURE-E3-000001',
  ]);
  assert.deepEqual(inputs[0]['shares.json'].shareLotIds, [
    'LOT-FIXTURE-SPY-000001', 'LOT-FIXTURE-SPY-000002',
  ]);
  assert.deepEqual(inputs[1]['proposal.json'].coverage.referencedShareLotIds,
    inputs[0]['shares.json'].shareLotIds);
  assert.equal(inputs[1]['decision.json'].thirdCallFault.outcome, 'FAULT');
});

test('missing execution identities, fees, or assignment lots return named faults', () => {
  const missingFillId = schwabPayload();
  const missingIdentityLeg = missingFillId.units[0].order
    .orderActivityCollection[0].executionLegs[0];
  delete missingIdentityLeg.fillId;
  delete missingIdentityLeg.executionId;
  delete missingIdentityLeg.orderLegExecutionId;
  delete missingIdentityLeg.time;
  delete missingFillId.units[0].order.orderActivityCollection[0].activityId;
  assert.deepEqual(schwabExecutionToEvents(missingFillId).faultCode, 'MISSING_FILL_ID');

  const missingFee = schwabPayload();
  delete missingFee.units[0].order.orderActivityCollection[0].executionLegs[0].fee;
  assert.deepEqual(schwabExecutionToEvents(missingFee).faultCode, 'MISSING_FEE');

  const missingLots = schwabPayload();
  delete missingLots.units[0].terminalActivities[0].shareLots;
  assert.deepEqual(schwabExecutionToEvents(missingLots).faultCode, 'MISSING_ASSIGNMENT_LOTS');
});

test('a Schwab position snapshot cannot be promoted into fill evidence', () => {
  const result = schwabExecutionToEvents({
    snapshotId: 'POSITION-ONLY',
    positions: [{ symbol: 'SPY', quantity: 200, marketValue: 10_000 }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'FAULT');
  assert.equal(result.faultCode, 'POSITION_SNAPSHOT_NOT_EXECUTION_EVIDENCE');
  assert.equal(result.events, null);
});

test('fixture-shaped Schwab payload folds, emits, and both unchanged replays exit zero', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'nuvo-e3-schwab-map-'));
  try {
    const mapped = schwabExecutionToEvents(schwabPayload());
    assert.equal(mapped.ok, true);
    const { firstUnit, coveredCallContinuation } = foldResolvedEpisode(
      fromBrokerEvents(mapped.events),
    );
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

    process.stdout.write(`schwab replay-e3-fixture exit=${fixture.status}\n${fixture.stdout}`);
    if (fixture.stderr) process.stdout.write(fixture.stderr);
    process.stdout.write(`schwab replay-e3-cc exit=${continuation.status}\n${continuation.stdout}`);
    if (continuation.stderr) process.stdout.write(continuation.stderr);
    assert.equal(fixture.status, 0, fixture.stderr || fixture.stdout);
    assert.equal(continuation.status, 0, continuation.stderr || continuation.stdout);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
