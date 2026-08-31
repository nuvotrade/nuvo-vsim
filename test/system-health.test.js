import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemHealth, proofsForWorker } from '../cloudflare/system-health.js';
import { handleLane1TvWebhook } from '../cloudflare/lane-1-runtime.js';
import {
  discordWebhookProbe, fullDashboard, liveDashboardScript, rewriteDesignHtml,
  tradingViewEndpointProbe,
} from '../cloudflare/worker.js';

const NOW = Date.parse('2026-08-28T20:00:00.000Z');
const at = (delta) => new Date(NOW + delta).toISOString();
const byLabel = (model) => Object.fromEntries(model.rows.map((row) => [row.label, row]));
const probe = (extra = {}) => ({ attempted: true, ok: true, at: at(-1_000), ...extra });

function healthy(extra = {}) {
  return buildSystemHealth({
    now: NOW, dashboardVersion: 'dashboard-sha', marketVersion: 'market-sha',
    storageProbe: probe(),
    schwabAuth: probe({ session: 'OPEN' }),
    schwabConnection: { status: 'CONNECTED' },
    custody: { observedAt: at(-2_000) },
    laneState: { armed: true, updatedAt: at(-500) },
    tradingViewEndpointProbe: probe(),
    tradingViewTape: { source: 'TRADINGVIEW', spy: 770.11, vix: 15.03, asOf: at(-1_000) },
    spyProbe: probe({ value: 769.27, source: 'POLYGON_SNAPSHOT', asOf: at(-500) }),
    vixProbe: probe({ value: 14.82, source: 'MASSIVE', asOf: at(-600) }),
    marketIdentityProbe: probe({ versionId: 'market-sha' }),
    discordProbe: probe(),
    ...extra,
  });
}

test('System card is exactly six binary connector tiles with version identity', () => {
  const model = healthy();
  assert.deepEqual(model.rows.map((row) => row.label), ['D1', 'SCHWAB', 'MARKET', 'TV', 'DISCORD', 'BOT']);
  assert.ok(model.rows.every((row) => ['GREEN', 'RED'].includes(row.color)));
  assert.ok(model.rows.every((row) => row.color === 'GREEN'));
  assert.equal(model.status, 'ALL HEALTHY');
  assert.deepEqual(model.versions, { dashboard: 'dashboard-sha', market: 'market-sha' });
});

test('configuration alone proves nothing and fail-closed state stays red', () => {
  const model = buildSystemHealth({ now: NOW, schwabConnection: { status: 'CONNECTED' },
    laneState: { armed: true } });
  assert.equal(model.status, 'ACTION REQUIRED');
  assert.ok(model.rows.every((row) => row.color === 'RED'));
  assert.equal(byLabel(model).BOT.status, 'BLOCKED');
});

test('market close does not paint reachable services red or call stale close data live', () => {
  const oldClose = at(-4 * 60 * 60 * 1000);
  const model = healthy({
    schwabAuth: probe({ session: 'CLOSED' }),
    tradingViewTape: null,
    spyProbe: probe({ value: 769.27, source: 'DAY_CLOSE+YAHOO', asOf: oldClose }),
    vixProbe: probe({ value: 14.82, source: 'MASSIVE_DAY_CLOSE', asOf: oldClose }),
  });
  const rows = byLabel(model);
  assert.equal(rows.MARKET.color, 'GREEN');
  assert.match(rows.MARKET.detail, /MARKET CLOSED/u);
  assert.equal(rows.TV.color, 'GREEN');
  assert.equal(rows.BOT.color, 'GREEN');
  assert.equal(rows.BOT.detail, 'WAITING · MARKET CLOSED');
  assert.equal(model.tape.source, 'MASSIVE');
});

test('open-session stale market and TradingView tape fail closed', () => {
  const stale = at(-10 * 60 * 1000);
  const model = healthy({
    tradingViewTape: { source: 'TRADINGVIEW', spy: 1, vix: 2, asOf: stale },
    spyProbe: probe({ value: 1, source: 'POLYGON', asOf: stale }),
    vixProbe: probe({ value: 2, source: 'MASSIVE', asOf: stale }),
  });
  const rows = byLabel(model);
  assert.equal(rows.MARKET.color, 'RED');
  assert.equal(rows.TV.color, 'RED');
  assert.equal(rows.BOT.color, 'RED');
});

test('valid recent operational proof survives a Worker version change', () => {
  const records = [
    { event_type: 'LANE_1_TV_TAPE', created_at: at(-1_000),
      detail_json: JSON.stringify({ workerVersion: 'prior', source: 'TRADINGVIEW',
        spy: 771.2, vix: 15.1, asOf: at(-1_200) }) },
  ];
  const proof = proofsForWorker(records, 'current');
  assert.equal(proof.LANE_1_TV_TAPE.spy, 771.2);
  assert.equal(proof.LANE_1_TV_TAPE.currentWorker, false);
});

test('same-host invalid-signal response proves the TradingView endpoint without a secret', async () => {
  const calls = [];
  const result = await tradingViewEndpointProbe({ PUBLIC_ORIGIN: 'https://example.test' }, async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body });
    return new Response(JSON.stringify({ faultCode: 'LANE_1_INVALID_SIGNAL', sent: false }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ url: 'https://example.test/lane/tv', method: 'POST', body: '{}' }]);
});

test('Discord heartbeat uses silent GET validation and sends no message', async () => {
  const calls = [];
  const result = await discordWebhookProbe({
    LANE_1_DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/token',
  }, async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body });
    return new Response(JSON.stringify({ id: '123' }), { status: 200,
      headers: { 'content-type': 'application/json' } });
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ url: 'https://discord.com/api/webhooks/123/token', method: 'GET', body: undefined }]);
});

test('TradingView TAPE heartbeat is authenticated, records data, and never enters order runtime', async () => {
  const eventTypes = [];
  const env = {
    LANE_1_TV_WEBHOOK_SECRET: 'secret', CF_VERSION_METADATA: { id: 'worker-1' },
    DB: { prepare() { return { bind(...values) { eventTypes.push(values[2]);
      return { async run() { return { success: true }; } }; } }; } },
  };
  const request = new Request('https://vsim.nuvotrade.co/lane/tv', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'TAPE', ticker: 'SPY', source: 'TRADINGVIEW',
      spy: 769.27, vix: 14.82, asOf: new Date().toISOString(), secret: 'secret' }),
  });
  const response = await handleLane1TvWebhook({ request, env, ownerId: 'owner' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { state: 'OBSERVED', disposition: 'tape', sent: false });
  assert.deepEqual(eventTypes, ['LANE_1_TV_INGRESS', 'LANE_1_TV_TAPE']);
});

test('Overview renderer is a quiet two-column grid with explicit Pacific time', () => {
  const script = liveDashboardScript();
  assert.match(script, /system-health-grid/u);
  assert.match(script, /'D1','SCHWAB','MARKET','TV','DISCORD','BOT'/u);
  assert.match(script, /timeZone: 'America\/Los_Angeles'/u);
  const renderer = script.slice(script.indexOf("const systemCards = qa('.system-brief')"),
    script.indexOf('function renderOpportunities'));
  assert.doesNotMatch(renderer, /alert\(|confirm\(|health-amber|tv-live-widget/u);
  assert.match(renderer, /Dashboard v/u);
  assert.match(renderer, /Market v/u);
  const html = rewriteDesignHtml('<html><head><title>NUVO VSIM v5 — Shadow Preview</title><link href="styles.css"></head><body><script src="app.js"></script></body></html>');
  assert.match(html, /system-health-tile/u);
  assert.match(fullDashboard('<html><head><title>NUVO VSIM v5 — Shadow Preview</title></head><body></body></html>')
    .headers.get('content-security-policy'), /frame-ancestors 'none'/u);
});

test('telemetry never stores the TradingView secret', () => {
  const source = readFileSync(new URL('../cloudflare/lane-1-runtime.js', import.meta.url), 'utf8');
  const recorder = source.slice(source.indexOf('async function recordOperationalProof'),
    source.indexOf('function easternDate'));
  assert.doesNotMatch(recorder, /secret/u);
});
