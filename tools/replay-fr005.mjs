import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import {
  normalizeSchwabHistoryPacket, SCHWAB_HISTORY_CONTRACT_VERSION,
  SchwabMarketProvider,
} from '../src/truth/providers/schwab.js';

const DAY_MS = 86_400_000;
const START = Date.UTC(2023, 0, 1);

function historySeries(length = 756) {
  return Array.from({ length }, (_, index) => ({
    sequence: index + 1,
    datetime: START + index * DAY_MS,
    open: index + 1,
    high: index + 1.5,
    low: index + 0.5,
    close: index + 1.25,
    volume: 1_000_000 + index,
  }));
}

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const full = historySeries();
const legacyRaw = full.slice(-502);
const suffixes = {};

for (const lookback of [120, 252, 400]) {
  const before = normalizeSchwabHistoryPacket({ candles: legacyRaw }, { lookback, minBars: 1 });
  const after = normalizeSchwabHistoryPacket({ candles: full }, { lookback, minBars: 1 });
  assert.deepEqual(after.value, before.value);
  suffixes[lookback] = {
    beforeCount: before.value.length,
    afterCount: after.value.length,
    beforeFirst: before.value[0],
    afterFirst: after.value[0],
    beforeLast: before.value.at(-1),
    afterLast: after.value.at(-1),
    beforeSha256: hash(before.value),
    afterSha256: hash(after.value),
    byteIdentical: JSON.stringify(before.value) === JSON.stringify(after.value),
  };
}

const requests = [];
const provider = new SchwabMarketProvider({
  ownerId: 'owner',
  client: { async marketHistory(ownerId, symbol, options) {
    requests.push({ ownerId, symbol, options });
    return { empty: false, candles: full };
  } },
});
const newGate = await provider.history('SPY', { lookback: 504, minBars: 504 });
const oldGate = normalizeSchwabHistoryPacket({ candles: legacyRaw },
  { lookback: 504, minBars: 504 });
const shortGate = normalizeSchwabHistoryPacket({ candles: historySeries(503) },
  { lookback: 504, minBars: 504 });

assert.equal(oldGate.error, 'SCHWAB_HISTORY_SHORT:502');
assert.equal(shortGate.error, 'SCHWAB_HISTORY_SHORT:503');
assert.equal(newGate.value.length, 504);
assert.equal(newGate.value[0].c, 253.25);
assert.equal(newGate.value.at(-1).c, 756.25);

process.stdout.write(`${JSON.stringify({
  schema: 'nuvo.fr-005.old-vs-new-replay.v1',
  fixture: {
    totalSourceBars: 756,
    legacyTwoYearBars: 502,
    firstSourceRecord: full[0],
    lastSourceRecord: full.at(-1),
  },
  old: {
    requestPeriodYears: 2,
    rawBarCount: 502,
    requestedLookback: 504,
    requiredBars: 504,
    result: { error: oldGate.error },
  },
  new: {
    requests,
    contractVersion: SCHWAB_HISTORY_CONTRACT_VERSION,
    rawBarCount: newGate.rawBarCount,
    requestedLookback: 504,
    requiredBars: 504,
    returnedBarCount: newGate.returnedBarCount,
    firstReturned: newGate.value[0],
    lastReturned: newGate.value.at(-1),
    resultSha256: hash(newGate.value),
  },
  boundary: {
    rawBarCount: 503,
    result: { error: shortGate.error },
  },
  lowerLookbackIdentity: suffixes,
}, null, 2)}\n`);
