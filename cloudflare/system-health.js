const COLORS = new Set(['GREEN', 'AMBER', 'RED']);

export const SYSTEM_HEALTH = Object.freeze({
  CUSTODY_STALE_MS: 20 * 60 * 1000,
  LIVE_PROBE_STALE_MS: 5 * 60 * 1000,
  TAPE_STALE_MS: 5 * 60 * 1000,
  RECENT_SIGNAL_MS: 30 * 60 * 1000,
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
      ingressId: record.id ?? detail.ingressId ?? null,
      acceptedInstruction: detail.acceptedInstruction ?? null,
      ingressKind: detail.ingressKind ?? null,
      probeKind: detail.probeKind ?? null,
      route: detail.route ?? null,
      signalShapeAccepted: detail.signalShapeAccepted === true,
      replayEligible: detail.replayEligible === true,
      spy: Number.isFinite(Number(detail.spy)) ? Number(detail.spy) : null,
      vix: Number.isFinite(Number(detail.vix)) ? Number(detail.vix) : null,
      asOf: detail.asOf ?? null,
    };
  }
  return result;
}

const LANE_1_INSTRUCTIONS = new Set(['BUY', 'SELL', 'SELL_SHORT', 'BUY_TO_COVER']);

export function tradingViewIngressHealth(proof, workerVersion, now = Date.now(), routeProof = null) {
  const at = new Date(Number(now)).toISOString();
  if (!proof || proof.currentWorker !== true || proof.workerVersion !== workerVersion) {
    const routeReachable = routeProof?.currentWorker === true
      && routeProof.workerVersion === workerVersion
      && routeProof.probeKind === 'PUBLIC_ROUTE_GET'
      && routeProof.route === '/lane/tv'
      && !routeProof.error
      && fresh(routeProof.at, Number(now));
    if (routeReachable) {
      return Object.freeze({ attempted: true, ok: true, state: 'REACHABLE', at,
        evidenceAt: routeProof.at, ingressId: routeProof.ingressId,
        instruction: null, recent: true, error: null });
    }
    return Object.freeze({ attempted: false, ok: false, state: 'UNPROVEN', at,
      evidenceAt: proof?.at ?? null, ingressId: proof?.ingressId ?? null,
      error: 'TV_INGRESS_UNPROVEN_ON_CURRENT_VERSION' });
  }
  const accepted = proof.ingressKind === 'ORDER_SIGNAL'
    && proof.signalShapeAccepted === true && proof.replayEligible === true
    && LANE_1_INSTRUCTIONS.has(proof.acceptedInstruction) && !proof.error;
  if (!accepted) {
    return Object.freeze({ attempted: true, ok: false, state: 'BROKEN', at,
      evidenceAt: proof.at ?? null, ingressId: proof.ingressId ?? null,
      error: proof.error ?? 'TV_AUTHENTICATED_INGRESS_INVALID' });
  }
  return Object.freeze({ attempted: true, ok: true, state: 'HEALTHY', at,
    evidenceAt: proof.at, ingressId: proof.ingressId,
    instruction: proof.acceptedInstruction,
    recent: fresh(proof.at, Number(now), SYSTEM_HEALTH.RECENT_SIGNAL_MS), error: null });
}

function fresh(value, nowMs, staleMs = SYSTEM_HEALTH.LIVE_PROBE_STALE_MS) {
  const at = instant(value);
  return at !== null && nowMs >= at && nowMs - at <= staleMs;
}

function liveProbe(probe, nowMs, { requirePayloadFresh = false } = {}) {
  if (!probe?.attempted || !probe.ok || !fresh(probe.at, nowMs)) return false;
  return !requirePayloadFresh || fresh(probe.asOf, nowMs);
}

function probeFailure(probe, nowMs, label, { requirePayloadFresh = true } = {}) {
  if (!probe?.attempted) return `${label}_NOT_ATTEMPTED`;
  if (!probe.ok) return probe.error ?? `${label}_FAILED`;
  if (!fresh(probe.at, nowMs)) return `${label}_CHECK_STALE`;
  if (requirePayloadFresh && !fresh(probe.asOf, nowMs)) {
    const observed = instant(probe.asOf);
    const ageSeconds = observed === null ? null : Math.max(0, Math.floor((nowMs - observed) / 1000));
    return ageSeconds === null ? `${label}_TIMESTAMP_MISSING` : `${label}_STALE_${ageSeconds}S`;
  }
  return null;
}

function tapeSource(spyProbe, vixProbe) {
  const sources = [spyProbe?.source, vixProbe?.source].filter(Boolean)
    .map((value) => String(value).toUpperCase());
  if (!sources.length) return 'UNPROVEN';
  if (sources.every((value) => value.includes('SCHWAB'))) return 'SCHWAB REALTIME';
  if (sources.every((value) => value.includes('TRADINGVIEW'))) return 'TRADINGVIEW';
  if (sources.some((value) => value.includes('POLYGON'))) return 'POLYGON';
  if (sources.some((value) => value.includes('MASSIVE'))) return 'MASSIVE';
  return [...new Set(sources)].join('+');
}

export function buildSystemHealth({
  now = Date.now(), dashboardVersion = 'local', marketVersion = 'unknown',
  storageProbe, schwabAuth, schwabConnection, custody, laneState,
  tradingViewIngressHealth: tvIngress, tradingViewTape, spyProbe, vixProbe,
  marketIdentityProbe, discordProbe, custodyRefreshProbe,
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
  const refreshOk = custodyRefreshProbe === undefined || liveProbe(custodyRefreshProbe, nowMs);
  const schwabOk = authOk && custodyOk && refreshOk;
  const schwab = row('SCHWAB', schwabOk ? 'GREEN' : 'RED', schwabOk ? 'LIVE' : 'DOWN',
    custody?.observedAt ?? schwabAuth?.at,
    schwabOk ? `AUTH + CUSTODY · ${marketOpen ? 'MARKET OPEN' : 'MARKET CLOSED'}`
      : (custodyRefreshProbe?.error ?? schwabAuth?.error ?? schwabConnection?.error
        ?? 'AUTH/CUSTODY UNPROVEN'),
    'SCHWAB_READ_ONLY');

  const identityOk = liveProbe(marketIdentityProbe, nowMs);
  const payloadsOk = liveProbe(spyProbe, nowMs, { requirePayloadFresh: marketOpen })
    && liveProbe(vixProbe, nowMs, { requirePayloadFresh: marketOpen });
  const marketOk = identityOk && payloadsOk;
  const providerSource = tapeSource(spyProbe, vixProbe);
  const market = row('MARKET', marketOk ? 'GREEN' : 'RED', marketOk ? 'LIVE' : 'DOWN',
    marketIdentityProbe?.at ?? spyProbe?.at ?? vixProbe?.at,
    marketOk ? `${providerSource} · MASTER SERVICE REACHABLE · ${marketOpen ? 'LIVE TAPE' : 'MARKET CLOSED'}`
      : (probeFailure(marketIdentityProbe, nowMs, 'MASTER_SERVICE', { requirePayloadFresh: false })
        ?? probeFailure(spyProbe, nowMs, 'SPY_QUOTE')
        ?? probeFailure(vixProbe, nowMs, 'VIX_QUOTE')
        ?? 'MARKET SERVICE UNPROVEN'),
    providerSource);

  const signalProven = tvIngress?.state === 'HEALTHY' && tvIngress.ok === true;
  const routeProven = tvIngress?.state === 'REACHABLE' && tvIngress.ok === true;
  const ingressProven = signalProven || routeProven;
  const ingressBroken = tvIngress?.state === 'BROKEN';
  const tvTapeFresh = tradingViewTape?.source === 'TRADINGVIEW'
    && Number.isFinite(tradingViewTape.spy) && Number.isFinite(tradingViewTape.vix)
    && fresh(tradingViewTape.asOf, nowMs, SYSTEM_HEALTH.TAPE_STALE_MS);
  // TradingView is the authenticated order-alert ingress, not the market-data
  // authority. A missing optional TAPE diagnostic must never turn a proven
  // webhook route into a false outage; MARKET owns quote freshness.
  const tvBroken = ingressBroken;
  const tvColor = tvBroken ? 'RED' : ingressProven ? 'GREEN' : 'AMBER';
  const tvStatus = tvBroken ? 'DOWN' : ingressProven ? 'LIVE' : 'UNPROVEN';
  const evidenceIdentity = tvIngress?.ingressId
    ? ` · ingress ${tvIngress.ingressId}` : '';
  const tvDetail = ingressBroken
    ? (tvIngress?.error ?? 'TV_AUTHENTICATED_INGRESS_FAILED')
    : signalProven
        ? `HEALTHY · ${tvIngress.recent ? 'RECENT SIGNAL' : 'NO NEW SIGNAL'} · ${tvIngress.instruction}${evidenceIdentity}`
        : routeProven
          ? `HEALTHY · PUBLIC INGRESS ROUTE REACHABLE · NO SIGNAL REQUIRED${evidenceIdentity}`
        : 'UNPROVEN · NO ACCEPTED SIGNAL ON THIS VERSION · SILENCE IS NOT A FAULT';
  const tv = row('TV', tvColor, tvStatus,
    tvTapeFresh ? tradingViewTape.asOf : tvIngress?.evidenceAt,
    tvDetail, signalProven ? 'D1_AUTHENTICATED_INGRESS'
      : routeProven ? 'D1_PUBLIC_ROUTE_PROBE' : 'UNPROVEN');

  const discordOk = liveProbe(discordProbe, nowMs);
  const discord = row('DISCORD', discordOk ? 'GREEN' : 'RED', discordOk ? 'LIVE' : 'DOWN',
    discordProbe?.at, discordOk ? 'SILENT WEBHOOK VALIDATION' : (discordProbe?.error ?? 'NEVER_PROBED'),
    'DISCORD_WEBHOOK_GET');

  const tvPreflightPass = tv.color === 'GREEN'
    || (tv.color === 'AMBER' && tv.status === 'UNPROVEN');
  const connectorsOk = [d1, schwab, market, discord].every((entry) => entry.color === 'GREEN')
    && tvPreflightPass;
  const armed = laneState?.armed === true;
  const laneFault = laneState?.configurationFault ?? laneState?.fault?.faultCode ?? null;
  const botReady = armed && connectorsOk && !laneFault;
  const botHealthyOff = !armed && !laneFault;
  const botColor = botReady || botHealthyOff ? 'GREEN' : 'RED';
  const botStatus = laneFault ? 'FAULT' : botReady ? 'READY' : armed ? 'BLOCKED' : 'OFF';
  const bot = row('BOT', botColor, botStatus,
    laneState?.updatedAt ?? schwabAuth?.at,
    botReady ? (tv.status === 'UNPROVEN' ? 'ARMED · WAITING FOR FIRST SIGNAL PROOF'
      : marketOpen ? 'ARMED · READY FOR VALID TV SIGNAL' : 'WAITING · MARKET CLOSED')
      : laneFault ?? (!armed ? 'DISARMED · HEALTHY OFF' : 'CONNECTOR GATE FAILED'),
    'DURABLE_ARM_AND_FAIL_CLOSED_GATES');

  const rows = Object.freeze([d1, schwab, market, tv, discord, bot]);
  const anyRed = rows.some((entry) => entry.color === 'RED');
  const allHealthy = rows.every((entry) => entry.color === 'GREEN');
  return Object.freeze({
    status: allHealthy ? 'ALL HEALTHY' : anyRed ? 'ACTION REQUIRED' : 'UNPROVEN',
    color: allHealthy ? 'GREEN' : anyRed ? 'RED' : 'AMBER',
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
