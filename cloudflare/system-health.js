const COLORS = new Set(['GREEN', 'RED']);

export const SYSTEM_HEALTH = Object.freeze({
  CUSTODY_STALE_MS: 20 * 60 * 1000,
  LIVE_PROBE_STALE_MS: 5 * 60 * 1000,
  TAPE_STALE_MS: 5 * 60 * 1000,
});

function instant(value) {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

function row(label, color, status, asOf, detail, source) {
  if (!COLORS.has(color)) throw new Error(`SYSTEM_HEALTH_COLOR_INVALID:${color}`);
  return Object.freeze({ label, color, status, asOf: asOf ?? null, detail, source });
}

export function proofsForWorker(rows = [], workerVersion) {
  const result = {};
  for (const record of rows) {
    if (result[record.event_type]) continue;
    let detail = {};
    try { detail = JSON.parse(record?.detail_json ?? '{}'); } catch { continue; }
    const proofVersion = detail.workerVersion ?? null;
    result[record.event_type] = {
      at: record.created_at,
      workerVersion: proofVersion,
      currentWorker: proofVersion === workerVersion,
      error: detail.error ?? null,
      source: detail.source ?? null,
      spy: Number.isFinite(Number(detail.spy)) ? Number(detail.spy) : null,
      vix: Number.isFinite(Number(detail.vix)) ? Number(detail.vix) : null,
      asOf: detail.asOf ?? null,
    };
  }
  return result;
}

function fresh(value, nowMs, staleMs = SYSTEM_HEALTH.LIVE_PROBE_STALE_MS) {
  const at = instant(value);
  return at !== null && nowMs >= at && nowMs - at <= staleMs;
}

function liveProbe(probe, nowMs, { requirePayloadFresh = false } = {}) {
  if (!probe?.attempted || !probe.ok || !fresh(probe.at, nowMs)) return false;
  return !requirePayloadFresh || fresh(probe.asOf, nowMs);
}

function tapeSource(spyProbe, vixProbe) {
  const sources = [spyProbe?.source, vixProbe?.source].filter(Boolean)
    .map((value) => String(value).toUpperCase());
  if (!sources.length) return 'UNPROVEN';
  if (sources.every((value) => value.includes('TRADINGVIEW'))) return 'TRADINGVIEW';
  if (sources.some((value) => value.includes('POLYGON'))) return 'POLYGON';
  if (sources.some((value) => value.includes('MASSIVE'))) return 'MASSIVE';
  return [...new Set(sources)].join('+');
}

export function buildSystemHealth({
  now = Date.now(), dashboardVersion = 'local', marketVersion = 'unknown',
  storageProbe, schwabAuth, schwabConnection, custody, laneState,
  tradingViewEndpointProbe, tradingViewTape, spyProbe, vixProbe,
  marketIdentityProbe, discordProbe,
} = {}) {
  const nowMs = Number(now);
  const marketOpen = schwabAuth?.session === 'OPEN';

  const storageOk = liveProbe(storageProbe, nowMs);
  const d1 = row('D1', storageOk ? 'GREEN' : 'RED', storageOk ? 'LIVE' : 'DOWN',
    storageProbe?.at, storageOk ? 'D1 + R2 + DURABLE OBJECT VERIFIED'
      : (storageProbe?.error ?? 'STORAGE NOT PROBED'), 'D1_R2_DURABLE_OBJECT');

  const authOk = liveProbe(schwabAuth, nowMs);
  const custodyOk = Boolean(custody?.observedAt)
    && !(schwabConnection?.error
      && instant(schwabConnection?.updatedAt) >= instant(custody.observedAt))
    && (!marketOpen || fresh(custody.observedAt, nowMs, SYSTEM_HEALTH.CUSTODY_STALE_MS));
  const schwabOk = authOk && custodyOk;
  const schwab = row('SCHWAB', schwabOk ? 'GREEN' : 'RED', schwabOk ? 'LIVE' : 'DOWN',
    custody?.observedAt ?? schwabAuth?.at,
    schwabOk ? `AUTH + CUSTODY · ${marketOpen ? 'MARKET OPEN' : 'MARKET CLOSED'}`
      : (schwabAuth?.error ?? schwabConnection?.error ?? 'AUTH/CUSTODY UNPROVEN'),
    'SCHWAB_READ_ONLY');

  const identityOk = liveProbe(marketIdentityProbe, nowMs);
  const payloadsOk = liveProbe(spyProbe, nowMs, { requirePayloadFresh: marketOpen })
    && liveProbe(vixProbe, nowMs, { requirePayloadFresh: marketOpen });
  const marketOk = identityOk && payloadsOk;
  const providerSource = tapeSource(spyProbe, vixProbe);
  const market = row('MARKET', marketOk ? 'GREEN' : 'RED', marketOk ? 'LIVE' : 'DOWN',
    marketIdentityProbe?.at ?? spyProbe?.at ?? vixProbe?.at,
    marketOk ? `${providerSource} · ${marketOpen ? 'LIVE TAPE' : 'SERVICE REACHABLE · MARKET CLOSED'}`
      : (marketIdentityProbe?.error ?? spyProbe?.error ?? vixProbe?.error ?? 'MARKET SERVICE UNPROVEN'),
    providerSource);

  const endpointOk = liveProbe(tradingViewEndpointProbe, nowMs);
  const tvTapeFresh = tradingViewTape?.source === 'TRADINGVIEW'
    && Number.isFinite(tradingViewTape.spy) && Number.isFinite(tradingViewTape.vix)
    && fresh(tradingViewTape.asOf, nowMs, SYSTEM_HEALTH.TAPE_STALE_MS);
  const tvOk = endpointOk && (!marketOpen || tvTapeFresh);
  const tv = row('TV', tvOk ? 'GREEN' : 'RED', tvOk ? 'LIVE' : 'DOWN',
    tvTapeFresh ? tradingViewTape.asOf : tradingViewEndpointProbe?.at,
    tvOk ? (marketOpen ? 'ENDPOINT + TRADINGVIEW TAPE' : 'ENDPOINT REACHABLE · MARKET CLOSED')
      : (tradingViewEndpointProbe?.error ?? (marketOpen ? 'TRADINGVIEW TAPE STALE' : 'ENDPOINT UNREACHABLE')),
    tvTapeFresh ? 'TRADINGVIEW' : 'TRADINGVIEW_ENDPOINT');

  const discordOk = liveProbe(discordProbe, nowMs);
  const discord = row('DISCORD', discordOk ? 'GREEN' : 'RED', discordOk ? 'LIVE' : 'DOWN',
    discordProbe?.at, discordOk ? 'SILENT WEBHOOK VALIDATION' : (discordProbe?.error ?? 'NEVER_PROBED'),
    'DISCORD_WEBHOOK_GET');

  const connectorsOk = [d1, schwab, market, tv, discord].every((entry) => entry.color === 'GREEN');
  const armed = laneState?.armed === true;
  const laneFault = laneState?.configurationFault ?? laneState?.fault?.faultCode ?? null;
  const botReady = armed && connectorsOk && !laneFault;
  const bot = row('BOT', botReady ? 'GREEN' : 'RED', botReady ? 'READY' : armed ? 'BLOCKED' : 'OFF',
    laneState?.updatedAt ?? schwabAuth?.at,
    botReady ? (marketOpen ? 'ARMED · READY FOR VALID TV SIGNAL' : 'WAITING · MARKET CLOSED')
      : (!armed ? 'DISARMED' : (laneFault ?? 'CONNECTOR GATE FAILED')),
    'DURABLE_ARM_AND_FAIL_CLOSED_GATES');

  const rows = Object.freeze([d1, schwab, market, tv, discord, bot]);
  const allHealthy = rows.every((entry) => entry.color === 'GREEN');
  return Object.freeze({
    status: allHealthy ? 'ALL HEALTHY' : 'ACTION REQUIRED',
    color: allHealthy ? 'GREEN' : 'RED',
    checkedAt: new Date(nowMs).toISOString(),
    versions: Object.freeze({ dashboard: dashboardVersion, market: marketVersion }),
    rows,
    tape: Object.freeze({
      spy: tvTapeFresh ? tradingViewTape.spy
        : Number.isFinite(Number(spyProbe?.value)) ? Number(spyProbe.value) : null,
      vix: tvTapeFresh ? tradingViewTape.vix
        : Number.isFinite(Number(vixProbe?.value)) ? Number(vixProbe.value) : null,
      source: tvTapeFresh ? 'TRADINGVIEW' : providerSource,
      asOf: tvTapeFresh ? tradingViewTape.asOf : spyProbe?.asOf ?? vixProbe?.asOf ?? null,
    }),
  });
}
