import { NuvoEngine } from '../src/engine.js';
import { MassiveProvider } from '../src/truth/providers/massive.js';
import { SchwabMarketProvider, sessionStatus } from '../src/truth/providers/schwab.js';
import { SchwabReadOnlyBroker } from '../src/execution/broker/schwab_readonly.js';
import { EvidenceStore } from '../src/evidence/store.js';
import { buildEvidence, verifyEvidence, verifyFingerprint } from '../src/evidence/package.js';
import { replay } from '../src/evidence/replay.js';
import {
  AUTHORITY, AuthorityConfigurationError, authorityAtLeast, authorityValue,
  capAuthority, validateAuthorityLevel,
} from '../src/constitution/authority.js';
import { DEFAULT_LIMITS } from '../src/constitution/limits.js';
import {
  analyzeCoveredCallLifecycle, coveredCallEntryEvidenceFromOpenLots,
} from '../src/lifecycle/covered_call_analysis.js';
import { contentHash, ORDER_STATE } from '../src/execution/order.js';
import { reconcile, RECON } from '../src/truth/reconciliation.js';
import { authenticateAccess } from './access-auth.js';
import {
  buildBlockedCycleContext, buildCycleContext, D1R2CycleContextStore, decisionName,
} from './cycle-context.js';
import { D1R2EvidencePersistence } from './evidence-persistence.js';
import { handleVsimMcp } from './mcp-server.js';
import { SchwabD1Client } from './schwab-client.js';
import { mapCustodyRisk } from './custody-risk.js';
import {
  evaluateGuardian, guardianDiscordPayload, guardianReport, GUARDIAN_MANDATE_VERSION, GUARDIAN_STATES,
  shouldNotifyGuardian,
} from './guardian.js';
import {
  handleTelegramWebhook, processTelegramUpdate, telegramAssistantStatus,
} from './telegram-assistant.js';
import { freezeTradeProposal, reviewTradeTicket } from './proposal-approval.js';
import {
  fillsFromBrokerRows, matchRealizedTrades, performanceFromBrokerRows,
  portfolioFromCustody, realizedPnlCalendar,
} from './portfolio-report.js';
import {
  calculateCoveredCallCandidates, configuredCoveredCallDteTargets, COVERED_CALL_DTE_TARGETS,
} from './covered-call-calculator.js';
import {
  BUNDLED_DESIGN_APP, BUNDLED_DESIGN_HTML, BUNDLED_DESIGN_STYLES,
} from './design-assets.js';
import {
  buildE3SpineTab, E3_SPINE_TAB_FLAG,
} from '../src/dashboard/e3-spine-tab.js';
import {
  disarmLane1FromDashboard, expireLane1,
  armExistingLane1FromDashboard, armLane1FromDashboard,
  handleLane1PreviewRequest, handleLane1TvWebhook,
  handlePrincipalFlatten, lane1ControlStateFromDashboard, lane1Status,
  latestLane1ReplayIngress, readBoundedJson, reconcileLane1OpenFromBrokerLedger,
  recordOperationalProof, resolveLane1CompletedExitFault, validateLane1V21Market,
} from './lane-1-runtime.js';
import { lane1EventLedger } from './lane-1-event-ledger.js';
import { buildSystemHealth, proofsForWorker,
  tradingViewIngressHealth } from './system-health.js';

const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
const nowIso = () => new Date().toISOString();
const configuredAuthority = (env) => validateAuthorityLevel(env.NUVO_AUTHORITY_LEVEL, {
  source: 'NUVO_AUTHORITY_LEVEL',
});
const operationalAuthority = (env) => capAuthority(configuredAuthority(env), AUTHORITY.PROPOSE);

export function e3SpineTabEnabled(env = {}) {
  return String(env[E3_SPINE_TAB_FLAG] ?? 'OFF').trim().toUpperCase() === 'ON';
}

export function systemFault(error, stage = 'AUTHORITY_BOUNDARY') {
  return {
    ok: false,
    outcome: 'SYSTEM_FAULT',
    decision: null,
    faultCode: error?.code ?? 'SYSTEM_FAULT',
    faultStage: stage,
    message: String(error?.message ?? error),
    at: nowIso(),
  };
}

function epochMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toolEnvelope(env, payload = {}, error = null) {
  return {
    ok: !error,
    cycle_id: payload.cycle_id ?? null,
    authority_level: authorityValue(configuredAuthority(env)),
    asof: payload.asof ?? nowIso(),
    ...payload,
    error: error ? {
      code: String(error.code ?? 'FAIL_CLOSED'),
      message: String(error.message ?? error),
    } : null,
  };
}

function firstReasonCode(result, fallback = null) {
  return result?.violations?.[0]?.code
    ?? result?.governance?.violations?.[0]?.code
    ?? fallback;
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function publicStatus(env) {
  return {
    ok: true,
    service: 'nuvo-vsim-v5-shadow',
    environment: env.NUVO_ENVIRONMENT ?? 'unknown',
    authority: authorityAtLeast(configuredAuthority(env), AUTHORITY.PROPOSE)
      ? '2_PROPOSE_HUMAN_EXECUTION' : '1_SHADOW',
    authority_level: authorityValue(configuredAuthority(env)),
    broker_mode: 'READ_ONLY',
    broker_execution_mode: 'SHADOW_ONLY',
    mutation_routes: false,
    features: { e3SpineTab: e3SpineTabEnabled(env) },
    canonical_dashboard: 'vsim.nuvotrade.co',
    schedule: 'Guardian every minute · VSIM every 15 minutes',
    version: env.CF_VERSION_METADATA?.id ?? 'local',
  };
}

function requireSameOrigin(request, env) {
  const origin = request.headers.get('origin');
  const requestOrigin = new URL(request.url).origin;
  if (!origin || (origin !== env.PUBLIC_ORIGIN && origin !== requestOrigin)) {
    throw new Error('ORIGIN_NOT_ALLOWED');
  }
}

async function audit(env, ownerId, type, detail = {}) {
  await env.DB.prepare(`INSERT INTO operational_audit
    (id,owner_id,event_type,detail_json,created_at) VALUES (?,?,?,?,?)`).bind(
    crypto.randomUUID(), ownerId, type, JSON.stringify(detail), nowIso(),
  ).run();
}

async function boundedResponseJson(response, maximumBytes = 65_536) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new Error('SYSTEM_HEALTH_RESPONSE_TOO_LARGE');
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error('SYSTEM_HEALTH_RESPONSE_TOO_LARGE');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return total ? JSON.parse(new TextDecoder().decode(bytes)) : null;
}

export async function marketIdentityProbe(env) {
  const at = nowIso();
  if (!env.MARKET?.fetch) return { attempted: false, ok: false, at, error: 'MARKET_BINDING_UNAVAILABLE' };
  try {
    const response = await env.MARKET.fetch(new Request('https://market.internal/health'), {
      signal: AbortSignal.timeout(8_000),
    });
    const body = await boundedResponseJson(response);
    if (!response.ok || body?.ok === false) return { attempted: true, ok: false, at,
      error: body?.error ?? `MARKET_SERVICE_HTTP_${response.status}` };
    return {
      attempted: true,
      ok: true,
      at,
      versionId: body?.versionId ?? env.NUVO_MARKET_VERSION_ID ?? 'unknown',
    };
  } catch (error) {
    return { attempted: true, ok: false, at, error: String(error?.message ?? error) };
  }
}

export async function schwabRealtimeMarketProbe(client, ownerId, symbol) {
  const at = nowIso();
  try {
    const quote = await client.marketQuote(ownerId, symbol);
    return {
      attempted: true, ok: true, at,
      asOf: new Date(quote.asOf).toISOString(),
      value: Number(quote.value?.last),
      source: quote.source,
      symbol,
    };
  } catch (error) {
    return {
      attempted: true, ok: false, at, asOf: null, value: null,
      source: 'SCHWAB_MARKET_DATA_REALTIME', symbol,
      error: String(error?.message ?? error).split(':')[0],
    };
  }
}

export async function discordWebhookProbe(env, fetcher = fetch) {
  const at = nowIso();
  const raw = String(env.LANE_1_DISCORD_WEBHOOK_URL ?? '').trim();
  if (!raw) return { attempted: false, ok: false, at, error: 'NEVER_PROBED' };
  let url;
  try { url = new URL(raw); } catch { return { attempted: true, ok: false, at, error: 'DISCORD_WEBHOOK_URL_INVALID' }; }
  if (url.protocol !== 'https:' || url.hostname !== 'discord.com'
    || !/^\/api\/webhooks\/[^/]+\/[^/]+$/u.test(url.pathname)) {
    return { attempted: true, ok: false, at, error: 'DISCORD_WEBHOOK_URL_INVALID' };
  }
  try {
    const response = await fetcher(url, { method: 'GET', signal: AbortSignal.timeout(8_000) });
    const body = await boundedResponseJson(response);
    const ok = response.ok && Boolean(body?.id);
    return { attempted: true, ok, at,
      error: ok ? null : (body?.message ?? `DISCORD_WEBHOOK_HTTP_${response.status}`) };
  } catch (error) {
    return { attempted: true, ok: false, at, error: String(error?.message ?? error) };
  }
}

export async function storageHealthProbe(env, ownerId) {
  const at = nowIso();
  try {
    if (!env.DB?.prepare || !env.EVIDENCE?.list || !env.ACCOUNT_COORDINATOR?.getByName) {
      throw new Error('STORAGE_BINDING_UNAVAILABLE');
    }
    const durable = env.ACCOUNT_COORDINATOR.getByName(ownerId);
    const [d1, r2, durableState] = await Promise.all([
      env.DB.prepare('SELECT 1 AS ok').first(),
      env.EVIDENCE.list({ limit: 1 }),
      durable.laneV2Status(),
    ]);
    if (Number(d1?.ok) !== 1 || !Array.isArray(r2?.objects) || !durableState) {
      throw new Error('STORAGE_PROBE_INCOMPLETE');
    }
    return { attempted: true, ok: true, at };
  } catch (error) {
    return { attempted: true, ok: false, at, error: String(error?.message ?? error) };
  }
}

async function persistConnectorProbes(env, ownerId, probes) {
  const dashboardVersion = env.CF_VERSION_METADATA?.id ?? 'local';
  await Promise.all(Object.entries(probes).map(async ([connector, probe]) => {
    if (probe?.state === 'UNPROVEN') return;
    const status = probe?.ok ? 'GREEN' : 'RED';
    await env.DB.prepare(`INSERT INTO connector_health
      (owner_id,connector,status,last_probe_at,last_success_at,failure_code,detail_json,
       dashboard_version,upstream_version,consecutive_failures,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(owner_id,connector) DO UPDATE SET
       status=excluded.status,last_probe_at=excluded.last_probe_at,
       last_success_at=CASE WHEN excluded.status='GREEN' THEN excluded.last_success_at
         ELSE connector_health.last_success_at END,
       failure_code=excluded.failure_code,detail_json=excluded.detail_json,
       dashboard_version=excluded.dashboard_version,upstream_version=excluded.upstream_version,
       consecutive_failures=CASE WHEN excluded.status='GREEN' THEN 0
         ELSE connector_health.consecutive_failures+1 END,updated_at=excluded.updated_at`).bind(
      ownerId, connector, status, probe?.at ?? nowIso(), probe?.ok ? probe.at : null,
      probe?.error ?? null, JSON.stringify(probe ?? {}), dashboardVersion,
      probe?.versionId ?? null, probe?.ok ? 0 : 1, nowIso(),
    ).run();
  })).catch(() => {});
}

async function currentWorkerProofs(env, ownerId) {
  const workerVersion = env.CF_VERSION_METADATA?.id ?? 'local';
  try {
    const rows = await env.DB.prepare(`SELECT id,event_type,detail_json,created_at
      FROM operational_audit WHERE owner_id=? AND event_type IN
      ('LANE_1_TV_INGRESS','LANE_1_TV_TAPE','LANE_1_TV_ROUTE_PROBE',
       'LANE_1_DISCORD_DELIVERED','LANE_1_DISCORD_FAILED')
      ORDER BY created_at DESC LIMIT 50`).bind(ownerId).all();
    return proofsForWorker(rows?.results ?? [], workerVersion);
  } catch {
    return {};
  }
}

async function schwabAuthProbe(client, ownerId) {
  const at = nowIso();
  try {
    const hours = await client.marketHours(ownerId, { markets: ['equity'] });
    return { attempted: true, ok: true, at, session: sessionStatus(hours, Date.now()) };
  } catch (error) {
    return { attempted: true, ok: false, at, error: String(error?.message ?? error) };
  }
}

async function loadBaseline(env, ownerId) {
  const row = await env.DB.prepare(`SELECT snapshot_hash,account_json,positions_json,orders_json,
    observed_at,created_at,updated_at FROM custody_baselines WHERE owner_id=? AND active=1`).bind(ownerId).first();
  if (!row) return null;
  return {
    hash: row.snapshot_hash,
    account: parseJson(row.account_json, null),
    positions: parseJson(row.positions_json, []),
    openOrders: parseJson(row.orders_json, []),
    observedAt: row.observed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadLatestCustody(env, ownerId) {
  const row = await env.DB.prepare(`SELECT snapshot_hash,account_json,positions_json,
    orders_json,observed_at FROM custody_latest WHERE owner_id=?`).bind(ownerId).first();
  if (!row) return null;
  return {
    hash: row.snapshot_hash,
    account: parseJson(row.account_json, null),
    positions: parseJson(row.positions_json, []),
    openOrders: parseJson(row.orders_json, []),
    observedAt: row.observed_at,
  };
}

async function latestGuardianReview(env, ownerId) {
  const row = await env.DB.prepare(`SELECT review_id,review_type,account_state,mandate_version,
    snapshot_hash,report_json,fingerprint,created_at FROM guardian_reviews
    WHERE owner_id=? ORDER BY created_at DESC LIMIT 1`).bind(ownerId).first();
  return row ? { id: row.review_id, type: row.review_type, state: row.account_state,
    mandateVersion: row.mandate_version, snapshotHash: row.snapshot_hash,
    report: parseJson(row.report_json, null), fingerprint: row.fingerprint, createdAt: row.created_at } : null;
}

async function guardianLedgerSummary(env, ownerId, limit = 100) {
  const [events, observations, campaigns] = await Promise.all([
    env.DB.prepare(`SELECT event_key,event_type,broker_order_id,transaction_id,transaction_leg_id,activity_id,
      account_mask,symbol,side,quantity,price,amount,state,occurred_at,first_seen_at,last_seen_at
      FROM (SELECT event_key,event_type,broker_order_id,transaction_id,transaction_leg_id,activity_id,
        account_mask,symbol,side,quantity,price,amount,state,occurred_at,first_seen_at,last_seen_at,
        ROW_NUMBER() OVER (PARTITION BY CASE WHEN transaction_id IS NOT NULL
          THEN 'TX:' || transaction_id || ':' || COALESCE(transaction_leg_id, 'PRIMARY')
          WHEN event_type='ORDER_STATE' AND broker_order_id IS NOT NULL
            THEN 'ORDER:' || broker_order_id
          WHEN activity_id IS NOT NULL THEN 'ACT:' || activity_id || ':' ||
            COALESCE(symbol,'') || ':' || COALESCE(side,'') || ':' ||
            COALESCE(CAST(quantity AS TEXT),'') || ':' || COALESCE(CAST(price AS TEXT),'') || ':' ||
            COALESCE(occurred_at,'')
          ELSE 'EV:' || event_key END
          ORDER BY last_seen_at DESC) AS occurrence
        FROM broker_events WHERE owner_id=?)
      WHERE occurrence=1 ORDER BY COALESCE(occurred_at,first_seen_at) DESC LIMIT ?`)
      .bind(ownerId, limit).all(),
    env.DB.prepare(`SELECT observation_id,snapshot_hash,previous_chain_hash,chain_hash,observed_at
      FROM broker_observations WHERE owner_id=? ORDER BY observed_at DESC LIMIT 20`).bind(ownerId).all(),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM guardian_campaign_contracts
      WHERE owner_id=? AND status='FROZEN'`).bind(ownerId).first(),
  ]);
  return { events: events.results ?? [], observations: observations.results ?? [],
    activeCampaigns: Number(campaigns?.count ?? 0) };
}

async function dispatchGuardianOutbox(env, ownerId) {
  if (!env.GUARDIAN_DISCORD_WEBHOOK_URL) return { configured: false, sent: 0 };
  const rows = await env.DB.prepare(`SELECT outbox_id,review_id,payload_json,attempts
    FROM guardian_discord_outbox WHERE owner_id=? AND delivery_status='PENDING'
    ORDER BY created_at LIMIT 10`).bind(ownerId).all();
  let sent = 0;
  for (const row of rows.results ?? []) {
    try {
      const response = await fetch(env.GUARDIAN_DISCORD_WEBHOOK_URL, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: row.payload_json, signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new Error(`DISCORD_WEBHOOK_${response.status}`);
      await env.DB.prepare(`UPDATE guardian_discord_outbox SET delivery_status='SENT',
        attempts=attempts+1,last_error=NULL,delivered_at=? WHERE owner_id=? AND outbox_id=?`).bind(
        nowIso(), ownerId, row.outbox_id,
      ).run();
      sent += 1;
    } catch (error) {
      await env.DB.prepare(`UPDATE guardian_discord_outbox SET delivery_status='FAILED',
        attempts=attempts+1,last_error=? WHERE owner_id=? AND outbox_id=?`).bind(
        String(error.message).slice(0, 240), ownerId, row.outbox_id,
      ).run();
    }
  }
  return { configured: true, sent };
}

export async function runGuardianReview(env, ownerId, { reviewType = 'EVENT', notify = true } = {}) {
  const previous = await latestGuardianReview(env, ownerId);
  let snapshot;
  try { snapshot = await reconciledSnapshot(env, ownerId); }
  catch (error) {
    await audit(env, ownerId, 'GUARDIAN_BROKER_SYNC_FAILED', { error: error.message });
    throw error;
  }
  const [baseline, ledger] = await Promise.all([loadBaseline(env, ownerId), guardianLedgerSummary(env, ownerId, 1)]);
  const recon = accountReconciliation(baseline, snapshot);
  let session = 'CLOSED';
  try {
    const market = await marketProvider(env, ownerId).marketState();
    session = normalizeSession(market.value?.status);
  } catch { session = 'CLOSED'; }
  const assessment = evaluateGuardian({
    snapshot, reconStatus: recon.status, campaignCount: ledger.activeCampaigns,
    unresolvedDiscrepancies: recon.problems.length, marketSession: session, now: Date.now(),
  });
  const report = guardianReport({ snapshot, assessment, reconStatus: recon.status,
    campaignCount: ledger.activeCampaigns, previousReconciliation: previous?.report?.lastSuccessfulReconciliation ?? null });
  report.marketData = session === 'RTH' ? 'LIVE' : 'NOT_RTH';
  report.brokerageSnapshotIdentifier = snapshot.snapshotHash;
  report.reconciliation = recon;
  const { fingerprint: _preEnrichmentFingerprint, ...completeReport } = report;
  report.fingerprint = contentHash(completeReport);
  const reviewId = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO guardian_reviews
    (owner_id,review_id,review_type,account_state,mandate_version,snapshot_hash,
     report_json,fingerprint,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(
    ownerId, reviewId, reviewType, assessment.state, GUARDIAN_MANDATE_VERSION,
    snapshot.snapshotHash, JSON.stringify(report), report.fingerprint, report.timestamp,
  ).run();
  const newEvents = await env.DB.prepare(`SELECT COUNT(*) AS count FROM broker_events
    WHERE owner_id=? AND first_seen_at=?`).bind(ownerId, new Date(snapshot.asOf).toISOString()).first();
  const critical = assessment.violations.some((row) => row.severity === 'CRITICAL');
  const shouldNotify = shouldNotifyGuardian({ previous, assessment,
    newEventCount: Number(newEvents?.count ?? 0), reviewType, notify });
  if (shouldNotify) {
    const review = { id: reviewId, report };
    await env.DB.prepare(`INSERT INTO guardian_discord_outbox
      (owner_id,outbox_id,review_id,severity,payload_json,delivery_status,attempts,created_at)
      VALUES (?,?,?,?,?,'PENDING',0,?)`).bind(
      ownerId, crypto.randomUUID(), reviewId, critical ? 'CRITICAL' : 'INFO',
      JSON.stringify(guardianDiscordPayload(review)), report.timestamp,
    ).run();
  }
  const delivery = await dispatchGuardianOutbox(env, ownerId);
  await audit(env, ownerId, 'GUARDIAN_REVIEW_COMPLETED', {
    reviewId, reviewType, accountState: assessment.state, violations: assessment.violations.map((row) => row.code),
    newEvents: Number(newEvents?.count ?? 0), discordConfigured: delivery.configured, discordSent: delivery.sent,
  });
  return { id: reviewId, type: reviewType, state: assessment.state, report, delivery };
}

async function loadOperatorControls(env, ownerId) {
  const row = await env.DB.prepare(`SELECT global_pause,global_pause_reason,
    independent_kill,independent_kill_reason,updated_at,updated_by
    FROM operator_controls WHERE owner_id=?`).bind(ownerId).first();
  return row ? {
    globalPause: Boolean(row.global_pause),
    globalPauseReason: row.global_pause_reason ?? null,
    independentKill: Boolean(row.independent_kill),
    independentKillReason: row.independent_kill_reason ?? null,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  } : {
    globalPause: false, globalPauseReason: null,
    independentKill: false, independentKillReason: null,
    updatedAt: null, updatedBy: null,
  };
}

async function updateOperatorControls(env, ownerId, { action, reason }) {
  if (!reason || String(reason).trim().length < 8) throw new Error('CONTROL_REASON_REQUIRED');
  const current = await loadOperatorControls(env, ownerId);
  const next = {
    globalPause: current.globalPause,
    globalPauseReason: current.globalPauseReason,
    independentKill: current.independentKill,
    independentKillReason: current.independentKillReason,
  };
  if (action === 'PAUSE') {
    next.globalPause = true;
    next.globalPauseReason = String(reason).trim();
  } else if (action === 'RESUME') {
    next.globalPause = false;
    next.globalPauseReason = null;
  } else if (action === 'KILL') {
    next.independentKill = true;
    next.independentKillReason = String(reason).trim();
  } else if (action === 'CLEAR_KILL') {
    next.independentKill = false;
    next.independentKillReason = null;
  } else {
    throw new Error('CONTROL_ACTION_INVALID');
  }
  const at = nowIso();
  await env.DB.prepare(`INSERT INTO operator_controls
    (owner_id,global_pause,global_pause_reason,independent_kill,
     independent_kill_reason,updated_at,updated_by)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET
    global_pause=excluded.global_pause,
    global_pause_reason=excluded.global_pause_reason,
    independent_kill=excluded.independent_kill,
    independent_kill_reason=excluded.independent_kill_reason,
    updated_at=excluded.updated_at,updated_by=excluded.updated_by`).bind(
    ownerId, next.globalPause ? 1 : 0, next.globalPauseReason,
    next.independentKill ? 1 : 0, next.independentKillReason,
    at, 'PRINCIPAL_ACCESS_SESSION',
  ).run();
  await audit(env, ownerId, `OPERATOR_CONTROL_${action}`, { reason: String(reason).trim() });
  return loadOperatorControls(env, ownerId);
}

function marketProvider(env, ownerId = null) {
  const dteTargets = String(env.NUVO_DTE_TARGETS ?? '14,30,45')
    .split(',').map(Number).filter(Number.isFinite);
  const marketSource = String(env.NUVO_MARKET_SOURCE ?? 'MASSIVE_OPTIONS').toUpperCase();
  const maxChainAgeMs = Number(env.NUVO_MAX_CHAIN_AGE_MS ?? 120_000);
  const maxQuoteAgeMs = Number(env.NUVO_MAX_QUOTE_AGE_MS ?? 60_000);
  const fundSymbols = String(env.NUVO_FUND_SYMBOLS ?? '').split(',')
    .map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
  if (marketSource === 'SCHWAB_MARKET_DATA') {
    if (!ownerId) throw new Error('SCHWAB_MARKET_OWNER_REQUIRED');
    const client = new SchwabD1Client(env);
    const eventProvider = new MassiveProvider({
      fetcher: (request) => env.MARKET.fetch(request),
      dteTargets,
      maxChainAgeMs,
      maxQuoteAgeMs,
      requireRealtimeUnderlying: false,
      fundSymbols,
    });
    return new SchwabMarketProvider({
      client,
      ownerId,
      dteTargets,
      maxChainAgeMs,
      maxQuoteAgeMs,
      eventProvider,
      vixSymbol: String(env.NUVO_SCHWAB_VIX_SYMBOL ?? '$VIX'),
    });
  }
  const underlyingSource = String(env.NUVO_UNDERLYING_SOURCE ?? 'MASSIVE').toUpperCase();
  const schwab = ownerId && underlyingSource === 'SCHWAB_MARKET_DATA'
    ? new SchwabD1Client(env) : null;
  return new MassiveProvider({
    fetcher: (request) => env.MARKET.fetch(request), dteTargets,
    maxChainAgeMs,
    maxQuoteAgeMs,
    underlyingQuoteFetcher: schwab
      ? (symbol) => schwab.marketQuote(ownerId, symbol) : null,
    requireRealtimeUnderlying: true,
    vixSymbol: schwab ? String(env.NUVO_SCHWAB_VIX_SYMBOL ?? '$VIX') : null,
    fundSymbols,
  });
}

async function verifyLiveMarket(env, ownerId) {
  const provider = marketProvider(env, ownerId);
  const symbols = String(env.NUVO_SYMBOLS ?? 'SPY,QQQ,IWM')
    .split(',').map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
  const dteTargets = String(env.NUVO_DTE_TARGETS ?? '14,30,45')
    .split(',').map(Number).filter(Number.isFinite);
  const marketState = await provider.marketState();
  const rows = await Promise.all(symbols.map(async (symbol) => {
    // The fresh options snapshot supplies the options-only strategy's
    // underlying mark; load it before the normalized underlying quote.
    const chain = await provider.optionChain(symbol, { expirations: dteTargets });
    const [quote, events] = await Promise.all([provider.quote(symbol), provider.events(symbol)]);
    const errors = [quote.error, chain.error, events.error].filter(Boolean);
    return {
      symbol,
      ok: errors.length === 0,
      errors,
      quoteAsOf: quote.asOf ?? null,
      chainAsOf: chain.asOf ?? null,
      contractCount: chain.value?.contracts?.length ?? 0,
      expirations: [...new Set((chain.value?.contracts ?? []).map((contract) => contract.expiration))],
      eventCount: events.value?.length ?? 0,
    };
  }));
  const result = {
    ok: !marketState.error && rows.every((row) => row.ok),
    checkedAt: nowIso(),
    source: provider.name === 'schwab'
      ? 'SCHWAB_MARKET_DATA_PRODUCTION' : 'MASSIVE_POLYGON_PRIVATE_SERVICE',
    provider: provider.name,
    marketState: marketState.error ? { error: marketState.error } : {
      status: marketState.value.status,
      vix: marketState.value.vix,
      vix3m: marketState.value.vix3m,
      vixSource: marketState.value.vixSource,
      vixAsOf: marketState.value.vixAsOf,
      asOf: marketState.asOf,
    },
    symbols: rows,
  };
  await audit(env, ownerId, 'LIVE_MARKET_COMPATIBILITY_CHECK', result);
  return result;
}

async function captureBaseline(env, ownerId) {
  const snapshot = await reconciledSnapshot(env, ownerId);
  if (snapshot.openOrders.length > 0) {
    throw new Error(`CUSTODY_BASELINE_OPEN_ORDERS:${snapshot.openOrders.length}`);
  }
  const account = { cash: snapshot.cash, buyingPower: snapshot.buyingPower, nav: snapshot.nav };
  const payload = { account, positions: snapshot.positions, openOrders: snapshot.openOrders };
  const hash = contentHash(payload);
  const at = nowIso();
  await env.DB.prepare(`INSERT INTO custody_baselines
    (owner_id,snapshot_hash,account_json,positions_json,orders_json,observed_at,
     active,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?)
    ON CONFLICT(owner_id) DO UPDATE SET snapshot_hash=excluded.snapshot_hash,
    account_json=excluded.account_json,positions_json=excluded.positions_json,
    orders_json=excluded.orders_json,observed_at=excluded.observed_at,active=1,
    updated_at=excluded.updated_at`).bind(
    ownerId, hash, JSON.stringify(account), JSON.stringify(snapshot.positions),
    JSON.stringify(snapshot.openOrders), new Date(snapshot.asOf).toISOString(), at, at,
  ).run();
  await audit(env, ownerId, 'CUSTODY_BASELINE_CAPTURED', {
    snapshotHash: hash, positionCount: snapshot.positions.length, openOrderCount: snapshot.openOrders.length,
  });
  return { hash, observedAt: snapshot.asOf, positionCount: snapshot.positions.length, openOrderCount: snapshot.openOrders.length };
}

function summaryOf(result, engine, connector) {
  const ranked = result.ranked ?? [...(result.candidates ?? [])].sort((a, b) =>
    (b.capital?.decisionValue ?? -Infinity) - (a.capital?.decisionValue ?? -Infinity));
  const opportunityOf = (candidate) => {
    const attempt = (result.governanceAttempts ?? []).find((row) =>
      row.underlying === candidate.underlying && row.kind === candidate.structure?.kind
      && row.shortStrike === candidate.structure?.shortStrike);
    const baseContracts = Number(candidate.structure?.contracts ?? 1);
    const approvedContracts = Number(attempt?.contracts ?? 0);
    const sizeScale = attempt?.approved && baseContracts > 0 ? approvedContracts / baseContracts : null;
    const wheel = candidate.wheelCompatibility
      ? Object.fromEntries(Object.entries(candidate.wheelCompatibility)
        .filter(([key]) => key !== 'recoveryDistanceSigmas'))
      : null;
    return {
      underlying: candidate.underlying,
      structure: candidate.structure?.kind ?? null,
      contracts: candidate.structure?.contracts ?? null,
      approvedContracts: attempt?.approved ? approvedContracts : 0,
      governorApproved: Boolean(attempt?.approved),
      governorStatus: attempt ? (attempt.approved ? 'APPROVED' : 'DECLINED') : 'NOT_EVALUATED',
      governorReasonCodes: attempt?.reasonCodes ?? [],
      governorReasons: attempt?.reasons ?? [],
      governorSizing: attempt?.sizing ?? null,
      shortStrike: candidate.structure?.shortStrike ?? null,
      longStrike: candidate.structure?.longStrike ?? null,
      expiration: candidate.structure?.expiration ?? null,
      dte: candidate.dte ?? null,
      nev: candidate.evaluation?.nev ?? null,
      sizedNev: sizeScale === null ? null : candidate.evaluation?.nev * sizeScale,
      decisionMetric: candidate.capital?.decisionMetric ?? null,
      decisionValue: candidate.capital?.decisionValue ?? null,
      ...(candidate.structure?.kind === 'CSP' ? {} : { raroc: candidate.capital?.raroc ?? null }),
      cvar: candidate.evaluation?.cvar ?? null,
      gapRisk: candidate.evaluation?.gapRisk?.value ?? null,
      liquidityRisk: candidate.evaluation?.liquidityRisk?.value ?? null,
      collateralOpportunityCost: candidate.evaluation?.collateralOpportunity?.value ?? null,
      collateralHurdleRate: candidate.evaluation?.collateralOpportunity?.annualRate ?? null,
      wheelCompatibleFraction: candidate.wheelCompatibility?.wheelCompatibleFraction ?? null,
      strandedAssignmentFraction: candidate.wheelCompatibility?.strandedFraction ?? null,
      wheelCompatibility: wheel,
      entryCredit: candidate.structure?.credit ?? null,
      sizedEntryCredit: sizeScale === null ? null : candidate.structure?.credit * sizeScale,
      buyingPower: candidate.structure?.buyingPower ?? null,
      sizedBuyingPower: sizeScale === null ? null : candidate.structure?.buyingPower * sizeScale,
      economicCapital: candidate.capital?.economicCapital ?? null,
      nevPerDay: Number.isFinite(candidate.evaluation?.nev) && Number.isFinite(candidate.dte) && candidate.dte > 0
        ? candidate.evaluation.nev / candidate.dte : null,
      pMarket: candidate.probabilities?.pMarket ?? null,
      pModel: candidate.probabilities?.pModel ?? null,
      pCal: candidate.probabilities?.calibration === 'UNCALIBRATED'
        ? null : candidate.probabilities?.pCal ?? null,
      pCalStatus: candidate.probabilities?.calibration === 'UNCALIBRATED' ? 'UNCALIBRATED' : 'ACTIVE',
      probabilityOfProfitModel: candidate.success?.p_model ?? null,
      probabilityOfProfitMarket: candidate.success?.p_market ?? null,
      breakeven: candidate.success?.breakeven ?? null,
      admissible: Boolean(candidate.admissible),
      underwritingEligibleBeforeCapital: Boolean(candidate.admissible),
      rejection: candidate.admissible ? null : candidate.violations?.map(String)?.[0] ?? null,
      assignmentFunding: attempt?.assignmentFunding ?? null,
    };
  };
  const opportunities = ranked.slice(0, 10).map(opportunityOf);
  const cspOpportunities = ranked
    .filter((candidate) => candidate.structure?.kind === 'CSP')
    .slice(0, 20).map(opportunityOf);
  const allCspCandidates = [...(result.candidates ?? [])]
    .filter((candidate) => candidate.structure?.kind === 'CSP')
    .sort((a, b) => (b.capital?.decisionValue ?? -Infinity)
      - (a.capital?.decisionValue ?? -Infinity));
  const unconstrainedWinner = allCspCandidates[0] ?? null;
  const unconstrainedWinnerView = unconstrainedWinner ? opportunityOf(unconstrainedWinner) : null;
  const cspShadowLog = {
    status: !unconstrainedWinner
      ? 'NO_CANDIDATE'
      : !unconstrainedWinner.admissible
        ? 'NO_EDGE'
        : unconstrainedWinnerView.governorApproved ? 'CAPITAL_APPROVED' : 'NO_CAPITAL',
    capitalConstraintAppliedAfterUnderwriting: true,
    winner: unconstrainedWinnerView,
    preFilterRejections: (result.screenedOut ?? [])
      .filter((row) => row.kind === 'CSP'),
  };
  return {
    cycleId: result.cycleId,
    at: result.evidence?.at ?? Date.now(),
    outcome: result.outcome,
    decision: decisionName(result.outcome),
    state: result.outcome === 'REFUSED'
      ? (['POSITION_UNKNOWN', 'POSITION_QTY_MISMATCH', 'POSITION_PHANTOM', 'ORDER_UNKNOWN', 'ORDER_PHANTOM',
        'CASH_MISMATCH_FATAL', 'BP_MISMATCH'].includes(firstReasonCode(result)) ? 'QUARANTINED' : 'REFUSED')
      : 'SHADOW_RECORDED',
    reasonCode: firstReasonCode(result, result.outcome === 'NO_TRADE' ? 'NO_TRADE' : null),
    reason: result.reason ?? result.reasons?.[0] ?? null,
    authority: authorityAtLeast(engine.authorityLevel, AUTHORITY.PROPOSE)
      ? '2_PROPOSE_HUMAN_EXECUTION' : '1_SHADOW',
    mutationEligible: false,
    regime: result.regime ?? result.marketState?.regime?.regime ?? null,
    regimeConfidence: result.marketState?.regime?.coverage ?? null,
    trace: result.trace ?? [],
    opportunities,
    cspOpportunities,
    cspShadowLog,
    selected: result.selected ? opportunities.find((item) => item.underlying === result.selected.underlying
      && item.shortStrike === result.selected.structure?.shortStrike) ?? null : null,
    evidence: result.evidence ? {
      hash: result.evidence.hash,
      decisionFingerprint: result.evidence.decisionFingerprint,
      inputsHash: result.evidence.inputs?.hash,
      chainValid: engine.evidence.verify().valid,
      sequence: engine.evidence.length - 1,
    } : null,
    connectors: connector,
  };
}

async function recordCycleSummary(env, ownerId, summary) {
  await env.DB.prepare(`INSERT INTO cycle_summaries
    (owner_id,cycle_id,outcome,reason,regime,summary_json,created_at,state,decision,
     reason_code,evidence_fingerprint,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,cycle_id) DO UPDATE SET
    outcome=excluded.outcome,reason=excluded.reason,regime=excluded.regime,
    summary_json=excluded.summary_json,state=excluded.state,decision=excluded.decision,
    reason_code=excluded.reason_code,evidence_fingerprint=excluded.evidence_fingerprint,
    updated_at=excluded.updated_at`).bind(
    ownerId, summary.cycleId, summary.outcome, summary.reason, summary.regime,
    JSON.stringify(summary), new Date(summary.at).toISOString(), summary.state,
    summary.decision, summary.reasonCode ?? null,
    summary.evidence?.decisionFingerprint ?? null, nowIso(),
  ).run();
}

async function recordCycleStates(env, ownerId, cycleId, states) {
  let sequence = 0;
  for (const entry of states) {
    await env.DB.prepare(`INSERT INTO cycle_state_events
      (owner_id,cycle_id,sequence,state,role,detail_json,created_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(owner_id,cycle_id,sequence) DO NOTHING`).bind(
      ownerId, cycleId, sequence, entry.state, entry.role ?? 'VSIM_ENGINE',
      JSON.stringify(entry.detail ?? {}), entry.at ?? nowIso(),
    ).run();
    sequence += 1;
  }
}

function statesForResult(result, summary) {
  const states = [{ state: 'TRIGGERED', role: 'MASTER_CHIEF_INTERFACE' }];
  const passed = new Set((result.trace ?? []).filter((entry) => entry.ok).map((entry) => entry.name));
  if (passed.has('truth') && passed.has('reconciliation')) states.push({ state: 'TRUTH_VERIFIED', role: 'TRUTH_SENTINEL' });
  if (passed.has('universe')) states.push({ state: 'UNIVERSE_SCREENED', role: 'VSIM_ENGINE' });
  if (passed.has('underwriting')) states.push({ state: 'UNDERWRITTEN', role: 'VSIM_ENGINE' });
  if (passed.has('ranking')) states.push({ state: 'CHALLENGED', role: 'RISK_MANAGER', detail: { source: 'stored gate results' } });
  if ((result.trace ?? []).some((entry) => entry.name === 'governor')) states.push({ state: 'GOVERNED', role: 'PORTFOLIO_GOVERNOR' });
  if (result.evidence) states.push({ state: 'EVIDENCE_SEALED', role: 'AUDIT_LOGGER' });
  states.push({ state: summary.state, role: summary.state === 'SHADOW_RECORDED' ? 'AUDIT_LOGGER' : 'TRUTH_SENTINEL' });
  return states;
}

async function recordBlocked(env, ownerId, cycleId, reason, detail = {}) {
  const persistence = new D1R2EvidencePersistence({ db: env.DB, bucket: env.EVIDENCE, ownerId });
  const evidenceStore = await EvidenceStore.open({
    persistence, genesis: `NUVO-VSIM-V5-SHADOW:${ownerId}`,
  });
  const evidence = buildEvidence({
    cycleId,
    now: Date.now(),
    decision: 'REFUSED',
    candidates: [],
    strategyId: 'VSIM-001',
    modelVersion: 'nuvo-model-5.0.1-execution-cost-v2',
    codeVersion: env.CF_VERSION_METADATA?.id ?? 'nuvo-vsim-v5-shadow',
    limits: DEFAULT_LIMITS,
    authorityLevel: operationalAuthority(env),
    rawInputs: {
      operationalRefusal: { reason, detail },
      connectors: { market: 'LIVE_PRIVATE_SERVICE', schwab: 'READ_ONLY', evidence: 'D1_R2' },
    },
  });
  const record = evidenceStore.append(evidence);
  await evidenceStore.flush();
  if (evidenceStore.persistenceError) throw evidenceStore.persistenceError;
  const summary = {
    cycleId, at: Date.now(), outcome: 'REFUSED', decision: 'REFUSED',
    state: reason.includes('RECON') || reason.includes('MISMATCH') ? 'QUARANTINED' : 'REFUSED',
    reasonCode: reason, reason: detail.message ?? reason,
    authority: authorityAtLeast(operationalAuthority(env), AUTHORITY.PROPOSE)
      ? '2_PROPOSE_HUMAN_EXECUTION' : '1_SHADOW',
    mutationEligible: false, regime: null, regimeConfidence: null, trace: [],
    opportunities: [], selected: null,
    evidence: {
      hash: record.hash,
      decisionFingerprint: record.decisionFingerprint,
      inputsHash: record.inputs?.hash,
      chainValid: evidenceStore.verify().valid,
      sequence: record.sequence,
    },
    connectors: { market: 'LIVE_PRIVATE_SERVICE', schwab: 'READ_ONLY', evidence: 'D1_R2' },
  };
  await recordCycleSummary(env, ownerId, summary);
  await recordCycleStates(env, ownerId, cycleId, [
    { state: 'TRIGGERED', role: 'MASTER_CHIEF_INTERFACE' },
    { state: 'EVIDENCE_SEALED', role: 'AUDIT_LOGGER' },
    { state: summary.state, role: 'TRUTH_SENTINEL', detail: { reasonCode: reason } },
  ]);
  const contextStore = new D1R2CycleContextStore({ db: env.DB, bucket: env.EVIDENCE, ownerId });
  await contextStore.put(buildBlockedCycleContext({
    summary, detail,
    codeVersion: env.CF_VERSION_METADATA?.id ?? 'nuvo-vsim-v5-shadow',
    constitutionVersion: DEFAULT_LIMITS.version,
    authorityLevel: operationalAuthority(env),
  }));
  await audit(env, ownerId, 'SHADOW_CYCLE_BLOCKED', { cycleId, reason, ...detail });
  return summary;
}

async function acquireCycleLease(env, ownerId, cycleId) {
  const now = nowIso();
  try {
    await env.DB.prepare(`UPDATE cycle_leases SET status='EXPIRED',finished_at=?
      WHERE owner_id=? AND status='RUNNING' AND expires_at<=?`).bind(now, ownerId, now).run();
    await env.DB.prepare(`INSERT INTO cycle_leases
      (owner_id,cycle_id,status,started_at,expires_at) VALUES (?,?,'RUNNING',?,?)`).bind(
      ownerId, cycleId, now, new Date(Date.now() + 10 * 60_000).toISOString(),
    ).run();
    return true;
  } catch {
    // Workflow steps may be retried after their side effects committed but
    // before Cloudflare recorded the step result. Re-entering the SAME lease
    // is safe because the Durable Object prevents a second Workflow. A
    // different running cycle still fails closed.
    const existing = await env.DB.prepare(`SELECT cycle_id,status FROM cycle_leases
      WHERE owner_id=? AND cycle_id=?`).bind(ownerId, cycleId).first().catch(() => null);
    return existing?.cycle_id === cycleId && existing.status === 'RUNNING';
  }
}

export function cycleIdFor({ ownerId, source, now = Date.now(), idempotencyKey = null }) {
  if (source === 'OPERATOR') {
    if (!/^[A-Za-z0-9:_-]{16,128}$/u.test(String(idempotencyKey ?? ''))) {
      throw new Error('OPERATOR_IDEMPOTENCY_KEY_REQUIRED');
    }
    return `CY-${ownerId.slice(0, 10)}-O-${contentHash({ ownerId, idempotencyKey }).slice(0, 16)}`;
  }
  return `CY-${ownerId.slice(0, 10)}-${Math.floor(now / (15 * 60_000))}`;
}

export async function runShadowCycle(env, ownerId, {
  source = 'MANUAL', idempotencyKey = null, cycleIdOverride = null,
} = {}) {
  const cycleId = cycleIdOverride ?? cycleIdFor({ ownerId, source, idempotencyKey });
  if (!await acquireCycleLease(env, ownerId, cycleId)) {
    const existing = await env.DB.prepare(`SELECT summary_json FROM cycle_summaries
      WHERE owner_id=? AND cycle_id=?`).bind(ownerId, cycleId).first();
    return existing ? parseJson(existing.summary_json, { cycleId, outcome: 'REFUSED', reason: 'DUPLICATE_CYCLE' })
      : { cycleId, outcome: 'REFUSED', reason: 'CYCLE_ALREADY_RUNNING' };
  }
  let finalStatus = 'FAILED';
  try {
    const existingSummary = await cycleSummary(env, ownerId, cycleId);
    if (existingSummary) {
      finalStatus = existingSummary.state ?? 'COMPLETE';
      return existingSummary;
    }
    const filed = await env.DB.prepare(`SELECT evidence_hash,decision_fingerprint,decision,sequence
      FROM evidence_index WHERE owner_id=? AND cycle_id=?`).bind(ownerId, cycleId).first();
    if (filed) {
      // The evidence write won a race with a Workflow retry, but its summary
      // did not. Never run the economic decision twice or relabel the sealed
      // package. Quarantine the incomplete projection for operator review.
      const summary = {
        cycleId,
        at: Date.now(),
        outcome: filed.decision,
        decision: filed.decision === 'PROPOSAL' ? 'SHADOW_PROPOSAL'
          : filed.decision === 'NO_TRADE' ? 'NO_TRADE' : 'REFUSED',
        state: 'QUARANTINED',
        reasonCode: 'EVIDENCE/PROJECTION_INCOMPLETE',
        reason: 'Evidence sealed before its D1 summary/context projection completed; no second decision was run.',
        authority: authorityAtLeast(operationalAuthority(env), AUTHORITY.PROPOSE)
          ? '2_PROPOSE_HUMAN_EXECUTION' : '1_SHADOW', mutationEligible: false,
        regime: null, regimeConfidence: null, trace: [], opportunities: [], selected: null,
        evidence: {
          hash: filed.evidence_hash,
          decisionFingerprint: filed.decision_fingerprint,
          sequence: filed.sequence,
          chainValid: null,
        },
        connectors: { market: 'UNKNOWN', schwab: 'READ_ONLY', evidence: 'D1_R2' },
      };
      await recordCycleSummary(env, ownerId, summary);
      await recordCycleStates(env, ownerId, cycleId, [
        { state: 'TRIGGERED', role: 'MASTER_CHIEF_INTERFACE' },
        { state: 'EVIDENCE_SEALED', role: 'AUDIT_LOGGER' },
        { state: 'QUARANTINED', role: 'AUDIT_LOGGER', detail: { reasonCode: summary.reasonCode } },
      ]);
      const contextStore = new D1R2CycleContextStore({ db: env.DB, bucket: env.EVIDENCE, ownerId });
      await contextStore.put(buildBlockedCycleContext({
        summary, detail: { massiveStatus: 'BLOCKED' },
        codeVersion: env.CF_VERSION_METADATA?.id ?? 'nuvo-vsim-v5-shadow',
        constitutionVersion: DEFAULT_LIMITS.version,
        authorityLevel: operationalAuthority(env),
      }));
      finalStatus = 'QUARANTINED';
      return summary;
    }
    // Prove the complete provider contract before portfolio mapping can hide
    // a market-data incompatibility. This is intentionally redundant with
    // the engine Truth Contract: the preflight gives the operator a precise
    // feed-capability result while the engine remains the final authority.
    const marketCompatibility = await verifyLiveMarket(env, ownerId);
    if (!marketCompatibility.ok) {
      finalStatus = 'BLOCKED';
      return await recordBlocked(env, ownerId, cycleId, 'TRUTH/MARKET_DATA_INCOMPATIBLE', {
        provider: marketCompatibility.provider,
        marketState: marketCompatibility.marketState,
        symbols: marketCompatibility.symbols,
      });
    }

    const schwabClient = new SchwabD1Client(env);
    const currentSnapshot = await reconciledSnapshot(env, ownerId);
    const baseline = await loadBaseline(env, ownerId);
    if (!baseline || baseline.hash !== currentSnapshot.snapshotHash) {
      finalStatus = 'BLOCKED';
      return await recordBlocked(env, ownerId, cycleId, 'BROKER_RECONCILIATION_CHECKPOINT_FAILED');
    }
    if (baseline.openOrders.length) {
      finalStatus = 'BLOCKED';
      return await recordBlocked(env, ownerId, cycleId, 'CUSTODY_OPEN_ORDER_RISK_MAPPING_REQUIRED', {
        openOrderCount: baseline.openOrders.length,
      });
    }
    const broker = new SchwabReadOnlyBroker({ client: schwabClient, ownerId });
    broker.snapshotPromise = Promise.resolve(currentSnapshot);
    const dteTargets = String(env.NUVO_DTE_TARGETS ?? '14,30,45').split(',').map(Number).filter(Number.isFinite);
    const provider = marketProvider(env, ownerId);
    const custodyRisk = await mapCustodyRisk({ provider, positions: currentSnapshot.positions });
    if (!custodyRisk.ok) {
      finalStatus = 'BLOCKED';
      return await recordBlocked(env, ownerId, cycleId, 'CUSTODY_RISK_MAPPING_REQUIRED', {
        reasons: custodyRisk.reasons,
      });
    }
    const persistence = new D1R2EvidencePersistence({ db: env.DB, bucket: env.EVIDENCE, ownerId });
    const evidenceStore = await EvidenceStore.open({ persistence, genesis: `NUVO-VSIM-V5-SHADOW:${ownerId}` });
    const baseSymbols = String(env.NUVO_SYMBOLS ?? 'SPY,QQQ,IWM').split(',')
      .map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
    const holdings = Object.fromEntries(baseline.positions
      .filter((position) => position.type === 'EQUITY' && Number(position.quantity) >= 100)
      .map((position) => [String(position.symbol).toUpperCase(), {
        shares: Number(position.quantity), costBasis: Number(position.averagePrice),
      }]));
    // Owned whole-lot names are admitted to the covered-call scan only when
    // Schwab proves a current option chain. An unoptionable holding is skipped
    // rather than allowed to make the fixed ETF opportunity universe fail.
    const optionableHoldings = [];
    for (const symbol of Object.keys(holdings).filter((value) => !baseSymbols.includes(value))) {
      const probe = await provider.optionChain(symbol, { expirations: dteTargets });
      if (!probe.error && probe.value?.contracts?.length) optionableHoldings.push(symbol);
      else await audit(env, ownerId, 'COVERED_CALL_UNIVERSE_EXCLUDED', {
        symbol, reason: probe.error ?? 'NO_EXECUTABLE_CONTRACTS',
      });
    }
    const symbols = [...new Set([...baseSymbols, ...optionableHoldings])];
    const engine = new NuvoEngine({
      provider, broker, nav: currentSnapshot.nav, authorityLevel: operationalAuthority(env),
      symbols, approved: symbols, evidenceStore,
      accountMirror: { cash: baseline.account.cash, buyingPower: baseline.account.buyingPower },
      codeVersion: env.CF_VERSION_METADATA?.id ?? 'nuvo-vsim-v5-shadow',
      modelVersion: 'nuvo-model-5.0.1-execution-cost-v2',
    });
    engine.positions = custodyRisk.positions.map((position) => structuredClone(position));
    for (const position of baseline.positions) engine.legPositions.set(position.symbol, structuredClone(position));
    for (const order of baseline.openOrders) {
      const id = order.brokerOrderId ?? order.clientOrderId;
      engine.orders.orders.set(id, { ...structuredClone(order), clientOrderId: id, brokerOrderId: id, state: ORDER_STATE.WORKING });
    }
    const strategy = engine.registry.get('VSIM-001');
    if (strategy?.state === 'RESEARCH') strategy.transition('VALIDATED', 'Architecture and correctness suite passed').transition('SHADOW', 'Real-market shadow observation');
    const structureAllowlist = source === 'CSP_CALCULATOR'
      ? ['CSP']
      : String(env.NUVO_ALLOWED_STRUCTURES ?? 'CSP')
        .split(',').map((value) => value.trim()).filter(Boolean);
    const result = await engine.cycle({
      cycleId,
      structureAllowlist,
      holdings,
      dteTargets,
      screenSamples: Number(env.NUVO_SCREEN_SAMPLES ?? 1500),
      decisionSamples: Number(env.NUVO_DECISION_SAMPLES ?? 8000),
      refineTop: Number(env.NUVO_REFINE_TOP ?? 8),
      portfolioReturnsBySymbol: custodyRisk.returnsBySymbol,
      portfolioSectors: custodyRisk.sectors,
    });
    const summary = summaryOf(result, engine, {
      market: 'LIVE_PRIVATE_SERVICE', schwab: 'READ_ONLY', evidence: 'D1_R2', source,
    });
    await recordCycleSummary(env, ownerId, summary);
    await recordCycleStates(env, ownerId, cycleId, statesForResult(result, summary));
    const contextStore = new D1R2CycleContextStore({ db: env.DB, bucket: env.EVIDENCE, ownerId });
    await contextStore.put(buildCycleContext({
      result, summary, snapshotHash: currentSnapshot.snapshotHash,
    }));
    finalStatus = result.outcome === 'REFUSED' ? 'REFUSED' : 'COMPLETE';
    return summary;
  } catch (error) {
    await audit(env, ownerId, 'SHADOW_CYCLE_ERROR', { cycleId, error: error.message, source });
    throw error;
  } finally {
    await env.DB.prepare(`UPDATE cycle_leases SET status=?,finished_at=?
      WHERE owner_id=? AND cycle_id=?`).bind(finalStatus, nowIso(), ownerId, cycleId).run().catch(() => {});
  }
}

async function apiStatus(env, ownerId, { custodyRefreshProbe } = {}) {
  const client = new SchwabD1Client(env);
  const [connection, baseline, custody, latest, evidenceCount, marketCheck, controls, guardian,
    ledgerStatus, reconciliation, schwabAuth, laneState, workerProofs, spyProbe,
    vixProbe, marketIdentity, discord, storage] = await Promise.all([
    client.status(ownerId),
    loadBaseline(env, ownerId),
    loadLatestCustody(env, ownerId),
    env.DB.prepare(`SELECT summary_json FROM cycle_summaries WHERE owner_id=? ORDER BY created_at DESC LIMIT 1`).bind(ownerId).first(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM evidence_index WHERE owner_id=?').bind(ownerId).first(),
    env.DB.prepare(`SELECT detail_json FROM operational_audit WHERE owner_id=?
      AND event_type IN ('LIVE_MARKET_COMPATIBILITY_CHECK','MASSIVE_LIVE_CHAIN_CHECK')
      ORDER BY created_at DESC LIMIT 1`).bind(ownerId).first(),
    loadOperatorControls(env, ownerId),
    latestGuardianReview(env, ownerId),
    client.ledgerStatus(ownerId),
    env.DB.prepare(`SELECT reconciliation_id,snapshot_hash,status,position_count,
      open_order_count,event_count,detail_json,reconciled_at FROM broker_reconciliation_runs
      WHERE owner_id=? ORDER BY reconciled_at DESC LIMIT 1`).bind(ownerId).first(),
    schwabAuthProbe(client, ownerId),
    lane1Status(env, ownerId).catch(() => null),
    currentWorkerProofs(env, ownerId),
    schwabRealtimeMarketProbe(client, ownerId, 'SPY'),
    schwabRealtimeMarketProbe(client, ownerId,
      String(env.NUVO_SCHWAB_VIX_SYMBOL ?? '$VIX')),
    marketIdentityProbe(env),
    discordWebhookProbe(env),
    storageHealthProbe(env, ownerId),
  ]);
  const tvIngress = tradingViewIngressHealth(workerProofs.LANE_1_TV_INGRESS,
    env.CF_VERSION_METADATA?.id ?? 'local', Date.now(), workerProofs.LANE_1_TV_ROUTE_PROBE);
  const systemHealth = buildSystemHealth({
    dashboardVersion: env.CF_VERSION_METADATA?.id ?? 'local',
    marketVersion: marketIdentity.versionId ?? 'unknown',
    storageProbe: storage,
    schwabAuth,
    schwabConnection: { ...connection, updatedAt: connection.updated_at,
      error: connection.last_error_code },
    custody,
    laneState,
    tradingViewIngressHealth: tvIngress,
    tradingViewTape: workerProofs.LANE_1_TV_TAPE,
    spyProbe,
    vixProbe,
    marketIdentityProbe: marketIdentity,
    discordProbe: discord,
    custodyRefreshProbe,
  });
  await persistConnectorProbes(env, ownerId, Object.fromEntries(systemHealth.rows.map((entry) => [
    entry.label, { attempted: true, ok: entry.color === 'GREEN',
      state: entry.color === 'AMBER' ? 'UNPROVEN' : undefined, at: systemHealth.checkedAt,
      error: entry.color === 'RED' ? entry.detail : null,
      versionId: entry.label === 'MARKET' ? systemHealth.versions.market : null },
  ])));
  return {
    ...publicStatus(env),
    access: 'VERIFIED',
    schwab: {
      status: connection.status,
      lastSuccessfulSyncAt: connection.last_successful_sync_at,
      error: connection.last_error_code,
    },
    custody: custody ? {
      status: 'LIVE_READ_ONLY', observedAt: custody.observedAt, hash: custody.hash,
      account: custody.account, positions: custody.positions, openOrders: custody.openOrders,
    } : { status: 'SYNC_REQUIRED' },
    baseline: baseline ? {
      status: 'RECONCILED_CHECKPOINT', hash: baseline.hash, observedAt: baseline.observedAt,
      positionCount: baseline.positions.length, openOrderCount: baseline.openOrders.length,
    } : { status: 'REQUIRED' },
    reconciliation: reconciliation ? {
      reconciliationId: reconciliation.reconciliation_id,
      snapshotHash: reconciliation.snapshot_hash,
      status: reconciliation.status,
      positionCount: reconciliation.position_count,
      openOrderCount: reconciliation.open_order_count,
      eventCount: reconciliation.event_count,
      detail: parseJson(reconciliation.detail_json, null),
      reconciledAt: reconciliation.reconciled_at,
    } : null,
    brokerLedger: ledgerStatus,
    evidence: { records: Number(evidenceCount?.count ?? 0), storage: 'D1_INDEX_R2_IMMUTABLE_OBJECT' },
    marketCheck: marketCheck ? parseJson(marketCheck.detail_json, null) : null,
    systemHealth,
    lane: laneState ? {
      armed: laneState.armed === true,
      stage: laneState.stage ?? 'UNKNOWN',
      positionSide: laneState.positionSide ?? 'UNKNOWN',
      updatedAt: laneState.updatedAt ?? null,
    } : null,
    controls,
    guardian: guardian ? {
      state: guardian.state, reviewId: guardian.id, reviewedAt: guardian.createdAt,
      mandateVersion: guardian.mandateVersion, report: guardian.report,
    } : { state: GUARDIAN_STATES.BLOCKED, reviewId: null, reviewedAt: null,
      mandateVersion: GUARDIAN_MANDATE_VERSION, report: null },
    latestCycle: latest ? parseJson(latest.summary_json, null) : null,
  };
}

async function portfolioDashboard(env, ownerId) {
  const custody = await loadLatestCustody(env, ownerId);
  if (!custody) throw new Error('SCHWAB_CUSTODY_SYNC_REQUIRED');
  const optionPositions = (custody.positions ?? []).filter((position) => position.type === 'OPTION');
  const shortCalls = optionPositions.filter((position) => Number(position.quantity) < 0
    && String(position.right).toLowerCase() === 'call');
  const analytics = new Map();
  const coveredCallLifecycle = new Map();
  const missingAnalytics = [];
  const client = new SchwabD1Client(env);
  let openLots = [];
  try {
    const ledgerRows = await env.DB.prepare(`SELECT transaction_id,raw_json,occurred_at FROM broker_events
      WHERE owner_id=? AND transaction_id IS NOT NULL ORDER BY occurred_at ASC`).bind(ownerId).all();
    openLots = matchRealizedTrades(fillsFromBrokerRows(ledgerRows.results ?? [])).open_lots;
  } catch (error) {
    missingAnalytics.push({ symbol: 'BROKER_LEDGER', error: error.message });
  }
  if (optionPositions.length) {
    const maxAgeMs = Number(env.NUVO_MAX_CHAIN_AGE_MS ?? 120_000);
    const now = Date.now();
    const quotes = await Promise.all(optionPositions.map(async (position) => {
      try {
        const quote = await client.marketOptionQuote(ownerId, position.symbol);
        return { symbol: position.symbol, quote };
      } catch (error) {
        return { symbol: position.symbol, error: error.message };
      }
    }));
    for (const { symbol, quote, error } of quotes) {
      if (quote?.value) analytics.set(symbol, {
        ...quote.value,
        spot: quote.value.underlyingPrice,
        asof: Number.isFinite(quote.asOf) ? new Date(quote.asOf).toISOString() : null,
        source: quote.source,
        freshness: Number.isFinite(quote.asOf) && now - quote.asOf <= maxAgeMs ? 'CURRENT' : 'LAST_MARKET_QUOTE',
      });
      else missingAnalytics.push({ symbol, error: error || 'SCHWAB_OPTION_QUOTE_UNAVAILABLE' });
    }
    const provider = marketProvider(env, ownerId);
    const lifecycleInputs = await Promise.all(shortCalls.map(async (position) => {
      const [underlyingResult, eventsResult] = await Promise.all([
        client.marketQuote(ownerId, position.underlying).catch((error) => ({ error: error.message })),
        provider.events(position.underlying).catch((error) => ({ error: error.message })),
      ]);
      return { position, underlyingResult, eventsResult };
    }));
    for (const { position, underlyingResult, eventsResult } of lifecycleInputs) {
      const shares = (custody.positions ?? []).find((candidate) => candidate.type === 'EQUITY'
        && candidate.symbol === position.underlying);
      const optionQuote = analytics.get(position.symbol);
      const entryEvidence = coveredCallEntryEvidenceFromOpenLots(openLots, position);
      const lifecycle = optionQuote && underlyingResult?.value
        ? analyzeCoveredCallLifecycle({
          optionPosition: position,
          sharePosition: shares,
          optionQuote,
          underlyingQuote: {
            ...underlyingResult.value,
            asof: Number.isFinite(underlyingResult.asOf)
              ? new Date(underlyingResult.asOf).toISOString() : null,
          },
          entryEvidence,
          events: eventsResult?.value ?? [],
          eventCoverage: {
            eventsVerified: Boolean(eventsResult?.value),
            dividendsVerified: eventsResult?.coverage?.dividends === true,
          },
          now,
        })
        : { ok: false, symbol: position.symbol,
          error: optionQuote ? underlyingResult?.error : 'SCHWAB_OPTION_QUOTE_UNAVAILABLE' };
      coveredCallLifecycle.set(position.symbol, lifecycle);
      if (!lifecycle.ok) missingAnalytics.push({ symbol: position.symbol, error: lifecycle.error });
    }
  }
  const report = portfolioFromCustody(custody, analytics, { limits: DEFAULT_LIMITS, coveredCallLifecycle });
  const analyticsRows = [...analytics.values()];
  const lastMarketQuotes = analyticsRows.filter((row) => row.freshness === 'LAST_MARKET_QUOTE').length;
  const analyticsAsOf = analyticsRows.length && analyticsRows.every((row) => row.asof)
    ? analyticsRows.map((row) => row.asof).sort()[0] : null;
  return {
    ...report,
    source: 'SCHWAB_READ_ONLY_CUSTODY',
    option_analytics_source: optionPositions.length
      ? (analytics.size === optionPositions.length ? 'SCHWAB_LATEST_AVAILABLE_COMPLETE' : 'SCHWAB_LATEST_AVAILABLE_PARTIAL')
      : 'NO_OPEN_OPTIONS',
    option_analytics_freshness: lastMarketQuotes ? 'LAST_MARKET_QUOTE' : 'CURRENT',
    option_analytics_asof: analyticsAsOf,
    option_positions: optionPositions.length,
    short_option_positions: optionPositions.filter((position) => Number(position.quantity) < 0).length,
    missing_option_analytics: missingAnalytics,
  };
}

function blockedCoveredCall(symbol, reasonCode, reason, detail = {}) {
  return {
    ok: false,
    outcome: 'NO_ELIGIBLE_COVERED_CALL',
    symbol,
    reason_code: reasonCode,
    reason,
    target_dtes: COVERED_CALL_DTE_TARGETS,
    execution: 'READ_ONLY_CALCULATION_NO_ORDER_ROUTE',
    user_action_required: false,
    ...detail,
  };
}

async function coveredCallDashboard(env, ownerId, rawSymbol) {
  const symbol = String(rawSymbol ?? '').trim().toUpperCase();
  const targetDtes = configuredCoveredCallDteTargets(env.NUVO_CC_DTE_TARGETS);
  if (!targetDtes) return blockedCoveredCall(symbol || null,
    'CONFIG/COVERED_CALL_DTE_TARGETS_INVALID',
    'The configured covered-call tenor targets are invalid. No strike was selected.', {
      target_dtes: [],
      diagnostics: { configured_value_present: env.NUVO_CC_DTE_TARGETS !== undefined },
    });
  const blocked = (blockedSymbol, reasonCode, reason, detail = {}) => blockedCoveredCall(
    blockedSymbol, reasonCode, reason, { ...detail, target_dtes: targetDtes },
  );
  if (!/^[A-Z][A-Z0-9.]{0,9}$/u.test(symbol)) {
    return blocked(symbol || null, 'SYMBOL_INVALID', 'Choose a ticker from the ownership book.');
  }
  const [snapshot, baseline, controls] = await Promise.all([
    reconciledSnapshot(env, ownerId), loadBaseline(env, ownerId), loadOperatorControls(env, ownerId),
  ]);
  if (controls.independentKill) return blocked(symbol,
    'CONSTITUTION/INDEPENDENT_KILL_SWITCH',
    'The independent safety switch is active. No new covered call may be evaluated.');
  if (controls.globalPause) return blocked(symbol, 'CONSTITUTION/GLOBAL_PAUSE',
    'New-trade evaluation is paused.');
  const reconciliation = accountReconciliation(baseline, snapshot);
  if (reconciliation.status !== 'CAPTURED') return blocked(symbol,
    `RECON/${reconciliation.status}`, 'Current Schwab custody does not match the captured reconciliation checkpoint.',
    { diagnostics: { reconciliation } });
  const encumberingOrders = (snapshot.openOrders ?? []).filter((order) => {
    const orderSymbol = String(order?.underlying ?? order?.underlyingSymbol ?? order?.symbol ?? '')
      .toUpperCase().replaceAll(' ', '');
    return !orderSymbol || orderSymbol === symbol || orderSymbol.startsWith(symbol);
  });
  if (encumberingOrders.length) return blocked(symbol,
    'CUSTODY/OPEN_ORDERS_PRESENT',
    'Working broker orders may already encumber shares. VSIM will not allocate the same shares twice.',
    { diagnostics: { encumbering_order_count: encumberingOrders.length } });

  const equity = (snapshot.positions ?? []).find((position) => position.type === 'EQUITY'
    && String(position.symbol).toUpperCase() === symbol && Number(position.quantity) > 0);
  if (!equity) return blocked(symbol, 'CUSTODY/SHARES_NOT_OWNED',
    'No owned shares for this ticker were found in current Schwab custody.');
  const shortCallContracts = (snapshot.positions ?? []).filter((position) => position.type === 'OPTION'
    && String(position.right).toLowerCase() === 'call'
    && String(position.underlying).toUpperCase() === symbol && Number(position.quantity) < 0)
    .reduce((sum, position) => sum + Math.abs(Number(position.quantity)), 0);
  const availableContracts = Math.max(0, Math.floor(Number(equity.quantity) / 100) - shortCallContracts);
  if (availableContracts < 1) return blocked(symbol, 'CUSTODY/NO_UNENCUMBERED_WHOLE_LOT',
    'Every whole 100-share lot is already covered or fewer than 100 shares are available.', {
      shares: Number(equity.quantity), existing_short_calls: shortCallContracts,
    });
  if (!(Number(equity.averagePrice) > 0)) return blocked(symbol,
    'CUSTODY/AVERAGE_SHARE_PRICE_UNAVAILABLE',
    'Average share price is required because a covered-call strike may never be at or below cost basis.');

  const provider = marketProvider(env, ownerId);
  const session = await provider.marketState();
  if (session.error) return blocked(symbol, 'TRUTH/MARKET_SESSION_UNVERIFIED',
    'The live options session could not be verified. VSIM will retry automatically when market truth is valid.',
    { diagnostics: { market_error: session.error } });
  if (String(session.value?.status).toUpperCase() !== 'OPEN') return blocked(symbol,
    'TRUTH/SESSION_NOT_RTH',
    `The options market is ${String(session.value?.status ?? 'closed').toLowerCase()}. Recalculation becomes available automatically during regular trading hours.`);
  const [chain, events, history] = await Promise.all([
    provider.optionChain(symbol, { expirations: targetDtes }),
    provider.events(symbol),
    provider.history(symbol, { lookback: 400, minBars: 121 }),
  ]);
  if (chain.error) return blocked(symbol, 'TRUTH/EXECUTABLE_CHAIN_UNAVAILABLE',
    `Fresh, complete executable quotes for the ${targetDtes.join(', ')}-DTE targets are unavailable. No strike was selected.`,
    { diagnostics: { chain_error: chain.error } });
  if (events.error) return blocked(symbol, 'TRUTH/EVENT_CLEARANCE_UNAVAILABLE',
    'The earnings and corporate-action calendar could not be verified. No strike was selected.',
    { diagnostics: { event_error: events.error } });
  if (history.error) return blocked(symbol, 'TRUTH/FORECAST_HISTORY_UNAVAILABLE',
    'At least 121 verified daily bars are required for independent covered-call valuation. No fallback volatility was used.',
    { diagnostics: { history_error: history.error } });

  const calculation = calculateCoveredCallCandidates({
    symbol,
    shares: Number(equity.quantity),
    averagePrice: Number(equity.averagePrice),
    availableContracts,
    spot: chain.value?.spot,
    contracts: chain.value?.contracts,
    historyBars: history.value,
    events: events.value,
    now: Date.now(),
    seed: `covered-call-entry:${symbol}:${chain.asOf}`,
    targets: targetDtes,
  });
  return {
    ...calculation,
    reason: calculation.ok
      ? 'Best eligible strike by incremental modeled value per day versus continuing to hold the shares uncovered.'
      : calculation.reason_code === 'NO_COVERED_CALL_ADDS_VALUE_VS_HOLDING_SHARES'
        ? 'Every eligible call surrendered at least as much modeled upside as its executable premium paid. Holding the shares uncovered is preferred.'
        : 'No liquid call strictly above both average share price and the current market passed every gate.',
    target_dtes: targetDtes,
    target_dtes_source: env.NUVO_CC_DTE_TARGETS === undefined
      ? 'CODE_DEFAULT_7_14_21_UNRATIFIED' : 'WORKER_VAR_UNRATIFIED',
    execution: 'READ_ONLY_CALCULATION_NO_ORDER_ROUTE',
    mutation_eligible: false,
    user_action_required: calculation.ok,
    asof: chain.asOf ? new Date(chain.asOf).toISOString() : null,
    source: chain.source,
    diagnostics: {
      reconciliation: reconciliation.status,
      market_session: session.value.status,
      existing_short_calls: shortCallContracts,
      chain_contracts_evaluated: chain.value?.contracts?.length ?? 0,
      verified_events: events.value?.length ?? 0,
      history_sessions: history.value?.length ?? 0,
    },
  };
}

async function performanceDashboard(env, ownerId) {
  const client = new SchwabD1Client(env);
  const [rows, current, ledgerStatus] = await Promise.all([
    env.DB.prepare(`SELECT transaction_id,raw_json,occurred_at FROM broker_events
      WHERE owner_id=? AND transaction_id IS NOT NULL AND transaction_leg_id IS NULL
      AND raw_json IS NOT NULL ORDER BY occurred_at ASC LIMIT 10000`).bind(ownerId).all(),
    env.DB.prepare(`SELECT unrealized_pnl,observed_at FROM broker_account_performance
      WHERE owner_id=? ORDER BY observed_at DESC LIMIT 1`).bind(ownerId).first(),
    client.ledgerStatus(ownerId),
  ]);
  const report = performanceFromBrokerRows(rows.results ?? [], {
    currentUnrealized: current?.unrealized_pnl,
  });
  const importedCount = Number(ledgerStatus.transaction_count ?? 0);
  const rowCount = (rows.results ?? []).length;
  const complete = Boolean(ledgerStatus.complete) && report.summary.history_complete
    && rowCount >= importedCount;
  return {
    ...report,
    asof: current?.observed_at ?? ledgerStatus.latest_transaction ?? null,
    source: 'SCHWAB_APPEND_ONLY_LEDGER',
    history: {
      status: complete ? 'COMPLETE_TO_CONFIGURED_HISTORY_FLOOR' : 'PARTIAL',
      broker_sync_complete: Boolean(ledgerStatus.complete),
      imported_transactions: importedCount,
      evaluated_packets: rowCount,
      earliest_transaction: ledgerStatus.earliest_transaction ?? null,
      latest_transaction: ledgerStatus.latest_transaction ?? null,
      unmatched_closures: report.summary.unmatched_closures,
      note: complete
        ? 'Every imported Schwab transaction packet was evaluated and all closures have an imported opening lot.'
        : 'Totals include only matched Schwab lifecycles. Unmatched closures are excluded from realized P&L.',
    },
    raw_packets: 'PROTECTED_NOT_EXPOSED',
  };
}

async function performanceCalendarDashboard(env, ownerId, { month, scope }) {
  const [rows, ledgerStatus] = await Promise.all([
    env.DB.prepare(`SELECT transaction_id,raw_json,occurred_at FROM broker_events
      WHERE owner_id=? AND transaction_id IS NOT NULL AND transaction_leg_id IS NULL
      AND raw_json IS NOT NULL ORDER BY occurred_at ASC LIMIT 10000`).bind(ownerId).all(),
    new SchwabD1Client(env).ledgerStatus(ownerId),
  ]);
  const report = performanceFromBrokerRows(rows.results ?? []);
  const calendar = realizedPnlCalendar(report.trades, { month, scope });
  const importedCount = Number(ledgerStatus.transaction_count ?? 0);
  const rowCount = (rows.results ?? []).length;
  return {
    ...calendar,
    history: {
      status: Boolean(ledgerStatus.complete) && report.summary.history_complete && rowCount >= importedCount
        ? 'COMPLETE_TO_CONFIGURED_HISTORY_FLOOR' : 'PARTIAL',
      imported_transactions: importedCount,
      evaluated_packets: rowCount,
      unmatched_closures: report.summary.unmatched_closures,
    },
    raw_packets: 'PROTECTED_NOT_EXPOSED',
  };
}

async function cycleSummary(env, ownerId, cycleId = null) {
  const row = cycleId
    ? await env.DB.prepare(`SELECT summary_json FROM cycle_summaries
      WHERE owner_id=? AND cycle_id=?`).bind(ownerId, cycleId).first()
    : await env.DB.prepare(`SELECT summary_json FROM cycle_summaries
      WHERE owner_id=? ORDER BY created_at DESC LIMIT 1`).bind(ownerId).first();
  return row ? parseJson(row.summary_json, null) : null;
}

function accountReconciliation(baseline, snapshot) {
  if (!baseline) return { status: 'MISSING', problems: [], details: {} };
  const report = reconcile({
    engine: {
      positions: baseline.positions,
      cash: baseline.account?.cash,
      buyingPower: baseline.account?.buyingPower,
      openOrders: baseline.openOrders,
    },
    broker: {
      positions: snapshot.positions,
      cash: snapshot.cash,
      buyingPower: snapshot.buyingPower,
      openOrders: snapshot.openOrders,
    },
  });
  return {
    status: report.status === RECON.PASS ? 'CAPTURED' : 'MISMATCH',
    problems: report.problems.map((problem) => ({
      code: problem.code,
      message: problem.message,
      detail: problem.detail ?? null,
    })),
    details: report.details,
  };
}

async function getAccountTruthTool(env, ownerId) {
  const client = new SchwabD1Client(env);
  const status = await client.status(ownerId);
  if (status.status !== 'CONNECTED') {
    return toolEnvelope(env, {
      nav: null, cash: null, margin_used: null, positions: [], open_orders: [],
      recon: { baseline: 'MISSING', positions_n: 0, open_orders_n: 0, mismatches: [] },
      schwab: 'DISCONNECTED',
    }, { code: 'SCHWAB_DISCONNECTED', message: status.last_error_code ?? 'Schwab is not connected.' });
  }

  let snapshot;
  try { snapshot = await reconciledSnapshot(env, ownerId); }
  catch (error) {
    return toolEnvelope(env, {
      nav: null, cash: null, margin_used: null, positions: [], open_orders: [],
      recon: { baseline: 'MISSING', positions_n: 0, open_orders_n: 0, mismatches: [] },
      schwab: 'DISCONNECTED',
    }, { code: 'SCHWAB_READ_FAILED', message: error.message });
  }
  const [baseline, guardian, ledger, ledgerStatus] = await Promise.all([
    loadBaseline(env, ownerId), latestGuardianReview(env, ownerId), guardianLedgerSummary(env, ownerId, 20),
    client.ledgerStatus(ownerId),
  ]);
  const recon = accountReconciliation(baseline, snapshot);
  const positions = snapshot.positions.map((position) => ({
    symbol: position.symbol,
    underlying: position.underlying,
    qty: position.quantity,
    mark: Number.isFinite(position.marketValue) && Number.isFinite(position.quantity)
      && position.quantity !== 0
      ? position.marketValue / (position.quantity * (position.multiplier || 1))
      : null,
    mv: position.marketValue,
    asset_class: position.type,
    right: position.right,
    strike: position.strike,
    expiration: position.expiration,
    multiplier: position.multiplier,
    average_price: position.averagePrice,
    unrealized_pnl: Number.isFinite(position.averagePrice)
      && Number.isFinite(position.quantity) && Number.isFinite(position.marketValue)
      ? position.quantity < 0
        ? position.averagePrice * Math.abs(position.quantity) * (position.multiplier || 1)
          + position.marketValue
        : position.marketValue
          - position.averagePrice * position.quantity * (position.multiplier || 1)
      : null,
  }));
  const openOrders = snapshot.openOrders.map((order) => ({
    id: order.brokerOrderId ?? order.clientOrderId,
    symbol: order.symbol,
    side: order.side ?? 'UNKNOWN',
    qty: order.quantity,
    status: order.state ?? order.status ?? 'UNKNOWN',
  }));
  const concentration = positions.map((position) => ({
    symbol: position.symbol,
    pct_nav: Number.isFinite(position.mv) && snapshot.nav > 0
      ? Math.abs(position.mv) / snapshot.nav : null,
  }));
  const payload = {
    nav: snapshot.nav,
    cash: snapshot.cash,
    margin_used: snapshot.marginDebit,
    withdrawable_cash: snapshot.withdrawableCash,
    buying_power: snapshot.buyingPower,
    positions,
    open_orders: openOrders,
    recon: {
      baseline: recon.status,
      reconciliation_id: snapshot.reconciliationId ?? null,
      reconciled_at: new Date(snapshot.asOf).toISOString(),
      positions_n: positions.length,
      open_orders_n: openOrders.length,
      mismatches: recon.problems,
    },
    schwab: 'CONNECTED',
    desk_overlay: {
      book: 'PRINCIPAL_SCHWAB_OUTSIDE_100K_MOMENTUM_OVERLAY',
      negative_cash: snapshot.cash < 0,
      concentrated_names: concentration.filter((row) => row.pct_nav > 0.10),
      action: 'REPORT_ONLY_NO_AUTO_LIQUIDATION',
    },
    guardian: guardian ? {
      state: guardian.state,
      review_id: guardian.id,
      reviewed_at: guardian.createdAt,
      mandate_version: guardian.mandateVersion,
      violations: guardian.report?.violations ?? [],
      final_directive: guardian.report?.finalDirective ?? null,
      evidence_fingerprint: guardian.fingerprint,
    } : {
      state: GUARDIAN_STATES.BLOCKED,
      review_id: null,
      reviewed_at: null,
      mandate_version: GUARDIAN_MANDATE_VERSION,
      violations: [{ code: 'GUARDIAN/REVIEW_MISSING', severity: 'CRITICAL' }],
      final_directive: 'Do not add exposure until a Guardian review is available.',
      evidence_fingerprint: null,
    },
    broker_ledger: {
      coverage: ledgerStatus.complete ? 'COMPLETE_TO_CONFIGURED_HISTORY_FLOOR' : 'BACKFILL_IN_PROGRESS',
      sync: ledgerStatus,
      active_campaigns: ledger.activeCampaigns,
      recent_events: ledger.events,
      latest_observation: ledger.observations[0] ?? null,
    },
    asof: new Date(snapshot.asOf).toISOString(),
  };
  if (recon.status !== 'CAPTURED') {
    return toolEnvelope(env, payload, {
      code: recon.status === 'MISSING' ? 'RECON_BASELINE_MISSING' : 'RECON_MISMATCH',
      message: recon.status === 'MISSING'
        ? 'No reconciliation baseline is captured.' : 'Schwab custody differs from the captured baseline.',
    });
  }
  return toolEnvelope(env, payload);
}

async function getCoveredCallLifecycleTool(env, ownerId, truth) {
  if (!truth?.ok || truth?.schwab !== 'CONNECTED' || truth?.recon?.baseline !== 'CAPTURED') {
    return toolEnvelope(env, { covered_calls: [] }, {
      code: 'LIFECYCLE_ACCOUNT_TRUTH_UNAVAILABLE',
      message: 'Current reconciled Schwab custody is required for lifecycle analysis.',
    });
  }
  const shortCalls = (truth.positions ?? []).filter((position) =>
    position.asset_class === 'OPTION' && position.right === 'call' && Number(position.qty) < 0);
  if (!shortCalls.length) {
    return toolEnvelope(env, {
      covered_calls: [], empty_reason: 'NO_OPEN_SHORT_CALLS', asof: truth.asof,
    });
  }
  const provider = marketProvider(env, ownerId);
  let openLots = [];
  try {
    const ledgerRows = await env.DB.prepare(`SELECT transaction_id,raw_json,occurred_at FROM broker_events
      WHERE owner_id=? AND transaction_id IS NOT NULL ORDER BY occurred_at ASC`).bind(ownerId).all();
    openLots = matchRealizedTrades(fillsFromBrokerRows(ledgerRows.results ?? [])).open_lots;
  } catch (error) {
    return toolEnvelope(env, { covered_calls: [] }, {
      code: 'LIFECYCLE_ENTRY_LEDGER_UNAVAILABLE', message: error.message,
    });
  }
  const coveredCalls = await Promise.all(shortCalls.map(async (position) => {
    const shares = (truth.positions ?? []).find((candidate) =>
      candidate.asset_class === 'EQUITY' && candidate.symbol === position.underlying);
    const [option, underlying, events] = await Promise.all([
      provider.optionQuote(position.symbol),
      provider.markQuote(position.underlying),
      provider.events(position.underlying),
    ]);
    const error = option.error ?? underlying.error ?? events.error;
    if (error) return { ok: false, symbol: position.symbol, error };
    return analyzeCoveredCallLifecycle({
      optionPosition: position,
      sharePosition: shares,
      optionQuote: {
        ...option.value,
        asof: new Date(option.asOf).toISOString(),
        source: option.source,
      },
      underlyingQuote: {
        ...underlying.value,
        asof: Number.isFinite(underlying.asOf) ? new Date(underlying.asOf).toISOString() : null,
      },
      entryEvidence: coveredCallEntryEvidenceFromOpenLots(openLots, position),
      events: events.value,
      eventCoverage: {
        eventsVerified: true,
        dividendsVerified: events.coverage?.dividends === true,
      },
      now: Date.now(),
    });
  }));
  const usable = coveredCalls.filter((row) => row.ok);
  return toolEnvelope(env, {
    covered_calls: coveredCalls,
    analysis_status: usable.length === coveredCalls.length ? 'COMPLETE' : 'PARTIAL',
    method: 'DETERMINISTIC_EXECUTABLE_COVERED_CALL_LIFECYCLE',
    asof: usable.map((row) => row.quote?.asof).filter(Boolean).sort().at(0) ?? truth.asof,
  }, usable.length ? null : {
    code: 'LIFECYCLE_ANALYSIS_UNAVAILABLE',
    message: coveredCalls.map((row) => row.error).filter(Boolean).join(', ') || 'No covered call could be analyzed.',
  });
}

function normalizeSession(status) {
  return status === 'OPEN' ? 'RTH' : ['PRE', 'POST', 'CLOSED'].includes(status) ? status : 'CLOSED';
}

async function getMarketStateTool(env, ownerId) {
  let check;
  try { check = await verifyLiveMarket(env, ownerId); }
  catch (error) {
    return toolEnvelope(env, {
      session: 'CLOSED', regime: null, regime_confidence: null, vix: null,
      massive: 'BLOCKED', live_contracts: 0, underlyings_checked: 0,
      market_provider: 'SCHWAB', quote_age_seconds: null, freshness_limit_seconds: 60,
    }, { code: 'MARKET_DATA_BLOCKED', message: error.message });
  }
  const latest = await cycleSummary(env, ownerId);
  // The 60-second MCP field is the underlying-quote freshness gate. Option
  // chains have their own stricter structural audit and a separate 120-second
  // maximum in the provider. Mixing the oldest illiquid contract timestamp
  // into quote_age_seconds falsely reports a live underlying feed as stale.
  const quoteTimestamps = check.symbols.map((row) => epochMs(row.quoteAsOf)).filter(Number.isFinite);
  const chainTimestamps = check.symbols.map((row) => epochMs(row.chainAsOf)).filter(Number.isFinite);
  const oldestQuote = quoteTimestamps.length ? Math.min(...quoteTimestamps) : null;
  const oldestChain = chainTimestamps.length ? Math.min(...chainTimestamps) : null;
  const quoteAge = oldestQuote === null ? null : Math.max(0, (Date.now() - oldestQuote) / 1000);
  const chainAge = oldestChain === null ? null : Math.max(0, (Date.now() - oldestChain) / 1000);
  const session = normalizeSession(check.marketState?.status);
  const latestAge = Number.isFinite(Number(latest?.at))
    ? Math.max(0, (Date.now() - Number(latest.at)) / 1000) : Infinity;
  const payload = {
    session,
    regime: latestAge <= 60 ? latest?.regime ?? null : null,
    regime_confidence: latestAge <= 60 ? latest?.regimeConfidence ?? null : null,
    vix: check.marketState?.vix ?? null,
    massive: String(check.provider ?? '').toUpperCase().includes('MASSIVE')
      ? (check.ok ? 'LIVE' : 'BLOCKED') : 'NOT_REQUIRED',
    market_data_status: check.ok ? 'LIVE' : 'BLOCKED',
    market_provider: String(check.provider ?? 'unknown').toUpperCase(),
    live_contracts: check.symbols.reduce((sum, row) => sum + row.contractCount, 0),
    underlyings_checked: check.symbols.length,
    quote_age_seconds: quoteAge,
    freshness_limit_seconds: 60,
    chain_age_seconds: chainAge,
    chain_freshness_limit_seconds: Number(env.NUVO_MAX_CHAIN_AGE_MS ?? 120_000) / 1000,
    asof: check.checkedAt,
  };
  if (!check.ok) return toolEnvelope(env, payload, { code: 'MARKET_DATA_BLOCKED', message: 'Live market verification failed.' });
  if (session !== 'RTH') return toolEnvelope(env, payload, { code: 'TRUTH/SESSION_NOT_RTH', message: `Market session is ${session}.` });
  if (!Number.isFinite(quoteAge) || quoteAge > 60) {
    return toolEnvelope(env, payload, { code: 'TRUTH/FACT_STALE', message: `Oldest quote is ${quoteAge ?? 'unknown'} seconds old.` });
  }
  return toolEnvelope(env, payload);
}

function accountCoordinator(env, ownerId) {
  if (!env.ACCOUNT_COORDINATOR) throw new Error('ACCOUNT_COORDINATOR_NOT_CONFIGURED');
  return env.ACCOUNT_COORDINATOR.getByName(ownerId);
}

async function reconciledSnapshot(env, ownerId) {
  if (!env.ACCOUNT_COORDINATOR) return new SchwabD1Client(env).snapshot(ownerId);
  return accountCoordinator(env, ownerId).reconciledSnapshot(ownerId);
}

export async function triggerShadowCycle(env, ownerId, { source = 'MCP', idempotencyKey = null } = {}) {
  if (!authorityAtLeast(configuredAuthority(env), AUTHORITY.SHADOW)) {
    return toolEnvelope(env, {}, { code: 'AUTHORITY_DENIED', message: 'Authority level does not permit shadow ranking.' });
  }
  const controls = await loadOperatorControls(env, ownerId);
  if (controls.globalPause || controls.independentKill) {
    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const cycleId = `CY-${ownerId.slice(0, 10)}-CONTROL-${date}`;
    const code = controls.independentKill
      ? 'CONSTITUTION/INDEPENDENT_KILL_SWITCH' : 'CONSTITUTION/GLOBAL_PAUSE';
    const message = controls.independentKill
      ? controls.independentKillReason : controls.globalPauseReason;
    const existing = await cycleSummary(env, ownerId, cycleId);
    const summary = existing ?? await recordBlocked(env, ownerId, cycleId, code, {
      massiveStatus: 'BLOCKED', message: message ?? code,
    });
    return toolEnvelope(env, {
      cycle_id: cycleId,
      state: summary.state,
      decision: summary.decision,
      reason_code: summary.reasonCode,
      reason: summary.reason,
      evidence_fingerprint: summary.evidence?.decisionFingerprint ?? null,
    }, { code: summary.reasonCode, message: summary.reason });
  }
  const provider = marketProvider(env, ownerId);
  const market = await provider.marketState();
  const session = normalizeSession(market.value?.status);
  if (market.error || session !== 'RTH') {
    const sessionParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const part = (type) => sessionParts.find((entry) => entry.type === type)?.value ?? '00';
    const sessionKey = `${part('year')}${part('month')}${part('day')}`;
    const cycleId = `CY-${ownerId.slice(0, 10)}-SESSION-${sessionKey}`;
    const existing = await cycleSummary(env, ownerId, cycleId);
    const summary = existing ?? await recordBlocked(env, ownerId, cycleId,
      market.error ? 'TRUTH/MARKET_STATE_UNAVAILABLE' : 'TRUTH/SESSION_NOT_RTH', {
        session, massiveStatus: market.error ? 'BLOCKED' : 'LIVE',
        message: market.error ?? `Market session is ${session}; RTH is required.`,
      });
    return toolEnvelope(env, {
      cycle_id: summary.cycleId, state: summary.state, decision: summary.decision,
      reason_code: summary.reasonCode, reason: summary.reason,
      evidence_fingerprint: summary.evidence?.decisionFingerprint ?? null,
    }, { code: summary.reasonCode, message: summary.reason });
  }

  const operatorSource = source === 'OPERATOR' || source === 'TELEGRAM_PROPOSAL'
    || source === 'CSP_CALCULATOR';
  const cycleId = cycleIdFor({
    ownerId,
    source: operatorSource ? 'OPERATOR' : 'SCHEDULED',
    idempotencyKey: operatorSource ? idempotencyKey : null,
  });
  const completed = await cycleSummary(env, ownerId, cycleId);
  if (completed) {
    return toolEnvelope(env, {
      cycle_id: cycleId, state: completed.state, decision: completed.decision,
      reason_code: completed.reasonCode ?? null, reason: completed.reason ?? null,
      evidence_fingerprint: completed.evidence?.decisionFingerprint ?? null,
      reused: true,
    });
  }

  const schwab = await new SchwabD1Client(env).status(ownerId);
  if (schwab.status !== 'CONNECTED') {
    const summary = await recordBlocked(env, ownerId, cycleId, 'TRUTH/SCHWAB_DISCONNECTED', {
      session,
      massiveStatus: 'LIVE',
      message: schwab.last_error_code ?? 'Schwab read-only custody is disconnected.',
    });
    return toolEnvelope(env, {
      cycle_id: cycleId,
      state: summary.state,
      decision: summary.decision,
      reason_code: summary.reasonCode,
      reason: summary.reason,
      evidence_fingerprint: summary.evidence?.decisionFingerprint ?? null,
    }, { code: summary.reasonCode, message: summary.reason });
  }

  const coordinator = accountCoordinator(env, ownerId);
  const lock = await coordinator.acquire(cycleId);
  if (!lock.acquired) {
    return toolEnvelope(env, {
      cycle_id: lock.cycle_id, state: lock.state ?? 'TRIGGERED', decision: 'REFUSED',
      reason_code: 'LOCK_HELD', reason: 'Another cycle is already active for this account.',
      evidence_fingerprint: null, reused: true,
    }, { code: 'LOCK_HELD', message: 'Another cycle is already active for this account.' });
  }
  if (!env.SHADOW_CYCLE_WORKFLOW) {
    await coordinator.finish(cycleId, 'REFUSED', { code: 'WORKFLOW_NOT_CONFIGURED' });
    return toolEnvelope(env, { cycle_id: cycleId }, {
      code: 'WORKFLOW_NOT_CONFIGURED', message: 'The Stage 2 shadow Workflow binding is missing.',
    });
  }
  try {
    await env.SHADOW_CYCLE_WORKFLOW.create({
      id: cycleId,
      params: { ownerId, cycleId, source },
      retention: { successRetention: '30 days', errorRetention: '30 days' },
    });
  } catch (error) {
    await coordinator.finish(cycleId, 'REFUSED', { code: 'WORKFLOW_START_FAILED', message: error.message });
    return toolEnvelope(env, { cycle_id: cycleId }, { code: 'WORKFLOW_START_FAILED', message: error.message });
  }
  return toolEnvelope(env, {
    cycle_id: cycleId, state: 'TRIGGERED', decision: 'REFUSED',
    reason_code: null, reason: null, evidence_fingerprint: null,
  });
}

async function getCycleTool(env, ownerId, cycleId) {
  const summary = await cycleSummary(env, ownerId, cycleId);
  if (!summary) return toolEnvelope(env, { cycle_id: cycleId }, { code: 'NOT_FOUND', message: 'Cycle not found.' });
  const events = await env.DB.prepare(`SELECT sequence,state,role,detail_json,created_at
    FROM cycle_state_events WHERE owner_id=? AND cycle_id=? ORDER BY sequence ASC`).bind(ownerId, cycleId).all();
  return toolEnvelope(env, {
    cycle_id: cycleId,
    state: summary.state,
    decision: summary.decision,
    reason_code: summary.reasonCode ?? null,
    reason: summary.reason ?? null,
    evidence_fingerprint: summary.evidence?.decisionFingerprint ?? null,
    created_at: new Date(summary.at).toISOString(),
    states: (events.results ?? []).map((event) => ({
      ...event, detail: parseJson(event.detail_json, {}), detail_json: undefined,
    })),
  });
}

async function listCyclesTool(env, ownerId, limit) {
  const rows = await env.DB.prepare(`SELECT cycle_id,state,decision,reason_code,
    evidence_fingerprint,created_at,updated_at FROM cycle_summaries
    WHERE owner_id=? ORDER BY created_at DESC LIMIT ?`).bind(ownerId, limit).all();
  return toolEnvelope(env, {
    cycles: rows.results ?? [],
  });
}

async function contextFor(env, ownerId, cycleId = null) {
  const store = new D1R2CycleContextStore({ db: env.DB, bucket: env.EVIDENCE, ownerId });
  return cycleId ? store.get(cycleId) : store.latest();
}

async function listRankedOpportunitiesTool(env, ownerId, cycleId = null) {
  const context = await contextFor(env, ownerId, cycleId);
  if (!context) return toolEnvelope(env, { cycle_id: cycleId, candidates: [] }, { code: 'NOT_FOUND', message: 'No sealed cycle context exists.' });
  return toolEnvelope(env, {
    cycle_id: context.cycle_id,
    decision: context.decision,
    candidates: context.candidates,
    empty_reason: context.candidates.length ? null : context.reason ?? context.reason_code ?? 'NO_CANDIDATES',
    asof: context.created_at,
  });
}

async function explainCandidateTool(env, ownerId, { cycleId, candidateId: id, rank }) {
  const context = await contextFor(env, ownerId, cycleId);
  if (!context) return toolEnvelope(env, { cycle_id: cycleId }, { code: 'NOT_FOUND', message: 'Cycle context not found.' });
  const candidate = id
    ? context.candidates.find((row) => row.candidate_id === id)
    : context.candidates.find((row) => row.rank === rank);
  if (!candidate) return toolEnvelope(env, { cycle_id: cycleId }, { code: 'NOT_FOUND', message: 'Candidate is not in the sealed cycle package.' });
  return toolEnvelope(env, {
    cycle_id: cycleId,
    candidate,
    why_passed: candidate.pass_reasons,
    why_alternatives_failed: context.rejections,
    portfolio_risk: candidate.portfolio_risk,
    asof: context.created_at,
  });
}

async function explainRejectionTool(env, ownerId, cycleId) {
  const context = await contextFor(env, ownerId, cycleId);
  if (!context) return toolEnvelope(env, { cycle_id: cycleId }, { code: 'NOT_FOUND', message: 'Cycle context not found.' });
  const timestamps = Object.values(context.quote_timestamps ?? {}).flatMap((row) => [row.quote, row.chain])
    .map((value) => Number(value)).filter(Number.isFinite);
  const oldest = timestamps.length ? Math.min(...timestamps) : null;
  return toolEnvelope(env, {
    cycle_id: cycleId,
    reason_code: context.reason_code,
    reason: context.reason,
    failing_gate: context.rejections[0] ?? null,
    quote_age_seconds: oldest == null ? null : Math.max(0, (Date.parse(context.created_at) - oldest) / 1000),
    session: context.session,
    recon_mismatches: context.rejections.filter((entry) => /RECON|MISMATCH|POSITION|ORDER/u.test(entry.code)),
    asof: context.created_at,
  });
}

async function evidencePackage(env, ownerId, { cycleId = null, fingerprint = null }) {
  const row = cycleId
    ? await env.DB.prepare(`SELECT object_key FROM evidence_index WHERE owner_id=? AND cycle_id=?`).bind(ownerId, cycleId).first()
    : await env.DB.prepare(`SELECT object_key FROM evidence_index WHERE owner_id=?
      AND decision_fingerprint LIKE ? ORDER BY created_at DESC LIMIT 1`).bind(ownerId, `${fingerprint}%`).first();
  if (!row) return null;
  const object = await env.EVIDENCE.get(row.object_key);
  if (!object) throw new Error(`EVIDENCE_OBJECT_MISSING:${row.object_key}`);
  const record = await object.json();
  const { previousHash: _previousHash, sequence: _sequence, chainHash: _chainHash, ...pkg } = record;
  return pkg;
}

async function replayEvidenceTool(env, ownerId, input) {
  if (!input.cycleId && !input.fingerprint) {
    return toolEnvelope(env, {}, { code: 'INPUT_REQUIRED', message: 'Provide cycle_id or fingerprint.' });
  }
  const pkg = await evidencePackage(env, ownerId, input);
  if (!pkg) return toolEnvelope(env, { cycle_id: input.cycleId }, { code: 'NOT_FOUND', message: 'Evidence package not found.' });
  let reproduced;
  let differences;
  if (pkg.inputs?.data?.operationalRefusal) {
    reproduced = verifyEvidence(pkg) && verifyFingerprint(pkg) && pkg.decision === 'REFUSED';
    differences = reproduced ? [] : ['Operational refusal evidence failed integrity or fingerprint verification.'];
  } else {
    const result = await replay(pkg);
    reproduced = result.reproduced;
    differences = result.differences ?? [result.reason].filter(Boolean);
  }
  const status = reproduced ? 'MATCH' : 'DRIFT';
  await audit(env, ownerId, reproduced ? 'EVIDENCE_REPLAY_MATCH' : 'EVIDENCE_REPLAY_DRIFT', {
    cycleId: pkg.cycleId, fingerprint: pkg.decisionFingerprint, differences,
  });
  return toolEnvelope(env, {
    cycle_id: pkg.cycleId,
    status,
    fingerprint: pkg.decisionFingerprint,
    differences,
    quarantine_required: !reproduced,
  }, reproduced ? null : { code: 'EVIDENCE_DRIFT', message: 'Replay differs from the sealed decision; quarantine is required.' });
}

async function listEvidenceTool(env, ownerId, limit) {
  const rows = await env.DB.prepare(`SELECT sequence,cycle_id,decision_fingerprint,
    decision,created_at FROM evidence_index WHERE owner_id=?
    ORDER BY sequence DESC LIMIT ?`).bind(ownerId, limit).all();
  return toolEnvelope(env, {
    records: (rows.results ?? []).map((row) => ({
      seq: row.sequence,
      cycle_id: row.cycle_id,
      fingerprint_prefix: String(row.decision_fingerprint ?? '').slice(0, 16),
      created_at: row.created_at,
      decision: row.decision,
    })),
    raw_packages: 'R2_PROTECTED_NOT_RETURNED',
  });
}

async function createTradeProposalTool(env, ownerId, { cycleId, candidateId }) {
  if (!authorityAtLeast(configuredAuthority(env), AUTHORITY.PROPOSE)) {
    return toolEnvelope(env, { cycle_id: cycleId }, {
      code: 'AUTHORITY_DENIED', message: 'Frozen ticket proposals require Authority 2.',
    });
  }
  const context = await contextFor(env, ownerId, cycleId);
  if (!context) return toolEnvelope(env, { cycle_id: cycleId }, { code: 'NOT_FOUND', message: 'Sealed cycle context not found.' });
  const truth = await getAccountTruthTool(env, ownerId);
  const market = await getMarketStateTool(env, ownerId);
  const result = await freezeTradeProposal({ env, ownerId, context, candidateId, truth, market });
  return result.ok
    ? toolEnvelope(env, { cycle_id: cycleId, ...result })
    : toolEnvelope(env, { cycle_id: cycleId, proposal_id: null }, { code: result.code, message: result.message });
}

async function reviewTradeTicketTool(env, ownerId, input) {
  if (!authorityAtLeast(configuredAuthority(env), AUTHORITY.PROPOSE)) {
    return toolEnvelope(env, {}, { code: 'AUTHORITY_DENIED', message: 'Ticket review requires Authority 2.' });
  }
  const truth = await getAccountTruthTool(env, ownerId);
  const market = await getMarketStateTool(env, ownerId);
  const result = await reviewTradeTicket({
    env, ownerId, proposalId: input.proposalId,
    ticket: { quantity: input.quantity, limit_price: input.limitPrice, time_in_force: input.timeInForce },
    truth, market,
  });
  if (result.ok) return toolEnvelope(env, result);
  const { ok: _ignored, code, message, ...detail } = result;
  return toolEnvelope(env, detail, { code: code ?? result.reason_codes?.[0] ?? 'TICKET_REVISE',
    message: message ?? 'The ticket does not match the frozen deterministic proposal.' });
}

export function createMcpService(env, ownerId) {
  return Object.freeze({
    getAccountTruth: () => getAccountTruthTool(env, ownerId),
    getLifecycleAnalytics: (truth) => getCoveredCallLifecycleTool(env, ownerId, truth),
    getMarketState: () => getMarketStateTool(env, ownerId),
    runShadowCycle: () => triggerShadowCycle(env, ownerId, { source: 'MCP' }),
    runProposalCycle: (idempotencyKey) => triggerShadowCycle(env, ownerId, {
      source: 'TELEGRAM_PROPOSAL', idempotencyKey,
    }),
    getCycle: (cycleId) => getCycleTool(env, ownerId, cycleId),
    listCycles: (limit) => listCyclesTool(env, ownerId, limit),
    listRankedOpportunities: (cycleId) => listRankedOpportunitiesTool(env, ownerId, cycleId),
    explainCandidate: (input) => explainCandidateTool(env, ownerId, input),
    explainRejection: (cycleId) => explainRejectionTool(env, ownerId, cycleId),
    replayEvidence: (input) => replayEvidenceTool(env, ownerId, input),
    listEvidence: (limit) => listEvidenceTool(env, ownerId, limit),
    createTradeProposal: (input) => createTradeProposalTool(env, ownerId, input),
    reviewTradeTicket: (input) => reviewTradeTicketTool(env, ownerId, input),
    authorityDenied: (tool, required, cycleId) => toolEnvelope(env, { cycle_id: cycleId }, {
      code: 'AUTHORITY_DENIED',
      message: `${tool} requires authority level ${required}; current level is ${authorityValue(configuredAuthority(env))}.`,
    }),
  });
}

export async function executeShadowWorkflow(env, { ownerId, cycleId, source }, step) {
  const coordinator = accountCoordinator(env, ownerId);
  try {
    const result = source === 'BASELINE_REFRESH'
      ? await step.do('capture verified read-only custody baseline', async () => ({
        state: 'BASELINE_CAPTURED',
        decision: 'READ_ONLY_BASELINE',
        baseline: await captureBaseline(env, ownerId),
      }))
      : await step.do('run deterministic VSIM shadow cycle', async () =>
        runShadowCycle(env, ownerId, { source, cycleIdOverride: cycleId }));
    await step.do('release account cycle lock', async () => {
      await coordinator.finish(cycleId, result.state ?? 'SHADOW_RECORDED', {
        decision: result.decision, reasonCode: result.reasonCode ?? null,
      });
      return { released: true };
    });
    return result;
  } catch (error) {
    await step.do('fail closed and release account cycle lock', async () => {
      await coordinator.finish(cycleId, 'REFUSED', { code: 'WORKFLOW_FAILED', message: error.message });
      return { released: true };
    });
    throw error;
  }
}

export function dashboardHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>NUVO VSIM v5 — Shadow</title><style>
  :root{color-scheme:dark;--bg:#07100e;--p:#0d1a16;--l:#22382f;--t:#e8f1ec;--m:#8ca096;--g:#60e2a8;--a:#f4ba61;--r:#f27676;font:14px Inter,system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,#123328,#07100e 38%);color:var(--t)}header,main{max-width:1200px;margin:auto}header{padding:26px 24px 18px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--l)}h1{margin:0;letter-spacing:.06em}h1 b{color:var(--g);font-size:.55em}.pill{padding:7px 10px;border:1px solid #725d34;color:var(--a);border-radius:99px;font-size:11px}main{padding:22px 24px 60px}.warning{border:1px solid #725d34;background:#2b2314;padding:12px 15px;border-radius:8px;color:#f4d6a5}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:16px}.card{background:linear-gradient(145deg,#10201b,#0a1512);border:1px solid var(--l);border-radius:10px;padding:18px}.card h2{font-size:12px;text-transform:uppercase;letter-spacing:.13em;color:var(--m);margin:0 0 13px}.value{font-size:22px;font-weight:750}.sub{color:var(--m);font-size:11px;margin-top:7px}.wide{grid-column:1/-1}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.metric{padding:12px;background:#08130f;border:1px solid var(--l);border-radius:7px}.metric span{display:block;color:var(--m);font-size:10px;text-transform:uppercase;letter-spacing:.1em}.metric b{display:block;font-size:19px;margin-top:5px}button,a.action{border:1px solid #315445;background:#10271f;color:var(--g);padding:9px 12px;border-radius:6px;cursor:pointer;text-decoration:none;font-weight:650;margin:5px 7px 0 0}button:disabled{opacity:.45;cursor:not-allowed}pre{white-space:pre-wrap;color:#c8d8cf;background:#07100e;padding:14px;border-radius:7px;max-height:320px;overflow:auto}table{width:100%;border-collapse:collapse;margin-top:10px}th,td{text-align:left;border-bottom:1px solid var(--l);padding:9px 7px;font-variant-numeric:tabular-nums}th{color:var(--m);font-size:10px;text-transform:uppercase;letter-spacing:.08em}.empty{color:var(--m);padding:12px 0}.ok{color:var(--g)}.bad{color:var(--r)}@media(max-width:760px){.grid,.metrics{grid-template-columns:1fr}.wide{grid-column:auto}.card{overflow-x:auto}}</style></head><body>
  <header><h1>NUVO VSIM <b>v5</b></h1><span class="pill">AUTHORITY 2 · PROPOSE ONLY</span></header><main><div class="warning">This is the protected v5 proposal system. It cannot submit, replace, or cancel a broker order. Execution remains locked.</div><section class="grid">
  <article class="card"><h2>Market data</h2><div class="value" id="market">Not checked</div><div class="sub" id="marketTime">Schwab Market Data · strict live chains</div></article>
  <article class="card"><h2>Schwab custody</h2><div class="value" id="schwab">Checking…</div><div class="sub" id="schwabTime">Read-only account, positions, and orders</div></article>
  <article class="card"><h2>Evidence</h2><div class="value" id="evidence">Checking…</div><div class="sub">D1 ordered index + R2 immutable packages</div></article>
  <article class="card wide"><h2>Live account snapshot</h2><div class="metrics"><div class="metric"><span>Account value</span><b id="nav">—</b></div><div class="metric"><span>Net cash / margin</span><b id="cash">—</b></div><div class="metric"><span>Buying power</span><b id="buyingPower">—</b></div></div><div class="sub" id="custodyTime">Refresh required</div></article>
  <article class="card wide"><h2>Open positions</h2><div id="positions" class="empty">No synchronized positions</div></article>
  <article class="card wide"><h2>Operator controls</h2><a class="action" href="/api/integrations/schwab/connect">Connect Schwab read-only</a><button id="custodyRefresh">Refresh account</button><button id="marketCheck">Verify Schwab live chains</button><button id="baseline">Capture reconciliation baseline</button><button id="cycle">Run opportunity scan</button><a class="action" href="https://nuvo-vsim-v5-preview.pages.dev/" target="_blank" rel="noreferrer">Open full design preview</a><div class="sub">The scan may rank opportunities, but this runtime has no broker mutation routes.</div></article>
  <article class="card wide"><h2>Opportunities</h2><div id="opportunities" class="empty">Run a verified shadow scan to populate ranked opportunities.</div></article>
  <article class="card wide"><h2>Latest cycle</h2><div class="value" id="outcome">No cycle yet</div><div class="sub" id="reason"></div><pre id="details">Loading protected status…</pre></article>
  </section></main><script>
  const el=id=>document.getElementById(id);const present=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value));const money=value=>present(value)?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(value)):'—';const num=value=>present(value)?Number(value).toLocaleString('en-US',{maximumFractionDigits:2}):'—';
  async function call(path,options){const r=await fetch(path,options);const j=await r.json();if(!r.ok)throw new Error(j.error||j.reason||('HTTP '+r.status));return j}
  function table(id,headers,rows){const root=el(id);root.replaceChildren();if(!rows.length){root.className='empty';root.textContent='None';return}root.className='';const t=document.createElement('table'),head=document.createElement('thead'),hr=document.createElement('tr');for(const h of headers){const th=document.createElement('th');th.textContent=h.label;hr.append(th)}head.append(hr);t.append(head);const body=document.createElement('tbody');for(const row of rows){const tr=document.createElement('tr');for(const h of headers){const td=document.createElement('td');td.textContent=h.format?h.format(row[h.key],row):String(row[h.key]??'—');tr.append(td)}body.append(tr)}t.append(body);root.append(t)}
  async function refresh(){try{const s=await call('/api/status');const mc=s.marketCheck;el('market').textContent=mc?(mc.ok?'VERIFIED LIVE':'BLOCKED'):'NOT CHECKED';el('market').className='value '+(mc?.ok?'ok':mc?'bad':'');el('marketTime').textContent=mc?.checkedAt||'Private service binding · strict live chains';el('schwab').textContent=s.schwab.status;el('schwab').className='value '+(s.schwab.status==='CONNECTED'?'ok':'bad');el('schwabTime').textContent=s.schwab.lastSuccessfulSyncAt||'Read-only connection required';el('evidence').textContent=s.evidence.records+' records';const c=s.custody;el('nav').textContent=money(c.account?.nav);el('cash').textContent=money(c.account?.cash);el('buyingPower').textContent=money(c.account?.buyingPower);el('custodyTime').textContent=c.observedAt?('Schwab as of '+c.observedAt+' · '+c.openOrders.length+' open orders'):'Refresh required';table('positions',[{key:'symbol',label:'Symbol'},{key:'type',label:'Type'},{key:'quantity',label:'Quantity',format:num},{key:'marketValue',label:'Market value',format:money}],c.positions||[]);const cycle=s.latestCycle;table('opportunities',[{key:'underlying',label:'Symbol'},{key:'structure',label:'Structure'},{key:'shortStrike',label:'Short strike',format:num},{key:'longStrike',label:'Long strike',format:num},{key:'expiration',label:'Expiration'},{key:'nev',label:'NEV',format:money},{key:'raroc',label:'RAROC',format:v=>present(v)?(Number(v)*100).toFixed(2)+'%':'—'},{key:'admissible',label:'Status',format:v=>v?'ELIGIBLE':'DECLINED'}],cycle?.opportunities||[]);el('outcome').textContent=cycle?.outcome||'No cycle yet';el('reason').textContent=cycle?.reason||'';el('details').textContent=JSON.stringify({baseline:s.baseline,marketCheck:s.marketCheck,latestCycle:cycle},null,2)}catch(e){el('details').textContent=e.message}}
  async function action(button,message,fn){button.disabled=true;el('details').textContent=message;try{await fn();await refresh()}catch(e){el('details').textContent=e.message}finally{button.disabled=false}}
  el('custodyRefresh').onclick=()=>action(el('custodyRefresh'),'Refreshing Schwab read-only snapshot…',()=>call('/api/operator/custody/refresh',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirm:'REFRESH_READ_ONLY_CUSTODY'})}));
  el('marketCheck').onclick=()=>action(el('marketCheck'),'Verifying Schwab quotes, events, and live option chains…',()=>call('/api/operator/market/check',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}));
  el('baseline').onclick=async()=>{if(!confirm('Capture the current read-only Schwab state as the reconciliation baseline?'))return;await action(el('baseline'),'Capturing reconciliation baseline…',()=>call('/api/operator/baseline',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirm:'CAPTURE_READ_ONLY_BASELINE'})}))};
  el('cycle').onclick=()=>action(el('cycle'),'Running deterministic live-chain opportunity scan…',()=>call('/api/cycle',{method:'POST',headers:{'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:'{}'}));refresh();
  </script></body></html>`;
}

const DASHBOARD_HEADERS = Object.freeze({
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'private, no-store',
  'content-security-policy': "default-src 'self'; script-src 'self' https://www.tradingview-widget.com; style-src 'self' 'unsafe-inline'; connect-src 'self' https://www.tradingview-widget.com https://*.tradingview.com wss://*.tradingview.com; img-src 'self' data: https://*.tradingview.com https://s3.tradingview.com; frame-src https://*.tradingview.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
});

export function rewriteDesignHtml(source, { e3SpineTab = false } = {}) {
  const e3SpineEnabled = e3SpineTab === true;
  const e3Nav = e3SpineEnabled
    ? '<button class="nav-button" data-view="e3-spine">Engine spine</button>' : '';
  const e3View = e3SpineEnabled ? `<section class="view" id="e3-spine" aria-labelledby="e3-spine-title">
    <div class="page-heading"><div><p class="kicker">Replayable economic chain · controlled lane</p><h2 id="e3-spine-title">E3 engine spine</h2></div><span class="readonly-tag">LANE 1 · DEFAULT OFF</span></div>
    <div class="e3-spine-panes">
      <article class="panel" data-e3-pane="fixture"><div class="panel-head"><div><p class="kicker">Synthetic replay bundle</p><h3>Resolved fixture episode</h3></div><span class="readonly-tag">FIXTURE</span></div>
        <dl class="e3-spine-facts"><div><dt>Put net cash</dt><dd data-e3="put-net-cash">—</dd></div><div><dt>Put option realized</dt><dd data-e3="put-option-realized">—</dd></div><div><dt>Shares after assignment</dt><dd data-e3="put-shares">—</dd></div><div><dt>Covered-call net cash</dt><dd data-e3="call-net-cash">—</dd></div><div><dt>Cumulative cash</dt><dd data-e3="cumulative-cash">—</dd></div><div><dt>Cumulative option realized</dt><dd data-e3="cumulative-option-realized">—</dd></div></dl>
        <p class="panel-note" data-e3="third-call">Third-call result unavailable.</p>
      </article>
      <article class="panel" data-e3-pane="live"><div class="panel-head"><div><p class="kicker">Stored custody snapshot</p><h3>Current account marks</h3></div><span class="readonly-tag">LIVE MARKS · NOT A UNIT</span></div>
        <dl class="e3-spine-facts"><div><dt>NAV</dt><dd data-e3="live-nav">—</dd></div><div><dt>Cash-derived</dt><dd data-e3="live-cash-derived">—</dd></div><div><dt>CBRS · LAST PRICE</dt><dd data-e3="live-cbrs">—</dd></div><div><dt>SPCX · LAST PRICE</dt><dd data-e3="live-spcx">—</dd></div></dl>
        <p class="panel-note" data-e3="live-asof">No stored custody snapshot.</p>
      </article>
      <article class="panel" data-e3-pane="lane"><div class="panel-head"><div><p class="kicker">Durable economic diary</p><h3 data-e3="lane-label">LANE_1_SPY unit</h3></div><span class="readonly-tag lane-arm-state" data-e3="lane-state" data-state="disarmed" role="status" aria-live="polite">DISARMED</span></div>
        <dl class="e3-spine-facts"><div><dt>Bot position</dt><dd data-e3="lane-position">UNVERIFIED · SPY · 1</dd></div><div><dt>Buy fill</dt><dd data-e3="lane-buy-fill">—</dd></div><div><dt>Sell fill</dt><dd data-e3="lane-sell-fill">—</dd></div><div><dt>Realized P&amp;L</dt><dd data-e3="lane-pnl">—</dd></div><div><dt>Manifest SHA-256</dt><dd data-e3="lane-hash">—</dd></div><div><dt>Diary updated</dt><dd data-e3="lane-updated">—</dd></div></dl>
        <button class="cc-directive" type="button" data-action="laneArm">ARM LANE_1_SPY</button>
        <button class="cc-directive" type="button" data-action="laneDisarm">DISARM LANE_1_SPY</button>
        <button class="cc-directive" type="button" data-action="lanePreview" disabled>VALIDATE ORDER</button>
        <p class="lane-preview-source" data-e3="lane-preview-source">No replayable TradingView ingress row.</p>
        <p class="lane-preview-result" data-e3="lane-preview-result" role="status" aria-live="polite" hidden></p>
        <p class="lane-control-error" data-e3="lane-error" role="alert" hidden></p>
        <p class="panel-note">Authenticated dashboard control. No Discord chat command is installed.</p>
      </article>
    </div>
  </section>` : '';
  const e3Styles = e3SpineEnabled ? `<style>
    .e3-spine-panes{display:grid;grid-template-columns:1fr 1fr;gap:16px}.e3-spine-facts{display:grid;grid-template-columns:1fr 1fr;margin:0}.e3-spine-facts>div{padding:13px;border-bottom:1px solid var(--line)}.e3-spine-facts dt{color:var(--muted);font:700 9px/1.2 var(--mono);letter-spacing:.1em;text-transform:uppercase}.e3-spine-facts dd{margin:7px 0 0;font:700 17px/1.2 var(--mono);font-variant-numeric:tabular-nums}.lane-arm-state{display:inline-flex;align-items:center;gap:7px;border-radius:999px;padding:7px 11px}.lane-arm-state:before{content:'';width:8px;height:8px;border-radius:50%;background:currentColor;box-shadow:0 0 8px currentColor}.lane-arm-state[data-state="armed"]{color:var(--green);border-color:rgba(96,226,168,.55);background:rgba(35,196,143,.13)}.lane-arm-state[data-state="disarmed"]{color:var(--red);border-color:rgba(242,118,118,.55);background:rgba(242,118,118,.1)}.lane-control-error,.lane-preview-result{margin:10px 0 0;padding:9px 11px;border:1px solid rgba(242,118,118,.45);border-radius:5px;background:rgba(242,118,118,.08);color:var(--red);font:700 10px/1.45 var(--mono)}.lane-preview-result{border-color:rgba(96,226,168,.45);background:rgba(35,196,143,.08);color:var(--green)}.lane-control-error[hidden],.lane-preview-result[hidden]{display:none}.lane-preview-source{margin:10px 0 0;color:var(--muted);font:700 9px/1.45 var(--mono);overflow-wrap:anywhere}@media(max-width:760px){.e3-spine-panes{grid-template-columns:1fr}.e3-spine-facts{grid-template-columns:1fr}}
  </style>` : '';
  const portfolio = `<section class="portfolio-ledger" aria-label="Current Schwab portfolio books">
    <article class="panel expiration-panel"><div class="panel-head"><div><p class="kicker">Open short-option capital by time to expiry</p><h3>Expiration ladder</h3></div><span data-vsim="custody-scope" class="as-of">—</span></div><div class="expiration-ladder" data-vsim="expiration-ladder"></div><div class="panel-note" data-vsim="expiration-note">W1–W4 use current V5 custody and the configured expiration concentration limit.</div></article>
    <article class="panel"><div class="panel-head"><div><p class="kicker">Open-position economics · Schwab custody</p><h3>Portfolio economics</h3></div><span class="readonly-tag">READ ONLY</span></div>
      <div class="desk-metrics">
        <div><span>Booked premium</span><strong data-vsim="booked-premium">—</strong><small>open short-option entry credit</small></div>
        <div><span>Income θ / day</span><strong data-vsim="income-theta">—</strong><small data-vsim="income-theta-note">short-option time decay</small></div>
        <div data-vsim="net-theta-card"><span>Net θ / day</span><strong data-vsim="net-theta">—</strong><small data-vsim="net-theta-note">all open option positions</small></div>
        <div><span>Open P&amp;L</span><strong data-vsim="open-pnl">—</strong><small data-vsim="open-pnl-note">shares + open options</small></div>
        <div><span>Margin debit</span><strong data-vsim="margin-debit">—</strong><small>financing in use</small></div>
        <div><span>Realized premium · MTD</span><strong data-vsim="mtd-realized-premium">—</strong><small data-vsim="mtd-realized-premium-note">closed covered calls + CSPs only</small></div>
      </div>
    </article>
    <article class="panel capital-guardrails"><div class="panel-head"><div><p class="kicker">Constitutional capital utilization</p><h3>Deployment and cash reserve</h3></div><span class="readonly-tag">SETTLED UNBORROWED CASH</span></div><div class="risk-gauges"><div class="risk-gauge" data-vsim="deployed-gauge"></div><div class="risk-gauge" data-vsim="reserve-gauge"></div></div><div class="panel-note">Buying power and withdrawal capacity are excluded from the reserve calculation.</div></article>
    <article class="panel"><div class="panel-head"><div><p class="kicker">Current market value and assignment collateral</p><h3>Capital committed by ticker</h3></div><span data-vsim="concentration-cap" class="as-of">—</span></div><div class="commitment-bars" data-vsim="commitments"></div></article>
    <article class="panel table-panel"><div class="panel-head"><div><p class="kicker">Current shares from Schwab custody</p><h3>Inventory / ownership book</h3></div><span data-vsim="inventory-count" class="count">0 positions</span></div><div class="table-wrap"><table><thead><tr><th>Ticker</th><th>Qty</th><th>Average price</th><th>Mark</th><th>Market value</th><th>Open P&amp;L</th><th>Portfolio weight</th><th>Available CCs</th><th>Directive</th></tr></thead><tbody data-vsim="inventory-body"></tbody></table></div><div class="panel-note">SELL CC appears only when Schwab proves at least one unencumbered 100-share lot, no working order is present, and average share price is known.</div></article>
    <article class="panel table-panel"><div class="panel-head"><div><p class="kicker">Open short options from Schwab custody</p><h3>Income / harvest book</h3></div><span data-vsim="harvest-count" class="count">0 active</span></div><div class="table-wrap"><table><thead><tr><th>Ticker</th><th>Type</th><th>Strike</th><th>Expiration</th><th>Qty</th><th>Entry credit</th><th>Mark</th><th>Open P&amp;L</th><th>θ / day</th><th>Distance to strike</th><th>Capital committed</th><th>Quote</th></tr></thead><tbody data-vsim="harvest-body"></tbody></table></div><div class="panel-note">Distance is OTM cushion: percent of spot · dollars/share · risk-neutral −d₂ when lifecycle inputs are complete. Stale quote-derived values remain visible but are explicitly muted and badged.</div></article>
    <article class="panel cc-lifecycle-panel"><div class="panel-head"><div><p class="kicker">Shares already owned · calls already open</p><h3>Covered-call lifecycle calculator</h3></div><span class="readonly-tag">DETERMINISTIC · READ ONLY</span></div><div class="cc-lifecycle-cards" data-vsim="cc-lifecycle-cards"></div><div class="panel-note">Flags are observable conditions, not a blended score. Risk-neutral probability is European and excludes early exercise. CLOSE · ROLL · EXIT remain NO_TRUTH until a validated common-horizon decision model exists.</div></article>
  </section>`;
  const underwrite = `<section class="view" id="underwrite" aria-labelledby="underwrite-title"><div class="page-heading"><div><p class="kicker">One underwriting workspace · read-only</p><h2 id="underwrite-title">Underwrite</h2></div><span class="readonly-tag">NO ORDER ROUTE</span></div><div class="underwrite-tabs" role="tablist" aria-label="Underwriting mode"><button type="button" class="underwrite-tab active" role="tab" aria-selected="true" data-underwrite-mode="scan">Scan opportunities</button><button type="button" class="underwrite-tab" role="tab" aria-selected="false" data-underwrite-mode="manual">Specify manually</button></div><div class="underwrite-pane active" data-underwrite-pane="scan"></div><div class="underwrite-pane" data-underwrite-pane="manual" hidden></div></section>`;
  const performance = `<section class="view" id="performance" aria-labelledby="performance-title"><div class="page-heading"><div><p class="kicker">Lifetime results and canonical Schwab ledger drill-down</p><h2 id="performance-title">Performance</h2></div><button type="button" class="as-of history-link" data-jump-system-history>History integrity →</button></div><div class="desk-metrics performance-metrics"><div><span>Realized P&amp;L · Lifetime</span><strong data-vsim="performance-realized">—</strong><small data-vsim="performance-realized-note">Lifetime · matched closed trades</small></div><div><span>Unrealized P&amp;L</span><strong data-vsim="performance-unrealized">—</strong><small data-vsim="performance-unrealized-note">latest custody marks</small></div><div><span>Total P&amp;L</span><strong data-vsim="performance-total">—</strong><small data-vsim="performance-total-note">realized + unrealized</small></div><div><span>Win rate</span><strong data-vsim="win-rate">—</strong><small data-vsim="win-count">—</small></div><div><span>Profit factor</span><strong data-vsim="profit-factor">—</strong><small data-vsim="profit-factor-note">Lifetime · gross wins ÷ gross losses</small></div><div><span>Matched trades</span><strong data-vsim="closed-trades">—</strong><small data-vsim="closed-trades-note">Lifetime ledger denominator</small></div></div><article class="panel pnl-calendar-panel"><div class="panel-head pnl-calendar-head"><div><p class="kicker" data-vsim="pnl-calendar-subtitle">Realized daily P&amp;L · all closed lifecycles · Schwab ledger</p><h3>Realized P&amp;L calendar</h3></div><div class="pnl-calendar-tools"><span data-vsim="pnl-calendar-reconciliation" class="readonly-tag">CHECKING</span><div class="pnl-calendar-nav"><button type="button" aria-label="Previous month" data-pnl-calendar-shift="-1">‹</button><strong data-vsim="pnl-calendar-month">—</strong><button type="button" aria-label="Next month" data-pnl-calendar-shift="1">›</button></div></div></div><div class="pnl-calendar-scopes" role="group" aria-label="Realized P&amp;L strategy scope"><button type="button" class="chip active" data-pnl-calendar-scope="ALL">All strategies</button><button type="button" class="chip" data-pnl-calendar-scope="IN_MANDATE">CC + CSP only</button></div><div class="pnl-calendar-weekdays" aria-hidden="true"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span></div><div class="pnl-calendar-grid" data-vsim="pnl-calendar-grid"></div><div class="pnl-calendar-footer"><div><span>Profit</span><strong data-vsim="pnl-calendar-profit">—</strong></div><div><span>Loss</span><strong data-vsim="pnl-calendar-loss">—</strong></div><div><span data-vsim="pnl-calendar-net-label">MONTH TOTAL</span><strong data-vsim="pnl-calendar-net">—</strong></div></div><p class="panel-note" data-vsim="pnl-calendar-note">New York market date · NYSE full-day closures · early-close sessions count as trading days.</p></article><article class="panel mandate-panel"><div class="panel-head"><div><p class="kicker">Historical strategy-leg view</p><h3>Mandate lens</h3></div><span class="readonly-tag">DRILL DOWN TO VERIFY STRUCTURES</span></div><div class="desk-metrics mandate-metrics"><div><span>Mandate-compatible legs</span><strong data-vsim="mandate-pnl">—</strong><small data-vsim="mandate-trades">—</small></div><div><span>Compatible profit factor</span><strong data-vsim="mandate-profit-factor">—</strong><small>SHARES · SHORT_CALL · SHORT_PUT</small></div><div><span>Structure review</span><strong data-vsim="review-pnl">—</strong><small data-vsim="review-trades">—</small></div><div><span>Review profit factor</span><strong data-vsim="review-profit-factor">—</strong><small>inspect long legs and futures</small></div></div><p class="panel-note" data-vsim="mandate-note">Historical option legs require ledger review before they can be classified as standalone or part of a spread.</p></article><article class="panel"><div class="panel-head"><div><p class="kicker">Matched realized lifecycles · drag to filter ledger dates</p><h3>Cumulative realized P&amp;L</h3></div><span data-vsim="performance-asof" class="as-of">—</span></div><svg class="performance-chart" data-vsim="performance-chart" viewBox="0 0 1000 220" role="img" aria-label="Cumulative realized profit and loss. Drag horizontally to filter the ledger by date."></svg></article><div class="two-column"><article class="panel"><div class="panel-head"><div><p class="kicker">Click a row to filter the ledger</p><h3>By ticker</h3></div></div><div class="attribution" data-vsim="ticker-attribution"></div></article><article class="panel"><div class="panel-head"><div><p class="kicker">Click a row to filter the ledger</p><h3>By strategy</h3></div></div><div class="attribution" data-vsim="strategy-attribution"></div></article></div><article class="panel table-panel performance-ledger"><div class="panel-head"><div><p class="kicker">Canonical append-only Schwab ledger</p><h3>Closed trade drill-down</h3></div><span data-vsim="filtered-trade-count" class="count">—</span></div><div class="ledger-filters"><span data-vsim="ledger-filter-summary">All matched trades</span><label>From <input type="date" data-performance-from></label><label>To <input type="date" data-performance-to></label><button type="button" class="chip" data-clear-performance-filter>Clear filters</button></div><div class="table-wrap"><table><thead><tr><th>Closed</th><th>Ticker</th><th>Strategy</th><th>Asset</th><th>Direction</th><th>Qty</th><th>Opened</th><th>Opening price</th><th>Closing price</th><th>Fees</th><th>Realized P&amp;L</th></tr></thead><tbody data-vsim="closed-trades-body"></tbody></table></div><div class="panel-note">Click attribution rows or drag the cumulative curve to filter. Raw broker packets remain protected; this table shows FIFO-matched lifecycles.</div></article><details class="panel broker-activity"><summary>Broker activity · imported orders, executions, cash, assignment and transfer events</summary><div class="table-wrap"><table><thead><tr><th>Occurred</th><th>Type</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Price</th><th>Cash amount</th><th>State</th></tr></thead><tbody data-vsim="broker-activity-body"></tbody></table></div></details><div class="preview-disclaimer" data-vsim="performance-warning"></div></section>`;
  const readinessScorecard = `<article class="panel scorecard"><div class="panel-head"><div><p class="kicker">Five scoreboards</p><h3>Readiness</h3></div><strong class="readiness">1 / 5</strong></div>
            <div class="score-rows"><div><span>Economic</span><i></i><small>Awaiting data</small></div><div><span>Calibration</span><i></i><small>Awaiting data</small></div><div><span>Execution</span><i></i><small>Not connected</small></div><div class="ready"><span>Constitution</span><i></i><small>Clean</small></div><div><span>Survival</span><i></i><small>Awaiting data</small></div></div>
          </article>`;
  const laneSummaryCard = `<article class="panel lane-summary-card" aria-labelledby="lane-summary-title"><div class="panel-head"><div><p class="kicker">LANE_1 · SPY 1 SHARE</p><h3 id="lane-summary-title">BOT summary</h3></div><strong class="lane-summary-arm" data-vsim="lane-summary-arm">—</strong></div>
    <div class="lane-summary-facts"><div><span>Position</span><strong data-vsim="lane-summary-position">—</strong></div><div><span>Fills</span><strong data-vsim="lane-summary-fills">0 of 4</strong></div></div>
    <div class="lane-summary-matrix" role="table" aria-label="Lane 1 evidence by instruction"><div class="lane-summary-matrix-head" role="row"><span role="columnheader">Instruction</span><span role="columnheader" title="Principal-confirmed alert configuration; not runtime evidence.">Alert</span><span role="columnheader">Preview</span><span role="columnheader">Fill</span></div><div data-vsim="lane-summary-matrix-body"></div></div>
    <div class="lane-summary-last"><span>Last signal</span><strong data-vsim="lane-summary-last">—</strong></div>
    <div class="lane-summary-today"><span>Today</span><strong data-vsim="lane-summary-today">— realized · — open</strong></div>
    <div class="lane-summary-block"><span>Blocking</span><strong data-vsim="lane-summary-blocking">—</strong></div>
    </article>`;
  const mobileSystemCard = `<article class="panel system-brief mobile-system-brief" aria-label="System status"></article>`;
  const botStatusCard = `<article class="panel bot-status-card" aria-labelledby="bot-status-title">
    <div class="bot-status-head"><div><p class="kicker">LANE_1 · LIVE CONTROL</p><h2 id="bot-status-title" data-vsim="bot-broker-symbol">Schwab · —</h2></div><div class="bot-status-actions"><button class="chip" type="button" data-action="laneRefresh" aria-label="Refresh Schwab bot position">↻</button><button class="cc-directive bot-quick-disarm" type="button" data-action="laneDisarm">DISARM</button><details class="bot-control-menu"><summary aria-label="BOT controls">•••</summary><div><button type="button" data-action="laneArm" data-vsim="bot-menu-arm">ARM</button><button type="button" data-action="laneDisarm" data-vsim="bot-menu-disarm">DISARM</button><button type="button" data-action="laneRecover">RECOVER OPEN POSITION</button><button type="button" disabled title="Available after live-exit validation">FLATTEN</button><small>Recovery is broker-first and never arms or trades.</small><small>Available after live-exit validation</small></div></details></div></div>
    <div class="bot-position"><strong data-vsim="bot-position">—</strong><span data-vsim="bot-position-copy">position unavailable</span></div>
    <p class="bot-arm-contract" data-vsim="bot-arm-contract">ARM transition unavailable</p>
    <div class="bot-pnl-grid"><div><span>OPEN P/L</span><strong data-vsim="bot-open-pnl">—</strong></div><div><span>DAY P/L</span><strong data-vsim="bot-day-pnl">—</strong></div></div>
    <div class="bot-status-row"><strong data-vsim="bot-live-state" data-state="stale">STALE</strong><strong data-vsim="bot-arm-state" data-vsim-control-state data-state="disarmed" role="status" aria-live="polite">DISARMED</strong><strong data-vsim="bot-online-state" data-state="offline">OFFLINE</strong></div>
    <p class="bot-status-meta"><span data-vsim="bot-live-age">Custody age unavailable</span><span>Stops new orders — does not cancel or flatten</span></p>
    <p class="bot-disarm-error" data-vsim="bot-disarm-error" role="alert" aria-live="assertive" hidden></p>
  </article>`;
  const bot = `<section class="view" id="bot" aria-labelledby="bot-title">
    ${botStatusCard}
    <div class="page-heading"><div><p class="kicker">LANE_1_SPY · append-only operational evidence</p><h2 id="bot-title">BOT event ledger</h2></div><span class="readonly-tag">PHASE 1 · READ ONLY</span></div>
    <div class="bot-ledger-counts" aria-label="Lane 1 event counts">
      <div><span>SIGNAL</span><strong data-vsim="bot-count-signal">0</strong></div>
      <div><span>REFUSED</span><strong data-vsim="bot-count-refused">0</strong></div>
      <div><span>PREVIEW</span><strong data-vsim="bot-count-preview">0</strong></div>
      <div><span>ORDER</span><strong data-vsim="bot-count-order">0</strong><small data-vsim="bot-order-reason">NEVER ARMED</small></div>
      <div><span>FILL</span><strong data-vsim="bot-count-fill">0</strong><small data-vsim="bot-fill-reason">NEVER ARMED</small></div>
    </div>
    <article class="panel bot-ledger-scope"><div><p class="kicker">Bot-only measurement</p><h3>P&amp;L · <span data-vsim="bot-pnl-status">NOT_MEASURED</span></h3><p data-vsim="bot-pnl-reason">No captured Lane 1 fill payloads exist. Phase 1 does not infer pairing or substitute account P&amp;L.</p></div><div><p class="kicker">Round-trip pairing</p><h3 data-vsim="bot-phase2-status">BLOCKED_NO_FILL_PAYLOADS</h3><p data-vsim="bot-phase2-reason">Round-trip pairing starts only after four complete broker fill payloads are captured.</p></div></article>
    <article class="panel table-panel bot-event-ledger"><div class="panel-head"><div><p class="kicker">Authenticated signals, named refusals, and Schwab previews</p><h3>Chronological Lane 1 events</h3><p class="bot-ledger-source" data-vsim="bot-ledger-source-status">Checking both append-only sources.</p></div><span class="count" data-vsim="bot-event-count">0 events</span></div><div class="table-wrap"><table><thead><tr><th>Timestamp</th><th>Event</th><th>Raw side</th><th>Accepted instruction</th><th>Qty</th><th>Outcome</th><th>Reason code</th><th>Receipt / ingress</th></tr></thead><tbody data-vsim="bot-event-ledger-body"></tbody></table></div><div class="panel-note">Raw side is displayed exactly as stored. A rejected token is never normalized into an accepted instruction. ORDER and FILL remain zero until the existing coordinator history records them.</div></article>
  </section>`;
  const calculators = `<section class="view" id="calculators" aria-labelledby="calculators-title">
    <div class="page-heading"><div><p class="kicker">Read-only underwriting · no order route</p><h2 id="calculators-title">Options calculators</h2></div></div>
    <div class="calculator-tabs" role="tablist" aria-label="Options calculator type"><button type="button" class="calculator-tab active" role="tab" aria-selected="true" data-calculator="covered-call">Covered calls</button><button type="button" class="calculator-tab" role="tab" aria-selected="false" data-calculator="cash-secured-put">Cash-secured puts</button></div>
    <div class="calculator-pane active" data-calculator-pane="covered-call">
      <article class="panel calculator-selector cc-status" data-vsim="cc-status"><div class="panel-head"><div><h3>Covered call</h3><p class="sub" data-vsim="cc-outcome">Choose an owned ticker</p></div><span class="readonly-tag" data-vsim="cc-badge">READY</span></div><div class="calculator-symbols" data-vsim="cc-symbols"><span class="cc-unavailable">Loading owned positions…</span></div><p data-vsim="cc-reason" class="cc-reason">VSIM will re-check custody, the market session, and fresh option quotes before calculating.</p><div class="calculator-rules"><span>Strike must exceed your average share price.</span><span>Evaluates 7 / 14 / 21 DTE.</span><span data-vsim="cc-symbol-count">Loading custody…</span></div></article>
      <div class="calculator-results" data-vsim="cc-results" hidden>
        <article class="panel cc-recommendation" data-vsim="cc-recommendation" hidden><div class="panel-head"><div><p class="kicker">Best eligible covered call</p><h3><span data-vsim="cc-ticker">—</span> · Sell <span data-vsim="cc-contracts">—</span> call contract(s)</h3></div><span class="regime">READ ONLY</span></div><div class="desk-metrics cc-metrics"><div><span>Strike</span><strong data-vsim="cc-strike">—</strong><small data-vsim="cc-expiration">—</small></div><div><span>Net premium</span><strong data-vsim="cc-premium">—</strong><small>executable bid less fees</small></div><div><span>Premium ROC</span><strong data-vsim="cc-roc">—</strong><small data-vsim="cc-annualized-roc">—</small></div><div><span>Expire OTM</span><strong data-vsim="cc-otm">—</strong><small>market-implied</small></div><div><span>Touch risk</span><strong data-vsim="cc-touch">—</strong><small>market-implied</small></div><div><span>Called-away return</span><strong data-vsim="cc-callaway">—</strong><small>gain + premium vs cost</small></div></div><p class="cc-decision-impact" data-vsim="cc-impact">—</p></article>
        <article class="panel"><div class="panel-head"><div><h3>7 / 14 / 21 DTE comparison</h3></div><span data-vsim="cc-asof" class="as-of">—</span></div><div class="cc-tenors" data-vsim="cc-tenors"></div></article>
        <article class="panel table-panel" data-vsim="cc-candidate-panel" hidden><div class="panel-head"><div><h3>Eligible candidates</h3></div><span class="count" data-vsim="cc-eligible-count">—</span></div><div class="table-wrap"><table><thead><tr><th>Rank</th><th>Expiry (DTE)</th><th>Strike</th><th>Bid</th><th>NEV / day</th><th>vs hold</th></tr></thead><tbody data-vsim="cc-candidates"></tbody></table></div></article>
        <details class="vsim-diagnostics"><summary>Diagnostics and evidence</summary><pre data-vsim="cc-diagnostics">No calculation loaded.</pre></details>
      </div>
    </div>
    <div class="calculator-pane" data-calculator-pane="cash-secured-put" hidden>
      <article class="panel csp-status" data-vsim="csp-status"><div class="panel-head"><div><h3>Cash-secured put</h3><p class="sub" data-vsim="csp-outcome">Ready for a fresh calculation</p></div><span class="readonly-tag" data-vsim="csp-badge">READY</span></div><p class="cc-reason" data-vsim="csp-reason">Uses fresh market data, unborrowed cash, assignment-notional concentration, and constitutional portfolio limits.</p><button type="button" class="cc-directive csp-run" data-csp-calculate>RUN CALCULATION</button><div class="calculator-rules"><span>Cash remains the default.</span><span>Collateral hurdle is charged inside NEV.</span></div></article>
      <div class="calculator-results" data-vsim="csp-results" hidden>
        <article class="panel csp-recommendation" data-vsim="csp-recommendation" hidden><div class="panel-head"><div><p class="kicker">Best eligible cash-secured put</p><h3><span data-vsim="csp-ticker">—</span> · <span data-vsim="csp-expiry-strike">—</span></h3></div><span class="regime">READ ONLY</span></div><div class="desk-metrics cc-metrics"><div><span>Entry credit</span><strong data-vsim="csp-credit">—</strong><small>modeled executable fill</small></div><div><span>Cash required</span><strong data-vsim="csp-cash">—</strong><small>settled cash · no buying power</small></div><div><span>Breakeven</span><strong data-vsim="csp-breakeven">—</strong><small>strike less credit/share</small></div><div><span>NEV / day</span><strong data-vsim="csp-nev-day">—</strong><small>ranking and eligibility metric</small></div><div><span>Wheel-ready paths</span><strong data-vsim="csp-wheel-ready">—</strong><small>assignment paths within recovery limit</small></div><div><span>Profit probability</span><strong data-vsim="csp-pop">—</strong><small>independent model estimate</small></div></div><p class="cc-decision-impact" data-vsim="csp-impact">—</p></article>
        <article class="panel table-panel" data-vsim="csp-candidate-panel" hidden><div class="panel-head"><div><h3>Evaluated candidates</h3></div><span data-vsim="csp-asof" class="as-of">—</span></div><div class="table-wrap"><table><thead><tr><th>Rank</th><th>Ticker</th><th>Expiry (DTE)</th><th>Strike</th><th>NEV / day</th><th>Decision</th></tr></thead><tbody data-vsim="csp-candidates"></tbody></table></div></article>
        <details class="vsim-diagnostics"><summary>Diagnostics and evidence</summary><pre data-vsim="csp-diagnostics">No calculation loaded.</pre></details>
      </div>
    </div>
  </section>`;
  const additions = `<style>
    .portfolio-ledger{display:grid;gap:16px;margin-top:16px}.desk-metrics{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));border:1px solid var(--line);border-radius:6px;overflow:hidden}.desk-metrics>div{padding:15px;border-right:1px solid var(--line);background:rgba(7,23,20,.42)}.desk-metrics>div:last-child{border-right:0}.desk-metrics span,.desk-metrics small{display:block}.desk-metrics span{font-size:9px;letter-spacing:.13em;text-transform:uppercase;color:var(--muted)}.desk-metrics strong{display:block;margin:6px 0 3px;font-size:20px;font-variant-numeric:tabular-nums}.desk-metrics small{font-size:9px;color:var(--muted)}.commitment-bars,.attribution{display:grid;gap:10px}.commitment-row,.attribution-row{display:grid;grid-template-columns:80px 1fr 80px 100px;gap:10px;align-items:center;font-size:11px}.commitment-track,.attribution-track{height:8px;background:#102620;border-radius:10px;overflow:hidden}.commitment-track i,.attribution-track i{display:block;height:100%;background:linear-gradient(90deg,#32c98d,#66e8ae)}.negative{color:var(--red)!important}.positive-value{color:var(--green)!important}.performance-chart{width:100%;height:220px;background:rgba(5,18,15,.35);border:1px solid var(--line)}.record-metrics,.performance-metrics{margin-bottom:16px}.portfolio-ledger table td,.portfolio-ledger table th,#records table td,#records table th,#calculators table td,#calculators table th{white-space:nowrap}.cc-directive,.cc-back{appearance:none;border:1px solid rgba(61,222,169,.55);border-radius:4px;background:rgba(35,196,143,.1);color:var(--green);font:700 10px/1.2 var(--mono);letter-spacing:.08em;padding:7px 10px;cursor:pointer}.cc-directive:hover,.cc-back:hover{background:rgba(35,196,143,.2)}.cc-unavailable{color:var(--muted);font-size:9px;letter-spacing:.08em;text-transform:uppercase}.cc-status[data-state="blocked"],.csp-status[data-state="blocked"]{border-color:rgba(242,118,118,.38)}.cc-status[data-state="ready"],.csp-status[data-state="ready"]{border-color:rgba(96,226,168,.38)}.cc-reason,.cc-decision-impact{color:var(--text);line-height:1.55}.cc-rule{margin-top:12px;padding:11px 13px;border-left:2px solid var(--amber);background:rgba(244,186,97,.06);color:var(--amber);font-size:11px}.cc-tenors{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.cc-tenor{padding:13px;border:1px solid var(--line);border-radius:5px;background:rgba(7,23,20,.42)}.cc-tenor strong,.cc-tenor span,.cc-tenor small{display:block}.cc-tenor strong{color:var(--green);font-size:16px}.cc-tenor span{margin:5px 0;color:var(--text);font-size:11px}.cc-tenor small{color:var(--muted);font-size:9px}.cc-metrics{margin-top:8px}.cc-decision-impact{margin:14px 0 0;color:var(--green)}.calculator-tabs{display:flex;gap:7px;margin:-6px 0 16px;border-bottom:1px solid var(--line);padding-bottom:12px}.calculator-tab{appearance:none;border:1px solid var(--line);border-radius:5px;background:var(--panel);color:var(--muted);font:700 10px/1.2 var(--mono);letter-spacing:.08em;padding:9px 13px;cursor:pointer}.calculator-tab.active{color:var(--green);border-color:rgba(61,222,169,.55);background:rgba(35,196,143,.1)}.calculator-pane{display:grid;gap:12px}.calculator-pane[hidden]{display:none}.calculator-selector{margin-bottom:0}.calculator-symbols{display:flex;flex-wrap:wrap;gap:8px}.calculator-symbol{display:grid;grid-template-columns:auto auto;gap:3px 14px;align-items:center;text-align:left}.calculator-symbol b{color:var(--text)}.calculator-symbol small{grid-column:1/-1;color:var(--muted);font-size:8px}.calculator-symbol[data-actionable="false"]{border-color:var(--line);color:var(--amber);background:rgba(244,186,97,.05)}.csp-run{margin-top:12px}.csp-recommendation{border-color:rgba(96,226,168,.38)}@media(max-width:1050px){.desk-metrics{grid-template-columns:repeat(3,1fr)}.desk-metrics>div:nth-child(3n){border-right:0}.desk-metrics>div:nth-child(-n+3){border-bottom:1px solid var(--line)}}@media(max-width:680px){.desk-metrics{grid-template-columns:1fr 1fr}.desk-metrics>div{border-bottom:1px solid var(--line)}.commitment-row,.attribution-row{grid-template-columns:62px 1fr 70px}.commitment-row strong,.attribution-row strong{display:none}.cc-tenors{grid-template-columns:1fr}.calculator-tabs{overflow:auto}.calculator-symbol{width:100%}}
    .underwrite-tabs{display:flex;gap:7px;margin:-6px 0 16px;border-bottom:1px solid var(--line);padding-bottom:12px}.underwrite-tab{appearance:none;border:1px solid var(--line);border-radius:5px;background:var(--panel);color:var(--muted);font:700 10px/1.2 var(--mono);letter-spacing:.08em;padding:9px 13px;cursor:pointer}.underwrite-tab.active{color:var(--green);border-color:rgba(61,222,169,.55);background:rgba(35,196,143,.1)}.underwrite-pane[hidden]{display:none}.underwrite-pane>.page-heading{display:none}.history-link{appearance:none;background:transparent;border:0;color:var(--green);cursor:pointer}.mandate-metrics{grid-template-columns:repeat(4,minmax(0,1fr));margin-top:8px}.attribution-row{width:100%;appearance:none;border:0;padding:4px;background:transparent;color:inherit;text-align:left;cursor:pointer;border-radius:4px}.attribution-row:hover,.attribution-row.active{background:rgba(35,196,143,.1);outline:1px solid rgba(61,222,169,.25)}.performance-chart{touch-action:none;cursor:crosshair}.performance-chart .range-selection{fill:rgba(96,226,168,.14);stroke:#60e2a8;stroke-width:1}.performance-ledger{margin-top:16px}.ledger-filters{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 12px;border:1px solid var(--line);border-radius:5px;margin-bottom:12px;color:var(--muted);font-size:10px}.ledger-filters>span{margin-right:auto;color:var(--text)}.ledger-filters label{display:flex;align-items:center;gap:6px}.ledger-filters input{color:var(--text);background:#071712;border:1px solid var(--line);border-radius:4px;padding:6px;font:10px var(--mono);color-scheme:dark}.broker-activity{margin-top:16px}.broker-activity summary{cursor:pointer;color:var(--text);font-weight:700}.performance-ledger td,.performance-ledger th,.broker-activity td,.broker-activity th{white-space:nowrap}.system-history{scroll-margin-top:20px}.system-decisions{margin-top:28px;padding-top:28px;border-top:1px solid var(--line)}.system-decisions>.page-heading{align-items:center;margin-bottom:14px}.system-decisions>.page-heading h2{font-size:22px}.system-decisions .evidence-layout{grid-template-columns:minmax(0,2fr) minmax(220px,.7fr)}.guardian-panel .package-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 18px}@media(max-width:1000px){.system-decisions .evidence-layout{grid-template-columns:1fr}}@media(max-width:680px){.mandate-metrics{grid-template-columns:1fr 1fr}.ledger-filters>span{width:100%;margin-right:0}.guardian-panel .package-facts{grid-template-columns:1fr}}
    .expiration-ladder{display:grid;gap:9px}.expiration-row{display:grid;grid-template-columns:110px minmax(120px,1fr) 96px 100px;gap:12px;align-items:center;font-size:10px}.expiration-row strong{color:var(--muted);font-size:9px;letter-spacing:.08em}.expiration-row strong span{color:var(--text);margin-right:8px}.risk-track{position:relative;height:9px;overflow:visible;border-radius:9px;background:#152c25}.risk-track>i{display:block;height:100%;max-width:100%;border-radius:9px;background:linear-gradient(90deg,#2d8f70,#60e2a8)}.risk-track>.cap-line{position:absolute;top:-4px;bottom:-4px;width:1px;background:var(--amber);box-shadow:0 0 0 1px rgba(244,186,97,.15)}.breach .risk-track>i{background:linear-gradient(90deg,#9d493f,#f27676)}.breach>span,.breach>b{color:var(--red)}.cash-row .risk-track>i{background:linear-gradient(90deg,#2e728e,#69c5e6)}.risk-gauges{display:grid;grid-template-columns:1fr 1fr;gap:16px}.risk-gauge{padding:14px;border:1px solid var(--line);border-radius:6px;background:rgba(7,23,20,.42)}.risk-gauge-head{display:flex;justify-content:space-between;gap:12px;margin-bottom:10px}.risk-gauge-head span{color:var(--muted);font-size:9px;letter-spacing:.1em;text-transform:uppercase}.risk-gauge-head strong{font-size:18px}.risk-gauge small{display:block;margin-top:8px;color:var(--muted);font-size:9px}.commitment-track{position:relative;overflow:visible}.commitment-track .cap-line{position:absolute;top:-4px;bottom:-4px;width:1px;background:var(--amber)}.commitment-row.breach .commitment-track i{background:linear-gradient(90deg,#9d493f,#f27676)}.stale-value{color:#71877e!important;opacity:.72}.stale-badge{display:inline-block;margin-left:6px;padding:1px 4px;border:1px solid rgba(244,186,97,.45);border-radius:3px;color:var(--amber);font-size:7px;line-height:1.3;letter-spacing:.08em;vertical-align:middle}.distance-value{font-variant-numeric:tabular-nums}.distance-value.itm{color:var(--red)}.desk-metrics.five-metrics{grid-template-columns:repeat(5,minmax(0,1fr))}.cc-lifecycle-cards{display:grid;gap:12px}.cc-life-card{border:1px solid var(--line);border-radius:6px;background:rgba(7,23,20,.42);overflow:hidden}.cc-life-head{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;padding:14px}.cc-life-head h4{margin:0;font-size:16px}.cc-life-head small{display:block;margin-top:4px;color:var(--muted)}.cc-life-flags{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:5px}.cc-life-flag{padding:4px 6px;border:1px solid rgba(244,186,97,.4);border-radius:3px;color:var(--amber);font:700 8px/1.2 var(--mono);letter-spacing:.06em}.cc-life-flag.nominal{border-color:rgba(96,226,168,.4);color:var(--green)}.cc-life-metrics{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));border-top:1px solid var(--line)}.cc-life-metrics>div{padding:12px;border-right:1px solid var(--line)}.cc-life-metrics>div:last-child{border-right:0}.cc-life-metrics span,.cc-life-metrics small{display:block;color:var(--muted);font-size:8px}.cc-life-metrics strong{display:block;margin:5px 0;font-size:15px;font-variant-numeric:tabular-nums}.cc-life-paths{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-top:1px solid var(--line)}.cc-life-paths>div{padding:12px;border-right:1px solid var(--line)}.cc-life-paths>div:last-child{border-right:0}.cc-life-paths span{display:block;color:var(--muted);font-size:8px;text-transform:uppercase}.cc-life-paths strong{display:block;margin-top:5px;font-size:14px}.cc-life-foot{padding:10px 14px;border-top:1px solid var(--line);color:var(--muted);font-size:9px;overflow-wrap:anywhere}@media(max-width:1050px){.desk-metrics.five-metrics{grid-template-columns:repeat(3,1fr)}.cc-life-metrics{grid-template-columns:repeat(3,1fr)}.cc-life-paths{grid-template-columns:repeat(2,1fr)}}@media(max-width:680px){.expiration-row{grid-template-columns:78px 1fr 78px}.expiration-row>b{display:none}.risk-gauges{grid-template-columns:1fr}.desk-metrics.five-metrics{grid-template-columns:1fr 1fr}.cc-life-head{display:block}.cc-life-flags{justify-content:flex-start;margin-top:9px}.cc-life-metrics{grid-template-columns:1fr 1fr}.cc-life-paths{grid-template-columns:1fr 1fr}}
    .cc-life-metrics{grid-template-columns:repeat(4,minmax(0,1fr))}@media(max-width:1050px){.cc-life-metrics{grid-template-columns:repeat(3,1fr)}}@media(max-width:680px){.cc-life-metrics{grid-template-columns:1fr 1fr}}
  </style>`;
  const operationalStyles = `<style>
    #overview .today-pnl-card{border-color:rgba(96,226,168,.42);background:linear-gradient(145deg,rgba(17,46,37,.88),rgba(7,25,20,.96))}#overview .today-pnl-card[data-pnl-state="loss"]{border-color:rgba(242,118,118,.48);background:linear-gradient(145deg,rgba(48,25,24,.82),rgba(20,17,15,.96))}#overview .today-pnl-card[data-pnl-state="unavailable"]{border-color:rgba(244,186,97,.42)}#overview .today-pnl-card .metric-value{font-variant-numeric:tabular-nums}#overview .today-pnl-card .metric-foot{line-height:1.45}.vsim-diagnostics{margin-top:14px;padding-top:12px;border-top:1px solid var(--line);color:var(--muted)}.vsim-diagnostics summary{cursor:pointer;font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}.vsim-diagnostics pre{margin:10px 0 0;padding:12px;max-height:220px;overflow:auto;border:1px solid var(--line);border-radius:6px;background:#07110e;color:#9eb2a8;font-size:9px;line-height:1.45;white-space:pre-wrap}#overview .system-brief .health-list li{align-items:center;gap:10px;padding:8px 0}#overview .system-brief .health-label{display:grid;grid-template-columns:10px 1fr;align-items:center;min-width:0}#overview .system-brief .health-label small{grid-column:2;color:var(--muted);font-size:7px;margin-top:2px;font-family:ui-monospace,monospace}#overview .system-brief .health-value{text-align:right;font-size:8px}#overview .system-brief .health-green{background:var(--green);box-shadow:0 0 6px rgba(96,226,168,.6)}#overview .system-brief .health-red{background:var(--red);box-shadow:0 0 6px rgba(242,118,118,.45)}#overview .system-brief .health-amber{background:var(--amber)}#overview .system-brief .health-tape{margin:10px 0 0;padding-top:10px;border-top:1px solid var(--line);color:var(--muted);font:8px/1.45 ui-monospace,monospace;white-space:normal}#overview .system-brief .tv-live-widget{margin-top:8px;min-height:44px;overflow:hidden;border:1px solid var(--line);border-radius:5px;background:#07110e}#overview .system-brief .tv-live-widget .tv-placeholder{padding:13px;color:var(--red);font:8px ui-monospace,monospace}
  </style>`;
  const systemHealthStyles = `<style>
    #overview .system-brief{min-width:0}.system-health-head{align-items:center;margin-bottom:14px}.system-overall{padding:6px 9px;border:1px solid currentColor;border-radius:4px;font:800 8px/1 ui-monospace,monospace;letter-spacing:.12em}.system-health-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.system-health-tile{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:55px;padding:12px 14px;border:1px solid currentColor;background:#07110e;font:700 10px/1 ui-monospace,monospace;letter-spacing:.1em}.system-health-tile>span{color:var(--muted)}.system-health-tile strong{display:flex;align-items:center;gap:7px}.health-light{width:8px;height:8px;border-radius:50%;background:currentColor;box-shadow:0 0 10px currentColor}.system-green{color:var(--green)}.system-amber{color:var(--amber)}.system-red{color:var(--red)}.system-neutral{color:var(--muted)}.system-neutral .health-light{box-shadow:none}.system-health-details{margin-top:12px;border-top:1px solid var(--line);color:var(--muted);font:9px/1.45 ui-monospace,monospace}.system-health-details summary{padding:10px 0 4px;color:var(--muted);cursor:pointer}.system-health-details p{display:flex;justify-content:space-between;gap:12px;margin:0;padding:7px 0;border-top:1px solid rgba(28,48,42,.55)}.system-health-details p strong{color:var(--text)}.system-health-details p span{text-align:right}.system-health-meta{margin:12px 0 0;color:var(--muted);font:8px/1.5 ui-monospace,monospace;overflow-wrap:anywhere}@media(max-width:660px){.system-health-grid{grid-template-columns:1fr}.system-health-details p{display:block}.system-health-details p span{display:block;margin-top:4px;text-align:left}}
  </style>`;
  const botLedgerStyles = `<style>
    .bot-status-card{margin-bottom:12px;padding:22px;border-color:#24302e;background:linear-gradient(145deg,#111820,#0a1118);box-shadow:0 18px 42px rgba(0,0,0,.18)}.bot-status-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.bot-status-head h2{margin:5px 0 0;font-size:22px}.bot-status-actions{display:flex;align-items:center;gap:8px}.bot-quick-disarm{margin:0;border-color:var(--red);color:var(--red)}.bot-control-menu{position:relative}.bot-control-menu summary{display:grid;place-items:center;width:42px;height:38px;border:1px solid var(--line);border-radius:7px;color:var(--text);cursor:pointer;list-style:none;font:800 14px/1 var(--mono)}.bot-control-menu summary::-webkit-details-marker{display:none}.bot-control-menu>div{position:absolute;z-index:8;right:0;top:46px;display:grid;min-width:210px;padding:8px;border:1px solid var(--line);border-radius:8px;background:#0a1513;box-shadow:0 14px 30px rgba(0,0,0,.45)}.bot-control-menu button{padding:10px;border:0;border-bottom:1px solid var(--line);background:transparent;color:var(--text);text-align:left;font:800 10px/1.2 var(--mono);cursor:pointer}.bot-control-menu button:disabled{color:var(--muted);cursor:not-allowed}.bot-control-menu small{padding:8px 10px 4px;color:var(--muted);font:8px/1.35 var(--mono)}.bot-position{display:flex;align-items:center;gap:8px;margin-top:18px}.bot-position strong{padding:7px 11px;border:1px solid var(--line);border-radius:999px;font:800 11px/1 var(--mono)}.bot-position span{color:var(--muted);font:10px/1.2 var(--mono)}.bot-arm-contract{margin:10px 0 0;color:var(--amber);font:800 9px/1.4 var(--mono);overflow-wrap:anywhere}.bot-pnl-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:18px}.bot-pnl-grid>div{padding:18px;border:1px solid var(--line);border-radius:9px;background:rgba(5,11,15,.48)}.bot-pnl-grid span{display:block;color:var(--muted);font:700 9px/1.2 var(--mono);letter-spacing:.13em}.bot-pnl-grid strong{display:block;margin-top:9px;font:800 26px/1.1 var(--mono);font-variant-numeric:tabular-nums}.bot-status-row{display:flex;flex-wrap:wrap;gap:9px;margin-top:18px}.bot-status-row strong{padding:8px 12px;border:1px solid currentColor;border-radius:999px;color:var(--red);font:800 9px/1 var(--mono);letter-spacing:.1em}.bot-status-row strong[data-state="live"],.bot-status-row strong[data-state="armed"],.bot-status-row strong[data-state="online"]{color:var(--green);background:rgba(35,196,143,.1)}.bot-status-row strong[data-state="stale"],.bot-status-row strong[data-state="unconfirmed"]{color:var(--amber);background:rgba(244,186,97,.08)}.bot-status-meta{display:flex;justify-content:space-between;gap:16px;margin:12px 0 0;color:var(--muted);font:8px/1.4 var(--mono)}.bot-disarm-error{margin:14px 0 0;padding:10px 12px;border:1px solid rgba(242,118,118,.65);border-radius:6px;background:rgba(242,118,118,.13);color:var(--red);font:800 10px/1.4 var(--mono);overflow-wrap:anywhere}.bot-disarm-error[hidden]{display:none}
    .bot-ledger-counts{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-bottom:12px}.bot-ledger-counts>div{padding:14px 16px;border:1px solid var(--line);border-radius:7px;background:#081510}.bot-ledger-counts span{display:block;color:var(--muted);font:700 8px/1.2 var(--mono);letter-spacing:.13em}.bot-ledger-counts strong{display:block;margin-top:8px;font:700 20px/1.2 var(--mono)}.bot-ledger-counts small{display:block;margin-top:5px;color:var(--muted);font:700 7px/1.2 var(--mono);letter-spacing:.1em}.bot-ledger-scope{display:grid;grid-template-columns:1fr 1fr;gap:22px;margin-bottom:12px}.bot-ledger-scope h3,.bot-ledger-scope p{margin:0}.bot-ledger-scope h3{margin-top:5px}.bot-ledger-scope p:last-child{margin-top:7px;color:var(--muted);font-size:10px;line-height:1.5}.bot-event-ledger{margin-top:0}.bot-event-ledger table{min-width:1120px}.bot-event-ledger td{font-family:var(--mono);font-size:9px}.bot-event-ledger .bot-refused{color:var(--red)}.bot-event-ledger .bot-clear{color:var(--green)}.bot-record-link{color:var(--cyan);text-decoration:none}.bot-record-link:hover,.bot-record-link:focus-visible{text-decoration:underline}.bot-raw-side{white-space:pre-wrap}.bot-ledger-source{margin:6px 0 0;color:var(--muted);font:700 8px/1.4 var(--mono)}.bot-ledger-source.source-fault{color:var(--red)}
    .lane-summary-card{min-width:0}.lane-summary-arm{padding:5px 8px;border:1px solid currentColor;border-radius:4px;color:var(--muted);font:800 8px/1 var(--mono);letter-spacing:.08em}.lane-summary-arm[data-state="on"]{color:var(--green)}.lane-summary-facts{display:grid;grid-template-columns:1fr 1fr;border:1px solid var(--line);border-radius:5px;overflow:hidden}.lane-summary-facts>div{padding:9px 10px;min-width:0;border-right:1px solid var(--line)}.lane-summary-facts>div:last-child{border-right:0}.lane-summary-facts span,.lane-summary-block span,.lane-summary-last span,.lane-summary-today span{display:block;color:var(--muted);font:700 7px/1.2 var(--mono);letter-spacing:.1em;text-transform:uppercase}.lane-summary-facts strong,.lane-summary-last strong,.lane-summary-today strong{display:block;margin-top:5px;font:700 10px/1.3 var(--mono);overflow-wrap:anywhere}
    .lane-summary-matrix{margin-top:10px;border:1px solid var(--line);border-radius:5px;overflow:hidden}.lane-summary-matrix-head,.lane-summary-matrix-row{display:grid;grid-template-columns:minmax(82px,1.35fr) .5fr .8fr .36fr;align-items:center}.lane-summary-matrix-head{background:#07110e;color:var(--muted);font:700 7px/1.2 var(--mono);letter-spacing:.08em;text-transform:uppercase}.lane-summary-matrix-head span,.lane-summary-matrix-row>div{min-width:0;padding:6px 5px;border-right:1px solid var(--line)}.lane-summary-matrix-head span:last-child,.lane-summary-matrix-row>div:last-child{border-right:0}.lane-summary-matrix-row{border-top:1px solid var(--line);font:700 7px/1.2 var(--mono)}.lane-summary-matrix-row>div:first-child{color:var(--text);white-space:nowrap}.lane-summary-matrix-row>div[data-evidence]{text-align:center}.lane-summary-matrix-row small{display:none}.lane-summary-matrix .clear{color:var(--green)}.lane-summary-matrix .refused{color:var(--amber)}.lane-summary-matrix .unmeasured{color:var(--muted)}
    .lane-summary-last,.lane-summary-today,.lane-summary-block{margin-top:9px;padding-top:8px;border-top:1px solid var(--line)}.lane-summary-block strong{display:block;margin-top:5px;color:var(--amber);font:800 9px/1.3 var(--mono)}@media(max-width:760px){.bot-ledger-counts{grid-template-columns:repeat(2,1fr)}.bot-ledger-scope{grid-template-columns:1fr}}
  </style>`;
  const mobileStyles = `<style>
    .mobile-system-brief{display:none}
    @media(max-width:660px){
      html,body,.shell,.topbar,.nav,main,.view,.panel,.metric-card{min-width:0;max-width:100%}
      body{font-size:13px}.topbar{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px 12px;padding:12px}.brand{min-width:0}.brand h1{font-size:20px}.header-status{margin-left:0;min-width:0}.header-status strong{font-size:11px}.header-status small{font-size:9px}
      .nav{grid-column:1/-1;order:3;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));width:100%;height:auto;gap:2px;overflow:visible}.nav-button{min-width:0;min-height:34px;padding:7px 4px;font-size:10px;line-height:1.15;white-space:normal}.nav-button.active:after{left:8px;right:8px;bottom:0}
      main{padding:18px 10px 36px}.page-heading{margin-bottom:16px}.page-heading h2{font-size:21px}.panel{padding:14px}.panel-head{gap:9px;margin-bottom:13px}.panel-head h3{font-size:16px}.metric-card{min-height:108px;padding:14px}.metric-value{font-size:25px;margin:9px 0}.metric-foot{font-size:9px}
      .lane-summary-card .panel-head{align-items:center}.lane-summary-arm{max-width:48%;text-align:right;line-height:1.25}.lane-summary-matrix-head,.lane-summary-matrix-row{grid-template-columns:minmax(96px,1.45fr) .52fr .8fr .38fr}.lane-summary-matrix-head span,.lane-summary-matrix-row>div{padding:7px 4px}.lane-summary-matrix-row{font-size:8px}.lane-summary-facts strong,.lane-summary-last strong,.lane-summary-today strong{font-size:11px}
      #bot>.bot-status-card{display:block}#bot>*:not(.bot-status-card){display:none}.bot-status-card{padding:16px}.bot-status-head h2{font-size:19px}.bot-status-actions{gap:6px}.bot-quick-disarm{min-height:44px;padding:9px 10px}.bot-control-menu summary{width:44px;height:44px}.bot-pnl-grid{gap:8px}.bot-pnl-grid>div{padding:14px}.bot-pnl-grid strong{font-size:22px}.bot-status-meta{display:grid;gap:5px}.bot-control-menu>div{position:fixed;top:auto;right:12px;bottom:18px;left:12px}
      #system>.mobile-system-brief{display:block}#system>*:not(.mobile-system-brief):not(.system-decisions){display:none}#system>.system-decisions{display:block;margin-top:14px;padding-top:14px}
      .system-health-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.system-health-tile{min-height:48px;padding:10px 8px;font-size:8px;gap:6px}.system-health-details{display:none}.system-overall{max-width:52%;line-height:1.25;text-align:right}.system-health-meta{font-size:7px}
      .pnl-calendar-head{display:grid}.pnl-calendar-tools{width:100%;flex-wrap:wrap;justify-content:space-between}
      .expiration-row{grid-template-columns:minmax(0,1fr) auto auto;gap:7px 10px}.expiration-row strong{grid-column:1}.expiration-row>span{grid-column:2}.expiration-row>b{display:block;grid-column:3}.expiration-row .risk-track{grid-column:1/-1;grid-row:2}
      #overview>article.table-panel{display:none}
      .portfolio-ledger .table-wrap,#overview .positions-empty .table-wrap{margin:0;overflow:visible}.portfolio-ledger table,#overview .positions-empty table{min-width:0;width:100%}.portfolio-ledger thead,#overview .positions-empty thead{display:none}.portfolio-ledger tbody,#overview .positions-empty tbody{display:grid;gap:10px}.portfolio-ledger tbody tr,#overview .positions-empty tbody tr{display:block;border:1px solid var(--line);border-radius:7px;background:#081510}.portfolio-ledger tbody td,#overview .positions-empty tbody td{display:grid;grid-template-columns:minmax(94px,.8fr) minmax(0,1.2fr);gap:12px;width:100%;padding:9px 10px;border-bottom:1px solid rgba(28,48,42,.75);font-size:11px;white-space:normal;overflow-wrap:anywhere;text-align:right}.portfolio-ledger tbody td:last-child,#overview .positions-empty tbody td:last-child{border-bottom:0}.portfolio-ledger tbody td:before,#overview .positions-empty tbody td:before{content:attr(data-label);color:var(--muted);font:700 8px/1.3 var(--mono);letter-spacing:.1em;text-align:left;text-transform:uppercase}.portfolio-ledger tbody td.muted,#overview .positions-empty tbody td.muted{display:block;text-align:left}.portfolio-ledger tbody td.muted:before,#overview .positions-empty tbody td.muted:before{content:none}
      .portfolio-ledger .panel-note,#overview .positions-empty .panel-note{overflow-wrap:anywhere}
    }
  </style>`;
  const calculatorStyles = `<style>
    .calculator-results{display:grid;gap:12px}.calculator-results[hidden],.calculator-pane[hidden],[data-vsim="cc-candidate-panel"][hidden],[data-vsim="csp-candidate-panel"][hidden]{display:none}.calculator-rules{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:13px;padding-top:12px;border-top:1px solid var(--line);color:var(--muted);font-size:10px}.calculator-rules span:before{content:'✓';margin-right:6px;color:var(--green)}.calculator-symbol:disabled{opacity:1;cursor:default}.calculator-symbol:disabled:hover{background:rgba(244,186,97,.05)}
  </style>`;
  const calendarStyles = `<style>
    .pnl-calendar-panel{margin-bottom:16px}.pnl-calendar-head{align-items:center}.pnl-calendar-tools{display:flex;align-items:center;gap:10px}.pnl-calendar-reconciliation.reconciled{color:var(--green);border-color:rgba(96,226,168,.45);background:rgba(96,226,168,.07)}.pnl-calendar-reconciliation.drift{color:var(--red);border-color:rgba(242,118,118,.55);background:rgba(242,118,118,.08)}.pnl-calendar-nav{display:grid;grid-template-columns:34px minmax(140px,auto) 34px;gap:10px;align-items:center;text-align:center}.pnl-calendar-nav button{appearance:none;width:34px;height:34px;border:1px solid var(--line);border-radius:5px;background:#091510;color:var(--text);font-size:20px;cursor:pointer}.pnl-calendar-nav button:disabled{opacity:.28;cursor:not-allowed}.pnl-calendar-nav strong{font-size:15px}.pnl-calendar-scopes{display:flex;gap:7px;margin:4px 0 14px}.pnl-calendar-scopes .chip.active{color:var(--green);border-color:rgba(96,226,168,.5);background:rgba(35,196,143,.1)}.pnl-calendar-weekdays,.pnl-calendar-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px}.pnl-calendar-weekdays{margin-bottom:7px}.pnl-calendar-weekdays span{text-align:center;color:var(--muted);font:700 9px/1.2 var(--mono);letter-spacing:.13em;text-transform:uppercase}.pnl-calendar-day{position:relative;min-height:84px;padding:10px;border:1px solid var(--line);border-radius:6px;background:rgba(8,21,17,.56);color:var(--text);text-align:left;font:inherit;font-variant-numeric:tabular-nums}.pnl-calendar-day button{font:inherit}.pnl-calendar-day .day-number{display:block;color:var(--muted);font:9px/1.2 var(--mono)}.pnl-calendar-day strong{display:block;margin-top:17px;font:700 clamp(11px,1.2vw,16px)/1.15 var(--mono)}.pnl-calendar-day small{display:block;margin-top:5px;color:var(--muted);font-size:8px}.pnl-calendar-day.actionable{cursor:pointer}.pnl-calendar-day.actionable:hover,.pnl-calendar-day.active{outline:1px solid var(--green);outline-offset:1px}.pnl-calendar-day.positive strong{color:var(--green)}.pnl-calendar-day.negative strong{color:var(--red)}.pnl-calendar-day.zero strong{color:var(--muted)}.pnl-calendar-day.non-trading{border-color:transparent;background:transparent}.pnl-calendar-day.non-trading .day-number{opacity:.45}.pnl-calendar-footer{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:16px;padding-top:15px;border-top:1px solid var(--line)}.pnl-calendar-footer span{display:block;color:var(--muted);font:700 9px/1.2 var(--mono);letter-spacing:.11em;text-transform:uppercase}.pnl-calendar-footer strong{display:block;margin-top:7px;font:700 18px/1.2 var(--mono);font-variant-numeric:tabular-nums}.pnl-calendar-footer>div:first-child strong{color:var(--green)}.pnl-calendar-footer>div:nth-child(2) strong{color:var(--red)}@media(max-width:680px){.pnl-calendar-head{align-items:flex-start}.pnl-calendar-nav{grid-template-columns:30px minmax(105px,auto) 30px}.pnl-calendar-nav button{width:30px;height:30px}.pnl-calendar-weekdays,.pnl-calendar-grid{gap:4px}.pnl-calendar-day{min-height:70px;padding:7px 5px}.pnl-calendar-day strong{margin-top:13px;font-size:10px}.pnl-calendar-day small{font-size:7px}.pnl-calendar-footer{gap:8px}.pnl-calendar-footer strong{font-size:13px}}
  </style>`;
  return source
    .replace('<title>NUVO VSIM v5 — Shadow Preview</title>', '<title>NUVO VSIM v5 — Live Shadow</title>')
    .replace('href="styles.css"', 'href="/design/styles.css"')
    .replace('src="app.js"', 'src="/design/app.js"')
    .replace('</head>', additions + operationalStyles + systemHealthStyles + calculatorStyles + calendarStyles + botLedgerStyles + mobileStyles + e3Styles + `<style>
      body:not(.live-ready) .shell{visibility:hidden}
      body:not(.live-ready)::before{content:'Loading live account data…';position:fixed;inset:0;display:grid;place-items:center;color:#8fa49b;background:#03100c;font:700 12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase}
    </style></head>`)
    .replace('<button class="nav-button" data-view="opportunities">Opportunities</button>', '<button class="nav-button" data-view="underwrite">Underwrite</button>')
    .replace('<button class="nav-button" data-view="evidence">Evidence</button>', '<button class="nav-button" data-view="performance">Performance</button><button class="nav-button" data-view="bot">BOT</button>')
    .replace('<button class="nav-button" data-view="system">System</button>', e3Nav + '<button class="nav-button" data-view="system">System</button>')
    .replace(readinessScorecard, laneSummaryCard)
    .replace('\n\n        <div class="two-column">', '\n' + portfolio + '\n\n        <div class="two-column">')
    .replace(/\n\s{8}<div class="two-column">\n\s{10}<article class="panel environment-panel">[\s\S]*?\n\s{8}<\/div>(?=\n\n\s{8}<article class="panel table-panel">)/u, '')
    .replace('      <section class="view" id="evidence"', calculators + underwrite + performance + bot + '\n      <section class="view" id="decisions"')
    .replace('<section class="view" id="system" aria-labelledby="system-title">', '<section class="view" id="system" aria-labelledby="system-title">' + mobileSystemCard)
    .replace('</main>', e3View + '</main>')
    .replace('</body>', '<script src="/design/live.js"></script></body>');
}

export function designAsset(path) {
  const type = path.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
  let source = path === 'styles.css' ? BUNDLED_DESIGN_STYLES
    : path === 'app.js' ? BUNDLED_DESIGN_APP : null;
  if (source === null) throw new Error('DESIGN_ASSET_UNAVAILABLE');
  if (path.endsWith('.js')) source = source.replace(' · preview`', ' · live shadow`');
  return new Response(source, { headers: {
    'content-type': type,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  } });
}

export function fullDashboard(source = BUNDLED_DESIGN_HTML, options = {}) {
  if (!source) throw new Error('DESIGN_UNAVAILABLE');
  return new Response(rewriteDesignHtml(source, options), { headers: DASHBOARD_HEADERS });
}

export async function serveDashboard(render = fullDashboard, reportError = console.error) {
  try { return await render(); }
  catch (error) {
    reportError('Full dashboard unavailable; serving protected fail-safe console', error);
    return new Response(dashboardHtml(), { headers: {
      ...DASHBOARD_HEADERS,
      'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    } });
  }
}

export function armLaneContract(state = {}) {
  if (state.pendingFill === true || ['FILL_PENDING_EXECUTION', 'FILL_PENDING_FEE']
    .includes(state.state)) {
    return { permitted: false, faultCode: 'LANE_1_ARM_FILL_PENDING',
      text: `ARM REFUSED · ${state.state ?? 'FILL_PENDING'}` };
  }
  if (state.state === 'FAULT' && state.positionSide === 'FLAT'
    && state.faultCode === 'LANE_1_EXIT_PENDING_STATE_REQUIRED') {
    return { permitted: true, transition: 'RESOLVE_COMPLETED_EXIT_AND_ARM',
      text: 'ARM · FLAT · verify completed exit, clear stale fault, and arm' };
  }
  if (state.faultCode || state.state === 'FAULT') {
    return { permitted: false, faultCode: 'LANE_1_ARM_FAULT_PRESENT',
      text: 'ARM REFUSED · FAULT' };
  }
  if (['FLAT', 'DISARMED'].includes(state.state) && state.positionSide === 'FLAT') {
    return { permitted: true, transition: 'FLAT_ONLY',
      text: 'ARM · FLAT · BUY and SELL_SHORT permitted' };
  }
  if (state.state === 'OPEN_SHORT' && state.positionSide === 'SHORT') {
    return { permitted: true, transition: 'ARM_EXISTING_SHORT',
      text: 'ARM · OPEN_SHORT · only BUY_TO_COVER permitted' };
  }
  if (state.state === 'OPEN_LONG' && state.positionSide === 'LONG') {
    return { permitted: true, transition: 'ARM_EXISTING_LONG',
      text: 'ARM · OPEN_LONG · only SELL permitted' };
  }
  return { permitted: false, faultCode: 'LANE_1_ARM_STATE_POSITION_MISMATCH',
    text: `ARM REFUSED · ${state.state ?? 'UNKNOWN'} · ${state.positionSide ?? 'UNKNOWN'}` };
}

export function resolveLaneControlOutcome({ action, previousArmed, result = null, error = null,
  readback = null, readbackError = null }) {
  const arming = action === 'laneArm';
  const verb = arming ? 'ARM' : 'DISARM';
  const prior = previousArmed === true;
  if (!arming) {
    if (readback?.armed === false && readback?.state === 'DISARMED') {
      return { armed: false, error: null };
    }
    const detail = readbackError?.message ?? readbackError ?? error?.message ?? error
      ?? result?.faultCode ?? result?.error ?? result?.message
      ?? (readback ? 'LANE_1_PRINCIPAL_DISARM_STATE_MISMATCH'
        : 'LANE_1_PRINCIPAL_DISARM_READBACK_MISSING');
    return { armed: prior, error: `DISARM UNCONFIRMED — the lane may still be armed. Cancel any in-flight order at Schwab directly. (${String(detail)})` };
  }
  const exactArmReadback = readback?.armed === true && (
    (readback.state === 'FLAT' && readback.positionSide === 'FLAT')
    || (readback.state === 'OPEN_SHORT' && readback.positionSide === 'SHORT')
    || (readback.state === 'OPEN_LONG' && readback.positionSide === 'LONG')
  );
  if (exactArmReadback) {
    return { armed: true, error: null };
  }
  const detail = readbackError?.message ?? readbackError ?? error?.message ?? error
    ?? result?.faultCode ?? result?.error ?? result?.message
    ?? (readback ? 'LANE_1_PRINCIPAL_ARM_STATE_MISMATCH'
      : 'LANE_1_PRINCIPAL_ARM_READBACK_MISSING');
  return { armed: prior, error: `ARM UNCONFIRMED — the lane remains in its prior state. (${String(detail)})` };
}

export function liveDashboardScript({ e3SpineTab = false } = {}) {
  return `(() => {
  'use strict';
  const E3_SPINE_ENABLED = ${e3SpineTab === true};
  const resolveLaneControlOutcome = ${resolveLaneControlOutcome.toString()};
  const armLaneContract = ${armLaneContract.toString()};
  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const present = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  const money = value => present(value) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(value)) : '—';
  const moneyExact = value => present(value) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value)) : '—';
  const number = value => present(value) ? Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—';
  const percent = value => present(value) ? (Number(value) * 100).toFixed(1) + '%' : '—';
  const when = value => value ? new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: 'America/Los_Angeles' }) : 'Not available';
  const text = (node, value) => { if (node) node.textContent = value; };
  const clear = node => { if (node) node.replaceChildren(); };
  const make = (tag, value, className) => { const node = document.createElement(tag); if (value !== undefined) node.textContent = value; if (className) node.className = className; return node; };
  const api = async (path, options) => { const response = await fetch(path, options); const body = await response.json(); if (!response.ok) throw new Error(body.error || body.reason || body.faultCode || body.message || ('HTTP ' + response.status)); return body; };
  const bounded = (promise, timeoutMs, faultCode) => new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(faultCode)), timeoutMs);
    Promise.resolve(promise).then(
      value => { window.clearTimeout(timer); resolve(value); },
      error => { window.clearTimeout(timer); reject(error); },
    );
  });
  const connectorOk = status => status === 'CONNECTED' || status === 'LIVE_READ_ONLY';
  const structure = value => ({ CSP: 'Cash-secured put', BULL_PUT_SPREAD: 'Bull put spread', CASH_SECURED_PUT: 'Cash-secured put' }[value] || value || '—');
  const marketDateKey = value => {
    if (/^\d{4}-\d{2}-\d{2}$/u.test(String(value || ''))) return String(value);
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const get = type => parts.find(part => part.type === type)?.value;
    return get('year') + '-' + get('month') + '-' + get('day');
  };
  const initialPerformanceParams = new URLSearchParams(window.location.search);
  const requestedCalendarMonth = initialPerformanceParams.get('pnlMonth');
  const requestedScope = initialPerformanceParams.get('pnlScope');
  const calculatorState = {
    mode: 'covered-call', coveredCallSymbol: null, coveredCallRequestId: null,
    coveredCallInventory: [], cspCycleId: null, cspRequestId: null,
  };
  const performanceState = {
    report: null, ledger: null, calendar: null, calendarRequestId: 0,
    ticker: initialPerformanceParams.get('pnlTicker'),
    strategy: initialPerformanceParams.get('pnlStrategy'),
    from: initialPerformanceParams.get('pnlFrom'), to: initialPerformanceParams.get('pnlTo'),
    scope: requestedScope === 'IN_MANDATE' ? 'IN_MANDATE' : 'ALL',
    month: /^\d{4}-\d{2}$/u.test(String(requestedCalendarMonth || ''))
      ? requestedCalendarMonth : marketDateKey(new Date()).slice(0, 7),
  };
  let underwriteMode = 'scan';
  let tradingViewWidgetLoad = null;

  async function ensureTradingViewWidget(root) {
    if (!root) return;
    let widget = q('tv-ticker-tape', root);
    if (!widget) {
      widget = make('tv-ticker-tape');
      widget.setAttribute('symbols', 'AMEX:SPY,CBOE:VIX');
      widget.setAttribute('direction', 'horizontal');
      widget.setAttribute('item-size', 'compact');
      widget.append(make('div', 'TRADINGVIEW DATA DISCONNECTED', 'tv-placeholder'));
      root.append(widget);
    }
    try {
      tradingViewWidgetLoad ||= import('https://www.tradingview-widget.com/w/en/tv-ticker-tape.js');
      await tradingViewWidgetLoad;
      await customElements.whenDefined('tv-ticker-tape');
      root.dataset.widget = 'loaded';
    } catch {
      root.dataset.widget = 'failed';
      const placeholder = q('.tv-placeholder', root);
      text(placeholder, 'TRADINGVIEW DATA DISCONNECTED');
    }
  }

  function scrubPreviewLanguage() {
    text(q('.header-status strong'), 'Protected shadow');
    text(q('.header-status small'), 'Loading verified data…');
    text(q('.safety-title'), '◇  LIVE SHADOW');
    text(q('.safety-banner p'), 'Running the live account, market, evidence, and Lane 1 self-audit…');
    text(q('.authority-pill strong'), '2 · PROPOSE ONLY');
    text(q('footer span:first-child'), 'NUVO VSIM v5 · Protected live shadow');
    text(q('footer span:nth-child(2)'), 'Live Lane 1 state loading · Schwab custody read-only');
  }

  function setUnderwriteMode(mode) {
    underwriteMode = mode === 'manual' ? 'manual' : 'scan';
    qa('[data-underwrite-mode]').forEach(button => {
      const active = button.dataset.underwriteMode === underwriteMode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    qa('[data-underwrite-pane]').forEach(pane => {
      const active = pane.dataset.underwritePane === underwriteMode;
      pane.classList.toggle('active', active); pane.hidden = !active;
    });
  }

  function composeConsolidatedViews() {
    const underwriteView = q('#underwrite');
    const opportunitiesView = q('#opportunities');
    const calculatorsView = q('#calculators');
    const scanPane = q('[data-underwrite-pane="scan"]', underwriteView);
    const manualPane = q('[data-underwrite-pane="manual"]', underwriteView);
    if (scanPane && opportunitiesView) {
      while (opportunitiesView.firstChild) scanPane.append(opportunitiesView.firstChild);
      opportunitiesView.remove();
    }
    if (manualPane && calculatorsView) {
      while (calculatorsView.firstChild) manualPane.append(calculatorsView.firstChild);
      calculatorsView.remove();
    }
    const decisions = q('#decisions');
    if (decisions) {
      const heading = q('.page-heading h2', decisions);
      if (heading) heading.textContent = 'Decision evidence';
      const kicker = q('.page-heading .kicker', decisions);
      if (kicker) kicker.textContent = 'Canonical audit trail · sealed records';
    }
    setUnderwriteMode('scan');
  }

  function relocateTopOpportunities() {
    const overview = q('#overview');
    const opportunitiesView = q('#underwrite [data-underwrite-pane="scan"]');
    if (!overview || !opportunitiesView) return;
    const detailed = q('.table-panel.detailed', opportunitiesView);
    if (!detailed) return;
    const panel = Array.from(overview.children).find(node => {
      const heading = node.matches('article.table-panel') && q('h3', node);
      return heading && heading.textContent.trim().toLowerCase() === 'top opportunities';
    });
    if (!panel) return;
    panel.classList.add('top-opportunities-panel');
    opportunitiesView.insertBefore(panel, detailed);
  }

  function consolidateDecisionsIntoSystem() {
    const decisions = q('#decisions');
    const system = q('#system');
    if (!decisions || !system) return;
    decisions.classList.remove('view', 'active');
    decisions.classList.add('system-decisions');
    decisions.removeAttribute('aria-labelledby');
    system.append(decisions);
  }

  function renderRows(tbody, rows, cells) {
    clear(tbody);
    if (!rows.length) {
      const row = make('tr'); const cell = make('td', 'No current candidates. The system remains in NO TRADE until every truth and risk gate passes.');
      cell.colSpan = cells.length; cell.className = 'muted'; row.append(cell); tbody.append(row); return;
    }
    rows.forEach((item, index) => {
      const row = make('tr');
      cells.forEach(formatter => { const cell = make('td'); const result = formatter(item, index); if (result instanceof Node) cell.append(result); else cell.textContent = result; row.append(cell); });
      tbody.append(row);
    });
  }

  function fillTable(tbody, rows, cells, emptyMessage) {
    clear(tbody);
    const table = tbody && tbody.closest('table');
    const labels = table ? qa('th', table).map(node => node.textContent.trim()) : [];
    if (!rows.length) {
      const row = make('tr'); const cell = make('td', emptyMessage, 'muted');
      cell.colSpan = cells.length; row.append(cell); tbody.append(row); return;
    }
    rows.forEach(item => {
      const row = make('tr');
      cells.forEach((formatter, index) => { const cell = make('td'); const value = formatter(item);
        cell.dataset.label = labels[index] || '';
        if (value instanceof Node) cell.append(value); else cell.textContent = value;
        if (typeof value === 'string' && value.startsWith('-$')) cell.className = 'negative';
        row.append(cell); });
      tbody.append(row);
    });
  }

  function setValue(name, value, formatter = String) {
    const node = q('[data-vsim="' + name + '"]');
    if (!node) return;
    const rendered = present(value) ? formatter(value) : (value === 0 ? formatter(value) : '—');
    text(node, rendered);
    if (present(value)) node.classList.toggle('negative', Number(value) < 0);
  }

  function resetCoveredCallView() {
    calculatorState.coveredCallSymbol = null; calculatorState.coveredCallRequestId = null;
    const results = q('[data-vsim="cc-results"]'); if (results) results.hidden = true;
    const recommendation = q('[data-vsim="cc-recommendation"]'); if (recommendation) recommendation.hidden = true;
    const candidates = q('[data-vsim="cc-candidate-panel"]'); if (candidates) candidates.hidden = true;
    clear(q('[data-vsim="cc-tenors"]')); clear(q('[data-vsim="cc-candidates"]'));
    text(q('[data-vsim="cc-outcome"]'), 'Choose an owned ticker');
    text(q('[data-vsim="cc-badge"]'), 'READY');
    text(q('[data-vsim="cc-reason"]'), 'VSIM will re-check custody, the market session, and fresh option quotes before calculating.');
    applyCoveredCallAvailability(calculatorState.coveredCallInventory);
  }

  function resetCspView() {
    calculatorState.cspCycleId = null; calculatorState.cspRequestId = null;
    const results = q('[data-vsim="csp-results"]'); if (results) results.hidden = true;
    const recommendation = q('[data-vsim="csp-recommendation"]'); if (recommendation) recommendation.hidden = true;
    const candidates = q('[data-vsim="csp-candidate-panel"]'); if (candidates) candidates.hidden = true;
    clear(q('[data-vsim="csp-candidates"]'));
    text(q('[data-vsim="csp-outcome"]'), 'Ready for a fresh calculation');
    text(q('[data-vsim="csp-badge"]'), 'READY');
    text(q('[data-vsim="csp-reason"]'), 'Uses fresh market data, unborrowed cash, assignment-notional concentration, and constitutional portfolio limits.');
  }

  function setCalculatorMode(mode) {
    if (calculatorState.mode !== mode) {
      if (mode === 'covered-call') resetCoveredCallView(); else resetCspView();
      calculatorState.mode = mode;
    }
    qa('[data-calculator]').forEach(button => {
      const active = button.dataset.calculator === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    qa('[data-calculator-pane]').forEach(pane => {
      const active = pane.dataset.calculatorPane === mode;
      pane.classList.toggle('active', active); pane.hidden = !active;
    });
  }

  function applyCoveredCallAvailability(rows) {
    if (rows.length > 0 && !rows.some(item => Boolean(item.covered_call_actionable))) {
      text(q('[data-vsim="cc-outcome"]'), 'NO AVAILABLE COVERED-CALL LOT');
      text(q('[data-vsim="cc-badge"]'), 'BLOCKED');
      text(q('[data-vsim="cc-reason"]'), 'Every owned whole lot is already encumbered by an open covered call. No new call can be initiated until shares are released.');
    }
  }

  function renderCalculatorSymbols(inventory) {
    const root = q('[data-vsim="cc-symbols"]'); clear(root);
    const rows = inventory || [];
    calculatorState.coveredCallInventory = rows;
    text(q('[data-vsim="cc-symbol-count"]'), rows.length + ' owned ticker' + (rows.length === 1 ? '' : 's'));
    if (!rows.length) {
      root.append(make('span', 'No owned equity positions are available to inspect.', 'cc-unavailable'));
      return;
    }
    let actionableCount = 0;
    rows.forEach(item => {
      const actionable = Boolean(item.covered_call_actionable);
      if (actionable) actionableCount += 1;
      const button = make('button', undefined, 'cc-directive calculator-symbol');
      button.type = 'button'; button.dataset.actionable = String(actionable); button.disabled = !actionable;
      if (actionable) button.dataset.ccSymbol = item.symbol;
      const openCalls = Number(item.covered_call_open_contracts || 0);
      const unavailable = number(item.covered_call_capacity) + ' available · '
        + number(item.covered_call_encumbered_shares || 0) + ' encumbered by '
        + number(openCalls) + ' open call' + (openCalls === 1 ? '' : 's');
      button.setAttribute('aria-label', actionable ? 'Calculate covered calls for ' + item.symbol : item.symbol + ' ' + unavailable);
      button.append(make('b', item.symbol || '—'), make('span', actionable ? 'RUN' : '0 AVAILABLE'),
        make('small', actionable
          ? number(item.covered_call_capacity) + ' contract(s) available · average price ' + moneyExact(item.average_price)
          : unavailable));
      root.append(button);
    });
    if (actionableCount === 0) applyCoveredCallAvailability(rows);
  }

  function renderPortfolio(portfolio, performance) {
    const account = portfolio.account || {}; const summary = portfolio.summary || {};
    const risk = portfolio.risk_instrumentation || {};
    const quotesStale = portfolio.option_analytics_freshness === 'LAST_MARKET_QUOTE';
    const staleMetric = (name, stale) => {
      const node = q('[data-vsim="' + name + '"]');
      if (node) node.classList.toggle('stale-value', Boolean(stale));
    };
    setValue('booked-premium', summary.booked_premium, money);
    setValue('income-theta', summary.income_theta_per_day, money);
    setValue('net-theta', summary.net_theta_per_day, money);
    const hasLongOptionLeg = Number(portfolio.option_positions || 0) > Number(portfolio.short_option_positions || 0);
    const netThetaCard = q('[data-vsim="net-theta-card"]');
    if (netThetaCard) {
      netThetaCard.hidden = !hasLongOptionLeg;
      netThetaCard.parentElement?.classList.toggle('five-metrics', !hasLongOptionLeg);
    }
    const thetaComplete = portfolio.option_analytics_source === 'SCHWAB_LATEST_AVAILABLE_COMPLETE';
    const thetaAsOf = portfolio.option_analytics_asof ? when(portfolio.option_analytics_asof) : 'No verified quote';
    text(q('[data-vsim="income-theta-note"]'), thetaComplete
      ? number(portfolio.short_option_positions) + ' short-option position'
        + (Number(portfolio.short_option_positions) === 1 ? '' : 's') + ' · '
        + (quotesStale ? 'STALE LAST QUOTE ' : 'quote ') + thetaAsOf
      : 'Unavailable · one or more option Greeks are missing');
    text(q('[data-vsim="net-theta-note"]'), thetaComplete
      ? number(portfolio.option_positions) + ' total option position'
        + (Number(portfolio.option_positions) === 1 ? '' : 's') + ' · '
        + (quotesStale ? 'STALE LAST QUOTE ' : 'quote ') + thetaAsOf
      : 'Unavailable · one or more option Greeks are missing');
    setValue('open-pnl', summary.open_pnl, money);
    staleMetric('income-theta', quotesStale); staleMetric('net-theta', quotesStale); staleMetric('open-pnl', quotesStale);
    const openPnlBreakdown = money(summary.share_open_pnl) + ' shares + '
      + money(summary.option_open_pnl) + ' options';
    text(q('[data-vsim="open-pnl-note"]'), openPnlBreakdown
      + (quotesStale ? ' · contains stale option marks' : ''));
    setValue('margin-debit', account.margin_debit, money);
    const performanceSummary = performance && performance.summary || {};
    const performanceHistory = performance && performance.history || {};
    const realizedPremiumVerified = performanceHistory.status === 'COMPLETE_TO_CONFIGURED_HISTORY_FLOOR';
    const realizedPremium = q('[data-vsim="mtd-realized-premium"]');
    if (realizedPremium) {
      text(realizedPremium, realizedPremiumVerified ? moneyExact(performanceSummary.mtd_realized_premium) : 'UNAVAILABLE');
      realizedPremium.classList.toggle('negative', realizedPremiumVerified
        && Number(performanceSummary.mtd_realized_premium) < 0);
    }
    text(q('[data-vsim="mtd-realized-premium-note"]'), realizedPremiumVerified
      ? number(performanceSummary.mtd_realized_premium_trades) + ' closed covered-call / CSP lifecycle'
        + (Number(performanceSummary.mtd_realized_premium_trades) === 1 ? '' : 's')
        + ' this month · net of close costs and fees'
      : 'Broker history incomplete · realized monthly premium cannot be verified');
    text(q('[data-vsim="inventory-count"]'), (portfolio.inventory || []).length + ' positions');
    text(q('[data-vsim="harvest-count"]'), (portfolio.harvest || []).length + ' active');
    renderCalculatorSymbols(portfolio.inventory || []);

    const masks = risk.custody_scope && risk.custody_scope.account_masks || [];
    const limitsVersion = String(risk.limits_version || 'version unavailable')
      .replace(/^constitution-/u, '');
    text(q('[data-vsim="custody-scope"]'), 'Schwab brokerage account '
      + (masks.length ? masks.map(mask => '••••' + mask).join(' + ') : 'scope unavailable')
      + ' · equities and options · ' + number(risk.custody_scope && risk.custody_scope.packet_position_count) + ' positions');
    const ladder = q('[data-vsim="expiration-ladder"]'); clear(ladder);
    const ladderRows = [...(risk.expiration_ladder || []), {
      bucket: 'CASH', label: 'settled reserve', value: Math.max(0, Number(account.cash || 0)),
      pct: risk.cash_reserve_pct, limit_pct: risk.min_cash_reserve_pct,
      breached: Boolean(risk.reserve_breached), cash: true,
    }];
    ladderRows.forEach(item => {
      const row = make('div', undefined, 'expiration-row' + (item.breached ? ' breach' : '') + (item.cash ? ' cash-row' : ''));
      const label = make('strong'); label.append(make('span', item.bucket), document.createTextNode(item.label));
      const track = make('div', undefined, 'risk-track'); const fill = make('i');
      fill.style.width = Math.min(100, Math.max(0, Number(item.pct || 0) * 100)) + '%'; track.append(fill);
      if (present(item.limit_pct)) { const cap = make('i', undefined, 'cap-line'); cap.style.left = Number(item.limit_pct) * 100 + '%'; track.append(cap); }
      row.append(label, track, make('span', percent(item.pct) + ' of NAV'), make('b', money(item.value))); ladder.append(row);
    });
    text(q('[data-vsim="expiration-note"]'), number(risk.short_option_contracts)
      + ' open short contracts · short-option capital / NAV · Constitution '
      + limitsVersion + ' expiration cap ' + percent(risk.expiration_limit_pct)
      + ' of NAV · ' + when(portfolio.asof) + ' · closed futures activity remains in the Performance ledger.');

    const renderGauge = (root, { label, value, limit, breached, note, floor = false }) => {
      clear(root); if (!root) return;
      const head = make('div', undefined, 'risk-gauge-head'); head.append(make('span', label), make('strong', percent(value)));
      const track = make('div', undefined, 'risk-track'); const fill = make('i');
      fill.style.width = Math.min(100, Math.max(0, Number(value || 0) * 100)) + '%'; track.append(fill);
      if (present(limit)) { const cap = make('i', undefined, 'cap-line'); cap.style.left = Number(limit) * 100 + '%'; track.append(cap); }
      root.classList.toggle('breach', Boolean(breached)); root.append(head, track,
        make('small', note + ' · ' + (floor ? 'minimum ' : 'maximum ') + percent(limit)));
    };
    renderGauge(q('[data-vsim="deployed-gauge"]'), { label: 'Deployed', value: risk.deployed_pct,
      limit: risk.max_deployed_pct, breached: risk.deployed_breached,
      note: money(Math.max(0, Number(account.nav || 0) - Math.max(0, Number(account.cash || 0)))) + ' deployed' });
    renderGauge(q('[data-vsim="reserve-gauge"]'), { label: 'Cash reserve', value: risk.cash_reserve_pct,
      limit: risk.min_cash_reserve_pct, breached: risk.reserve_breached,
      note: money(Math.max(0, Number(account.cash || 0))) + ' settled unborrowed cash', floor: true });

    const bars = q('[data-vsim="commitments"]'); clear(bars);
    const commitments = portfolio.capital_committed || [];
    if (!commitments.length) bars.append(make('p', 'No marked positions or positive cash commitment is available.', 'muted'));
    text(q('[data-vsim="concentration-cap"]'), percent(risk.single_underlying_limit_pct)
      + ' Constitution single-name cap · ' + limitsVersion);
    commitments.forEach(item => { const row = make('div', undefined, 'commitment-row' + (item.breached ? ' breach' : ''));
      row.append(make('strong', item.symbol)); const track = make('div', undefined, 'commitment-track');
      const fill = make('i'); fill.style.width = Math.min(100, Math.max(0, Number(item.pct_nav || 0) * 100)) + '%'; track.append(fill);
      if (present(item.limit_pct)) { const cap = make('i', undefined, 'cap-line'); cap.style.left = Number(item.limit_pct) * 100 + '%'; track.append(cap); }
      row.append(track, make('span', percent(item.pct_nav)), make('b', money(item.value))); bars.append(row); });

    fillTable(q('[data-vsim="inventory-body"]'), portfolio.inventory || [], [
      item => item.symbol || '—', item => number(item.quantity), item => money(item.average_price), item => money(item.mark),
      item => money(item.market_value), item => money(item.unrealized_pnl), item => percent(item.portfolio_weight),
      item => number(item.covered_call_capacity),
      item => {
        if (item.covered_call_actionable) {
          const button = make('button', 'SELL CC', 'cc-directive');
          button.type = 'button'; button.dataset.ccSymbol = item.symbol;
          button.setAttribute('aria-label', 'Calculate covered calls for ' + item.symbol);
          return button;
        }
        const label = item.covered_call_blocker === 'OPEN_ORDER_RECONCILIATION_REQUIRED'
          ? 'ORDER OPEN' : item.covered_call_blocker === 'AVERAGE_SHARE_PRICE_UNAVAILABLE'
            ? 'BASIS NEEDED' : 'NOT AVAILABLE';
        return make('span', label, 'cc-unavailable');
      },
    ], 'No current Schwab equity positions.');
    const quoteValue = (item, value, exact = false) => {
      const node = make('span', exact ? moneyExact(value) : money(value));
      if (Number(value) < 0) node.classList.add('negative');
      if (item.quote_freshness === 'LAST_MARKET_QUOTE') {
        node.classList.add('stale-value'); node.append(make('small', 'STALE', 'stale-badge'));
      }
      return node;
    };
    const distanceValue = item => {
      if (!present(item.distance_to_strike_pct) || !present(item.distance_to_strike_dollars)
        || !present(item.distance_to_strike_sigma)) return make('span', 'UNAVAILABLE', 'cc-unavailable');
      const node = make('span', (Number(item.distance_to_strike_pct) * 100).toFixed(1) + '% · '
        + moneyExact(item.distance_to_strike_dollars) + ' · ' + Number(item.distance_to_strike_sigma).toFixed(2) + 'σ', 'distance-value');
      if (Number(item.distance_to_strike_dollars) < 0) node.classList.add('itm');
      if (item.quote_freshness === 'LAST_MARKET_QUOTE') { node.classList.add('stale-value'); node.append(make('small', 'STALE', 'stale-badge')); }
      return node;
    };
    fillTable(q('[data-vsim="harvest-body"]'), portfolio.harvest || [], [
      item => item.symbol || '—', item => item.type || '—', item => money(item.strike), item => item.expiration || '—',
      item => number(item.quantity), item => money(item.entry_credit), item => quoteValue(item, item.mark, true), item => quoteValue(item, item.unrealized_pnl),
      item => quoteValue(item, item.theta_per_day), item => distanceValue(item), item => money(item.capital_committed ?? item.expiration_capital),
      item => item.quote_asof ? when(item.quote_asof) + (item.quote_freshness === 'LAST_MARKET_QUOTE' ? ' · LAST QUOTE' : '') : 'UNAVAILABLE',
    ], 'No current short-option positions in Schwab custody.');
    const lifecycleRoot = q('[data-vsim="cc-lifecycle-cards"]'); clear(lifecycleRoot);
    const lifecycleRows = (portfolio.harvest || []).filter(item => item.type === 'COVERED_CALL');
    if (!lifecycleRows.length) lifecycleRoot.append(make('p', 'No open covered calls in current Schwab custody.', 'muted'));
    lifecycleRows.forEach(item => {
      const result = item.lifecycle;
      const card = make('section', undefined, 'cc-life-card');
      const head = make('div', undefined, 'cc-life-head');
      const title = make('div'); title.append(make('h4', item.symbol + ' · $' + number(item.strike) + ' call'),
        make('small', item.expiration + ' · ' + number(result && result.dte) + ' DTE · ' + number(item.quantity)
          + ' contract(s) · ' + number(result && result.covered_shares) + ' covered shares'));
      const badges = make('div', undefined, 'cc-life-flags');
      if (result && result.ok) (result.classification.flags || []).forEach(flag => badges.append(
        make('span', flag.code, 'cc-life-flag' + (flag.code === 'NOMINAL' ? ' nominal' : ''))));
      else badges.append(make('span', result && result.error || 'CALCULATOR_UNAVAILABLE', 'cc-life-flag'));
      head.append(title, badges); card.append(head);
      if (!result || !result.ok) {
        card.append(make('p', 'Exact lifecycle economics unavailable: ' + (result && result.error || 'live inputs incomplete') + '. No fee or market value was guessed.', 'cc-life-foot'));
        lifecycleRoot.append(card); return;
      }
      const trade = result.current_trade || {}; const riskNeutral = result.risk_neutral || {}; const paths = result.paths || {};
      const distance = result.distance_to_strike || {}; const basisDistance = result.strike_vs_share_basis || {};
      const metrics = make('div', undefined, 'cc-life-metrics');
      [
        ['RN expire OTM', percent(riskNeutral.probability_expire_otm), 'European · excludes early exercise'],
        ['Distance to strike', percent(distance.pct_of_spot), moneyExact(distance.dollars_per_share) + ' · ' + number(distance.risk_neutral_sigma) + 'σ (−d₂)'],
        ['Close outlay', money(trade.total_close_outlay), 'ask × shares + close fees'],
        ['Liability left', percent(trade.total_liability_pct_of_original_gross_credit), 'close outlay / original gross credit'],
        ['Locked option P&L', money(trade.profit_locked_if_call_closed_now), 'net entry credit − close outlay'],
        ['Extrinsic left', percent(trade.extrinsic_pct_of_original_gross_credit), money(trade.executable_extrinsic_total)],
        ['Theta / day', money(trade.broker_short_theta_per_day), 'broker Greek · short position'],
        ['Adjusted basis', moneyExact(trade.adjusted_share_basis), 'share basis − net credit/share'],
      ].forEach(metric => { const node = make('div'); node.append(make('span', metric[0]), make('strong', metric[1]), make('small', metric[2])); metrics.append(node); });
      const pathGrid = make('div', undefined, 'cc-life-paths');
      [
        ['Assignment P&L', money(paths.assignment && paths.assignment.pnl)],
        ['Exit-now P&L', money(paths.exit_now && paths.exit_now.pnl)],
        ['Worthless scenario', money(paths.expire_worthless && paths.expire_worthless.pnl)],
        ['Close/keep crossover', moneyExact(paths.close_call_keep_shares && paths.close_call_keep_shares.crossover_share_price)],
      ].forEach(path => { const node = make('div'); node.append(make('span', path[0]), make('strong', path[1])); pathGrid.append(node); });
      const flagFacts = (result.classification.flags || []).map(flag => flag.code + ': ' + flag.explanation
        + ' Threshold: ' + flag.threshold + '.').join(' ');
      const gaps = (result.classification.data_gaps || []).length
        ? ' Data gaps: ' + result.classification.data_gaps.join(', ') + '.' : '';
      card.append(metrics, pathGrid, make('p', flagFacts + ' Sell/wait crossover: '
        + moneyExact(paths.sell_shares_wait_on_call && paths.sell_shares_wait_on_call.crossover_share_price)
        + '. Opening fees: ' + money(result.entry_evidence && result.entry_evidence.opening_fees)
        + ' from ' + (result.entry_evidence && result.entry_evidence.source || 'UNVERIFIED')
        + '. Configured close fee: ' + money(result.current_trade && result.current_trade.close_fees)
        + '. Share basis: ' + moneyExact(result.share_basis) + '; strike minus basis: '
        + moneyExact(basisDistance.dollars_per_share) + ' (' + percent(basisDistance.pct_of_share_basis) + ')'
        + '. RN inputs: r ' + percent(riskNeutral.rate) + ', q ' + percent(riskNeutral.dividend_yield)
        + '. CLOSE · ROLL · EXIT: NO_TRUTH.' + gaps, 'cc-life-foot'));
      lifecycleRoot.append(card);
    });
  }

  function activateView(id) {
    qa('.view').forEach(view => view.classList.toggle('active', view.id === id));
    qa('.nav-button').forEach(button => button.classList.toggle('active', button.dataset.view === id));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderCoveredCall(result) {
    const ready = Boolean(result && result.ok && result.selected);
    const results = q('[data-vsim="cc-results"]'); if (results) results.hidden = false;
    const status = q('[data-vsim="cc-status"]');
    if (status) status.dataset.state = ready ? 'ready' : 'blocked';
    text(q('[data-vsim="cc-outcome"]'), ready
      ? 'SELL CC candidate identified for ' + result.symbol
      : 'NO ELIGIBLE COVERED CALL' + (result && result.symbol ? ' · ' + result.symbol : ''));
    text(q('[data-vsim="cc-badge"]'), ready ? 'READY' : 'BLOCKED');
    text(q('[data-vsim="cc-reason"]'), result && result.reason
      ? result.reason : 'Calculation is unavailable. No covered call should be initiated.');
    text(q('[data-vsim="cc-asof"]'), result && result.asof ? 'Quotes as of ' + when(result.asof) : 'No valid live quote');
    const recommendation = q('[data-vsim="cc-recommendation"]');
    if (recommendation) recommendation.hidden = !ready;
    if (ready) {
      const selected = result.selected;
      text(q('[data-vsim="cc-ticker"]'), result.symbol);
      text(q('[data-vsim="cc-contracts"]'), number(selected.contracts));
      text(q('[data-vsim="cc-strike"]'), moneyExact(selected.strike));
      text(q('[data-vsim="cc-expiration"]'), selected.expiration + ' · ' + number(selected.dte) + ' DTE');
      text(q('[data-vsim="cc-premium"]'), moneyExact(selected.net_premium));
      text(q('[data-vsim="cc-roc"]'), percent(selected.premium_roc));
      text(q('[data-vsim="cc-annualized-roc"]'), percent(selected.annualized_premium_roc) + ' annualized');
      text(q('[data-vsim="cc-otm"]'), percent(selected.market_implied_expire_otm));
      text(q('[data-vsim="cc-touch"]'), percent(selected.market_implied_touch));
      text(q('[data-vsim="cc-callaway"]'), percent(selected.called_away_return_on_cost));
      text(q('[data-vsim="cc-impact"]'), 'Decision impact: selling this call would reserve '
        + number(selected.covered_shares) + ' shares through ' + selected.expiration
        + ' and accept sale of those shares at ' + moneyExact(selected.strike)
        + '. Modeled incremental value versus holding uncovered is ' + moneyExact(selected.incremental_nev_vs_holding)
        + ' (' + moneyExact(selected.incremental_nev_per_day) + ' per day). User action is required outside VSIM; this screen cannot place the trade.');
    }
    const tenors = q('[data-vsim="cc-tenors"]'); clear(tenors);
    const configuredTargets = result && (result.target_dtes || []).length
      ? result.target_dtes : ${JSON.stringify(COVERED_CALL_DTE_TARGETS)};
    const tenorRows = result && (result.targets || []).length ? result.targets
      : configuredTargets.map(target => ({ target_dte: target, status: 'NOT_EVALUATED' }));
    tenorRows.forEach(tenor => {
      const card = make('div', undefined, 'cc-tenor');
      card.append(make('strong', number(tenor.target_dte) + ' DTE target'));
      if (tenor.best) card.append(
        make('span', tenor.expiration + ' · ' + moneyExact(tenor.best.strike) + ' strike'),
        make('small', number(tenor.eligible_candidates) + ' eligible · modeled edge/day ' + moneyExact(tenor.best.incremental_nev_per_day)),
      );
      else card.append(make('span', 'No eligible strike'), make('small', tenor.status || 'Blocked'));
      tenors.append(card);
    });
    const candidateRows = [];
    configuredTargets.forEach(target => candidateRows.push(...((result && result.candidates) || [])
      .filter(row => Number(row.target_dte) === target).slice(0, 4)));
    const candidatePanel = q('[data-vsim="cc-candidate-panel"]');
    if (candidatePanel) candidatePanel.hidden = candidateRows.length === 0;
    text(q('[data-vsim="cc-eligible-count"]'), candidateRows.length + ' shown');
    if (candidateRows.length) fillTable(q('[data-vsim="cc-candidates"]'), candidateRows, [
      item => number(item.rank), item => (item.expiration || '—') + ' (' + number(item.dte) + ')',
      item => moneyExact(item.strike), item => moneyExact(item.executable_credit_per_share),
      item => moneyExact(item.incremental_nev_per_day), item => moneyExact(item.incremental_nev_vs_holding),
    ], '');
    else clear(q('[data-vsim="cc-candidates"]'));
    text(q('[data-vsim="cc-diagnostics"]'), JSON.stringify({
      outcome: result && result.outcome, reason_code: result && result.reason_code,
      symbol: result && result.symbol, target_dtes: result && result.target_dtes,
      average_price: result && result.average_price, current_mark: result && result.spot,
      minimum_strike_exclusive: result && result.minimum_strike_exclusive,
      rejected: result && result.rejected, forecast: result && result.forecast, method: result && result.method,
      diagnostics: result && result.diagnostics, source: result && result.source,
      execution: result && result.execution,
    }, null, 2));
  }

  async function openCoveredCall(symbol, button) {
    activateView('underwrite'); setUnderwriteMode('manual'); setCalculatorMode('covered-call'); resetCoveredCallView();
    const requestId = crypto.randomUUID();
    calculatorState.coveredCallSymbol = symbol; calculatorState.coveredCallRequestId = requestId;
    text(q('[data-vsim="cc-outcome"]'), 'Calculating ' + symbol + ' covered calls…');
    text(q('[data-vsim="cc-badge"]'), 'CHECKING');
    text(q('[data-vsim="cc-reason"]'), 'Re-checking unencumbered shares, average price, reconciliation, market session, and fresh 7 / 14 / 21 DTE option quotes.');
    if (button) button.disabled = true;
    try {
      const result = await api('/api/covered-call/calculate?symbol=' + encodeURIComponent(symbol));
      if (calculatorState.mode === 'covered-call' && calculatorState.coveredCallSymbol === symbol
        && calculatorState.coveredCallRequestId === requestId) renderCoveredCall(result);
    } catch (error) {
      if (calculatorState.mode === 'covered-call' && calculatorState.coveredCallSymbol === symbol
        && calculatorState.coveredCallRequestId === requestId) {
        renderCoveredCall({ ok: false, symbol, reason_code: 'CALCULATION_REQUEST_FAILED', reason: error.message });
      }
    }
    finally { if (button) button.disabled = false; }
  }

  function renderCashSecuredPuts(cycle) {
    const rows = ((cycle && cycle.cspOpportunities) || (cycle && cycle.opportunities) || [])
      .filter(item => item.structure === 'CSP' || item.structure === 'CASH_SECURED_PUT')
      .map((item, index) => ({ ...item, cspRank: index + 1 }));
    const best = rows.find(item => item.governorApproved) || null;
    const reasonCodes = [cycle && cycle.reasonCode, ...rows.flatMap(item => item.governorReasonCodes || [])]
      .filter(Boolean).map(value => String(value).toUpperCase());
    const failed = cycle && (cycle.outcome === 'REFUSED' || cycle.state === 'QUARANTINED');
    const unavailable = failed || reasonCodes.some(code => /TRUTH|DATA|QUOTE|CHAIN|SESSION|EVIDENCE|PERSIST|WORKFLOW|RECONCIL|UNAVAILABLE/u.test(code));
    const governorDeclined = rows.some(item => item.governorStatus === 'DECLINED');
    const assignmentUnfunded = rows.find(item => (item.governorReasonCodes || [])
      .includes('SIMULTANEOUS_ASSIGNMENT_UNFUNDED'));
    const verdict = best ? 'ELIGIBLE CSP CANDIDATE'
      : unavailable ? 'NO DATA' : governorDeclined ? 'NO CAPITAL' : 'NO EDGE';
    const results = q('[data-vsim="csp-results"]'); if (results) results.hidden = false;
    calculatorState.cspCycleId = cycle && cycle.cycleId || null;
    const status = q('[data-vsim="csp-status"]');
    if (status) status.dataset.state = best ? 'ready' : 'blocked';
    text(q('[data-vsim="csp-outcome"]'), best ? verdict + ' · ' + best.underlying : verdict);
    text(q('[data-vsim="csp-badge"]'), best ? 'READY' : 'BLOCKED');
    text(q('[data-vsim="csp-reason"]'), best
      ? 'The candidate below cleared current market-data, expectancy, liquidity, cash-security, and portfolio gates.'
      : unavailable && cycle && cycle.reason
        ? cycle.reason + ' This is an infrastructure or input failure, not an investment rejection.'
        : assignmentUnfunded && assignmentUnfunded.assignmentFunding
          ? 'All open short puts plus this proposal require '
            + moneyExact(assignmentUnfunded.assignmentFunding.totalObligation)
            + ' at simultaneous assignment, but settled unborrowed cash is '
            + moneyExact(assignmentUnfunded.assignmentFunding.settledUnborrowedCash)
            + '. Schwab buying power and margin capacity are excluded.'
        : governorDeclined
          ? 'Underwriting found candidate structures, but the Portfolio Governor approved zero contracts. Cash remains uncommitted.'
          : cycle && cycle.reason ? cycle.reason
        : rows[0] && rows[0].governorReasons && rows[0].governorReasons.length
          ? rows[0].governorReasons.join(' ')
          : 'Fresh candidates were evaluated, but none produced positive NEV after the full collateral hurdle. Cash remains preferred.');
    text(q('[data-vsim="csp-asof"]'), cycle && cycle.at ? 'Calculated ' + when(cycle.at) : 'No completed calculation');
    const recommendation = q('[data-vsim="csp-recommendation"]');
    if (recommendation) recommendation.hidden = !best;
    if (best) {
      const contracts = Number(best.approvedContracts || 0);
      text(q('[data-vsim="csp-ticker"]'), best.underlying);
      text(q('[data-vsim="csp-expiry-strike"]'), best.expiration + ' · ' + moneyExact(best.shortStrike) + ' put');
      text(q('[data-vsim="csp-credit"]'), moneyExact(best.sizedEntryCredit));
      text(q('[data-vsim="csp-cash"]'), moneyExact(best.sizedBuyingPower));
      text(q('[data-vsim="csp-breakeven"]'), moneyExact(best.breakeven));
      text(q('[data-vsim="csp-nev-day"]'), moneyExact(best.nevPerDay));
      text(q('[data-vsim="csp-wheel-ready"]'), percent(best.wheelCompatibleFraction));
      text(q('[data-vsim="csp-pop"]'), percent(best.probabilityOfProfitModel));
      text(q('[data-vsim="csp-impact"]'), 'Decision impact: selling ' + number(contracts)
        + ' cash-secured put contract' + (contracts === 1 ? '' : 's') + ' would reserve '
        + moneyExact(best.sizedBuyingPower) + ' through ' + best.expiration + ' and accept assignment at '
        + moneyExact(best.shortStrike) + ' per share. User action is required outside VSIM; this screen cannot place the trade.');
    }
    const candidatePanel = q('[data-vsim="csp-candidate-panel"]');
    if (candidatePanel) candidatePanel.hidden = rows.length === 0;
    if (rows.length) fillTable(q('[data-vsim="csp-candidates"]'), rows, [
      item => number(item.cspRank), item => item.underlying || '—',
      item => (item.expiration || '—') + ' (' + number(item.dte) + ')', item => moneyExact(item.shortStrike),
      item => moneyExact(item.nevPerDay), item => item.governorApproved ? 'ELIGIBLE' : item.governorStatus || 'DECLINED',
    ], '');
    else clear(q('[data-vsim="csp-candidates"]'));
    text(q('[data-vsim="csp-diagnostics"]'), JSON.stringify({
      cycle_id: cycle && cycle.cycleId, outcome: cycle && cycle.outcome,
      state: cycle && cycle.state, reason_code: cycle && cycle.reasonCode,
      reason: cycle && cycle.reason, candidates_returned: rows.length,
      verdict, governor_rejections: rows.map(item => ({ underlying: item.underlying,
        strike: item.shortStrike, reason_codes: item.governorReasonCodes,
        reasons: item.governorReasons, sizing: item.governorSizing,
        assignment_funding: item.assignmentFunding,
        wheel_compatibility: item.wheelCompatibility })),
      authority: cycle && cycle.authority, evidence: cycle && cycle.evidence,
    }, null, 2));
  }

  async function waitForCompletedCycle(cycleId) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      const status = await api('/api/status');
      if (status.latestCycle && status.latestCycle.cycleId === cycleId
        && status.latestCycle.state !== 'TRIGGERED') return status.latestCycle;
    }
    return null;
  }

  async function runCashSecuredPut(button) {
    setCalculatorMode('cash-secured-put'); resetCspView();
    const requestId = crypto.randomUUID(); calculatorState.cspRequestId = requestId;
    if (button) button.disabled = true;
    text(q('[data-vsim="csp-outcome"]'), 'Calculating cash-secured puts…');
    text(q('[data-vsim="csp-badge"]'), 'RUNNING');
    text(q('[data-vsim="csp-reason"]'), 'Verifying account cash, market session, live chains, tail risk, liquidity, and portfolio limits.');
    try {
      const trigger = await api('/api/cash-secured-put/calculate', { method: 'POST', headers: {
        'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(),
      }, body: '{}' });
      if (calculatorState.mode !== 'cash-secured-put' || calculatorState.cspRequestId !== requestId) return;
      if (!trigger.ok) {
        renderCashSecuredPuts({ outcome: 'REFUSED', state: 'REFUSED', reasonCode: trigger.error && trigger.error.code,
          reason: trigger.error && trigger.error.message }); return;
      }
      const completed = await waitForCompletedCycle(trigger.cycle_id);
      if (calculatorState.mode !== 'cash-secured-put' || calculatorState.cspRequestId !== requestId) return;
      if (completed) { currentStatus.latestCycle = completed; renderCashSecuredPuts(completed); }
      else {
        text(q('[data-vsim="csp-outcome"]'), 'CSP CALCULATION STILL RUNNING');
        text(q('[data-vsim="csp-badge"]'), 'IN PROGRESS');
        text(q('[data-vsim="csp-reason"]'), 'The protected workflow has not finished yet. Its result will appear automatically on the next dashboard refresh.');
      }
    } catch (error) {
      if (calculatorState.mode === 'cash-secured-put' && calculatorState.cspRequestId === requestId) {
        renderCashSecuredPuts({ outcome: 'REFUSED', state: 'REFUSED', reasonCode: 'CALCULATION_REQUEST_FAILED', reason: error.message });
      }
    } finally { if (button) button.disabled = false; }
  }

  function renderBrokerActivity(performance, ledger) {
    performanceState.ledger = ledger || {};
    fillTable(q('[data-vsim="broker-activity-body"]'), performanceState.ledger.events || [], [
      item => when(item.occurred_at || item.first_seen_at), item => item.event_type || '—', item => item.symbol || '—',
      item => item.side || '—', item => number(item.quantity), item => money(item.price), item => money(item.amount), item => item.state || '—',
    ], 'No broker activity has been ingested.');
  }

  function filterDate(value) {
    return value ? marketDateKey(value) : null;
  }

  function monthLabel(value) {
    const date = new Date(value + '-01T12:00:00Z');
    return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }

  function dayLabel(value) {
    const date = new Date(value + 'T12:00:00Z');
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  }

  function shiftedMonth(value, offset) {
    const [year, month] = value.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1 + offset, 1)).toISOString().slice(0, 7);
  }

  function syncPerformanceUrl(mode = 'push') {
    const url = new URL(window.location.href);
    const fields = [
      ['pnlMonth', performanceState.month], ['pnlScope', performanceState.scope],
      ['pnlTicker', performanceState.ticker], ['pnlStrategy', performanceState.strategy],
      ['pnlFrom', performanceState.from], ['pnlTo', performanceState.to],
    ];
    fields.forEach(([key, value]) => { if (value) url.searchParams.set(key, value); else url.searchParams.delete(key); });
    window.history[mode === 'replace' ? 'replaceState' : 'pushState']({}, '', url.pathname + '?' + url.searchParams.toString() + url.hash);
  }

  function applyPerformanceUrl() {
    const params = new URLSearchParams(window.location.search);
    const month = params.get('pnlMonth'); const scope = params.get('pnlScope');
    performanceState.month = /^\d{4}-\d{2}$/u.test(String(month || ''))
      ? month : marketDateKey(new Date()).slice(0, 7);
    performanceState.scope = scope === 'IN_MANDATE' ? 'IN_MANDATE' : 'ALL';
    performanceState.ticker = params.get('pnlTicker'); performanceState.strategy = params.get('pnlStrategy');
    performanceState.from = params.get('pnlFrom'); performanceState.to = params.get('pnlTo');
  }

  function commitPerformanceState(changes, { push = true, scroll = false, reloadCalendar = false } = {}) {
    Object.assign(performanceState, changes);
    if (push) syncPerformanceUrl('push');
    renderPerformanceLedger();
    if (reloadCalendar) loadPerformanceCalendar(); else renderPerformanceCalendar(performanceState.calendar);
    if (scroll) q('.performance-ledger')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderPerformanceCalendar(calendar) {
    const root = q('[data-vsim="pnl-calendar-grid"]'); clear(root);
    if (!root) return;
    text(q('[data-vsim="pnl-calendar-month"]'), monthLabel(performanceState.month));
    const reconciliationBadge = q('[data-vsim="pnl-calendar-reconciliation"]');
    if (reconciliationBadge) {
      text(reconciliationBadge, 'CHECKING');
      reconciliationBadge.classList.remove('reconciled', 'drift');
    }
    qa('[data-pnl-calendar-scope]').forEach(button => button.classList.toggle('active', button.dataset.pnlCalendarScope === performanceState.scope));
    const next = q('[data-pnl-calendar-shift="1"]');
    if (next) next.disabled = performanceState.month >= marketDateKey(new Date()).slice(0, 7);
    if (!calendar || calendar.month !== performanceState.month || calendar.scope !== performanceState.scope) {
      root.append(make('p', 'Loading the requested month…', 'muted')); return;
    }
    text(q('[data-vsim="pnl-calendar-subtitle"]'), 'Realized daily P&L · '
      + (calendar.scope === 'ALL' ? 'all closed lifecycles' : 'CC and CSP closed lifecycles only') + ' · Schwab ledger');
    const weekdayColumn = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4 };
    const first = calendar.days && calendar.days[0];
    for (let index = 0; first && index < (weekdayColumn[first.weekday] || 0); index += 1) root.append(make('div', undefined, 'pnl-calendar-day non-trading'));
    const maximum = Math.max(1, Number(calendar.summary && calendar.summary.largest_absolute_day || 0));
    (calendar.days || []).forEach(day => {
      const actionable = day.state === 'CLOSES' || day.state === 'ZERO';
      const cell = make(actionable ? 'button' : 'div', undefined, 'pnl-calendar-day ' + (actionable ? 'actionable ' : 'non-trading ')
        + (day.state === 'CLOSES' ? Number(day.pnl) < 0 ? 'negative' : 'positive' : day.state === 'ZERO' ? 'zero' : day.state.toLowerCase()));
      if (actionable) {
        cell.type = 'button'; cell.dataset.performanceDate = day.date;
        const intensity = Math.abs(Number(day.pnl || 0)) / maximum;
        if (day.state === 'CLOSES') {
          const rgb = Number(day.pnl) < 0 ? '242,118,118' : '96,226,168';
          cell.style.background = 'rgba(' + rgb + ',' + (0.05 + intensity * 0.24).toFixed(3) + ')';
          cell.style.borderColor = 'rgba(' + rgb + ',' + (0.25 + intensity * 0.55).toFixed(3) + ')';
        }
        cell.classList.toggle('active', performanceState.from === day.date && performanceState.to === day.date);
        cell.setAttribute('aria-label', day.date + ': ' + moneyExact(day.pnl) + ', ' + number(day.trades) + ' closed trade' + (day.trades === 1 ? '' : 's'));
      } else cell.setAttribute('aria-label', day.date + ': ' + (day.state === 'HOLIDAY' ? 'market closed' : 'future trading day'));
      cell.append(make('span', String(day.day), 'day-number'));
      if (actionable) {
        const amount = day.pnl > 0 ? '+' + moneyExact(day.pnl) : moneyExact(day.pnl);
        cell.append(make('strong', amount), make('small', number(day.trades) + ' trade' + (day.trades === 1 ? '' : 's')));
      }
      root.append(cell);
    });
    const summary = calendar.summary || {};
    const reconciliation = calendar.reconciliation || {};
    if (reconciliationBadge) {
      const matched = reconciliation.status === 'MATCH';
      text(reconciliationBadge, matched ? 'RECONCILED' : 'DRIFT');
      reconciliationBadge.classList.toggle('reconciled', matched);
      reconciliationBadge.classList.toggle('drift', !matched);
      reconciliationBadge.title = matched
        ? 'Daily cells, monthly ticker attribution, and monthly strategy attribution agree.'
        : 'Daily cells ' + moneyExact(reconciliation.cell_total) + ' · ticker attribution '
          + moneyExact(reconciliation.ticker_attribution_total) + ' · strategy attribution '
          + moneyExact(reconciliation.strategy_attribution_total);
    }
    setValue('pnl-calendar-profit', summary.profit, moneyExact); setValue('pnl-calendar-loss', summary.loss, moneyExact);
    setValue('pnl-calendar-net', summary.net, value => Number(value) > 0 ? '+' + moneyExact(value) : moneyExact(value));
    const net = q('[data-vsim="pnl-calendar-net"]'); if (net) net.classList.toggle('positive-value', Number(summary.net) > 0);
    const currentMonth = calendar.month === marketDateKey(new Date()).slice(0, 7);
    text(q('[data-vsim="pnl-calendar-net-label"]'), monthLabel(calendar.month).toUpperCase() + (currentMonth ? ' MTD' : ' TOTAL'));
    text(q('[data-vsim="pnl-calendar-note"]'), 'New York market date · NYSE full-day closures · early-close sessions count as trading days · '
      + number(summary.closed_trades || 0) + ' matched lifecycle' + (Number(summary.closed_trades) === 1 ? '' : 's')
      + (reconciliation.status === 'MATCH'
        ? ' · daily cells = monthly ticker attribution = monthly strategy attribution'
        : ' · DRIFT: cells ' + moneyExact(reconciliation.cell_total) + ' · ticker '
          + moneyExact(reconciliation.ticker_attribution_total) + ' · strategy '
          + moneyExact(reconciliation.strategy_attribution_total))
      + (calendar.history && calendar.history.status === 'PARTIAL' ? ' · HISTORY PARTIAL' : ''));
  }

  async function loadPerformanceCalendar() {
    const requestId = ++performanceState.calendarRequestId;
    renderPerformanceCalendar(null);
    try {
      const calendar = await api('/api/performance/calendar?month=' + encodeURIComponent(performanceState.month)
        + '&scope=' + encodeURIComponent(performanceState.scope));
      if (requestId !== performanceState.calendarRequestId) return;
      performanceState.calendar = calendar; renderPerformanceCalendar(calendar);
    } catch (error) {
      if (requestId !== performanceState.calendarRequestId) return;
      const root = q('[data-vsim="pnl-calendar-grid"]'); clear(root);
      if (root) root.append(make('p', 'Calendar unavailable: ' + error.message, 'muted'));
    }
  }

  function renderPerformanceLedger() {
    const performance = performanceState.report || {};
    const history = performance.history || {};
    const rows = (performance.trades || []).filter(item => {
      const ticker = item.underlying || item.symbol || '';
      const closed = item.closed_date || filterDate(item.closed_at);
      return (!performanceState.ticker || ticker === performanceState.ticker)
        && (!performanceState.strategy || item.strategy === performanceState.strategy)
        && (performanceState.scope !== 'IN_MANDATE' || ['SHORT_CALL','SHORT_PUT'].includes(item.strategy))
        && (!performanceState.from || closed >= performanceState.from)
        && (!performanceState.to || closed <= performanceState.to);
    });
    const filters = [];
    if (performanceState.ticker) filters.push('Ticker ' + performanceState.ticker);
    if (performanceState.strategy) filters.push('Strategy ' + performanceState.strategy);
    if (performanceState.scope === 'IN_MANDATE') filters.push('CC + CSP only');
    if (performanceState.from || performanceState.to) filters.push((performanceState.from || 'start') + ' → ' + (performanceState.to || 'latest'));
    const exactDay = performanceState.from && performanceState.from === performanceState.to;
    const filterWindow = exactDay ? dayLabel(performanceState.from) : filters.join(' · ');
    text(q('[data-vsim="ledger-filter-summary"]'), filters.length
      ? 'Filtered · ' + filterWindow + ' · ' + number(rows.length) + ' trade' + (rows.length === 1 ? '' : 's')
      : 'All matched trades');
    const drillDownNote = filters.length ? ' · drill-down below: ' + filters.join(' · ') : '';
    const summary = performance.summary || {};
    text(q('[data-vsim="performance-realized-note"]'), 'Lifetime · matched closed trades' + drillDownNote);
    text(q('[data-vsim="profit-factor-note"]'), 'Lifetime · gross wins ÷ gross losses' + drillDownNote);
    text(q('[data-vsim="closed-trades-note"]'), 'Lifetime ledger denominator' + drillDownNote);
    text(q('[data-vsim="win-count"]'), 'Lifetime · ' + number(summary.wins || 0) + ' wins · '
      + number(summary.losses || 0) + ' losses' + drillDownNote);
    text(q('[data-vsim="filtered-trade-count"]'), number(rows.length) + ' of ' + number((performance.trades || []).length) + ' trades');
    const from = q('[data-performance-from]'); const to = q('[data-performance-to]');
    if (from) from.value = performanceState.from || '';
    if (to) to.value = performanceState.to || '';
    fillTable(q('[data-vsim="closed-trades-body"]'), rows, [
      item => when(item.closed_at), item => item.underlying || item.symbol || '—', item => item.strategy || '—',
      item => item.asset_class || '—', item => item.direction || '—', item => number(item.quantity),
      item => when(item.opened_at), item => money(item.opening_price), item => money(item.closing_price),
      item => money(item.fees), item => money(item.realized_pnl),
    ], history.status === 'PARTIAL' ? 'No matched lifecycle satisfies these filters; imported history is partial.' : 'No matched lifecycle satisfies these filters.');
    qa('.attribution-row').forEach(row => {
      const active = (row.dataset.performanceFilter === 'ticker' && row.dataset.filterValue === performanceState.ticker)
        || (row.dataset.performanceFilter === 'strategy' && row.dataset.filterValue === performanceState.strategy);
      row.classList.toggle('active', active);
    });
  }

  function setPerformanceFilter(kind, value) {
    if (kind === 'ticker') commitPerformanceState({ ticker: performanceState.ticker === value ? null : value }, { scroll: true });
    if (kind === 'strategy') commitPerformanceState({ strategy: performanceState.strategy === value ? null : value }, { scroll: true });
  }

  function attribution(root, rows, key) {
    clear(root); const maximum = Math.max(1, ...(rows || []).map(row => Math.abs(Number(row.realized_pnl || 0))));
    if (!rows.length) { root.append(make('p', 'No matched realized trades.', 'muted')); return; }
    rows.forEach(item => { const row = make('button', undefined, 'attribution-row'); row.type = 'button';
      row.dataset.performanceFilter = key; row.dataset.filterValue = item[key] || '';
      row.setAttribute('aria-label', 'Filter closed trades to ' + (item[key] || 'unknown'));
      row.append(make('strong', item[key] || '—'));
      const track = make('div', undefined, 'attribution-track'); const fill = make('i');
      fill.style.width = Math.abs(Number(item.realized_pnl || 0)) / maximum * 100 + '%'; if (Number(item.realized_pnl) < 0) fill.style.background = 'var(--red)';
      track.append(fill); row.append(track, make('span', money(item.realized_pnl)), make('b', number(item.closed_trades || 0) + ' trades')); root.append(row); });
  }

  function drawPerformanceChart(svg, points) {
    clear(svg); if (!points || !points.length) { const label = document.createElementNS('http://www.w3.org/2000/svg','text'); label.setAttribute('x','500'); label.setAttribute('y','112'); label.setAttribute('text-anchor','middle'); label.setAttribute('fill','#82978e'); label.textContent='No matched realized trades'; svg.append(label); return; }
    const sorted = points.slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const values = sorted.map(point => Number(point.value)); const min = Math.min(0, ...values); const max = Math.max(0, ...values); const span = Math.max(1, max - min);
    const coordinates = sorted.map((point,index) => [30 + index * (940 / Math.max(1, sorted.length - 1)), 195 - ((Number(point.value)-min)/span)*165]);
    const zeroY = 195 - ((0-min)/span)*165; const zero = document.createElementNS('http://www.w3.org/2000/svg','line');
    zero.setAttribute('x1','25'); zero.setAttribute('x2','975'); zero.setAttribute('y1',String(zeroY)); zero.setAttribute('y2',String(zeroY)); zero.setAttribute('stroke','#28443a'); svg.append(zero);
    const path = document.createElementNS('http://www.w3.org/2000/svg','polyline'); path.setAttribute('points', coordinates.map(pair => pair.join(',')).join(' '));
    path.setAttribute('fill','none'); path.setAttribute('stroke','#60e2a8'); path.setAttribute('stroke-width','3'); svg.append(path);
    let startX = null; let selection = null;
    const chartX = event => { const box = svg.getBoundingClientRect(); return Math.max(30, Math.min(970, 30 + ((event.clientX - box.left) / Math.max(1, box.width)) * 940)); };
    svg.onpointerdown = event => { startX = chartX(event); svg.setPointerCapture(event.pointerId); selection = document.createElementNS('http://www.w3.org/2000/svg','rect'); selection.setAttribute('y','20'); selection.setAttribute('height','180'); selection.setAttribute('class','range-selection'); selection.setAttribute('x',String(startX)); selection.setAttribute('width','0'); svg.append(selection); };
    svg.onpointermove = event => { if (startX === null || !selection) return; const x = chartX(event); selection.setAttribute('x',String(Math.min(startX,x))); selection.setAttribute('width',String(Math.abs(x-startX))); };
    svg.onpointerup = event => { if (startX === null) return; const endX = chartX(event); const left = Math.min(startX,endX); const right = Math.max(startX,endX); startX = null;
      if (Math.abs(right-left) < 6) { selection?.remove(); selection = null; return; }
      const indexAt = x => Math.max(0, Math.min(sorted.length - 1, Math.round(((x - 30) / 940) * (sorted.length - 1))));
      const first = sorted[indexAt(left)]; const last = sorted[indexAt(right)];
      selection = null;
      commitPerformanceState({ from: first.closed_date || filterDate(first.at),
        to: last.closed_date || filterDate(last.at) }, { scroll: true }); };
  }

  function renderPerformance(performance, portfolio) {
    performanceState.report = performance;
    const summary = performance.summary || {}; const mandate = performance.mandate_view || {};
    const compatible = mandate.mandate_compatible || {}; const review = mandate.structure_review || {};
    setValue('performance-realized', summary.realized_pnl, money); setValue('performance-unrealized', summary.unrealized_pnl, money);
    setValue('performance-total', summary.total_pnl, money); setValue('win-rate', summary.win_rate, percent);
    const unrealizedStale = portfolio && portfolio.option_analytics_freshness === 'LAST_MARKET_QUOTE';
    const unrealizedValue = q('[data-vsim="performance-unrealized"]');
    const totalValue = q('[data-vsim="performance-total"]');
    if (unrealizedValue) unrealizedValue.classList.toggle('stale-value', Boolean(unrealizedStale));
    if (totalValue) totalValue.classList.toggle('stale-value', Boolean(unrealizedStale));
    text(q('[data-vsim="performance-unrealized-note"]'), unrealizedStale
      ? 'latest custody marks · STALE option marks included' : 'latest custody marks');
    text(q('[data-vsim="performance-total-note"]'), unrealizedStale
      ? 'lifetime realized + current unrealized · STALE option marks included' : 'lifetime realized + current unrealized');
    setValue('profit-factor', summary.profit_factor, value => Number(value).toFixed(2)); setValue('closed-trades', summary.closed_trades, number);
    text(q('[data-vsim="win-count"]'), 'Lifetime · ' + number(summary.wins || 0) + ' wins · ' + number(summary.losses || 0) + ' losses');
    setValue('mandate-pnl', compatible.realized_pnl, money); setValue('mandate-profit-factor', compatible.profit_factor, value => Number(value).toFixed(2));
    setValue('review-pnl', review.realized_pnl, money); setValue('review-profit-factor', review.profit_factor, value => Number(value).toFixed(2));
    text(q('[data-vsim="mandate-trades"]'), number(compatible.closed_trades || 0) + ' matched trades');
    text(q('[data-vsim="review-trades"]'), number(review.closed_trades || 0) + ' matched trades');
    text(q('[data-vsim="mandate-note"]'), mandate.note || 'Historical option legs require ledger review before structure classification.');
    text(q('[data-vsim="performance-asof"]'), 'As of ' + when(performance.asof));
    text(q('[data-vsim="performance-warning"]'), performance.history && performance.history.note || 'Performance history unavailable.');
    drawPerformanceChart(q('[data-vsim="performance-chart"]'), performance.curve || []);
    attribution(q('[data-vsim="ticker-attribution"]'), performance.by_ticker || [], 'ticker');
    attribution(q('[data-vsim="strategy-attribution"]'), performance.by_strategy || [], 'strategy');
    renderPerformanceLedger(); renderPerformanceCalendar(performanceState.calendar);
  }

  function renderOverview(status, portfolio) {
    const custody = status.custody || {};
    const account = custody.account || {};
    const positions = custody.positions || [];
    const cycle = status.latestCycle || {};
    const market = status.marketCheck;
    const completeMarks = positions.every(position => present(position.marketValue));
    const marked = completeMarks ? positions.reduce((sum, position) => sum + Number(position.marketValue), 0) : null;
    const cards = qa('#overview .metric-card');
    if (cards[0]) { text(q('.metric-label', cards[0]), 'Net asset value'); text(q('.metric-value', cards[0]), money(account.nav)); text(q('.metric-foot', cards[0]), 'Schwab read-only · ' + when(custody.observedAt)); }
    if (cards[1]) {
      text(q('.metric-label', cards[1]), 'Signed cash balance');
      text(q('.metric-value', cards[1]), money(account.cash));
      const bar = q('.bar', cards[1]); if (bar) bar.remove();
      text(q('.metric-foot', cards[1]), present(account.cash) && Number(account.cash) < 0 ? 'Margin borrowing · negative cash' : 'Uninvested cash · excludes buying power');
    }
    if (cards[2]) {
      text(q('.metric-label', cards[2]), 'Net marked positions');
      text(q('.metric-value', cards[2]), completeMarks ? money(marked) : 'UNAVAILABLE');
      text(q('.metric-foot', cards[2]), completeMarks && present(account.cash) && present(account.nav)
        ? (money(marked) + ' + ' + money(account.cash) + ' cash = ' + money(account.nav) + ' NAV')
        : 'Incomplete position marks · no partial total shown');
    }
    if (cards[3]) {
      const dayPnlVerified = present(account.dayProfitLoss)
        && account.dayProfitLossSource === 'SCHWAB_SUM_RECONCILED_POSITION_DAY_PROFIT_LOSS';
      const dayPnl = dayPnlVerified ? Number(account.dayProfitLoss) : null;
      const dayPnlStale = portfolio && portfolio.option_analytics_freshness === 'LAST_MARKET_QUOTE';
      cards[3].classList.add('today-pnl-card');
      cards[3].dataset.pnlState = !dayPnlVerified ? 'unavailable' : dayPnl < 0 ? 'loss' : 'gain';
      text(q('.metric-label', cards[3]), "Today's P&L");
      const pnlValue = q('.metric-value', cards[3]);
      text(pnlValue, dayPnlVerified ? moneyExact(dayPnl) : 'UNAVAILABLE');
      if (pnlValue) {
        pnlValue.classList.toggle('negative', dayPnlVerified && dayPnl < 0);
        pnlValue.classList.toggle('positive-value', dayPnlVerified && dayPnl >= 0);
        pnlValue.classList.toggle('stale-value', Boolean(dayPnlStale));
      }
      text(q('.metric-foot', cards[3]), dayPnlVerified
        ? 'Schwab position day P&L · ' + number(account.dayProfitLossPositionCount) + ' open positions'
          + (Number(account.dayProfitLossAdjustmentCount || 0) > 0
            ? ' · ' + number(account.dayProfitLossAdjustmentCount) + ' carried day-cost reconciliation' : '')
          + (dayPnlStale ? ' · STALE option marks included' : '')
        : 'Schwab day P&L is incomplete · no estimated balance change shown');
    }
    text(q('#overview .snapshot strong'), when(custody.observedAt));

    const opportunities = cycle.opportunities || [];
    const topBody = q('#underwrite [data-underwrite-pane="scan"] .top-opportunities-panel tbody');
    renderRows(topBody, opportunities.slice(0, 10), [
      (_item, index) => String(index + 1).padStart(2, '0'),
      item => item.underlying || '—', item => structure(item.structure),
      item => [item.shortStrike, item.longStrike].filter(present).join(' / ') || '—',
      item => number(item.dte), item => money(item.nev), item => percent(item.raroc),
      item => money(item.economicCapital), item => item.admissible ? 'ELIGIBLE' : (item.rejection || 'DECLINED'),
    ]);
    text(q('#underwrite [data-underwrite-pane="scan"] .top-opportunities-panel .panel-note'), 'Live ranked shadow candidates. Values are generated from current Schwab option chains; no order can be submitted.');

    const positionPanel = q('#overview .positions-empty');
    if (positionPanel) {
      clear(positionPanel);
      const head = make('div', undefined, 'panel-head'); const title = make('div'); title.append(make('p', 'Layer 8 · Live custody', 'kicker'), make('h3', 'Open positions')); head.append(title, make('span', positions.length + ' open', 'count')); positionPanel.append(head);
      if (!positions.length) positionPanel.append(make('div', 'No synchronized positions.', 'empty-state'));
      else { const wrap = make('div', undefined, 'table-wrap'); const table = make('table'); const thead = make('thead'); const hr = make('tr'); const labels = ['Symbol','Type','Quantity','Market value']; labels.forEach(label => hr.append(make('th', label))); thead.append(hr); const body = make('tbody'); positions.forEach(position => { const row = make('tr'); [position.symbol || '—', position.type || '—', number(position.quantity), money(position.marketValue)].forEach((value, index) => { const cell = make('td', value); cell.dataset.label = labels[index]; row.append(cell); }); body.append(row); }); table.append(thead, body); wrap.append(table); positionPanel.append(wrap); }
    }

    const systemCards = qa('.system-brief');
    if (systemCards.length) {
      const model = status.systemHealth || { rows: [
        'D1','SCHWAB','MARKET','TV','DISCORD','BOT',
      ].map(label => ({ label, color: 'RED', status: label === 'BOT' ? 'OFF' : 'DOWN',
        asOf: null, detail: 'NOT PROBED' })), status: 'ACTION REQUIRED', color: 'RED',
      checkedAt: null, versions: { dashboard: 'unknown', market: 'unknown' },
      tape: { spy: null, vix: null, source: 'UNPROVEN', asOf: null } };
      const intendedBotOff = model.rows.some(entry => entry.label === 'BOT' && entry.status === 'OFF');
      const actionable = model.rows.some(entry => entry.color === 'RED'
        && !(entry.label === 'BOT' && entry.status === 'OFF'));
      const overallText = actionable ? 'ACTION REQUIRED'
        : model.status === 'UNPROVEN' ? 'SYSTEMS UNPROVEN'
          : intendedBotOff ? 'SYSTEMS LIVE · BOT OFF' : model.status;
      const tape = model.tape || {};
      const versions = model.versions || {};
      systemCards.forEach(systemCard => {
        clear(systemCard);
        const head = make('div', undefined, 'panel-head system-health-head');
        const title = make('div');
        title.append(make('p', 'Operational integrity', 'kicker'), make('h3', 'System'));
        const overall = make('strong', overallText,
          'system-overall system-' + (actionable ? 'red'
            : model.color === 'AMBER' ? 'amber' : 'green'));
        head.append(title, overall);
        const grid = make('div', undefined, 'system-health-grid');
        model.rows.forEach(entry => {
          const displayColor = entry.label === 'BOT' && entry.status === 'OFF'
            ? 'neutral' : String(entry.color).toLowerCase();
          const tile = make('div', undefined, 'system-health-tile system-' + displayColor);
          const name = make('span', entry.label);
          const state = make('strong');
          state.append(make('i', undefined, 'health-light'), document.createTextNode(entry.status));
          tile.append(name, state);
          grid.append(tile);
        });
        const details = make('details', undefined, 'system-health-details');
        details.append(make('summary', 'Diagnostics'));
        model.rows.forEach(entry => {
          const line = make('p');
          line.append(make('strong', entry.label + ' · ' + entry.status),
            make('span', (entry.detail || 'No detail') + ' · ' + (entry.asOf ? when(entry.asOf) : 'not yet checked')));
          details.append(line);
        });
        details.append(make('p', 'SPY ' + (present(tape.spy) ? Number(tape.spy).toFixed(2) : '—')
          + ' · VIX ' + (present(tape.vix) ? Number(tape.vix).toFixed(2) : '—')
          + ' · SOURCE ' + (tape.source || 'UNPROVEN')));
        const footer = make('p', 'Dashboard v' + String(versions.dashboard || 'unknown').slice(0, 12)
          + ' · Market v' + String(versions.market || 'unknown').slice(0, 12)
          + ' · Checked ' + (model.checkedAt ? when(model.checkedAt) : 'not yet'), 'system-health-meta');
        systemCard.append(head, grid, details, footer);
      });
    }
  }

  function renderOpportunities(status) {
    const cycle = status.latestCycle || {};
    const rows = cycle.opportunities || [];
    const chips = qa('#underwrite [data-underwrite-pane="scan"] .chip');
    if (chips[0]) text(chips[0], 'Current candidates ' + rows.length);
    if (chips[1]) text(chips[1], 'Eligible ' + rows.filter(row => row.admissible).length);
    if (chips[2]) text(chips[2], 'Declined ' + rows.filter(row => !row.admissible).length);
    if (chips[3]) text(chips[3], cycle.outcome || 'NO CYCLE');
    text(q('#underwrite [data-underwrite-pane="scan"] .as-of'), cycle.at ? ('As of ' + when(cycle.at)) : 'No completed cycle');
    renderRows(q('#underwrite [data-underwrite-pane="scan"] .detailed tbody'), rows, [
      (_item, index) => String(index + 1).padStart(2, '0'), item => item.underlying || '—',
      item => structure(item.structure), () => '—', () => '—', () => '—',
      item => money(item.cvar), () => '—', item => money(item.nev), item => percent(item.raroc),
      item => item.admissible ? 'ELIGIBLE' : (item.rejection || 'DECLINED'),
    ]);
    const detail = q('#underwrite [data-underwrite-pane="scan"] .candidate-detail');
    if (detail) {
      clear(detail);
      const panel = make('article', undefined, 'panel');
      panel.append(make('p', 'Current shadow result', 'kicker'), make('h3', cycle.outcome || 'No live cycle yet'), make('p', cycle.reason || 'Run a verified shadow scan. Missing values are intentionally shown as unavailable instead of synthetic estimates.'));
      const actions = make('div', undefined, 'operator-actions');
      const run = make('button', 'Run live shadow scan', 'chip active'); run.dataset.action = 'cycle'; actions.append(run); panel.append(actions); detail.append(panel);
    }
  }

  async function renderEvidence(status) {
    const payload = await api('/api/evidence');
    const records = payload.records || [];
    text(q('#decisions .chain-valid strong'), records.length ? 'VALID' : 'EMPTY');
    const layout = q('#decisions .evidence-layout'); clear(layout);
    const list = make('article', undefined, 'panel evidence-list');
    const head = make('div', undefined, 'panel-head'); const title = make('div'); title.append(make('p', 'Append-only D1 index · immutable R2 packages', 'kicker'), make('h3', records.length + ' sealed evidence record' + (records.length === 1 ? '' : 's'))); head.append(title, make('span', 'SHA-256 chained', 'hash')); list.append(head);
    const tableWrap = make('div', undefined, 'table-wrap'); const table = make('table'); const thead = make('thead'); const hr = make('tr'); ['Sequence','Cycle','Decision','Authority','Fingerprint','Created'].forEach(label => hr.append(make('th', label))); thead.append(hr); const body = make('tbody');
    records.forEach(record => { const row = make('tr'); [record.sequence, record.cycle_id, record.decision, record.authority_level, (record.decision_fingerprint || '').slice(0, 16) + '…', when(record.created_at)].forEach(value => row.append(make('td', String(value ?? '—')))); body.append(row); });
    if (!records.length) { const row = make('tr'); const cell = make('td', 'No evidence records have been sealed.'); cell.colSpan = 6; row.append(cell); body.append(row); }
    table.append(thead, body); tableWrap.append(table); list.append(tableWrap); layout.append(list);
    const side = make('aside', undefined, 'evidence-side'); const facts = make('article', undefined, 'panel'); facts.append(make('p', 'Protected evidence storage', 'kicker'), make('h3', status.evidence.storage)); const dl = make('dl', undefined, 'package-facts'); [['Index','Cloudflare D1'],['Raw packages','Protected R2'],['Records',String(records.length)],['Mutation request','None'],['Authority','2 · Propose only']].forEach(pair => { const div = make('div'); div.append(make('dt', pair[0]), make('dd', pair[1])); dl.append(div); }); facts.append(dl); side.append(facts); layout.append(side);
    text(q('#decisions .preview-disclaimer'), 'Live protected evidence metadata. Raw evidence packages remain private and are not exposed to the browser.');
  }

  function renderSystem(status, performance) {
    text(q('#system .readiness-banner strong'), 'Operational live shadow system');
    text(q('#system .readiness-banner p'), 'Schwab custody and market data are read-only and fail-closed, and D1/R2 evidence is active. Live-order mutation remains constitutionally and technically unavailable.');
    text(q('#system .readiness-number'), 'SHADOW');
    const connectors = qa('#system .connector');
    const market = status.marketCheck;
    const states = [
      { status: market ? (market.ok ? 'Verified live' : 'Blocked safely') : 'Not checked', note: market ? ('Last check ' + when(market.checkedAt)) : 'Run the live chain verification.', values: ['Private service binding','Options chains + Greeks','Strict freshness gate','Session + event data'] },
      { status: status.schwab && status.schwab.status || 'Unknown', note: 'Custody reads only. No order mutation route exists.', values: ['Account + cash live','Positions + orders live','Baseline reconciliation','Order mutation locked'] },
      { status: status.evidence.records + ' records', note: 'Ordered D1 index with protected immutable R2 packages.', values: ['Decision metadata in D1','Raw packages in R2','Append-only hash chain','Raw packages not browser-exposed'] },
      { status: status.schedule || 'Every 15 minutes', note: 'Single-flight cycles use distributed D1 leases and deterministic IDs.', values: ['Market-session gate','Distributed idempotency','Single-flight lease','Fail-closed refusal evidence'] },
    ];
    const connectorNames = ['Schwab Market Data', 'Schwab Custody', 'Evidence', 'Shadow Scheduler'];
    connectors.forEach((card, index) => { const state = states[index]; if (!state) return; const heading = q('h3', card); if (heading) text(heading, connectorNames[index]); text(q('.connector-status', card), state.status); text(q('.connector-note', card), state.note); qa('li b', card).forEach((node, valueIndex) => text(node, state.values[valueIndex] || 'Active')); });
    const ladderPanel = q('#system .authority-ladder');
    text(q('h3', ladderPanel), 'Authority changes require the Principal');
    const ladder = qa('#system .ladder > div');
    if (ladder[1]) text(q('small', ladder[1]), 'Current live shadow');
    if (ladder[2]) text(q('small', ladder[2]), 'Explicit Constitution amendment');
    let controls = q('#system .operator-controls');
    if (!controls) {
      controls = make('article', undefined, 'panel operator-controls');
      controls.append(make('p', 'Protected operator controls', 'kicker'), make('h3', 'Live shadow operations'));
      controls.append(make('p', '', 'control-status connector-note'));
      const actions = make('div', undefined, 'filter-row');
      [['refresh','Refresh status'],['ledger','Backfill Schwab ledger'],['guardian','Run Guardian review'],['cycle','Run shadow cycle'],['replay','Replay latest evidence'],
        ['pause','Global pause'],['resume','Resume cycles'],['kill','Trip kill switch'],['clearKill','Clear kill switch']]
        .forEach(pair => { const button = make('button', pair[1], 'chip'); button.dataset.action = pair[0]; actions.append(button); });
      const reason = make('input', undefined, 'control-reason');
      reason.type = 'text'; reason.maxLength = 240; reason.placeholder = 'Required reason for pause / resume / kill / clear';
      controls.append(actions, reason, make('p', 'Normal mission-control actions are limited to running a shadow cycle or replaying sealed evidence. Global pause and the independent kill switch are separate safety controls. None can submit, replace, or cancel an order.', 'connector-note'), make('pre', 'Ready.', 'operator-output'));
      ladderPanel.parentNode.insertBefore(controls, ladderPanel);
    }
    let historyPanel = q('.system-history', q('#system'));
    if (!historyPanel) {
      historyPanel = make('article', undefined, 'panel system-history');
      historyPanel.id = 'system-history';
      const parent = controls && controls.parentNode || q('#system');
      parent.insertBefore(historyPanel, controls || null);
    }
    clear(historyPanel);
    const history = performance && performance.history || {};
    historyPanel.append(make('p', 'Broker history integrity', 'kicker'), make('h3', history.status || 'History unavailable'));
    const historyFacts = make('dl', undefined, 'package-facts');
    [['Imported transactions', number(history.imported_transactions)], ['Evaluated packets', number(history.evaluated_packets)],
      ['Coverage', history.broker_sync_complete ? 'COMPLETE TO CONFIGURED FLOOR' : 'PARTIAL'],
      ['Earliest event', when(history.earliest_event_at)], ['Latest event', when(history.latest_event_at)],
      ['Unmatched closures', number(history.unmatched_closures)]].forEach(pair => { const row = make('div'); row.append(make('dt', pair[0]), make('dd', pair[1])); historyFacts.append(row); });
    historyPanel.append(historyFacts, make('p', history.note || 'History status unavailable.', 'connector-note'));

    const safety = status.controls || {};
    text(q('.control-status', controls), 'GLOBAL PAUSE: ' + (safety.globalPause ? 'ACTIVE' : 'CLEAR')
      + ' · INDEPENDENT KILL: ' + (safety.independentKill ? 'TRIPPED' : 'CLEAR')
      + (safety.updatedAt ? ' · ' + when(safety.updatedAt) : ''));
  }

  function renderGuardian(guardianPayload) {
    const root = q('#system');
    if (!root) return;
    let panel = q('.guardian-panel', root);
    if (!panel) { panel = make('article', undefined, 'panel guardian-panel'); root.append(panel); }
    clear(panel);
    const review = guardianPayload.review;
    panel.append(make('p', 'Independent risk and behavioral enforcement', 'kicker'),
      make('h3', 'NUVO Guardian · ' + (review?.state || 'BLOCKED-INCOMPLETE')),
      make('p', review?.report?.finalDirective || 'A complete Guardian review has not been recorded.', 'connector-note'));
    const facts = make('dl', undefined, 'package-facts');
    [['Mandate', guardianPayload.mandateVersion], ['Last review', review?.createdAt ? when(review.createdAt) : 'Not available'],
      ['Margin debit', money(review?.report?.marginDebit)], ['Campaign contracts', String(guardianPayload.activeCampaigns || 0)],
      ['Discord delivery', guardianPayload.discord?.configured ? 'CONFIGURED' : 'NOT CONFIGURED']].forEach(pair => {
      const row = make('div'); row.append(make('dt', pair[0]), make('dd', pair[1])); facts.append(row);
    });
    panel.append(facts);
    const violations = review?.report?.violations || [];
    panel.append(make('p', violations.length ? 'Violations: ' + violations.map(row => row.code).join(' · ') : 'COMPLIANT — NO ACTION REQUIRED', 'connector-note'));
    const decisions = q('#decisions', root);
    if (decisions) root.append(decisions);
  }

  function renderLane1SummaryCard(ledger, status) {
    const summary = ledger && ledger.summary;
    if (!summary) return;
    const textAll = (selector, value) => qa(selector).forEach(node => text(node, value));
    const arms = qa('[data-vsim="lane-summary-arm"]');
    const armStage = summary.arm?.stage || (summary.arm?.value === 'OFF' ? 'DISARMED' : null);
    const intendedArmOff = summary.arm?.value === 'OFF' && summary.blocking === 'ARM_OFF · INTENDED';
    textAll('[data-vsim="lane-summary-arm"]', armStage ? armStage + (intendedArmOff ? ' · intended' : '') : '—');
    arms.forEach(arm => { arm.dataset.state = String(summary.arm?.value || '').toLowerCase(); });
    if (summary.arm?.value === 'ON' || summary.arm?.value === 'OFF') {
      setLaneState(summary.arm.value === 'ON');
    }
    const renderedArmContract = armLaneContract({ state: summary.arm?.stage,
      positionSide: summary.arm?.positionSide,
      faultCode: summary.blocking === 'LANE_1_EXIT_PENDING_STATE_REQUIRED'
        ? summary.blocking : null });
    text(q('[data-vsim="bot-arm-contract"]'), renderedArmContract.text);
    const position = summary.position || {};
    const compactPosition = position.value === 'POSITION_DRIFT'
      ? 'POSITION_DRIFT · coordinator ' + (position.coordinatorPositionSide || 'UNKNOWN')
        + ' · Schwab ' + (position.brokerPositionSide || 'UNKNOWN') + ' 1 SPY'
      : position.value === 'NOT_MEASURED' ? '—' : (position.value || '—');
    textAll('[data-vsim="lane-summary-position"]', compactPosition);
    textAll('[data-vsim="lane-summary-fills"]', number(summary.fills?.provenInstructions || 0)
      + ' of ' + number(summary.fills?.targetInstructions || 4));
    const realized = summary.pnl?.realizedToday || {};
    const openPnl = summary.pnl?.open || {};
    const realizedText = Number.isSafeInteger(realized.valueCents)
      ? moneyExact(realized.valueCents / 100) : '—';
    const openText = Number.isSafeInteger(openPnl.valueCents)
      ? moneyExact(openPnl.valueCents / 100) : '—';
    textAll('[data-vsim="lane-summary-today"]', realizedText + ' realized · ' + openText + ' open');
    qa('[data-vsim="lane-summary-matrix-body"]').forEach(body => {
      clear(body);
      ['BUY','SELL','SELL_SHORT','BUY_TO_COVER'].forEach(instruction => {
        const evidence = summary.matrix?.[instruction] || {};
        const row = make('div', undefined, 'lane-summary-matrix-row');
        row.setAttribute('role', 'row');
        row.append(make('div', instruction));
        [['alert', evidence.alert], ['preview', evidence.preview], ['fill', evidence.fill]]
          .forEach(([kind, item = {}]) => {
            const status = item.status || 'NOT_MEASURED';
            const compact = kind === 'alert' ? status === 'CONFIRMED' ? '✓' : '—'
              : kind === 'preview' ? status.includes('CLEAR') ? 'clear'
                : status.includes('REFUSED_NO_POSITION') ? 'no pos'
                  : status.includes('REFUSED') ? 'refused' : '—'
                : status === 'FILLED' ? '1'
                  : status.includes('RECOVERED') ? 'recovered' : '—';
            const className = compact === '✓' || compact === 'clear' || compact === '1'
              ? 'clear' : compact === 'no pos' || compact === 'refused' ? 'refused' : 'unmeasured';
            const cell = make('div', undefined, className); cell.dataset.evidence = kind;
            cell.append(make('strong', compact));
            row.append(cell);
          });
        body.append(row);
      });
    });
    textAll('[data-vsim="lane-summary-blocking"]', intendedArmOff ? 'none' : (summary.blocking || 'none'));
    const last = summary.lastSignal || {};
    textAll('[data-vsim="lane-summary-last"]', last.timestamp
      ? when(last.timestamp) + ' · ' + (last.instruction || '—') + ' · '
        + (last.outcome === 'PREVIEW · CLEAR' ? 'previewed'
          : last.outcome === 'PREVIEW · REFUSED_NO_POSITION' ? 'preview no pos'
            : String(last.outcome || 'recorded').toLowerCase().replaceAll('_', ' ')) : '—');
    const instrument = summary.instrument || {};
    const brokerSymbol = q('[data-vsim="bot-broker-symbol"]');
    text(brokerSymbol, instrument.ticker
      ? (instrument.broker || 'Schwab') + ' · ' + instrument.ticker : 'Schwab · —');
    if (brokerSymbol) {
      brokerSymbol.dataset.ticker = instrument.ticker || '';
      brokerSymbol.dataset.quantity = Number.isSafeInteger(instrument.quantityShares)
        ? String(instrument.quantityShares) : '';
    }
    const positionValue = summary.position?.value;
    const positionMeasured = positionValue && positionValue !== 'NOT_MEASURED';
    text(q('[data-vsim="bot-position"]'), positionValue === 'POSITION_DRIFT' ? 'DRIFT'
      : positionMeasured ? positionValue.split(' ')[0] : '—');
    text(q('[data-vsim="bot-position-copy"]'), positionValue === 'POSITION_DRIFT'
      ? 'coordinator ' + (position.coordinatorPositionSide || 'UNKNOWN') + ' @ '
        + (position.coordinatorUpdatedAt ? when(position.coordinatorUpdatedAt) : 'time unknown')
        + ' · Schwab ' + (position.brokerPositionSide || 'UNKNOWN') + ' 1 SPY @ '
        + (position.brokerAcquiredAt ? when(position.brokerAcquiredAt) : 'time unknown')
      : positionMeasured ? positionValue === 'FLAT' ? 'no position'
        : position.verified === false ? positionValue + ' · unverified' : positionValue
        : 'position unavailable');
    const botRealized = summary.pnl?.realizedToday || {};
    const dayPnl = Number.isSafeInteger(botRealized.valueCents) ? botRealized.valueCents / 100 : null;
    const mark = Number(status?.systemHealth?.tape?.[String(instrument.ticker || '').toLowerCase()]);
    const open = summary.openPosition || null;
    const marketRow = (status?.systemHealth?.rows || []).find(row => row.label === 'MARKET');
    const botOpenPnl = open && Number.isFinite(mark) && marketRow?.color === 'GREEN'
      ? ((open.side === 'LONG' ? mark - open.openingPriceUsdPerShare
        : open.openingPriceUsdPerShare - mark) * open.quantityShares)
        - (open.openingFeeCents / 100) : null;
    const setPnl = (selector, value) => {
      const node = q(selector); text(node, Number.isFinite(value) ? moneyExact(value) : '—');
      if (node) node.className = Number.isFinite(value) ? value > 0 ? 'positive'
        : value < 0 ? 'negative' : 'neutral' : 'unmeasured';
    };
    setPnl('[data-vsim="bot-open-pnl"]', botOpenPnl);
    setPnl('[data-vsim="bot-day-pnl"]', dayPnl);
    const positionRead = summary.brokerReconciliation || {};
    const observedAt = Date.parse(positionRead.broker?.acquiredAt || '');
    const custodyAgeMs = Number.isFinite(observedAt) ? Math.max(0, Date.now() - observedAt) : null;
    const custodyLive = custodyAgeMs !== null && custodyAgeMs <= 20 * 60 * 1000
      && positionRead.brokerRead?.ok === true;
    const liveNode = q('[data-vsim="bot-live-state"]');
    text(liveNode, custodyLive ? 'LIVE' : 'STALE');
    if (liveNode) liveNode.dataset.state = custodyLive ? 'live' : 'stale';
    const ageMinutes = custodyAgeMs === null ? null : Math.floor(custodyAgeMs / 60_000);
    text(q('[data-vsim="bot-live-age"]'), ageMinutes === null ? 'Schwab position read unavailable'
      : 'Schwab position read ' + (ageMinutes < 1 ? '<1m' : ageMinutes + 'm')
        + ' old · live threshold 20m');
    const connectors = new Map((status?.systemHealth?.rows || [])
      .filter(row => ['D1','SCHWAB','MARKET','TV','DISCORD'].includes(row.label))
      .map(row => [row.label, row.color]));
    const online = ['D1','SCHWAB','MARKET','DISCORD']
      .every(label => connectors.get(label) === 'GREEN')
      && ['GREEN','AMBER'].includes(connectors.get('TV'));
    const onlineNode = q('[data-vsim="bot-online-state"]');
    text(onlineNode, online ? 'ONLINE' : 'OFFLINE');
    if (onlineNode) onlineNode.dataset.state = online ? 'online' : 'offline';
  }

  function renderLane1EventLedger(ledger, status = currentStatus) {
    if (!ledger) return;
    renderLane1SummaryCard(ledger, status);
    const counts = ledger.counts || {};
    ['signal','refused','preview','order','fill'].forEach(kind => {
      const value = counts[kind.toUpperCase()];
      text(q('[data-vsim="bot-count-' + kind + '"]'), value === null || value === undefined
        ? 'SOURCE_FAULT' : number(value));
    });
    text(q('[data-vsim="bot-order-reason"]'), ledger.zeroReasons?.ORDER === 'NEVER_ARMED'
      ? 'NEVER ARMED' : counts.ORDER === null ? 'SOURCE FAULT' : 'RECORDED');
    text(q('[data-vsim="bot-fill-reason"]'), ledger.zeroReasons?.FILL === 'NEVER_ARMED'
      ? 'NEVER ARMED' : counts.FILL === null ? 'SOURCE FAULT' : 'RECORDED');
    const sourceNode = q('[data-vsim="bot-ledger-source-status"]');
    text(sourceNode, ledger.availability === 'COMPLETE'
      ? 'LIVE STORE · operational audit + coordinator history'
      : 'SOURCE FAULT · ' + (ledger.sourceErrors || []).join(' · '));
    if (sourceNode) sourceNode.classList.toggle('source-fault', ledger.availability !== 'COMPLETE');
    text(q('[data-vsim="bot-pnl-status"]'), ledger.pnl?.status || 'NOT_MEASURED');
    text(q('[data-vsim="bot-pnl-reason"]'), ledger.pnl?.reason || 'Bot P&L is not measured.');
    text(q('[data-vsim="bot-phase2-status"]'), ledger.phase2?.status || 'BLOCKED_NO_FILL_PAYLOADS');
    text(q('[data-vsim="bot-phase2-reason"]'), ledger.phase2?.reason || 'Captured fills are required.');
    const events = Array.isArray(ledger.events) ? ledger.events : [];
    text(q('[data-vsim="bot-event-count"]'), events.length + (events.length === 1 ? ' event' : ' events'));
    const tbody = q('[data-vsim="bot-event-ledger-body"]');
    clear(tbody);
    if (!tbody) return;
    if (!events.length) {
      const row = make('tr'); const cell = make('td', ledger.availability === 'COMPLETE'
        ? 'No Lane 1 bot events.' : 'Lane 1 event source unavailable; empty state is not asserted.');
      cell.colSpan = 8; cell.className = 'muted'; row.append(cell); tbody.append(row); return;
    }
    events.forEach(event => {
      const row = make('tr');
      if (event.recordId) row.id = 'lane1-event-' + event.recordId;
      const raw = event.rawSide === null || event.rawSide === undefined ? 'NOT_RECORDED'
        : typeof event.rawSide === 'string' ? event.rawSide : String(event.rawSide);
      const values = [when(event.timestamp), event.event || '—', raw,
        event.instruction ?? 'null', event.quantity ?? '—', event.outcome || '—',
        event.reasonCode || '—'];
      values.forEach((value, index) => {
        const cell = make('td', String(value));
        if (index === 2) cell.className = 'bot-raw-side';
        if (index === 5) cell.className = event.outcome === 'REFUSED'
          || event.outcome === 'CONTRACT_REFUSED' ? 'bot-refused' : 'bot-clear';
        row.append(cell);
      });
      const recordCell = make('td');
      const link = make('a', event.recordId || '—', 'bot-record-link');
      link.href = event.recordHref || '#'; link.title = event.recordId || '';
      recordCell.append(link); row.append(recordCell); tbody.append(row);
    });
  }

  async function pollLane1EventLedger() {
    if (document.visibilityState !== 'visible') return;
    try { renderLane1EventLedger(await api('/api/lane-1-spy/ledger?limit=250')); }
    catch (error) {
      const sourceNode = q('[data-vsim="bot-ledger-source-status"]');
      text(sourceNode, 'SOURCE FAULT · ' + error.message + ' · prior rows retained');
      if (sourceNode) sourceNode.classList.add('source-fault');
    }
  }

  function setLaneState(armed) {
    qa('[data-e3="lane-state"], [data-vsim="bot-disarm-state"], [data-vsim-control-state]').forEach(node => {
      node.dataset.state = armed ? 'armed' : 'disarmed';
      text(node, armed ? 'ARMED' : 'DISARMED');
    });
    qa('[data-vsim="bot-menu-arm"]').forEach(node => { node.hidden = armed; });
    qa('[data-vsim="bot-menu-disarm"]').forEach(node => { node.hidden = !armed; });
  }

  function setLaneUnconfirmed() {
    qa('[data-e3="lane-state"], [data-vsim="bot-disarm-state"], [data-vsim-control-state]').forEach(node => {
      node.dataset.state = 'unconfirmed';
      text(node, 'UNCONFIRMED');
    });
  }

  function showLaneError(message) {
    qa('[data-e3="lane-error"], [data-vsim="bot-disarm-error"]').forEach(node => {
      text(node, message || '');
      node.hidden = !message;
    });
  }

  function showLanePreviewResult(message) {
    const node = q('[data-e3="lane-preview-result"]');
    if (!node) return;
    text(node, message || '');
    node.hidden = !message;
  }

  function renderE3Spine(model) {
    if (!E3_SPINE_ENABLED || !model) return;
    const fixture = model.paneA || {};
    const put = fixture.putUnit || {};
    const call = fixture.coveredCallUnit || {};
    const live = model.paneB || {};
    const values = live.values || {};
    const lane = model.paneC || {};
    text(q('[data-e3="put-net-cash"]'), moneyExact(put.netCashUsd));
    text(q('[data-e3="put-option-realized"]'), moneyExact(put.optionRealizedPnlUsd));
    text(q('[data-e3="put-shares"]'), number(put.shares));
    text(q('[data-e3="call-net-cash"]'), moneyExact(call.callNetCashUsd));
    text(q('[data-e3="cumulative-cash"]'), moneyExact(call.cumulativeEpisodeCashUsd));
    text(q('[data-e3="cumulative-option-realized"]'), moneyExact(call.cumulativeOptionRealizedPnlUsd));
    text(q('[data-e3="third-call"]'), call.thirdCallOutcome || 'Third-call result unavailable.');
    text(q('[data-e3="live-nav"]'), moneyExact(values.nav && values.nav.value));
    text(q('[data-e3="live-cash-derived"]'), moneyExact(values.cashDerived && values.cashDerived.value));
    text(q('[data-e3="live-cbrs"]'), moneyExact(values.CBRS && values.CBRS.value));
    text(q('[data-e3="live-spcx"]'), moneyExact(values.SPCX && values.SPCX.value));
    text(q('[data-e3="live-asof"]'), live.observedAt
      ? 'Stored custody as of ' + when(live.observedAt) + ' · marks only, not a resolved unit.'
      : 'No stored custody snapshot.');
    setLaneState(lane.armed === true);
    text(q('[data-e3="lane-label"]'), lane.label || 'LANE_1_SPY');
    const laneProjection = lane.positionProjection || {};
    text(q('[data-e3="lane-position"]'), laneProjection.status === 'POSITION_DRIFT'
      ? 'POSITION_DRIFT · coordinator ' + (laneProjection.coordinator?.positionSide || 'UNKNOWN')
        + ' @ ' + (laneProjection.coordinator?.updatedAt
          ? when(laneProjection.coordinator.updatedAt) : 'time unknown')
        + ' · Schwab ' + (laneProjection.broker?.positionSide || 'UNKNOWN') + ' · SPY · 1 @ '
        + (laneProjection.broker?.acquiredAt
          ? when(laneProjection.broker.acquiredAt) : 'time unknown')
      : (lane.positionSide || 'UNKNOWN') + (laneProjection.status === 'UNVERIFIED'
        ? ' · UNVERIFIED' : '') + ' · ' + (lane.symbol || 'SPY') + ' · '
        + number(lane.quantity || 1));
    text(q('[data-e3="lane-buy-fill"]'), lane.buyFillId || '—');
    text(q('[data-e3="lane-sell-fill"]'), lane.sellFillId || '—');
    text(q('[data-e3="lane-pnl"]'), moneyExact(lane.realizedPnlUsd));
    text(q('[data-e3="lane-hash"]'), lane.manifestHash || '—');
    text(q('[data-e3="lane-updated"]'), lane.updatedAt ? when(lane.updatedAt) : '—');
    const preview = lane.previewSource || null;
    const previewButton = q('[data-action="lanePreview"]');
    if (previewButton) {
      previewButton.dataset.ingressId = preview && preview.ingressId || '';
      previewButton.disabled = lane.armed === true || !preview;
    }
    text(q('[data-e3="lane-preview-source"]'), preview
      ? 'TV ' + preview.side + ' · ' + preview.ticker + ' · ' + preview.qty + ' · '
        + when(preview.receivedAt) + ' · ' + preview.tvBodyBindingSha256.slice(0, 16)
      : 'No replayable TradingView ingress row. Historical rows without a stored body cannot be invented.');
  }

  let currentStatus = null;
  let laneControlInFlight = false;
  let initialSelfAudit = true;

  function applyTvRouteProof(status, proof) {
    if (!status?.systemHealth || proof?.state !== 'REACHABLE'
      || proof.orderDispatch !== false
      || proof.workerVersion !== status.systemHealth.versions?.dashboard) return status;
    const rows = status.systemHealth.rows || [];
    const tv = rows.find(row => row.label === 'TV');
    // A route-reachability proof can resolve UNPROVEN, but it must never hide
    // an explicit failed authenticated ingress that the server marked red.
    if (!tv || tv.color === 'RED' || tv.status === 'DOWN') return status;
    tv.color = 'GREEN'; tv.status = 'LIVE'; tv.asOf = proof.at || new Date().toISOString();
    tv.detail = 'HEALTHY · PUBLIC INGRESS ROUTE REACHABLE · NO SIGNAL REQUIRED · ingress '
      + proof.proofId;
    tv.source = 'D1_PUBLIC_ROUTE_PROBE';
    const anyRed = rows.some(row => row.color === 'RED');
    const allGreen = rows.every(row => row.color === 'GREEN');
    status.systemHealth.status = allGreen ? 'ALL HEALTHY' : anyRed ? 'ACTION REQUIRED' : 'UNPROVEN';
    status.systemHealth.color = allGreen ? 'GREEN' : anyRed ? 'RED' : 'AMBER';
    return status;
  }

  function renderCoreStatus(status) {
    currentStatus = status;
    renderOverview(status, null);
    renderOpportunities(status);
    renderSystem(status, null);
    text(q('.header-status strong'), 'Shadow connected');
    text(q('.header-status small'), 'Updated ' + new Date().toLocaleTimeString([], {
      hour: 'numeric', minute: '2-digit', second: '2-digit',
    }));
    text(q('.safety-title'), '◇  LIVE PROTECTED SHADOW');
    const market = (status.systemHealth?.rows || []).find(row => row.label === 'MARKET');
    const lane = status.lane || {};
    const laneMutation = lane.armed
      ? 'Lane 1 is ARMED · ' + (lane.stage || 'UNKNOWN')
        + ' · live orders are enabled only for the legal instruction from this state.'
      : 'Lane 1 is DISARMED · no Lane 1 order can be submitted.';
    text(q('.safety-banner p'), market?.color === 'GREEN'
      ? 'Live Schwab custody, verified market data, D1/R2 evidence, and coordinator state are connected. '
        + laneMutation
      : 'The live self-audit found a failed source. ' + laneMutation);
    text(q('footer span:nth-child(2)'), lane.armed
      ? 'Lane 1 ARMED · live order path state-gated · Schwab custody read-only'
      : 'Lane 1 DISARMED · Schwab custody and market data read-only');
    const versions = status.systemHealth?.versions || {};
    text(q('footer span:nth-child(3)'), 'Dashboard '
      + String(versions.dashboard || status.version || '').slice(0, 12)
      + ' · Market ' + String(versions.market || 'unknown').slice(0, 12));
  }

  async function refresh() {
    const isInitialSelfAudit = initialSelfAudit;
    const statusRequest = isInitialSelfAudit
      ? api('/api/self-audit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      : api('/api/status');
    initialSelfAudit = false;
    let status = await statusRequest;
    if (isInitialSelfAudit && status?.selfAudit?.tvRouteChallenge) {
      // Leave the authenticated dashboard context and re-enter through the
      // public TradingView door. The one-use challenge prevents public callers
      // from generating audit writes; GET can never enter the order handler.
      const challenge = encodeURIComponent(status.selfAudit.tvRouteChallenge);
      const routeProof = await api('/lane/tv?health=1&challenge=' + challenge,
        { method: 'GET', credentials: 'omit', cache: 'no-store' }).catch(() => null);
      status = applyTvRouteProof(status, routeProof);
    }
    renderCoreStatus(status);
    document.body.classList.add('live-ready');

    // Lane state is the next visible priority. The startup self-audit already
    // performed a fresh broker read, so do not immediately make a duplicate.
    try {
      const laneLedger = await api('/api/lane-1-spy/ledger?limit=250');
      renderLane1EventLedger(laneLedger, currentStatus);
    } catch (error) {
      const sourceNode = q('[data-vsim="bot-ledger-source-status"]');
      text(sourceNode, 'BOT LEDGER UNAVAILABLE · ' + error.message + ' · live audit retained');
      if (sourceNode) sourceNode.classList.add('source-fault');
    }

    // Historical and off-screen panels hydrate after the operational surface
    // is already usable. A secondary-panel failure cannot blank the dashboard.
    try {
      const requests = [api('/api/guardian'), api('/api/ledger?limit=250'),
        api('/api/portfolio'), api('/api/performance'),
        api('/api/performance/calendar?month=' + encodeURIComponent(performanceState.month)
          + '&scope=' + encodeURIComponent(performanceState.scope))];
      if (E3_SPINE_ENABLED) requests.push(api('/api/e3-spine'));
      const payloads = await Promise.all(requests);
      performanceState.calendar = payloads[4];
      renderOverview(currentStatus, payloads[2]);
      renderSystem(currentStatus, payloads[3]);
      renderGuardian(payloads[0]);
      renderPortfolio(payloads[2], payloads[3]);
      renderBrokerActivity(payloads[3], payloads[1]);
      renderPerformance(payloads[3], payloads[2]);
      if (E3_SPINE_ENABLED) renderE3Spine(payloads[5]);
      await renderEvidence(currentStatus);
    } catch (error) {
      const output = q('.operator-output');
      if (output) text(output, 'Core live data loaded. A secondary panel failed: ' + error.message);
    }
  }

  async function operate(action, button) {
    const output = q('.operator-output');
    const reason = (q('.control-reason') && q('.control-reason').value || '').trim();
    const control = (controlAction, confirm) => api('/api/operator/controls', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: controlAction, reason, confirm }),
    });
    const operations = {
      refresh: () => Promise.resolve(),
      ledger: () => api('/api/operator/broker/backfill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'BACKFILL_READ_ONLY_LEDGER', max_windows: 6, window_days: 59 }) }),
      guardian: () => api('/api/operator/guardian/review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      cycle: () => api('/api/cycle', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: '{}' }),
      replay: () => api('/api/operator/replay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cycle_id: currentStatus && currentStatus.latestCycle && currentStatus.latestCycle.cycleId }) }),
      pause: () => control('PAUSE', 'PAUSE_SHADOW_CYCLES'),
      resume: () => control('RESUME', 'RESUME_SHADOW_CYCLES'),
      kill: () => control('KILL', 'TRIP_INDEPENDENT_KILL_SWITCH'),
      clearKill: () => control('CLEAR_KILL', 'CLEAR_INDEPENDENT_KILL_SWITCH'),
      laneDisarm: () => api('/api/lane-1-spy/disarm', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      }),
      laneState: () => api('/api/lane-1-spy/state'),
      laneArm: () => api('/api/lane-1-spy/arm', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: 'ARM_LANE_1_CURRENT_STATE' }),
      }),
      laneRefresh: () => api('/api/lane-1-spy/ledger?limit=250&refresh=1'),
      laneRecover: () => api('/api/lane-1-spy/reconcile-open', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: 'RECONCILE_BROKER_LEDGER_OPEN' }),
      }),
      lanePreview: () => {
        const source = q('[data-action="lanePreview"]');
        const ingressId = source && source.dataset.ingressId || '';
        return api('/api/lane-1-spy/preview-ingress', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ingressId }),
        });
      },
    };
    if (action === 'laneRefresh') {
      if (button) button.disabled = true;
      try {
        const ledger = await operations.laneRefresh();
        renderLane1EventLedger(ledger, currentStatus);
        if (E3_SPINE_ENABLED) renderE3Spine(await api('/api/e3-spine'));
      } catch (error) { showLaneError('REFRESH failed: ' + error.message); }
      finally { if (button) button.disabled = false; }
      return;
    }
    if (action === 'laneRecover') {
      if (button) button.disabled = true;
      showLaneError(null);
      try {
        const result = await bounded(operations.laneRecover(), 10_000,
          'LANE_1_RECOVERY_RESPONSE_TIMEOUT');
        if (result.state !== 'OPEN_SHORT' || result.positionSide !== 'SHORT') {
          throw new Error(result.faultCode || 'LANE_1_RECOVERY_STATE_MISMATCH');
        }
        await refresh();
      } catch (error) { showLaneError('RECOVERY failed: ' + error.message); }
      finally { if (button) button.disabled = false; }
      return;
    }
    const confirmations = {
      ledger: 'Backfill the append-only Schwab transaction ledger using read-only API history?',
      guardian: 'Refresh Schwab truth, ingest the broker ledger, and run the read-only Guardian review?',
      cycle: 'Run a live-data shadow opportunity simulation? It cannot place an order.',
      pause: 'Pause all shadow cycles?', resume: 'Resume shadow cycles?',
      kill: 'Trip the independent kill switch and block every new cycle?',
      clearKill: 'Clear the independent kill switch after verifying its cause is gone?',
    };
    if (action === 'laneArm' || action === 'laneDisarm') {
      if (laneControlInFlight) return;
      laneControlInFlight = true;
      const stateNode = q('[data-e3="lane-state"], [data-vsim="bot-disarm-state"], [data-vsim-control-state]');
      const previousArmed = stateNode && stateNode.dataset.state === 'armed';
      const laneButtons = qa('[data-action="laneArm"], [data-action="laneDisarm"]');
      showLaneError(null);
      laneButtons.forEach(node => { node.disabled = true; });
      try {
        if (action === 'laneArm') {
          let liveArmState;
          try {
            liveArmState = await bounded(operations.laneState(), 5_000,
              'LANE_1_PRINCIPAL_ARM_PREFLIGHT_TIMEOUT');
          } catch (caught) {
            showLaneError('ARM UNCONFIRMED — live coordinator state unavailable. ('
              + caught.message + ')');
            return;
          }
          const contract = armLaneContract(liveArmState);
          text(q('[data-vsim="bot-arm-contract"]'), contract.text);
          if (!contract.permitted) {
            showLaneError('ARM REFUSED — ' + contract.faultCode);
            return;
          }
          if (!window.confirm(contract.text + '?')) return;
        }
        let result = null; let error = null; let readback = null; let readbackError = null;
        try {
          result = await bounded(operations[action](), 5_000,
            'LANE_1_CONTROL_RESPONSE_TIMEOUT');
        } catch (caught) { error = caught; }
        if (action === 'laneArm' || action === 'laneDisarm') {
          try {
            readback = await bounded(operations.laneState(), 5_000,
              action === 'laneDisarm' ? 'LANE_1_PRINCIPAL_DISARM_READBACK_TIMEOUT'
                : 'LANE_1_PRINCIPAL_ARM_READBACK_TIMEOUT');
          } catch (caught) { readbackError = caught; }
        }
        const outcome = resolveLaneControlOutcome({
          action, previousArmed, result, error, readback, readbackError,
        });
        if (outcome.error) {
          if (action === 'laneDisarm') setLaneUnconfirmed();
          showLaneError(outcome.error);
        }
        else setLaneState(outcome.armed);
      } catch (error) {
        const outcome = resolveLaneControlOutcome({ action, previousArmed, error });
        if (action === 'laneDisarm') setLaneUnconfirmed();
        showLaneError(outcome.error);
      } finally {
        laneControlInFlight = false;
        laneButtons.forEach(node => { node.disabled = false; });
      }
      return;
    }
    if (action === 'lanePreview') {
      const stateNode = q('[data-e3="lane-state"]');
      if (!stateNode || stateNode.dataset.state !== 'disarmed') {
        showLaneError('VALIDATE failed: LANE_1_PREVIEW_REQUIRES_DURABLE_DISARMED'); return;
      }
      const laneButtons = qa('[data-action="laneArm"], [data-action="laneDisarm"], [data-action="lanePreview"]');
      showLaneError(null); showLanePreviewResult(null);
      laneButtons.forEach(node => { node.disabled = true; });
      try {
        const result = await operations.lanePreview();
        showLanePreviewResult('PREVIEWED · ' + result.brokerInstruction + ' 1 SPY · request '
          + result.requestSha256.slice(0, 16) + ' · TV ' + result.tvBodyBindingSha256.slice(0, 16)
          + ' · ARM DISARMED · orders 0');
        await refresh();
      } catch (error) { showLaneError('VALIDATE failed: ' + error.message); }
      finally {
        const preview = q('[data-action="lanePreview"]');
        laneButtons.forEach(node => { node.disabled = false; });
        const laneState = q('[data-e3="lane-state"]');
        if (preview) preview.disabled = !preview.dataset.ingressId
          || !laneState || laneState.dataset.state !== 'disarmed';
      }
      return;
    }
    if (['pause','resume','kill','clearKill'].includes(action) && reason.length < 8) {
      text(output, 'REFUSED: enter a reason of at least 8 characters.'); return;
    }
    if (confirmations[action] && !window.confirm(confirmations[action])) return;
    if (!operations[action]) return;
    if (button) button.disabled = true; text(output, 'Working…');
    try { const result = await operations[action](); text(output, result ? JSON.stringify(result, null, 2) : 'Status refreshed.'); await refresh(); }
    catch (error) { text(output, 'REFUSED: ' + error.message); }
    finally { if (button) button.disabled = false; }
  }

  document.addEventListener('click', event => {
    const underwriteTab = event.target.closest('[data-underwrite-mode]');
    if (underwriteTab) { setUnderwriteMode(underwriteTab.dataset.underwriteMode); return; }
    const performanceFilter = event.target.closest('[data-performance-filter]');
    if (performanceFilter) { setPerformanceFilter(performanceFilter.dataset.performanceFilter, performanceFilter.dataset.filterValue); return; }
    const calendarDay = event.target.closest('[data-performance-date]');
    if (calendarDay) { commitPerformanceState({ from: calendarDay.dataset.performanceDate,
      to: calendarDay.dataset.performanceDate }, { scroll: true }); return; }
    const calendarScope = event.target.closest('[data-pnl-calendar-scope]');
    if (calendarScope) { commitPerformanceState({ scope: calendarScope.dataset.pnlCalendarScope }, { reloadCalendar: true }); return; }
    const calendarShift = event.target.closest('[data-pnl-calendar-shift]');
    if (calendarShift) { commitPerformanceState({ month: shiftedMonth(performanceState.month,
      Number(calendarShift.dataset.pnlCalendarShift)) }, { reloadCalendar: true }); return; }
    if (event.target.closest('[data-clear-performance-filter]')) {
      commitPerformanceState({ ticker: null, strategy: null, from: null, to: null, scope: 'ALL' }, { reloadCalendar: true }); return;
    }
    if (event.target.closest('[data-jump-system-history]')) { activateView('system'); q('#system-history')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    const calculatorTab = event.target.closest('[data-calculator]');
    if (calculatorTab) { setCalculatorMode(calculatorTab.dataset.calculator); return; }
    const coveredCall = event.target.closest('[data-cc-symbol]');
    if (coveredCall) { openCoveredCall(coveredCall.dataset.ccSymbol, coveredCall); return; }
    const cspCalculate = event.target.closest('[data-csp-calculate]');
    if (cspCalculate) { runCashSecuredPut(cspCalculate); return; }
    const button = event.target.closest('[data-action]'); if (button) operate(button.dataset.action, button);
  });
  document.addEventListener('change', event => {
    if (event.target.matches('[data-performance-from]')) commitPerformanceState({ from: event.target.value || null });
    if (event.target.matches('[data-performance-to]')) commitPerformanceState({ to: event.target.value || null });
  });
  window.addEventListener('popstate', () => { applyPerformanceUrl(); renderPerformanceLedger(); loadPerformanceCalendar(); });
  composeConsolidatedViews();
  consolidateDecisionsIntoSystem();
  relocateTopOpportunities();
  scrubPreviewLanguage();
  refresh().catch(error => {
    text(q('.header-status strong'), 'Live data unavailable');
    text(q('.safety-title'), '◇  FAIL-CLOSED');
    text(q('.safety-banner p'), 'The protected live state could not be loaded: ' + error.message + '. No synthetic account or opportunity values are displayed.');
    qa('.metric-value').forEach(node => text(node, 'UNAVAILABLE'));
    qa('tbody').forEach(clear);
    document.body.classList.add('live-ready');
  });
  window.setInterval(pollLane1EventLedger, 5_000);
})();`;
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === '/health') return json(publicStatus(env));
  if (url.pathname === '/api/integrations/telegram/webhook' && request.method === 'POST') {
    if (!env.ACCESS_OWNER_ID) return json({ error: 'TELEGRAM_OWNER_NOT_CONFIGURED' }, 503);
    return handleTelegramWebhook({
      request,
      env,
      ctx,
      ownerId: env.ACCESS_OWNER_ID,
      service: createMcpService(env, env.ACCESS_OWNER_ID),
      reviewGuardian: (options) => runGuardianReview(env, env.ACCESS_OWNER_ID, options),
    });
  }
  if (url.pathname === '/lane/tv') {
    if (!env.ACCESS_OWNER_ID) return json({ error: 'LANE_1_OWNER_NOT_CONFIGURED' }, 503);
    if (request.method === 'GET' && url.searchParams.get('health') === '1') {
      const challenge = url.searchParams.get('challenge');
      if (!challenge) return json({ error: 'TV_ROUTE_CHALLENGE_REQUIRED' }, 403);
      const row = await env.DB.prepare(`SELECT detail_json FROM operational_audit
        WHERE id=? AND owner_id=? AND event_type='DASHBOARD_TV_ROUTE_CHALLENGE'`).bind(
        challenge, env.ACCESS_OWNER_ID,
      ).first();
      const challengeDetail = parseJson(row?.detail_json, null);
      const currentVersion = env.CF_VERSION_METADATA?.id ?? 'local';
      if (!challengeDetail || challengeDetail.workerVersion !== currentVersion
        || Date.parse(challengeDetail.expiresAt ?? '') < Date.now()) {
        return json({ error: 'TV_ROUTE_CHALLENGE_INVALID' }, 403);
      }
      const createdAt = nowIso();
      const result = await env.DB.prepare(`UPDATE operational_audit
        SET event_type='LANE_1_TV_ROUTE_PROBE',detail_json=?,created_at=?
        WHERE id=? AND owner_id=? AND event_type='DASHBOARD_TV_ROUTE_CHALLENGE'`).bind(
        JSON.stringify({ workerVersion: currentVersion, probeKind: 'PUBLIC_ROUTE_GET',
          route: '/lane/tv' }), createdAt, challenge, env.ACCESS_OWNER_ID,
      ).run();
      if (Number(result?.meta?.changes) !== 1) {
        return json({ error: 'TV_ROUTE_CHALLENGE_ALREADY_USED' }, 409);
      }
      return json({ state: 'REACHABLE', workerVersion: env.CF_VERSION_METADATA?.id ?? 'local',
        proofId: challenge, at: createdAt, orderDispatch: false });
    }
    return handleLane1TvWebhook({ request, env, ownerId: env.ACCESS_OWNER_ID });
  }
  if (url.pathname === '/lane/principal-flatten') {
    if (!env.ACCESS_OWNER_ID) return json({ error: 'LANE_1_OWNER_NOT_CONFIGURED' }, 503);
    return handlePrincipalFlatten({ request, env, ownerId: env.ACCESS_OWNER_ID });
  }
  if (url.pathname === '/mcp') {
    let owner;
    try { owner = await authenticateAccess(request, env, { allowServiceToken: true }); }
    catch (error) { return json({ error: error.message }, 401); }
    return handleVsimMcp({
      request, env, ctx, owner, service: createMcpService(env, owner.id),
    });
  }
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/design/'))) {
    try { await authenticateAccess(request, env); }
    catch (error) { return json({ error: error.message }, 401); }
    if (url.pathname === '/design/styles.css') return designAsset('styles.css');
    if (url.pathname === '/design/app.js') return designAsset('app.js');
    if (url.pathname === '/design/live.js') return new Response(liveDashboardScript({
      e3SpineTab: e3SpineTabEnabled(env),
    }), { headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    } });
    if (url.pathname !== '/') return json({ error: 'NOT_FOUND' }, 404);
    return serveDashboard(() => fullDashboard(BUNDLED_DESIGN_HTML, {
      e3SpineTab: e3SpineTabEnabled(env),
    }));
  }
  if (!url.pathname.startsWith('/api/')) return json({ error: 'NOT_FOUND' }, 404);

  let owner;
  try { owner = await authenticateAccess(request, env); }
  catch (error) { return json({ error: error.message }, 401); }

  const client = new SchwabD1Client(env);
  if (url.pathname === '/api/status' && request.method === 'GET') return json(await apiStatus(env, owner.id));
  if (url.pathname === '/api/self-audit' && request.method === 'POST') {
    try { requireSameOrigin(request, env); } catch (error) { return json({ error: error.message }, 403); }
    const startedAt = nowIso();
    const tvRouteChallenge = await recordOperationalProof(env, owner.id,
      'DASHBOARD_TV_ROUTE_CHALLENGE', {
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    let custodyRefreshProbe;
    try {
      const snapshot = await reconciledSnapshot(env, owner.id);
      custodyRefreshProbe = {
        attempted: true, ok: true, at: nowIso(),
        asOf: new Date(snapshot.asOf).toISOString(),
        snapshotHash: snapshot.snapshotHash,
      };
    } catch (error) {
      custodyRefreshProbe = {
        attempted: true, ok: false, at: nowIso(),
        error: String(error?.message ?? error).split(':')[0],
      };
    }
    const status = await apiStatus(env, owner.id, { custodyRefreshProbe });
    const completedAt = nowIso();
    const passed = !status.systemHealth.rows.some((row) => row.color === 'RED');
    await audit(env, owner.id, 'DASHBOARD_SELF_AUDIT', {
      startedAt, completedAt, passed,
      workerVersion: env.CF_VERSION_METADATA?.id ?? 'local',
      custodyRefresh: custodyRefreshProbe,
      sources: Object.fromEntries(status.systemHealth.rows.map((row) => [row.label, {
        status: row.status, detail: row.detail, asOf: row.asOf,
      }])),
    });
    return json({ ...status, selfAudit: { startedAt, completedAt, passed,
      tvRouteChallenge: tvRouteChallenge?.id ?? null } });
  }
  if (url.pathname === '/api/e3-spine' && request.method === 'GET') {
    if (!e3SpineTabEnabled(env)) return json({ error: 'NOT_FOUND' }, 404);
    const positionStub = env.ACCOUNT_COORDINATOR?.getByName?.(owner.id);
    const [cycleSnapshot, laneUnit, lanePreviewSource, positionProjection] = await Promise.all([
      loadLatestCustody(env, owner.id), lane1Status(env, owner.id),
      latestLane1ReplayIngress(env, owner.id),
      positionStub?.laneV2PositionProjection
        ? positionStub.laneV2PositionProjection({ ownerId: owner.id, refresh: false,
          maxAgeMs: 60_000 }) : null,
    ]);
    return json(buildE3SpineTab({ cycleSnapshot, laneUnit, lanePreviewSource,
      positionProjection }));
  }
  if (url.pathname === '/api/lane-1-spy/ledger' && request.method === 'GET') {
    return json(await lane1EventLedger(env, owner.id, {
      limit: Number(url.searchParams.get('limit') ?? 250),
      refreshPosition: url.searchParams.get('refresh') === '1',
    }));
  }
  if (url.pathname === '/api/lane-1-spy/disarm' && request.method === 'POST') {
    const result = await disarmLane1FromDashboard({ env, ownerId: owner.id });
    return json(result.body, result.status);
  }
  if (url.pathname === '/api/lane-1-spy/state' && request.method === 'GET') {
    const result = await lane1ControlStateFromDashboard({ env, ownerId: owner.id });
    return json(result.body, result.status);
  }
  if (url.pathname === '/api/lane-1-spy/arm' && request.method === 'POST') {
    const body = await readBoundedJson(request, 1_024).catch(() => ({}));
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(['confirm'])) {
      return json({ armed: false, faultCode: 'LANE_1_ARM_REQUEST_INVALID' }, 400);
    }
    const result = await armLane1FromDashboard({ env, ownerId: owner.id,
      principalConfirmation: body.confirm });
    return json(result.body, result.status);
  }
  if (url.pathname === '/api/lane-1-spy/reconcile-open' && request.method === 'POST') {
    const body = await readBoundedJson(request, 1_024).catch(() => ({}));
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(['confirm'])) {
      return json({ state: 'REFUSED', faultCode: 'LANE_1_RECOVERY_REQUEST_INVALID' }, 400);
    }
    const result = await reconcileLane1OpenFromBrokerLedger({ env, ownerId: owner.id,
      principalConfirmation: body?.confirm });
    return json(result.body, result.status);
  }
  if (url.pathname === '/api/lane-1-spy/resolve-completed-exit-fault'
    && request.method === 'POST') {
    const body = await readBoundedJson(request, 1_024).catch(() => ({}));
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(['confirm'])) {
      return json({ state: 'REFUSED',
        faultCode: 'LANE_1_COMPLETED_EXIT_FAULT_REQUEST_INVALID' }, 400);
    }
    const result = await resolveLane1CompletedExitFault({ env, ownerId: owner.id,
      principalConfirmation: body.confirm });
    return json(result.body, result.status);
  }
  if (url.pathname === '/api/lane-1-spy/arm-existing' && request.method === 'POST') {
    const body = await readBoundedJson(request, 1_024).catch(() => ({}));
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(['confirm'])) {
      return json({ armed: false, faultCode: 'LANE_1_ARM_EXISTING_REQUEST_INVALID' }, 400);
    }
    const result = await armExistingLane1FromDashboard({ env, ownerId: owner.id,
      principalConfirmation: body?.confirm });
    return json(result.body, result.status);
  }
  if (url.pathname === '/api/lane-1-spy/preview-ingress' && request.method === 'POST') {
    return handleLane1PreviewRequest({ request, env, ownerId: owner.id });
  }
  if (url.pathname === '/api/lane-1-spy/validate-bracket' && request.method === 'POST') {
    return json({ state: 'RETIRED', faultCode: 'LANE_1_BRACKET_CONTRACT_RETIRED' }, 410);
  }
  if (url.pathname === '/api/lane-1-spy/validate-market' && request.method === 'POST') {
    return json({ state: 'RETIRED', faultCode: 'LANE_1_PREVIEW_GATE_RETIRED' }, 410);
  }
  if (url.pathname === '/api/lane-1-spy/principal-flatten' && request.method === 'POST') {
    return json({ state: 'DISABLED', faultCode: 'LANE_1_FLATTEN_ROUTE_RETIRED' }, 410);
  }
  if (url.pathname === '/api/portfolio' && request.method === 'GET') {
    return json(await portfolioDashboard(env, owner.id));
  }
  if (url.pathname === '/api/covered-call/calculate' && request.method === 'GET') {
    return json(await coveredCallDashboard(env, owner.id, url.searchParams.get('symbol')));
  }
  if (url.pathname === '/api/performance/calendar' && request.method === 'GET') {
    try {
      return json(await performanceCalendarDashboard(env, owner.id, {
        month: url.searchParams.get('month'),
        scope: url.searchParams.get('scope') || 'ALL',
      }));
    } catch (error) {
      return json({ error: error.message }, 400);
    }
  }
  if (url.pathname === '/api/performance' && request.method === 'GET') {
    return json(await performanceDashboard(env, owner.id));
  }
  if (url.pathname === '/api/integrations/telegram/status' && request.method === 'GET') {
    return json(await telegramAssistantStatus(env, owner.id));
  }
  if (url.pathname === '/api/guardian' && request.method === 'GET') {
    const [review, ledger, pending] = await Promise.all([
      latestGuardianReview(env, owner.id), guardianLedgerSummary(env, owner.id, 1),
      env.DB.prepare(`SELECT COUNT(*) AS count FROM guardian_discord_outbox
        WHERE owner_id=? AND delivery_status IN ('PENDING','FAILED')`).bind(owner.id).first(),
    ]);
    return json({ mandateVersion: GUARDIAN_MANDATE_VERSION, review,
      activeCampaigns: ledger.activeCampaigns, discord: {
        configured: Boolean(env.GUARDIAN_DISCORD_WEBHOOK_URL), pending: Number(pending?.count ?? 0),
      } });
  }
  if (url.pathname === '/api/ledger' && request.method === 'GET') {
    const limit = Math.min(250, Math.max(1, Number(url.searchParams.get('limit') ?? 100)));
    const [ledger, sync] = await Promise.all([
      guardianLedgerSummary(env, owner.id, limit), client.ledgerStatus(owner.id),
    ]);
    return json({ ...ledger, sync, raw: 'PROTECTED_NOT_EXPOSED', appendOnly: true });
  }
  if (url.pathname === '/api/integrations/schwab/connect' && request.method === 'GET') {
    const destination = await client.beginOAuth(owner.id);
    const safeDestination = destination.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Connect Schwab read-only</title><style>body{color-scheme:dark;background:#07100e;color:#e8f1ec;font:16px system-ui;display:grid;min-height:100vh;place-items:center;margin:0}.card{max-width:620px;background:#0d1a16;border:1px solid #22382f;border-radius:12px;padding:28px}h1{margin-top:0}p{color:#a9bbb2;line-height:1.55}.warn{color:#f4ba61}a{display:inline-block;margin-top:12px;border:1px solid #315445;background:#10271f;color:#60e2a8;padding:11px 15px;border-radius:7px;text-decoration:none;font-weight:700}</style></head><body><main class="card"><h1>Connect Schwab read-only</h1><p>This authorizes custody reads for account balances, positions, and open orders. NUVO VSIM v5 remains proposal-only and has no order submission, replacement, or cancellation capability.</p><p class="warn">You will review and approve the connection on Schwab.</p><a href="${safeDestination}" rel="noreferrer">Continue to Schwab</a></main></body></html>`, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'private, no-store',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      },
    });
  }
  if (url.pathname === '/api/integrations/schwab/callback' && request.method === 'GET') {
    if (url.searchParams.has('error')) return new Response(null, { status: 303, headers: { location: '/?schwab=denied' } });
    try {
      await client.completeOAuth(owner.id, url.searchParams.get('state'), url.searchParams.get('code'));
      await audit(env, owner.id, 'SCHWAB_CONNECTED_READ_ONLY');
      return new Response(null, { status: 303, headers: { location: '/?schwab=connected' } });
    } catch (error) {
      await audit(env, owner.id, 'SCHWAB_OAUTH_FAILED', { error: error.message });
      return new Response(null, { status: 303, headers: { location: '/?schwab=failed' } });
    }
  }
  if (url.pathname === '/api/operator/baseline' && request.method === 'POST') {
    try { requireSameOrigin(request, env); } catch (error) { return json({ error: error.message }, 403); }
    const body = await request.json().catch(() => ({}));
    if (body.confirm !== 'CAPTURE_READ_ONLY_BASELINE') return json({ error: 'EXPLICIT_BASELINE_CONFIRMATION_REQUIRED' }, 400);
    return json({ ok: true, baseline: await captureBaseline(env, owner.id) });
  }
  if (url.pathname === '/api/operator/custody/refresh' && request.method === 'POST') {
    try { requireSameOrigin(request, env); } catch (error) { return json({ error: error.message }, 403); }
    const body = await request.json().catch(() => ({}));
    if (body.confirm !== 'REFRESH_READ_ONLY_CUSTODY') return json({ error: 'EXPLICIT_CUSTODY_REFRESH_REQUIRED' }, 400);
    const snapshot = await reconciledSnapshot(env, owner.id);
    await audit(env, owner.id, 'CUSTODY_READ_ONLY_REFRESHED', {
      snapshotHash: snapshot.snapshotHash,
      positionCount: snapshot.positions.length,
      openOrderCount: snapshot.openOrders.length,
      observedAt: new Date(snapshot.asOf).toISOString(),
    });
    return json({ ok: true, observedAt: snapshot.asOf, snapshotHash: snapshot.snapshotHash });
  }
  if (url.pathname === '/api/operator/broker/backfill' && request.method === 'POST') {
    try { requireSameOrigin(request, env); } catch (error) { return json({ error: error.message }, 403); }
    const body = await request.json().catch(() => ({}));
    if (body.confirm !== 'BACKFILL_READ_ONLY_LEDGER') {
      return json({ error: 'EXPLICIT_LEDGER_BACKFILL_CONFIRMATION_REQUIRED' }, 400);
    }
    const result = await client.backfillLedger(owner.id, {
      maxWindows: Math.min(12, Math.max(1, Number(body.max_windows ?? 6))),
      windowDays: Math.min(365, Math.max(1, Number(body.window_days ?? 59))),
    });
    await audit(env, owner.id, 'BROKER_LEDGER_BACKFILL', result);
    return json({ ok: true, ledger: result });
  }
  if (url.pathname === '/api/operator/market/check' && request.method === 'POST') {
    try { requireSameOrigin(request, env); } catch (error) { return json({ error: error.message }, 403); }
    return json(await verifyLiveMarket(env, owner.id));
  }
  if (url.pathname === '/api/operator/guardian/review' && request.method === 'POST') {
    try { requireSameOrigin(request, env); } catch (error) { return json({ error: error.message }, 403); }
    return json({ ok: true, guardian: await runGuardianReview(env, owner.id, { reviewType: 'MANUAL' }) });
  }
  if (url.pathname === '/api/operator/controls' && request.method === 'POST') {
    try { requireSameOrigin(request, env); } catch (error) { return json({ error: error.message }, 403); }
    const body = await request.json().catch(() => ({}));
    const confirmations = {
      PAUSE: 'PAUSE_SHADOW_CYCLES',
      RESUME: 'RESUME_SHADOW_CYCLES',
      KILL: 'TRIP_INDEPENDENT_KILL_SWITCH',
      CLEAR_KILL: 'CLEAR_INDEPENDENT_KILL_SWITCH',
    };
    if (!confirmations[body.action] || body.confirm !== confirmations[body.action]) {
      return json({ error: 'EXPLICIT_CONTROL_CONFIRMATION_REQUIRED' }, 400);
    }
    try {
      return json({ ok: true, controls: await updateOperatorControls(env, owner.id, body) });
    } catch (error) {
      return json({ error: error.message }, 400);
    }
  }
  if (url.pathname === '/api/operator/replay' && request.method === 'POST') {
    try { requireSameOrigin(request, env); } catch (error) { return json({ error: error.message }, 403); }
    const body = await request.json().catch(() => ({}));
    const latest = body.cycle_id ? null : await cycleSummary(env, owner.id);
    const cycleId = body.cycle_id ?? latest?.cycleId ?? null;
    if (!cycleId) return json({ error: 'NO_SEALED_CYCLE' }, 404);
    const result = await replayEvidenceTool(env, owner.id, { cycleId, fingerprint: null });
    return json(result, result.ok ? 200 : 409);
  }
  if (url.pathname === '/api/cash-secured-put/calculate' && request.method === 'POST') {
    try { requireSameOrigin(request, env); } catch (error) { return json({ error: error.message }, 403); }
    const idempotencyKey = request.headers.get('idempotency-key');
    if (!idempotencyKey) return json({ error: 'OPERATOR_IDEMPOTENCY_KEY_REQUIRED' }, 400);
    return json(await triggerShadowCycle(env, owner.id, { source: 'CSP_CALCULATOR', idempotencyKey }));
  }
  if (url.pathname === '/api/cycle' && request.method === 'POST') {
    try { requireSameOrigin(request, env); } catch (error) { return json({ error: error.message }, 403); }
    const idempotencyKey = request.headers.get('idempotency-key');
    if (!idempotencyKey) return json({ error: 'OPERATOR_IDEMPOTENCY_KEY_REQUIRED' }, 400);
    return json(await triggerShadowCycle(env, owner.id, { source: 'OPERATOR', idempotencyKey }));
  }
  if (url.pathname === '/api/evidence' && request.method === 'GET') {
    const rows = await env.DB.prepare(`SELECT cycle_id,sequence,evidence_hash,chain_hash,
      decision_fingerprint,decision,authority_level,created_at FROM evidence_index
      WHERE owner_id=? ORDER BY sequence DESC LIMIT 100`).bind(owner.id).all();
    return json({ records: rows.results ?? [], rawPackages: 'R2_PROTECTED_NOT_EXPOSED' });
  }
  return json({ error: 'NOT_FOUND' }, 404);
}

function easternClock(value = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false,
    weekday: 'short', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(value));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  const weekday = get('weekday');
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  const minuteOfDay = hour * 60 + minute;
  const session = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday)
    && minuteOfDay >= 9 * 60 + 30 && minuteOfDay < 16 * 60 ? 'RTH' : 'CLOSED';
  return { weekday, hour, minute, session };
}

export default {
  async fetch(request, env, ctx) {
    try {
      configuredAuthority(env);
      return await route(request, env, ctx);
    }
    catch (error) {
      console.error('NUVO VSIM v5 shadow error', error);
      if (error instanceof AuthorityConfigurationError) return json(systemFault(error), 503);
      return json({ error: 'FAIL_CLOSED', reason: error.message }, 503);
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      try { configuredAuthority(env); }
      catch (error) {
        console.error(JSON.stringify(systemFault(error)));
        return;
      }
      const owners = await env.DB.prepare(`SELECT owner_id FROM broker_connections
        WHERE status IN ('CONNECTED','DEGRADED') ORDER BY updated_at ASC`).all();
      const clock = easternClock(controller.scheduledTime);
      if (controller.cron === '*/5 * * * *') {
        for (const owner of owners.results ?? []) {
          try { await apiStatus(env, owner.owner_id); }
          catch (error) { await audit(env, owner.owner_id, 'CONNECTOR_HEARTBEAT_FAILED', { error: error.message }); }
        }
        return;
      }
      for (const owner of owners.results ?? []) {
        try { await expireLane1(env, owner.owner_id); }
        catch (error) { await audit(env, owner.owner_id, 'LANE_1_TTL_DISARM_FAILED', { error: error.message }); }
        if (clock.session === 'RTH' && clock.minute % 15 === 2) {
          try {
            const ledger = await new SchwabD1Client(env).backfillLedger(owner.owner_id, {
              maxWindows: 48, windowDays: 59,
            });
            await audit(env, owner.owner_id, 'SCHEDULED_BROKER_LEDGER_BACKFILL', ledger);
          } catch (error) {
            await audit(env, owner.owner_id, 'SCHEDULED_BROKER_LEDGER_BACKFILL_FAILED', { error: error.message });
          }
        }
        try {
          const reviewType = clock.hour === 16 && clock.minute >= 10 && clock.minute < 15
            ? 'END_OF_DAY' : clock.minute === 0 ? 'HOURLY' : 'EVENT';
          await runGuardianReview(env, owner.owner_id, { reviewType });
        } catch (error) {
          await audit(env, owner.owner_id, 'SCHEDULED_GUARDIAN_FAILED', { error: error.message });
        }
        if (clock.hour >= 9 && clock.hour <= 16 && clock.minute % 15 === 0) {
          try { await triggerShadowCycle(env, owner.owner_id, { source: 'SCHEDULED' }); }
          catch (error) { await audit(env, owner.owner_id, 'SCHEDULED_SHADOW_FAILED', { error: error.message }); }
        }
      }
    })());
  },
  async queue(batch, env) {
    try { configuredAuthority(env); }
    catch (error) {
      console.error(JSON.stringify(systemFault(error)));
      for (const message of batch.messages) message.retry();
      return;
    }
    for (const message of batch.messages) {
      const ownerId = String(message.body?.ownerId ?? '');
      const update = message.body?.update;
      if (!ownerId || ownerId !== String(env.ACCESS_OWNER_ID ?? '') || !update) {
        message.ack();
        continue;
      }
      await processTelegramUpdate({
        env,
        ownerId,
        service: createMcpService(env, ownerId),
        reviewGuardian: (options) => runGuardianReview(env, ownerId, options),
        update,
      });
      message.ack();
    }
  },
};
