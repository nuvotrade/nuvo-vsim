import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MassiveProvider } from '../src/truth/providers/massive.js';
import { SchwabMarketProvider } from '../src/truth/providers/schwab.js';
import { PRODUCTION_CLOCK_CONTRACT_VERSION } from '../src/truth/providers/clock_contract.js';

const DAY_MS = 86_400_000;
const EVENT_DECISION_TIME = Date.UTC(2026, 7, 27, 23, 58, 30);
const symbols = Array.from({ length: 198 }, (_, index) => `SYM${String(index + 1).padStart(3, '0')}`);

function ymd(value) {
  return new Date(value).toISOString().slice(0, 10);
}

const oldWindows = symbols.map((symbol, index) => {
  const providerClock = EVENT_DECISION_TIME + index * 1000;
  return {
    symbol,
    providerClock,
    from: ymd(providerClock - 2 * DAY_MS),
    through: ymd(providerClock + 60 * DAY_MS),
  };
});

const eventRequests = [];
let eventClock = EVENT_DECISION_TIME;
const eventProvider = new MassiveProvider({
  now: () => (eventClock += 1000),
  fetcher: async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/v1/earnings-events') {
      eventRequests.push({
        symbol: url.searchParams.get('ticker'),
        from: url.searchParams.get('from'),
        through: url.searchParams.get('through'),
      });
      return Response.json({ status: 'VERIFIED', source: 'TEST_EARNINGS', events: [] });
    }
    if (url.pathname === '/v1/corporate-actions') {
      return Response.json({ status: 'VERIFIED', source: 'TEST_ACTIONS', splits: [] });
    }
    return Response.json({ error: 'UNEXPECTED_PATH' }, { status: 404 });
  },
});
for (const symbol of symbols) {
  const result = await eventProvider.events(symbol, { decisionTime: EVENT_DECISION_TIME });
  if (result.error) throw new Error(`${symbol}:${result.error}`);
}

const uniqueOldWindows = new Set(oldWindows.map((row) => `${row.from}:${row.through}`));
const uniqueNewWindows = new Set(eventRequests.map((row) => `${row.from}:${row.through}`));

const QUOTE_BASE = Date.UTC(2026, 7, 27, 16, 0, 0);
const acquisitions = [QUOTE_BASE, QUOTE_BASE + 130_000];
let acquisitionIndex = 0;
const expirationDate = ymd(EVENT_DECISION_TIME + 14 * DAY_MS);
const option = (right) => ({
  symbol: `TEST_${right}`,
  putCall: right,
  strikePrice: right === 'put' ? 95 : 105,
  expirationDate: new Date(`${expirationDate}T00:00:00Z`).getTime(),
  daysToExpiration: 14,
  bid: 1,
  ask: 1.1,
  mark: 1.05,
  volatility: 25,
  delta: right === 'put' ? -0.25 : 0.25,
  gamma: 0.01,
  theta: -0.03,
  vega: 0.1,
  openInterest: 1000,
  totalVolume: 100,
  multiplier: 100,
  quoteTimeInLong: QUOTE_BASE - 1000,
});
const quoteProvider = new SchwabMarketProvider({
  ownerId: 'owner',
  maxChainAgeMs: 120_000,
  maxQuoteAgeMs: 60_000,
  now: () => acquisitions[acquisitionIndex++] ?? acquisitions.at(-1),
  client: {
    async marketOptionChain() {
      return {
        putExpDateMap: { [`${expirationDate}:14`]: { 95: [option('put')] } },
        callExpDateMap: { [`${expirationDate}:14`]: { 105: [option('call')] } },
      };
    },
    async marketQuote() {
      return {
        value: { symbol: 'TEST', last: 100, bid: 99.99, ask: 100.01 },
        asOf: QUOTE_BASE + 129_000,
        source: 'SCHWAB_MARKET_DATA_REALTIME',
      };
    },
  },
});
const chain = await quoteProvider.optionChain('TEST', {
  expirations: [14],
  decisionTime: EVENT_DECISION_TIME,
});
if (chain.error) throw new Error(chain.error);

const oldSharedEvaluationTime = acquisitions.at(-1);
const quoteRows = [{
  response: 'SCHWAB_OPTION_CHAIN',
  acquiredAt: acquisitions[0],
  vendorQuoteAsOf: QUOTE_BASE - 1000,
  oldSharedAgeMs: oldSharedEvaluationTime - (QUOTE_BASE - 1000),
  oldAccepted: oldSharedEvaluationTime - (QUOTE_BASE - 1000) <= 120_000,
  newPerResponseAgeMs: 1000,
  newAccepted: true,
}, {
  response: 'SCHWAB_UNDERLYING_QUOTE',
  acquiredAt: acquisitions[1],
  vendorQuoteAsOf: QUOTE_BASE + 129_000,
  oldSharedAgeMs: 1000,
  oldAccepted: true,
  newPerResponseAgeMs: 1000,
  newAccepted: true,
}];

const chainTrueAgeMs = acquisitions[0] - (QUOTE_BASE - 1000);
const siblingDelaySensitivity = [0, 30_000, 60_000, 90_000, 119_000, 120_000, 130_000]
  .map((siblingDelayMs) => {
    const oldSharedAgeMs = chainTrueAgeMs + siblingDelayMs;
    return {
      siblingDelayMs,
      oldSharedAgeMs,
      oldAccepted: oldSharedAgeMs <= 120_000,
      newPerResponseAgeMs: chainTrueAgeMs,
      newAccepted: chainTrueAgeMs <= 120_000,
    };
  });

const output = {
  packet: 'FR-006B',
  contractVersion: PRODUCTION_CLOCK_CONTRACT_VERSION,
  eventMembership: {
    population: symbols.length,
    decisionTime: EVENT_DECISION_TIME,
    oldUniqueWindows: uniqueOldWindows.size,
    newUniqueWindows: uniqueNewWindows.size,
    oldFirst: oldWindows[0],
    oldLast: oldWindows.at(-1),
    newFirst: eventRequests[0],
    newLast: eventRequests.at(-1),
  },
  quoteFreshness: {
    currentMarketSource: 'SCHWAB_MARKET_DATA',
    currentLiveTopology: 'ONE_SCHWAB_CHAIN_RESPONSE_CONCURRENT_WITH_ONE_SCHWAB_UNDERLYING_RESPONSE',
    dormantMassiveTopology: 'MULTIPLE_EXPIRATION_RIGHT_RESPONSES_NOT_CURRENT_LIVE_OPTION_SOURCE',
    configuredChainMaxAgeMs: 120_000,
    configuredUnderlyingMaxAgeMs: 60_000,
    scenario: 'DETERMINISTIC_STRESS_REPLAY_NOT_OBSERVED_INCIDENCE',
    oldSharedEvaluationTime,
    oldChainResponseAccepted: quoteRows[0].oldAccepted,
    newChainResponseAccepted: chain.value.contracts.length === 2,
    newContractCount: chain.value.contracts.length,
    contractVerdicts: chain.value.contracts.map((contract) => ({
      symbol: contract.symbol,
      right: contract.right,
      oldAccepted: quoteRows[0].oldAccepted,
      oldReason: quoteRows[0].oldAccepted ? null : 'SCHWAB_EXECUTABLE_CHAIN_UNAVAILABLE',
      newAccepted: true,
    })),
    acquisitionTimes: chain.acquisitionTimes,
    rows: quoteRows,
    sensitivity: {
      chainTrueAgeMs,
      falseRefusalWhenSiblingDelayMsGreaterThan: 119_000,
      boundaryReason: 'oldSharedAgeMs = chainTrueAgeMs + siblingDelayMs; refusal occurs only above 120000 ms',
      rows: siblingDelaySensitivity,
    },
    historicalIncidence: null,
    historicalIncidenceReason: 'Legacy evidence did not seal per-response acquisition times.',
  },
};

const outputPath = process.argv[2]
  ? resolve(process.argv[2])
  : resolve('docs/evidence/fr-006b/OLD_VS_NEW_REPLAY.json');
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
