import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_FILES = Object.freeze([
  'cash.json',
  'decision.json',
  'fills.json',
  'manifest.json',
  'order-events.json',
  'pnl.json',
  'proposal.json',
  'shares.json',
]);

const EPISODE_ID = 'EP-FIXTURE-E3-000001';
const LOT_IDS = Object.freeze(['LOT-FIXTURE-SPY-000001', 'LOT-FIXTURE-SPY-000002']);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function equal(actual, expected, label) {
  invariant(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
  );
}

function cents(value, label) {
  invariant(typeof value === 'number' && Number.isFinite(value), `${label}: finite number required`);
  return Math.round(value * 100);
}

function readBundle(directory) {
  const files = readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
  equal(files, EXPECTED_FILES, `${directory} JSON file set`);
  return Object.fromEntries(files.map((name) => [
    name,
    JSON.parse(readFileSync(join(directory, name), 'utf8')),
  ]));
}

function forbiddenKeyPaths(value, path = '$', found = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => forbiddenKeyPaths(entry, `${path}[${index}]`, found));
    return found;
  }
  if (value === null || typeof value !== 'object') return found;

  for (const [key, entry] of Object.entries(value)) {
    const keyPath = `${path}.${key}`;
    if (/forecast|calibration/iu.test(key)) found.push(keyPath);
    forbiddenKeyPaths(entry, keyPath, found);
  }
  return found;
}

try {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const parent = readBundle(join(repositoryRoot, 'docs', 'E3_FIRST_UNIT_FIXTURE_BUNDLE'));
  const continuation = readBundle(join(repositoryRoot, 'docs', 'E3_CC_CONTINUATION_BUNDLE'));

  equal(parent['manifest.json'].economicEpisodeId, EPISODE_ID, 'parent episode ID');
  equal(continuation['manifest.json'].economicEpisodeId, EPISODE_ID, 'continuation episode ID');
  equal(continuation['manifest.json'].parentResolvedUnitId, 'RU-FIXTURE-E3-000001',
    'continuation parent unit');

  equal(parent['shares.json'].summary.sharesRemaining, 200, 'parent remaining shares');
  equal(parent['shares.json'].summary.episodeStatus, 'OPEN_SHARES', 'parent episode status');
  equal(parent['shares.json'].shareLotIds, LOT_IDS, 'parent share lots');
  equal(cents(parent['cash.json'].summary.netCashMovementUsd, 'parent net cash'), -965695,
    'parent net cash cents');
  equal(cents(parent['pnl.json'].summary.optionRealizedPnlUsd, 'parent option realized'), 34805,
    'parent option realized cents');

  const decision = continuation['decision.json'];
  equal(decision.acceptedCoverageEvaluation.requestedContracts, 2, 'accepted call contracts');
  equal(decision.acceptedCoverageEvaluation.requiredShares, 200, 'accepted required shares');
  equal(decision.acceptedCoverageEvaluation.deliverableShares, 200, 'accepted deliverable shares');
  equal(decision.acceptedCoverageEvaluation.result, 'PASS', 'two-call coverage result');
  equal(decision.acceptedCoverageEvaluation.reservedShareLotIds, LOT_IDS,
    'two-call source lots');

  const fault = decision.thirdCallFault;
  equal(fault.outcome, 'FAULT', 'third-call outcome');
  equal(fault.faultCode, 'COVERED_CALL_INSUFFICIENT_DELIVERABLE_SHARES',
    'third-call fault code');
  equal(fault.requestedContracts, 3, 'third-call requested contracts');
  equal(fault.requiredShares, 300, 'third-call required shares');
  equal(fault.deliverableShares, 200, 'third-call deliverable shares');
  equal(fault.shortfallShares, 100, 'third-call share shortfall');
  equal([fault.proposalCreated, fault.orderCreated, fault.reservationCreated],
    [false, false, false], 'third-call side effects');

  const proposal = continuation['proposal.json'];
  equal(proposal.contract.quantityContracts, 2, 'proposal call contracts');
  equal(proposal.coverage.referencedShareLotIds, LOT_IDS, 'proposal source lots');
  equal(proposal.coverage.inventedShares, 0, 'proposal invented shares');

  const events = continuation['order-events.json'].appendLog;
  equal(events.length, 2, 'continuation broker-event count');
  equal(events.map((event) => event.appendSequence), [1, 2], 'continuation append order');
  equal(events.map((event) => event.eventId),
    ['BEVT-FIXTURE-CC-ACK-000002', 'BEVT-FIXTURE-CC-FILL-000001'],
    'continuation event IDs');

  const fills = continuation['fills.json'].fills;
  equal(fills.length, 1, 'covered-call fill count');
  equal(fills[0].fillId, 'FILL-FIXTURE-E3-CC-000001', 'covered-call fill ID');
  equal(fills[0].quantityContracts, 2, 'filled call contracts');
  equal(fills[0].reservedShareLotIds, LOT_IDS, 'fill reserved lots');

  const cash = continuation['cash.json'];
  const continuationCashCents = cash.entries.reduce(
    (total, entry) => total + cents(entry.amount, `cash entry ${entry.cashEntryId}`),
    0,
  );
  equal(continuationCashCents, 15870, 'continuation net cash cents');
  equal(cents(cash.summary.continuationNetCashMovementUsd, 'continuation cash summary'), 15870,
    'reported continuation cash cents');
  equal(cents(cash.summary.cumulativeEpisodeNetCashMovementUsd, 'cumulative cash summary'), -949825,
    'cumulative episode cash cents');
  equal(cash.shareSaleCashEntryIds, [], 'share-sale cash entry IDs');
  equal(cents(cash.summary.shareSaleProceedsUsd, 'share-sale proceeds'), 0,
    'share-sale proceeds cents');

  const shares = continuation['shares.json'];
  equal(shares.openingShareLotIds, LOT_IDS, 'opening continuation lots');
  equal(shares.movements.map((movement) => movement.action), [
    'RESERVE_COVERED_CALL',
    'RESERVE_COVERED_CALL',
    'RELEASE_COVERED_CALL',
    'RELEASE_COVERED_CALL',
  ], 'share reservation/release order');
  equal(shares.movements.map((movement) => movement.shareLotId), [
    LOT_IDS[0], LOT_IDS[1], LOT_IDS[0], LOT_IDS[1],
  ], 'reservation/release lot continuity');
  equal(shares.newShareLotIds, [], 'new share-lot IDs');
  equal(shares.shareSaleMovementIds, [], 'share-sale movement IDs');
  equal(shares.shareDeliveryMovementIds, [], 'share-delivery movement IDs');
  equal(shares.closingLots.map((lot) => lot.shareLotId), LOT_IDS, 'closing continuation lots');
  equal(shares.summary.durableLotCount, 2, 'durable lot count');
  equal(shares.summary.newShareLotsCreated, 0, 'new share lots created');
  equal(shares.summary.sharesRemaining, 200, 'remaining shares');
  equal(shares.summary.reservedShares, 0, 'remaining reserved shares');
  equal(shares.summary.episodeStatus, 'OPEN_SHARES', 'share episode status');

  const terminal = continuation['fills.json'].lifecycle.terminalSummary;
  equal(terminal.openedContracts, 2, 'opened call contracts');
  equal(terminal.expiredContracts, 2, 'expired call contracts');
  equal(terminal.assignedContracts, 0, 'assigned call contracts');
  equal(terminal.remainingContracts, 0, 'remaining call contracts');
  equal(terminal.sharesCreated, 0, 'terminal shares created');
  equal(terminal.sharesDelivered, 0, 'terminal shares delivered');
  equal(terminal.unitStatus, 'RESOLVED_EXPIRED', 'call unit status');
  equal(terminal.episodeStatus, 'OPEN_SHARES', 'terminal episode status');

  const pnl = continuation['pnl.json'];
  equal(cents(pnl.summary.coveredCallOptionRealizedPnlUsd, 'call option realized'), 15870,
    'call option realized cents');
  equal(cents(pnl.summary.cumulativeOptionRealizedPnlUsd, 'cumulative option realized'), 50675,
    'cumulative option realized cents');
  equal(cents(pnl.summary.shareSaleProceedsUsd, 'P&L share-sale proceeds'), 0,
    'P&L share-sale proceeds cents');
  equal(pnl.summary.remainingShares, 200, 'P&L remaining shares');
  equal(pnl.summary.unitStatus, 'RESOLVED_EXPIRED', 'P&L unit status');
  equal(pnl.summary.episodeStatus, 'OPEN_SHARES', 'P&L episode status');

  const allRecords = [...Object.entries(parent), ...Object.entries(continuation)];
  const forbidden = allRecords.flatMap(([name, record]) => forbiddenKeyPaths(record, `$[${name}]`));
  equal(forbidden, [], 'forecast/calibration key paths across both bundles');

  process.stdout.write([
    'E3 CC continuation replay: PASS',
    'parentBundle=PASS',
    'continuationJsonFiles=8',
    `economicEpisodeId=${EPISODE_ID}`,
    `fills=${fills.length}`,
    'coveredCalls=2',
    `reservedLots=${LOT_IDS.join(',')}`,
    `releasedLots=${LOT_IDS.join(',')}`,
    'newShareLots=0',
    'callNetCashUsd=158.70',
    'cumulativeEpisodeCashUsd=-9498.25',
    'callOptionRealizedPnlUsd=158.70',
    'cumulativeOptionRealizedPnlUsd=506.75',
    'shares=200',
    'optionUnitStatus=RESOLVED_EXPIRED',
    'episodeStatus=OPEN_SHARES',
    'thirdCallAttempt=FAULT:COVERED_CALL_INSUFFICIENT_DELIVERABLE_SHARES',
    'forecastCalibrationKeys=0',
  ].join('\n') + '\n');
} catch (error) {
  process.stderr.write(`E3 CC continuation replay: FAIL\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
