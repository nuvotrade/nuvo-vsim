import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemHealth, proofsForWorker,
  tradingViewIngressHealth } from '../cloudflare/system-health.js';
import { handleLane1TvWebhook } from '../cloudflare/lane-1-runtime.js';
import {
  discordWebhookProbe, fullDashboard, liveDashboardScript, rewriteDesignHtml,
  schwabRealtimeMarketProbe,
} from '../cloudflare/worker.js';
import worker from '../cloudflare/worker.js';

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
    tradingViewIngressHealth: { attempted: true, ok: true, state: 'HEALTHY',
      at: at(-1_000), evidenceAt: at(-1_000), ingressId: 'INGRESS-1',
      instruction: 'SELL_SHORT', recent: true },
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
  assert.ok(model.rows.filter((row) => row.label !== 'TV')
    .every((row) => row.color === 'RED'));
  assert.equal(byLabel(model).TV.color, 'AMBER');
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
  assert.match(rows.MARKET.detail, /SPY_QUOTE_STALE_600S/u);
});

test('market health uses authoritative Schwab real-time quotes and verifies master reachability', async () => {
  const result = await schwabRealtimeMarketProbe({
    async marketQuote(_ownerId, symbol) {
      return { value: { last: symbol === 'SPY' ? 765.12 : 15.4 }, asOf: NOW - 500,
        source: 'SCHWAB_MARKET_DATA_REALTIME' };
    },
  }, 'owner', 'SPY');
  assert.equal(result.ok, true);
  assert.equal(result.value, 765.12);
  assert.equal(result.source, 'SCHWAB_MARKET_DATA_REALTIME');
  const market = byLabel(healthy({
    spyProbe: probe({ value: 765.12, source: 'SCHWAB_MARKET_DATA_REALTIME', asOf: at(-500) }),
    vixProbe: probe({ value: 15.4, source: 'SCHWAB_MARKET_DATA_REALTIME', asOf: at(-500) }),
  })).MARKET;
  assert.equal(market.color, 'GREEN');
  assert.match(market.detail, /SCHWAB REALTIME · MASTER SERVICE REACHABLE · LIVE TAPE/u);
});

test('failed login custody refresh cannot inherit a green Schwab tile from cached custody', () => {
  const rows = byLabel(healthy({ custodyRefreshProbe: probe({ ok: false,
    error: 'SCHWAB_CUSTODY_REFRESH_FAILED' }) }));
  assert.equal(rows.SCHWAB.color, 'RED');
  assert.equal(rows.SCHWAB.detail, 'SCHWAB_CUSTODY_REFRESH_FAILED');
  assert.equal(rows.BOT.status, 'BLOCKED');
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

test('TV health is UNPROVEN on a new Worker and silence never becomes broken', () => {
  const prior = { id: 'INGRESS-PRIOR', event_type: 'LANE_1_TV_INGRESS',
    created_at: at(-18 * 60 * 60 * 1000), detail_json: JSON.stringify({
      workerVersion: 'prior', ingressKind: 'ORDER_SIGNAL', signalShapeAccepted: true,
      replayEligible: true, acceptedInstruction: 'SELL_SHORT' }) };
  const proof = proofsForWorker([prior], 'current').LANE_1_TV_INGRESS;
  const health = tradingViewIngressHealth(proof, 'current', NOW);
  assert.equal(health.state, 'UNPROVEN');
  const model = healthy({ tradingViewIngressHealth: health,
    schwabAuth: probe({ session: 'CLOSED' }), tradingViewTape: null });
  const tv = byLabel(model).TV;
  assert.equal(tv.color, 'AMBER');
  assert.equal(tv.status, 'UNPROVEN');
  assert.match(tv.detail, /SILENCE IS NOT A FAULT/u);
  assert.doesNotMatch(tv.detail, /STALE|BROKEN/u);
  assert.equal(byLabel(model).BOT.color, 'GREEN');
  assert.match(byLabel(model).BOT.detail, /WAITING FOR FIRST SIGNAL PROOF/u);
  assert.equal(model.status, 'UNPROVEN');
});

test('accepted current-version ingress flips TV to green and records time and ingress ID', () => {
  const record = { id: 'INGRESS-CURRENT', event_type: 'LANE_1_TV_INGRESS',
    created_at: at(-2_000), detail_json: JSON.stringify({ workerVersion: 'current',
      ingressKind: 'ORDER_SIGNAL', signalShapeAccepted: true, replayEligible: true,
      acceptedInstruction: 'SELL_SHORT' }) };
  const proof = proofsForWorker([record], 'current').LANE_1_TV_INGRESS;
  const health = tradingViewIngressHealth(proof, 'current', NOW);
  assert.equal(health.state, 'HEALTHY');
  assert.equal(health.ingressId, 'INGRESS-CURRENT');
  assert.equal(health.evidenceAt, at(-2_000));
  const tv = byLabel(healthy({ tradingViewIngressHealth: health })).TV;
  assert.equal(tv.color, 'GREEN');
  assert.match(tv.detail, /INGRESS-CURRENT/u);
});

test('fresh external route proof makes TV live without inventing a signal', () => {
  const routeRecord = { id: 'ROUTE-CURRENT', event_type: 'LANE_1_TV_ROUTE_PROBE',
    created_at: at(-2_000), detail_json: JSON.stringify({ workerVersion: 'current',
      probeKind: 'PUBLIC_ROUTE_GET', route: '/lane/tv' }) };
  const routeProof = proofsForWorker([routeRecord], 'current').LANE_1_TV_ROUTE_PROBE;
  const health = tradingViewIngressHealth(null, 'current', NOW, routeProof);
  assert.equal(health.state, 'REACHABLE');
  assert.equal(health.ok, true);
  const model = healthy({ tradingViewIngressHealth: health, tradingViewTape: null });
  const tv = byLabel(model).TV;
  assert.equal(tv.color, 'GREEN');
  assert.equal(tv.status, 'LIVE');
  assert.match(tv.detail, /PUBLIC INGRESS ROUTE REACHABLE · NO SIGNAL REQUIRED/u);
  assert.doesNotMatch(tv.detail, /RECENT SIGNAL/u);
  assert.equal(model.status, 'ALL HEALTHY');
});

test('stale route proof cannot paint TradingView green', () => {
  const routeRecord = { id: 'ROUTE-STALE', event_type: 'LANE_1_TV_ROUTE_PROBE',
    created_at: at(-10 * 60 * 1000), detail_json: JSON.stringify({ workerVersion: 'current',
      probeKind: 'PUBLIC_ROUTE_GET', route: '/lane/tv' }) };
  const routeProof = proofsForWorker([routeRecord], 'current').LANE_1_TV_ROUTE_PROBE;
  assert.equal(tradingViewIngressHealth(null, 'current', NOW, routeProof).state, 'UNPROVEN');
});

test('public TV route probe consumes one authenticated challenge and never dispatches', async () => {
  const challengeDetail = JSON.stringify({ workerVersion: 'current',
    expiresAt: new Date(Date.now() + 60_000).toISOString() });
  let consumed = false;
  const env = {
    NUVO_AUTHORITY_LEVEL: '2', ACCESS_OWNER_ID: 'owner',
    CF_VERSION_METADATA: { id: 'current' },
    DB: { prepare(sql) { return { bind(...values) { return {
      async first() {
        if (!sql.includes('DASHBOARD_TV_ROUTE_CHALLENGE') || values[0] !== 'challenge-1') return null;
        return consumed ? null : { detail_json: challengeDetail };
      },
      async run() {
        if (!sql.includes("SET event_type='LANE_1_TV_ROUTE_PROBE'")) throw new Error('unexpected write');
        if (consumed) return { meta: { changes: 0 } };
        consumed = true;
        return { meta: { changes: 1 } };
      },
    }; } }; } },
  };
  const first = await worker.fetch(new Request(
    'https://vsim.nuvotrade.co/lane/tv?health=1&challenge=challenge-1'), env, {});
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { state: 'REACHABLE', workerVersion: 'current',
    proofId: 'challenge-1', orderDispatch: false });
  const replay = await worker.fetch(new Request(
    'https://vsim.nuvotrade.co/lane/tv?health=1&challenge=challenge-1'), env, {});
  assert.equal(replay.status, 403);
});

test('explicit failed authenticated ingress is red and can never report healthy', () => {
  const record = { id: 'INGRESS-BROKEN', event_type: 'LANE_1_TV_INGRESS',
    created_at: at(-2_000), detail_json: JSON.stringify({ workerVersion: 'current',
      ingressKind: 'ORDER_SIGNAL', signalShapeAccepted: false, replayEligible: false,
      signalFaultCode: 'LANE_1_INVALID_SIGNAL' }) };
  const proof = proofsForWorker([record], 'current').LANE_1_TV_INGRESS;
  const health = tradingViewIngressHealth(proof, 'current', NOW);
  assert.equal(health.state, 'BROKEN');
  const tv = byLabel(healthy({ tradingViewIngressHealth: health,
    schwabAuth: probe({ session: 'CLOSED' }), tradingViewTape: null })).TV;
  assert.equal(tv.color, 'RED');
  assert.equal(tv.status, 'DOWN');
});

test('old accepted current-version ingress remains healthy without inferring STALE', () => {
  const record = { id: 'INGRESS-OLD', event_type: 'LANE_1_TV_INGRESS',
    created_at: at(-4 * 60 * 60 * 1000), detail_json: JSON.stringify({ workerVersion: 'current',
      ingressKind: 'ORDER_SIGNAL', signalShapeAccepted: true, replayEligible: true,
      acceptedInstruction: 'BUY' }) };
  const health = tradingViewIngressHealth(
    proofsForWorker([record], 'current').LANE_1_TV_INGRESS, 'current', NOW);
  assert.equal(health.recent, false);
  const tv = byLabel(healthy({ tradingViewIngressHealth: health,
    schwabAuth: probe({ session: 'CLOSED' }), tradingViewTape: null })).TV;
  assert.equal(tv.color, 'GREEN');
  assert.match(tv.detail, /HEALTHY · NO NEW SIGNAL/u);
  assert.doesNotMatch(tv.detail, /STALE|BROKEN/u);
});

test('Worker source contains no self-referential POST to the order ingress route', () => {
  const source = readFileSync(new URL('../cloudflare/worker.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /PUBLIC_ORIGIN[\s\S]{0,600}\/lane\/tv/u);
  assert.doesNotMatch(source, /\/lane\/tv[\s\S]{0,180}body:\s*'\{\}'/u);
  assert.match(source, /credentials: 'omit'/u);
  assert.match(source, /DASHBOARD_TV_ROUTE_CHALLENGE[\s\S]{0,900}LANE_1_TV_ROUTE_PROBE/u);
  assert.match(source, /event_type='DASHBOARD_TV_ROUTE_CHALLENGE'/u);
  assert.match(source, /TV_ROUTE_CHALLENGE_ALREADY_USED/u);
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
  assert.match(script, /\/api\/self-audit/u);
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
