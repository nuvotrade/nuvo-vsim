import { createHash } from 'node:crypto';
import {
  consumeEarningsEnvelope,
  EARNINGS_SOURCE_CONTRACT_VERSION,
  EARNINGS_SOURCE_ID,
  EARNINGS_UPSTREAM_ORIGIN,
  MassiveProvider,
} from '../src/truth/providers/massive.js';

const NOW = Date.UTC(2026, 7, 23, 18, 0, 0);
const requestedRange = { ticker: 'SPY', from: '2026-08-21', through: '2026-10-22' };

function envelope(events, overrides = {}) {
  return {
    status: events.length ? 'BLOCKED' : 'VERIFIED',
    faultCode: null,
    faultStage: null,
    sourceId: EARNINGS_SOURCE_ID,
    upstreamOrigin: EARNINGS_UPSTREAM_ORIGIN,
    vendorAsOf: '2026-08-23T17:59:59.000Z',
    fetchedAt: '2026-08-23T18:00:00.000Z',
    requestedRange,
    echoedRange: { ...requestedRange },
    coverageThrough: requestedRange.through,
    schemaVersion: EARNINGS_SOURCE_CONTRACT_VERSION,
    events,
    rawPayloadHash: 'a'.repeat(64),
    ...overrides,
  };
}

function oldEarningsMap(event) {
  const at = Date.parse(event.eventTimeUtc)
    || Date.parse(event.date ? `${event.date}T16:00:00Z` : '');
  return { type: 'EARNINGS', at, source: EARNINGS_SOURCE_ID };
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const missingTimeEvent = {
  date: '2026-10-29',
  timeEst: null,
  eventTimeUtc: null,
  lastUpdated: '2026-08-12T23:30:03.000Z',
  dateStatus: 'projected',
};
const correctedEvent = {
  ...missingTimeEvent,
  timeEst: '16:00:00',
  eventTimeUtc: '2026-10-29T20:00:00.000Z',
};

const baseFetcher = async (request) => {
  const url = new URL(request.url);
  if (url.pathname === '/v1/earnings-events') return Response.json(envelope([]));
  if (url.pathname === '/v1/corporate-actions') {
    return Response.json({
      status: 'VERIFIED',
      source: 'MASSIVE_ACTIONS',
      splits: [{ executionDate: '2026-09-01' }],
    });
  }
  return Response.json({ error: 'unknown' }, { status: 404 });
};

const provider = new MassiveProvider({ fetcher: baseFetcher, now: () => NOW });
const liveResult = await provider.events('SPY', { decisionTime: NOW });
const newSplit = liveResult.value.find((event) => event.type === 'CORPORATE_SPLIT');
const oldSplit = {
  type: 'CORPORATE_SPLIT',
  at: Date.parse('2026-09-01T16:00:00Z'),
  source: 'MASSIVE_ACTIONS',
};

const oldMissing = oldEarningsMap(missingTimeEvent);
const newMissing = consumeEarningsEnvelope(envelope([missingTimeEvent]));
const newCorrected = consumeEarningsEnvelope(envelope([correctedEvent]));

const result = {
  schema: 'nuvo.b5b.earnings-consumer-replay.v1',
  baseCommit: 'd600c0b8e00936d31d550eff1d75cc4d4af6ca03',
  contractVersion: EARNINGS_SOURCE_CONTRACT_VERSION,
  missingTime: {
    old: {
      result: oldMissing,
      verdict: 'ACCEPTED_FABRICATED_TIME',
    },
    next: {
      error: newMissing.error,
      faultStage: newMissing.faultStage,
      verdict: 'REFUSED',
      containsInvented1600Z: JSON.stringify(newMissing).includes('T16:00:00Z'),
    },
  },
  correctedTime: {
    input: correctedEvent.eventTimeUtc,
    result: newCorrected.events[0],
    exactInstant: newCorrected.events[0].at === Date.parse(correctedEvent.eventTimeUtc),
  },
  splitIsolation: {
    old: oldSplit,
    next: newSplit,
    oldSha256: digest(oldSplit),
    nextSha256: digest(newSplit),
    byteIdentical: JSON.stringify(oldSplit) === JSON.stringify(newSplit),
    limitation: 'FR-026 split half remains open; date-only splits still receive 16:00Z.',
  },
  sealedEnvelopeFields: Object.keys(newCorrected.sourceEnvelope),
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
