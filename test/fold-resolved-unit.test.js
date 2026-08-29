import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { foldResolvedEpisode, foldResolvedUnit } from '../src/economic/fold-resolved-unit.js';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readBundle(name) {
  const directory = join(REPOSITORY_ROOT, 'docs', name);
  return Object.fromEntries(readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .map((file) => [file, JSON.parse(readFileSync(join(directory, file), 'utf8'))]));
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

test('fold emits the exact two bundle objects consumed by both passing replay scripts', () => {
  const firstInput = readBundle('E3_FIRST_UNIT_FIXTURE_BUNDLE');
  const coveredCallInput = readBundle('E3_CC_CONTINUATION_BUNDLE');

  const { firstUnit, coveredCallContinuation } = foldResolvedEpisode([
    firstInput,
    coveredCallInput,
  ]);

  assert.deepEqual(firstUnit, firstInput);
  assert.deepEqual(coveredCallContinuation, coveredCallInput);
  assert.equal(firstUnit['cash.json'].summary.netCashMovementUsd, -9656.95);
  assert.equal(firstUnit['pnl.json'].summary.optionRealizedPnlUsd, 348.05);
  assert.equal(firstUnit['shares.json'].summary.sharesRemaining, 200);
  assert.equal(coveredCallContinuation['cash.json'].summary.continuationNetCashMovementUsd, 158.70);
  assert.equal(coveredCallContinuation['cash.json'].summary.cumulativeEpisodeNetCashMovementUsd,
    -9498.25);
  assert.equal(coveredCallContinuation['pnl.json'].summary.coveredCallOptionRealizedPnlUsd, 158.70);
  assert.equal(coveredCallContinuation['shares.json'].summary.newShareLotsCreated, 0);
  assert.equal(coveredCallContinuation['shares.json'].summary.sharesRemaining, 200);
  assert.equal(coveredCallContinuation['manifest.json'].unitStatus, 'RESOLVED_EXPIRED');
  assert.equal(coveredCallContinuation['manifest.json'].episodeStatus, 'OPEN_SHARES');
});

test('fold reconstructs drifted derived totals from immutable input events', () => {
  const firstInput = readBundle('E3_FIRST_UNIT_FIXTURE_BUNDLE');
  const coveredCallInput = readBundle('E3_CC_CONTINUATION_BUNDLE');
  const driftedFirst = copy(firstInput);
  const driftedCall = copy(coveredCallInput);

  driftedFirst['fills.json'].fillReconciliation.grossPremiumUsd = 0;
  driftedFirst['fills.json'].position.remainingOptionContracts = 99;
  driftedFirst['cash.json'].summary.netCashMovementUsd = 0;
  driftedFirst['shares.json'].summary.sharesRemaining = 0;
  driftedFirst['pnl.json'].summary.optionRealizedPnlUsd = 0;
  driftedFirst['pnl.json'].lines.find((line) => line.name === 'OPTION_REALIZED_PNL').amountUsd = 0;

  driftedCall['cash.json'].summary.continuationNetCashMovementUsd = 0;
  driftedCall['cash.json'].summary.cumulativeEpisodeNetCashMovementUsd = 0;
  driftedCall['shares.json'].summary.reservedShares = 200;
  driftedCall['pnl.json'].summary.coveredCallOptionRealizedPnlUsd = 0;
  driftedCall['pnl.json'].lines
    .find((line) => line.name === 'COVERED_CALL_OPTION_REALIZED_PNL').amountUsd = 0;

  const { firstUnit, coveredCallContinuation } = foldResolvedEpisode([
    driftedFirst,
    driftedCall,
  ]);

  assert.equal(firstUnit['fills.json'].fillReconciliation.grossPremiumUsd, 350);
  assert.equal(firstUnit['fills.json'].position.remainingOptionContracts, 0);
  assert.equal(firstUnit['cash.json'].summary.netCashMovementUsd, -9656.95);
  assert.equal(firstUnit['shares.json'].summary.sharesRemaining, 200);
  assert.equal(firstUnit['pnl.json'].summary.optionRealizedPnlUsd, 348.05);
  assert.equal(coveredCallContinuation['cash.json'].summary.continuationNetCashMovementUsd, 158.70);
  assert.equal(coveredCallContinuation['cash.json'].summary.cumulativeEpisodeNetCashMovementUsd,
    -9498.25);
  assert.equal(coveredCallContinuation['shares.json'].summary.reservedShares, 0);
  assert.equal(coveredCallContinuation['pnl.json'].summary.coveredCallOptionRealizedPnlUsd, 158.70);
});

test('fold rejects duplicate fills instead of double-counting cash or position quantity', () => {
  const firstInput = readBundle('E3_FIRST_UNIT_FIXTURE_BUNDLE');
  firstInput['fills.json'].fills.push(copy(firstInput['fills.json'].fills[0]));
  firstInput['order-events.json'].appendLog.push({
    ...copy(firstInput['order-events.json'].appendLog[0]),
    appendSequence: 4,
  });

  assert.throws(() => foldResolvedUnit(firstInput), /DUPLICATE_FILL_ID/u);
});

test('fold faults a third covered call and refuses invented or missing share inventory', () => {
  const firstInput = readBundle('E3_FIRST_UNIT_FIXTURE_BUNDLE');
  const parent = foldResolvedUnit(firstInput);
  const coveredCallInput = readBundle('E3_CC_CONTINUATION_BUNDLE');

  coveredCallInput['decision.json'].thirdCallFault.outcome = 'PASS';
  assert.throws(
    () => foldResolvedUnit(coveredCallInput, { parentBundle: parent }),
    /THIRD_CALL_MUST_FAULT/u,
  );

  const missingLotInput = readBundle('E3_CC_CONTINUATION_BUNDLE');
  missingLotInput['proposal.json'].coverage.referencedShareLotIds = ['LOT-FIXTURE-SPY-000001'];
  assert.throws(
    () => foldResolvedUnit(missingLotInput, { parentBundle: parent }),
    /COVERED_CALL_SHARE_LOT_REFERENCE_MISMATCH/u,
  );
});

test('fold rejects forecast or calibration keys in either event bundle', () => {
  const firstInput = readBundle('E3_FIRST_UNIT_FIXTURE_BUNDLE');
  firstInput['decision.json'].forecastHash = 'illegal-after-the-outcome';
  assert.throws(() => foldResolvedUnit(firstInput), /FORBIDDEN_KEYS/u);
});
