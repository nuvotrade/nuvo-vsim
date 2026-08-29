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

const EXPECTED_EVENT_ORDER = Object.freeze([
  'BEVT-FIXTURE-FILL-000002',
  'BEVT-FIXTURE-ACK-000001',
  'BEVT-FIXTURE-FILL-000001',
]);

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
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = resolve(scriptDirectory, '..');
  const bundleDirectory = join(repositoryRoot, 'docs', 'E3_FIRST_UNIT_FIXTURE_BUNDLE');

  const jsonFiles = readdirSync(bundleDirectory)
    .filter((name) => name.endsWith('.json'))
    .sort();
  equal(jsonFiles, EXPECTED_FILES, 'bundle JSON file set');

  const records = Object.fromEntries(jsonFiles.map((name) => {
    const bytes = readFileSync(join(bundleDirectory, name), 'utf8');
    return [name, JSON.parse(bytes)];
  }));

  const fills = records['fills.json'].fills;
  invariant(Array.isArray(fills), 'fills.json.fills: array required');
  equal(fills.length, 2, 'fill count');

  const appendLog = records['order-events.json'].appendLog;
  invariant(Array.isArray(appendLog), 'order-events.json.appendLog: array required');
  equal(appendLog.length, 3, 'append-event count');
  equal(appendLog.map((event) => event.appendSequence), [1, 2, 3], 'append sequence');
  equal(appendLog.map((event) => event.eventId), EXPECTED_EVENT_ORDER, 'append-event order');
  equal(
    records['order-events.json'].acquisitionOrderFillIds,
    ['FILL-FIXTURE-E3-000002', 'FILL-FIXTURE-E3-000001'],
    'out-of-order acquired fills',
  );

  const cash = records['cash.json'];
  invariant(Array.isArray(cash.entries), 'cash.json.entries: array required');
  const computedNetCashCents = cash.entries.reduce(
    (total, entry) => total + cents(entry.amount, `cash entry ${entry.cashEntryId}`),
    0,
  );
  equal(computedNetCashCents, -965695, 'computed net cash cents');
  equal(cents(cash.summary.netCashMovementUsd, 'cash summary net'), -965695, 'reported net cash cents');

  const pnl = records['pnl.json'];
  const optionRealizedLines = pnl.lines.filter((line) => line.name === 'OPTION_REALIZED_PNL');
  equal(optionRealizedLines.length, 1, 'OPTION_REALIZED_PNL line count');
  equal(cents(optionRealizedLines[0].amountUsd, 'option realized line'), 34805, 'option realized cents');
  equal(cents(pnl.summary.optionRealizedPnlUsd, 'option realized summary'), 34805,
    'reported option realized cents');

  const shares = records['shares.json'];
  invariant(Array.isArray(shares.lots), 'shares.json.lots: array required');
  equal(shares.lots.length, 2, 'share-lot count');
  equal(new Set(shares.lots.map((lot) => lot.shareLotId)).size, 2, 'unique share-lot count');
  const computedShares = shares.lots.reduce((total, lot) => total + lot.quantityShares, 0);
  equal(computedShares, 200, 'computed remaining shares');
  equal(shares.summary.sharesRemaining, 200, 'reported remaining shares');

  equal(shares.summary.episodeStatus, 'OPEN_SHARES', 'share-ledger episode status');
  equal(pnl.summary.episodeStatus, 'OPEN_SHARES', 'P&L episode status');
  equal(
    records['fills.json'].lifecycle.terminalSummary.episodeStatus,
    'OPEN_SHARES',
    'terminal-summary episode status',
  );
  equal(records['manifest.json'].episodeStatus, 'OPEN_SHARES', 'manifest episode status');

  const forbidden = jsonFiles.flatMap((name) => forbiddenKeyPaths(records[name], `$[${name}]`));
  equal(forbidden, [], 'forecast/calibration key paths');

  process.stdout.write([
    'E3 fixture replay: PASS',
    `jsonFiles=${jsonFiles.length}`,
    `fills=${fills.length}`,
    `events=${appendLog.length}`,
    `eventOrder=${appendLog.map((event) => event.eventId).join(' -> ')}`,
    'netCashUsd=-9656.95',
    'optionRealizedPnlUsd=348.05',
    `shares=${computedShares}`,
    `shareLots=${shares.lots.length}`,
    'episodeStatus=OPEN_SHARES',
    'forecastCalibrationKeys=0',
  ].join('\n') + '\n');
} catch (error) {
  process.stderr.write(`E3 fixture replay: FAIL\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
