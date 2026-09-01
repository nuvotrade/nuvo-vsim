import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  CUSTODY_REFRESH_DEBOUNCE_MS, custodyRefreshFailure, custodyRefreshPolicy,
  fullDashboard, liveDashboardScript,
} from '../cloudflare/worker.js';
import { performCustodyRefresh, queueCustodyRefresh } from '../cloudflare/custody-refresh.js';

test('custody refresh skips the broker below 60 seconds and refreshes at the boundary', () => {
  const now = Date.parse('2026-09-01T15:00:00.000Z');
  assert.deepEqual(custodyRefreshPolicy({
    observedAt: new Date(now - CUSTODY_REFRESH_DEBOUNCE_MS + 1).toISOString(),
  }, now), {
    refreshRequired: false,
    ageMs: CUSTODY_REFRESH_DEBOUNCE_MS - 1,
    thresholdMs: CUSTODY_REFRESH_DEBOUNCE_MS,
  });
  assert.equal(custodyRefreshPolicy({
    observedAt: new Date(now - CUSTODY_REFRESH_DEBOUNCE_MS).toISOString(),
  }, now).refreshRequired, true);
  assert.equal(custodyRefreshPolicy({ observedAt: 'not-a-date' }, now).refreshRequired, true);
  assert.equal(custodyRefreshPolicy({
    observedAt: new Date(now - 90_000).toISOString(),
  }, now, 120_000).refreshRequired, false);
});

test('account coordinator serializes refreshes and rechecks stored age before every broker call', async () => {
  const platform = readFileSync(new URL('../cloudflare/platform.js', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../cloudflare/worker.js', import.meta.url), 'utf8');
  assert.match(platform, /async refreshCustody\(ownerId,[\s\S]{0,1800}queueCustodyRefresh\(this\.snapshotTail/u);
  assert.match(platform, /FROM custody_latest WHERE owner_id=\?/u);
  assert.match(platform, /this\.snapshotTail = queued\.next/u);
  assert.match(worker, /accountCoordinator\(env, ownerId\)\.refreshCustody\(ownerId/u);
  assert.doesNotMatch(worker, /\/api\/operator\/custody\/refresh[\s\S]{0,900}reconciledSnapshot\(env, owner\.id\)/u);

  const now = Date.parse('2026-09-01T15:00:00.000Z');
  let observedAt = new Date(now - 10 * 60_000).toISOString();
  let brokerCalls = 0;
  let tail = Promise.resolve();
  const reads = Array.from({ length: 10 }, () => {
    const queued = queueCustodyRefresh(tail, () => performCustodyRefresh({
      now: () => now,
      readStored: async () => ({ observedAt, hash: 'stored' }),
      readBroker: async () => {
        brokerCalls += 1;
        observedAt = new Date(now).toISOString();
        return { asOf: observedAt, snapshotHash: 'fresh', positions: [], openOrders: [] };
      },
    }));
    tail = queued.next;
    return queued.task;
  });
  const results = await Promise.all(reads);
  assert.equal(brokerCalls, 1);
  assert.equal(results.filter(row => row.refreshed).length, 1);
  assert.equal(results.filter(row => row.debounced).length, 9);
});

test('custody refresh distinguishes Schwab throttling from an ordinary read failure', () => {
  assert.deepEqual(custodyRefreshFailure(new Error('SCHWAB_HTTP_429')), {
    code: 'SCHWAB_CUSTODY_RATE_LIMITED', status: 429, message: 'SCHWAB_HTTP_429',
  });
  assert.deepEqual(custodyRefreshFailure(new Error('SCHWAB_HTTP_503')), {
    code: 'SCHWAB_CUSTODY_REFRESH_FAILED', status: 503, message: 'SCHWAB_HTTP_503',
  });
});

test('BOT refresh is a genuine single-flight custody read with visible degradation', async () => {
  const html = await (await fullDashboard()).text();
  const botStart = html.indexOf('<section class="view" id="bot"');
  const botEnd = html.indexOf('</section>', botStart);
  const bot = html.slice(botStart, botEnd);
  assert.match(bot, /data-action="custodyRefresh">REFRESH/u);
  assert.match(bot, /data-vsim="bot-refresh-error" role="alert"/u);
  assert.doesNotMatch(bot, /BALANCE/u);

  const script = liveDashboardScript();
  assert.match(script, /api\('\/api\/operator\/custody\/refresh'/u);
  assert.match(script, /confirm: 'REFRESH_READ_ONLY_CUSTODY'/u);
  assert.match(script, /if \(custodyRefreshInFlight\) return custodyRefreshInFlight;/u);
  assert.match(script, /SCHWAB_CUSTODY_REFRESH_TIMEOUT/u);
  assert.match(script, /Fresh snapshot · broker call skipped/u);
  assert.match(script, /Stored snapshot · Schwab rate limited/u);
  assert.match(script, /error\.message === 'SCHWAB_CUSTODY_RATE_LIMITED'/u);
  assert.match(script, /CUSTODY REFRESH FAILED — showing stored snapshot/u);
  assert.match(script, /refresh\(\{ requestCustody: false \}\)/u);
  assert.equal((script.match(/await refresh\(\{ requestCustody: false \}\);/gu) || []).length, 1);
  assert.match(script, /window\.setTimeout\(\(\) => \{ refreshCustody\(\)/u);
  assert.match(script, /custodyFresh \? 'Shadow connected' : 'Custody stale'/u);
  assert.match(script, /CUSTODY DEGRADED/u);
  assert.match(script, /card\.dataset\.custodyState = custodyStale \? 'stale' : 'fresh'/u);
  assert.match(html, /metric-card\[data-custody-state="stale"\]/u);
  assert.doesNotMatch(script, /custodyRefresh[^\n]{0,240}\/orders/iu);
});
