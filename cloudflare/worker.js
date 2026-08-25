import { NuvoEngine } from '../src/engine.js';
import { MassiveProvider } from '../src/truth/providers/massive.js';
import { SchwabReadOnlyBroker } from '../src/execution/broker/schwab_readonly.js';
import { EvidenceStore } from '../src/evidence/store.js';
import { buildEvidence, verifyEvidence, verifyFingerprint } from '../src/evidence/package.js';
import { replay } from '../src/evidence/replay.js';
import { AUTHORITY } from '../src/constitution/authority.js';
import { DEFAULT_LIMITS } from '../src/constitution/limits.js';
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

const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
const nowIso = () => new Date().toISOString();
const authorityLevel = (env) => Number(env.NUVO_AUTHORITY_LEVEL ?? AUTHORITY.SHADOW);

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
    authority_level: authorityLevel(env),
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
    authority: `${authorityLevel(env)}_SHADOW`,
    authority_level: authorityLevel(env),
    broker_mode: 'READ_ONLY',
    broker_execution_mode: 'SHADOW_ONLY',
    mutation_routes: false,
    existing_vsim_untouched: true,
    schedule: 'Every 15 minutes',
    version: env.CF_VERSION_METADATA?.id ?? 'local',
  };
}

function requireSameOrigin(request, env) {
  const origin = request.headers.get('origin');
  if (!origin || origin !== env.PUBLIC_ORIGIN) throw new Error('ORIGIN_NOT_ALLOWED');
}

async function audit(env, ownerId, type, detail = {}) {
  await env.DB.prepare(`INSERT INTO operational_audit
    (id,owner_id,event_type,detail_json,created_at) VALUES (?,?,?,?,?)`).bind(
    crypto.randomUUID(), ownerId, type, JSON.stringify(detail), nowIso(),
  ).run();
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

function marketProvider(env) {
  const dteTargets = String(env.NUVO_DTE_TARGETS ?? '14,30,45')
    .split(',').map(Number).filter(Number.isFinite);
  return new MassiveProvider({
    fetcher: (request) => env.MARKET.fetch(request), dteTargets,
    maxChainAgeMs: Number(env.NUVO_MAX_CHAIN_AGE_MS ?? 120_000),
    fundSymbols: String(env.NUVO_FUND_SYMBOLS ?? '').split(',')
      .map((symbol) => symbol.trim().toUpperCase()).filter(Boolean),
  });
}

async function verifyLiveMarket(env, ownerId) {
  const provider = marketProvider(env);
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
    source: 'MASSIVE_POLYGON_PRIVATE_SERVICE',
    marketState: marketState.error ? { error: marketState.error } : {
      status: marketState.value.status,
      vix: marketState.value.vix,
      vix3m: marketState.value.vix3m,
      asOf: marketState.asOf,
    },
    symbols: rows,
  };
  await audit(env, ownerId, 'MASSIVE_LIVE_CHAIN_CHECK', result);
  return result;
}

async function captureBaseline(env, ownerId) {
  const client = new SchwabD1Client(env);
  const snapshot = await client.snapshot(ownerId);
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
    (b.capital?.raroc ?? -Infinity) - (a.capital?.raroc ?? -Infinity));
  const opportunities = ranked.slice(0, 10).map((candidate) => ({
    underlying: candidate.underlying,
    structure: candidate.structure?.kind ?? null,
    shortStrike: candidate.structure?.shortStrike ?? null,
    longStrike: candidate.structure?.longStrike ?? null,
    expiration: candidate.structure?.expiration ?? null,
    dte: candidate.dte ?? null,
    nev: candidate.evaluation?.nev ?? null,
    raroc: candidate.capital?.raroc ?? null,
    cvar: candidate.evaluation?.cvar ?? null,
    gapRisk: candidate.evaluation?.gapRisk?.value ?? null,
    liquidityRisk: candidate.evaluation?.liquidityRisk?.value ?? null,
    economicCapital: candidate.capital?.economicCapital ?? null,
    nevPerDay: Number.isFinite(candidate.evaluation?.nev) && Number.isFinite(candidate.dte) && candidate.dte > 0
      ? candidate.evaluation.nev / candidate.dte : null,
    pMarket: candidate.probabilities?.pMarket ?? null,
    pModel: candidate.probabilities?.pModel ?? null,
    pCal: candidate.probabilities?.calibration === 'UNCALIBRATED'
      ? null : candidate.probabilities?.pCal ?? null,
    pCalStatus: candidate.probabilities?.calibration === 'UNCALIBRATED' ? 'UNCALIBRATED' : 'ACTIVE',
    admissible: Boolean(candidate.admissible),
    rejection: candidate.admissible ? null : candidate.violations?.map(String)?.[0] ?? null,
  }));
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
    authority: '1_SHADOW',
    mutationEligible: false,
    regime: result.regime ?? result.marketState?.regime?.regime ?? null,
    regimeConfidence: result.marketState?.regime?.coverage ?? null,
    trace: result.trace ?? [],
    opportunities,
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
    modelVersion: 'nuvo-model-5.0.0',
    codeVersion: env.CF_VERSION_METADATA?.id ?? 'nuvo-vsim-v5-shadow',
    limits: DEFAULT_LIMITS,
    authorityLevel: AUTHORITY.SHADOW,
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
    reasonCode: reason, reason: detail.message ?? reason, authority: '1_SHADOW',
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
        authority: '1_SHADOW', mutationEligible: false,
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
      }));
      finalStatus = 'QUARANTINED';
      return summary;
    }
    const baseline = await loadBaseline(env, ownerId);
    if (!baseline) {
      finalStatus = 'BLOCKED';
      return await recordBlocked(env, ownerId, cycleId, 'CUSTODY_BASELINE_REQUIRED');
    }
    if (baseline.openOrders.length) {
      finalStatus = 'BLOCKED';
      return await recordBlocked(env, ownerId, cycleId, 'CUSTODY_OPEN_ORDER_RISK_MAPPING_REQUIRED', {
        openOrderCount: baseline.openOrders.length,
      });
    }

    const schwabClient = new SchwabD1Client(env);
    const currentSnapshot = await schwabClient.snapshot(ownerId);
    const broker = new SchwabReadOnlyBroker({ client: schwabClient, ownerId });
    broker.snapshotPromise = Promise.resolve(currentSnapshot);
    const dteTargets = String(env.NUVO_DTE_TARGETS ?? '14,30,45').split(',').map(Number).filter(Number.isFinite);
    const provider = marketProvider(env);
    const custodyRisk = await mapCustodyRisk({ provider, positions: currentSnapshot.positions });
    if (!custodyRisk.ok) {
      finalStatus = 'BLOCKED';
      return await recordBlocked(env, ownerId, cycleId, 'CUSTODY_RISK_MAPPING_REQUIRED', {
        reasons: custodyRisk.reasons,
      });
    }
    const persistence = new D1R2EvidencePersistence({ db: env.DB, bucket: env.EVIDENCE, ownerId });
    const evidenceStore = await EvidenceStore.open({ persistence, genesis: `NUVO-VSIM-V5-SHADOW:${ownerId}` });
    const symbols = String(env.NUVO_SYMBOLS ?? 'SPY,QQQ,IWM').split(',').map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
    const engine = new NuvoEngine({
      provider, broker, nav: currentSnapshot.nav, authorityLevel: AUTHORITY.SHADOW,
      symbols, approved: symbols, evidenceStore,
      accountMirror: { cash: baseline.account.cash, buyingPower: baseline.account.buyingPower },
      codeVersion: env.CF_VERSION_METADATA?.id ?? 'nuvo-vsim-v5-shadow',
      modelVersion: 'nuvo-model-5.0.0',
    });
    engine.positions = custodyRisk.positions.map((position) => structuredClone(position));
    for (const position of baseline.positions) engine.legPositions.set(position.symbol, structuredClone(position));
    for (const order of baseline.openOrders) {
      const id = order.brokerOrderId ?? order.clientOrderId;
      engine.orders.orders.set(id, { ...structuredClone(order), clientOrderId: id, brokerOrderId: id, state: ORDER_STATE.WORKING });
    }
    const strategy = engine.registry.get('VSIM-001');
    if (strategy?.state === 'RESEARCH') strategy.transition('VALIDATED', 'Architecture and correctness suite passed').transition('SHADOW', 'Real-market shadow observation');
    const result = await engine.cycle({
      cycleId,
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

async function apiStatus(env, ownerId) {
  const client = new SchwabD1Client(env);
  const [connection, baseline, custody, latest, evidenceCount, marketCheck, controls] = await Promise.all([
    client.status(ownerId),
    loadBaseline(env, ownerId),
    loadLatestCustody(env, ownerId),
    env.DB.prepare(`SELECT summary_json FROM cycle_summaries WHERE owner_id=? ORDER BY created_at DESC LIMIT 1`).bind(ownerId).first(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM evidence_index WHERE owner_id=?').bind(ownerId).first(),
    env.DB.prepare(`SELECT detail_json FROM operational_audit WHERE owner_id=?
      AND event_type='MASSIVE_LIVE_CHAIN_CHECK' ORDER BY created_at DESC LIMIT 1`).bind(ownerId).first(),
    loadOperatorControls(env, ownerId),
  ]);
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
      status: 'CAPTURED', hash: baseline.hash, observedAt: baseline.observedAt,
      positionCount: baseline.positions.length, openOrderCount: baseline.openOrders.length,
    } : { status: 'REQUIRED' },
    evidence: { records: Number(evidenceCount?.count ?? 0), storage: 'D1_INDEX_R2_IMMUTABLE_OBJECT' },
    marketCheck: marketCheck ? parseJson(marketCheck.detail_json, null) : null,
    controls,
    latestCycle: latest ? parseJson(latest.summary_json, null) : null,
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
  try { snapshot = await client.snapshot(ownerId); }
  catch (error) {
    return toolEnvelope(env, {
      nav: null, cash: null, margin_used: null, positions: [], open_orders: [],
      recon: { baseline: 'MISSING', positions_n: 0, open_orders_n: 0, mismatches: [] },
      schwab: 'DISCONNECTED',
    }, { code: 'SCHWAB_READ_FAILED', message: error.message });
  }
  const baseline = await loadBaseline(env, ownerId);
  const recon = accountReconciliation(baseline, snapshot);
  const positions = snapshot.positions.map((position) => ({
    symbol: position.symbol,
    qty: position.quantity,
    mark: Number.isFinite(position.marketValue) && Number.isFinite(position.quantity)
      && position.quantity !== 0
      ? position.marketValue / (position.quantity * (position.multiplier || 1))
      : null,
    mv: position.marketValue,
    asset_class: position.type,
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
    margin_used: Math.max(0, -snapshot.cash),
    positions,
    open_orders: openOrders,
    recon: {
      baseline: recon.status,
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
      quote_age_seconds: null, freshness_limit_seconds: 60,
    }, { code: 'MASSIVE_BLOCKED', message: error.message });
  }
  const latest = await cycleSummary(env, ownerId);
  const timestamps = check.symbols.flatMap((row) => [row.quoteAsOf, row.chainAsOf])
    .map(epochMs).filter(Number.isFinite);
  const oldest = timestamps.length ? Math.min(...timestamps) : null;
  const quoteAge = oldest === null ? null : Math.max(0, (Date.now() - oldest) / 1000);
  const session = normalizeSession(check.marketState?.status);
  const latestAge = Number.isFinite(Number(latest?.at))
    ? Math.max(0, (Date.now() - Number(latest.at)) / 1000) : Infinity;
  const payload = {
    session,
    regime: latestAge <= 60 ? latest?.regime ?? null : null,
    regime_confidence: latestAge <= 60 ? latest?.regimeConfidence ?? null : null,
    vix: check.marketState?.vix ?? null,
    massive: check.ok ? 'LIVE' : 'BLOCKED',
    live_contracts: check.symbols.reduce((sum, row) => sum + row.contractCount, 0),
    underlyings_checked: check.symbols.length,
    quote_age_seconds: quoteAge,
    freshness_limit_seconds: 60,
    asof: check.checkedAt,
  };
  if (!check.ok) return toolEnvelope(env, payload, { code: 'MASSIVE_BLOCKED', message: 'Massive live market verification failed.' });
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

export async function triggerShadowCycle(env, ownerId, { source = 'MCP' } = {}) {
  if (authorityLevel(env) < AUTHORITY.SHADOW) {
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
  const provider = marketProvider(env);
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

  const cycleId = cycleIdFor({ ownerId, source: 'SCHEDULED' });
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

export function createMcpService(env, ownerId) {
  return Object.freeze({
    getAccountTruth: () => getAccountTruthTool(env, ownerId),
    getMarketState: () => getMarketStateTool(env, ownerId),
    runShadowCycle: () => triggerShadowCycle(env, ownerId, { source: 'MCP' }),
    getCycle: (cycleId) => getCycleTool(env, ownerId, cycleId),
    listCycles: (limit) => listCyclesTool(env, ownerId, limit),
    listRankedOpportunities: (cycleId) => listRankedOpportunitiesTool(env, ownerId, cycleId),
    explainCandidate: (input) => explainCandidateTool(env, ownerId, input),
    explainRejection: (cycleId) => explainRejectionTool(env, ownerId, cycleId),
    replayEvidence: (input) => replayEvidenceTool(env, ownerId, input),
    listEvidence: (limit) => listEvidenceTool(env, ownerId, limit),
    authorityDenied: (tool, required, cycleId) => toolEnvelope(env, { cycle_id: cycleId }, {
      code: 'AUTHORITY_DENIED',
      message: `${tool} requires authority level ${required}; current level is ${authorityLevel(env)}.`,
    }),
  });
}

export async function executeShadowWorkflow(env, { ownerId, cycleId, source }, step) {
  const coordinator = accountCoordinator(env, ownerId);
  try {
    const result = await step.do('run deterministic VSIM shadow cycle', async () =>
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

function dashboardHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>NUVO VSIM v5 — Shadow</title><style>
  :root{color-scheme:dark;--bg:#07100e;--p:#0d1a16;--l:#22382f;--t:#e8f1ec;--m:#8ca096;--g:#60e2a8;--a:#f4ba61;--r:#f27676;font:14px Inter,system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,#123328,#07100e 38%);color:var(--t)}header,main{max-width:1200px;margin:auto}header{padding:26px 24px 18px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--l)}h1{margin:0;letter-spacing:.06em}h1 b{color:var(--g);font-size:.55em}.pill{padding:7px 10px;border:1px solid #725d34;color:var(--a);border-radius:99px;font-size:11px}main{padding:22px 24px 60px}.warning{border:1px solid #725d34;background:#2b2314;padding:12px 15px;border-radius:8px;color:#f4d6a5}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:16px}.card{background:linear-gradient(145deg,#10201b,#0a1512);border:1px solid var(--l);border-radius:10px;padding:18px}.card h2{font-size:12px;text-transform:uppercase;letter-spacing:.13em;color:var(--m);margin:0 0 13px}.value{font-size:22px;font-weight:750}.sub{color:var(--m);font-size:11px;margin-top:7px}.wide{grid-column:1/-1}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.metric{padding:12px;background:#08130f;border:1px solid var(--l);border-radius:7px}.metric span{display:block;color:var(--m);font-size:10px;text-transform:uppercase;letter-spacing:.1em}.metric b{display:block;font-size:19px;margin-top:5px}button,a.action{border:1px solid #315445;background:#10271f;color:var(--g);padding:9px 12px;border-radius:6px;cursor:pointer;text-decoration:none;font-weight:650;margin:5px 7px 0 0}button:disabled{opacity:.45;cursor:not-allowed}pre{white-space:pre-wrap;color:#c8d8cf;background:#07100e;padding:14px;border-radius:7px;max-height:320px;overflow:auto}table{width:100%;border-collapse:collapse;margin-top:10px}th,td{text-align:left;border-bottom:1px solid var(--l);padding:9px 7px;font-variant-numeric:tabular-nums}th{color:var(--m);font-size:10px;text-transform:uppercase;letter-spacing:.08em}.empty{color:var(--m);padding:12px 0}.ok{color:var(--g)}.bad{color:var(--r)}@media(max-width:760px){.grid,.metrics{grid-template-columns:1fr}.wide{grid-column:auto}.card{overflow-x:auto}}</style></head><body>
  <header><h1>NUVO VSIM <b>v5</b></h1><span class="pill">AUTHORITY 1 · SHADOW ONLY</span></header><main><div class="warning">This is the isolated v5 shadow system. It cannot submit, replace, or cancel a broker order. The existing vsim.nuvotrade.co deployment is untouched.</div><section class="grid">
  <article class="card"><h2>Massive / Polygon</h2><div class="value" id="market">Not checked</div><div class="sub" id="marketTime">Private service binding · strict live chains</div></article>
  <article class="card"><h2>Schwab custody</h2><div class="value" id="schwab">Checking…</div><div class="sub" id="schwabTime">Read-only account, positions, and orders</div></article>
  <article class="card"><h2>Evidence</h2><div class="value" id="evidence">Checking…</div><div class="sub">D1 ordered index + R2 immutable packages</div></article>
  <article class="card wide"><h2>Live account snapshot</h2><div class="metrics"><div class="metric"><span>Account value</span><b id="nav">—</b></div><div class="metric"><span>Net cash / margin</span><b id="cash">—</b></div><div class="metric"><span>Buying power</span><b id="buyingPower">—</b></div></div><div class="sub" id="custodyTime">Refresh required</div></article>
  <article class="card wide"><h2>Open positions</h2><div id="positions" class="empty">No synchronized positions</div></article>
  <article class="card wide"><h2>Operator controls</h2><a class="action" href="/api/integrations/schwab/connect">Connect Schwab read-only</a><button id="custodyRefresh">Refresh account</button><button id="marketCheck">Verify Massive live chains</button><button id="baseline">Capture reconciliation baseline</button><button id="cycle">Run opportunity scan</button><a class="action" href="https://nuvo-vsim-v5-preview.pages.dev/" target="_blank" rel="noreferrer">Open full design preview</a><div class="sub">The scan may rank opportunities, but this runtime has no broker mutation routes.</div></article>
  <article class="card wide"><h2>Opportunities</h2><div id="opportunities" class="empty">Run a verified shadow scan to populate ranked opportunities.</div></article>
  <article class="card wide"><h2>Latest cycle</h2><div class="value" id="outcome">No cycle yet</div><div class="sub" id="reason"></div><pre id="details">Loading protected status…</pre></article>
  </section></main><script>
  const el=id=>document.getElementById(id);const present=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value));const money=value=>present(value)?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(value)):'—';const num=value=>present(value)?Number(value).toLocaleString('en-US',{maximumFractionDigits:2}):'—';
  async function call(path,options){const r=await fetch(path,options);const j=await r.json();if(!r.ok)throw new Error(j.error||j.reason||('HTTP '+r.status));return j}
  function table(id,headers,rows){const root=el(id);root.replaceChildren();if(!rows.length){root.className='empty';root.textContent='None';return}root.className='';const t=document.createElement('table'),head=document.createElement('thead'),hr=document.createElement('tr');for(const h of headers){const th=document.createElement('th');th.textContent=h.label;hr.append(th)}head.append(hr);t.append(head);const body=document.createElement('tbody');for(const row of rows){const tr=document.createElement('tr');for(const h of headers){const td=document.createElement('td');td.textContent=h.format?h.format(row[h.key],row):String(row[h.key]??'—');tr.append(td)}body.append(tr)}t.append(body);root.append(t)}
  async function refresh(){try{const s=await call('/api/status');const mc=s.marketCheck;el('market').textContent=mc?(mc.ok?'VERIFIED LIVE':'BLOCKED'):'NOT CHECKED';el('market').className='value '+(mc?.ok?'ok':mc?'bad':'');el('marketTime').textContent=mc?.checkedAt||'Private service binding · strict live chains';el('schwab').textContent=s.schwab.status;el('schwab').className='value '+(s.schwab.status==='CONNECTED'?'ok':'bad');el('schwabTime').textContent=s.schwab.lastSuccessfulSyncAt||'Read-only connection required';el('evidence').textContent=s.evidence.records+' records';const c=s.custody;el('nav').textContent=money(c.account?.nav);el('cash').textContent=money(c.account?.cash);el('buyingPower').textContent=money(c.account?.buyingPower);el('custodyTime').textContent=c.observedAt?('Schwab as of '+c.observedAt+' · '+c.openOrders.length+' open orders'):'Refresh required';table('positions',[{key:'symbol',label:'Symbol'},{key:'type',label:'Type'},{key:'quantity',label:'Quantity',format:num},{key:'marketValue',label:'Market value',format:money}],c.positions||[]);const cycle=s.latestCycle;table('opportunities',[{key:'underlying',label:'Symbol'},{key:'structure',label:'Structure'},{key:'shortStrike',label:'Short strike',format:num},{key:'longStrike',label:'Long strike',format:num},{key:'expiration',label:'Expiration'},{key:'nev',label:'NEV',format:money},{key:'raroc',label:'RAROC',format:v=>present(v)?(Number(v)*100).toFixed(2)+'%':'—'},{key:'admissible',label:'Status',format:v=>v?'ELIGIBLE':'DECLINED'}],cycle?.opportunities||[]);el('outcome').textContent=cycle?.outcome||'No cycle yet';el('reason').textContent=cycle?.reason||'';el('details').textContent=JSON.stringify({baseline:s.baseline,marketCheck:s.marketCheck,latestCycle:cycle},null,2)}catch(e){el('details').textContent=e.message}}
  async function action(button,message,fn){button.disabled=true;el('details').textContent=message;try{await fn();await refresh()}catch(e){el('details').textContent=e.message}finally{button.disabled=false}}
  el('custodyRefresh').onclick=()=>action(el('custodyRefresh'),'Refreshing Schwab read-only snapshot…',()=>call('/api/operator/custody/refresh',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirm:'REFRESH_READ_ONLY_CUSTODY'})}));
  el('marketCheck').onclick=()=>action(el('marketCheck'),'Verifying Massive quotes, events, and live option chains…',()=>call('/api/operator/market/check',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}));
  el('baseline').onclick=async()=>{if(!confirm('Capture the current read-only Schwab state as the reconciliation baseline?'))return;await action(el('baseline'),'Capturing reconciliation baseline…',()=>call('/api/operator/baseline',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirm:'CAPTURE_READ_ONLY_BASELINE'})}))};
  el('cycle').onclick=()=>action(el('cycle'),'Running deterministic live-chain opportunity scan…',()=>call('/api/cycle',{method:'POST',headers:{'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:'{}'}));refresh();
  </script></body></html>`;
}

// Pin the reviewed visual assets to the immutable Pages deployment. The public
// preview alias is retired because its example values could be mistaken for
// live market and account data.
const DESIGN_ORIGIN = 'https://c8c17621.nuvo-vsim-v5-preview.pages.dev';
const DASHBOARD_HEADERS = Object.freeze({
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'private, no-store',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
});

export function rewriteDesignHtml(source) {
  return source
    .replace('<title>NUVO VSIM v5 — Shadow Preview</title>', '<title>NUVO VSIM v5 — Live Shadow</title>')
    .replace('href="styles.css"', 'href="/design/styles.css"')
    .replace('src="app.js"', 'src="/design/app.js"')
    .replace('</head>', '<style>body{visibility:hidden}body.live-ready{visibility:visible}</style></head>')
    .replace('</body>', '<script src="/design/live.js"></script></body>');
}

async function designAsset(path) {
  const upstream = await fetch(`${DESIGN_ORIGIN}/${path}`, { signal: AbortSignal.timeout(5_000) });
  if (!upstream.ok) throw new Error('DESIGN_ASSET_UNAVAILABLE');
  const type = path.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
  let source = await upstream.text();
  if (path.endsWith('.js')) source = source.replace(' · preview`', ' · live shadow`');
  return new Response(source, { headers: {
    'content-type': type,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  } });
}

async function fullDashboard() {
  const upstream = await fetch(`${DESIGN_ORIGIN}/`, { signal: AbortSignal.timeout(5_000) });
  if (!upstream.ok) throw new Error('DESIGN_UNAVAILABLE');
  return new Response(rewriteDesignHtml(await upstream.text()), { headers: DASHBOARD_HEADERS });
}

export function liveDashboardScript() {
  return `(() => {
  'use strict';
  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const present = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  const money = value => present(value) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(value)) : '—';
  const number = value => present(value) ? Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—';
  const percent = value => present(value) ? (Number(value) * 100).toFixed(1) + '%' : '—';
  const when = value => value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : 'Not available';
  const text = (node, value) => { if (node) node.textContent = value; };
  const clear = node => { if (node) node.replaceChildren(); };
  const make = (tag, value, className) => { const node = document.createElement(tag); if (value !== undefined) node.textContent = value; if (className) node.className = className; return node; };
  const api = async (path, options) => { const response = await fetch(path, options); const body = await response.json(); if (!response.ok) throw new Error(body.error || body.reason || ('HTTP ' + response.status)); return body; };
  const connectorOk = status => status === 'CONNECTED' || status === 'LIVE_READ_ONLY';
  const structure = value => ({ CSP: 'Cash-secured put', BULL_PUT_SPREAD: 'Bull put spread', CASH_SECURED_PUT: 'Cash-secured put' }[value] || value || '—');

  function scrubPreviewLanguage() {
    text(q('.header-status strong'), 'Protected shadow');
    text(q('.header-status small'), 'Loading verified data…');
    text(q('.safety-title'), '◇  LIVE SHADOW');
    text(q('.safety-banner p'), 'Loading protected account, market, and evidence state. Broker mutation remains disabled.');
    text(q('footer span:first-child'), 'NUVO VSIM v5 · Protected live shadow');
    text(q('footer span:nth-child(2)'), 'Schwab read-only · Massive live market data · no broker mutation');
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

  function renderOverview(status) {
    const custody = status.custody || {};
    const account = custody.account || {};
    const positions = custody.positions || [];
    const baseline = status.baseline || {};
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
    if (cards[3]) { text(q('.metric-label', cards[3]), 'Reconciliation baseline'); text(q('.metric-value', cards[3]), baseline.status || 'REQUIRED'); text(q('.metric-foot', cards[3]), baseline.status === 'CAPTURED' ? (baseline.positionCount + ' positions · ' + baseline.openOrderCount + ' open orders') : 'Required before a cycle may proceed'); }
    text(q('#overview .snapshot strong'), when(custody.observedAt));

    const environment = q('#overview .environment-panel');
    if (environment) {
      const session = market && market.marketState ? (market.marketState.status || market.marketState.error || 'UNKNOWN') : 'NOT CHECKED';
      const confidence = present(cycle.regimeConfidence) ? Math.round(Number(cycle.regimeConfidence) * 100) : null;
      text(q('.regime', environment), cycle.regime || session);
      text(q('.score-ring span', environment), confidence === null ? '—' : String(confidence));
      text(q('.score-ring small', environment), confidence === null ? '' : '/ 100');
      text(q('.regime-score strong', environment), cycle.regime ? 'Live model classification' : 'Awaiting an admissible live cycle');
      text(q('.regime-score p', environment), market ? (market.ok ? 'Massive quotes and option chains passed freshness checks.' : 'Market data is fail-closed: ' + (market.marketState && (market.marketState.error || market.marketState.status) || 'freshness check failed') + '.') : 'Run the live market verification before opportunity analysis.');
      const signals = qa('.signal-grid > div', environment);
      const contractCount = market && market.symbols ? market.symbols.reduce((sum, row) => sum + Number(row.contractCount || 0), 0) : 0;
      const values = [
        ['Market session', session, market && market.marketState && market.marketState.asOf ? when(market.marketState.asOf) : 'Not checked'],
        ['Massive', market ? (market.ok ? 'VERIFIED' : 'BLOCKED') : 'NOT CHECKED', market ? when(market.checkedAt) : 'Strict freshness'],
        ['Live contracts', market ? number(contractCount) : '—', market && market.symbols ? market.symbols.length + ' underlyings checked' : 'Not checked'],
        ['Schwab', status.schwab && status.schwab.status || 'UNKNOWN', when(status.schwab && status.schwab.lastSuccessfulSyncAt)],
      ];
      signals.forEach((node, index) => { const value = values[index]; if (!value) return; text(q('span', node), value[0]); text(q('strong', node), value[1]); text(q('small', node), value[2]); });
      text(q('.confidence span', environment), 'Regime confidence'); text(q('.confidence strong', environment), confidence === null ? 'Not available' : confidence + '%');
      const fill = q('.confidence .bar i', environment); if (fill) fill.style.width = (confidence || 0) + '%';
    }

    const decision = q('#overview .decision-panel');
    if (decision) {
      const outcome = cycle.outcome || 'NO CYCLE';
      text(q('h3', decision), outcome === 'REFUSED' ? 'Proposal withheld' : outcome);
      text(q('.decision-badge', decision), outcome);
      text(q('.decision-copy strong', decision), cycle.reason || 'No completed live decision yet');
      text(q('.decision-copy p', decision), cycle.cycleId ? ('Cycle ' + cycle.cycleId + ' · Authority 1 cannot allocate capital.') : 'Run a verified live shadow scan after reconciliation and market freshness pass.');
      const trace = q('.trace-mini', decision); clear(trace);
      const steps = cycle.trace && cycle.trace.length ? cycle.trace.slice(-4) : ['Custody synchronized', 'Reconciliation baseline checked', 'Live market freshness checked', 'Risk governor retained'];
      steps.forEach((step, index) => { const li = make('li', undefined, index === steps.length - 1 && outcome === 'REFUSED' ? 'stop' : 'pass'); li.append(make('span', typeof step === 'string' ? step : (step.layer || step.stage || 'Verified gate')), make('small', index === steps.length - 1 ? (cycle.reason || 'Shadow only') : 'Recorded')); trace.append(li); });
    }

    const opportunities = cycle.opportunities || [];
    const topBody = q('#overview .table-panel tbody');
    renderRows(topBody, opportunities.slice(0, 10), [
      (_item, index) => String(index + 1).padStart(2, '0'),
      item => item.underlying || '—', item => structure(item.structure),
      item => [item.shortStrike, item.longStrike].filter(present).join(' / ') || '—',
      item => number(item.dte), item => money(item.nev), item => percent(item.raroc),
      item => money(item.economicCapital), item => item.admissible ? 'ELIGIBLE' : (item.rejection || 'DECLINED'),
    ]);
    text(q('#overview .panel-note'), 'Live ranked shadow candidates. Values are generated from current Massive option chains; no order can be submitted.');

    const positionPanel = q('#overview .positions-empty');
    if (positionPanel) {
      clear(positionPanel);
      const head = make('div', undefined, 'panel-head'); const title = make('div'); title.append(make('p', 'Layer 8 · Live custody', 'kicker'), make('h3', 'Open positions')); head.append(title, make('span', positions.length + ' open', 'count')); positionPanel.append(head);
      if (!positions.length) positionPanel.append(make('div', 'No synchronized positions.', 'empty-state'));
      else { const wrap = make('div', undefined, 'table-wrap'); const table = make('table'); const thead = make('thead'); const hr = make('tr'); ['Symbol','Type','Quantity','Market value'].forEach(label => hr.append(make('th', label))); thead.append(hr); const body = make('tbody'); positions.forEach(position => { const row = make('tr'); [position.symbol || '—', position.type || '—', number(position.quantity), money(position.marketValue)].forEach(value => row.append(make('td', value))); body.append(row); }); table.append(thead, body); wrap.append(table); positionPanel.append(wrap); }
    }

    const health = q('#overview .health-list');
    if (health) {
      clear(health);
      const entries = [
        ['Evidence chain', status.evidence && status.evidence.records + ' RECORDS', true],
        ['Constitution', 'AUTHORITY 1', true],
        ['Market adapter', market ? (market.ok ? 'LIVE' : 'BLOCKED') : 'NOT CHECKED', Boolean(market && market.ok)],
        ['Broker adapter', status.schwab && status.schwab.status || 'UNKNOWN', connectorOk(status.schwab && status.schwab.status)],
        ['Order mutation', 'DISABLED', true],
      ];
      entries.forEach(entry => { const li = make('li'); const label = make('span'); label.append(make('i', undefined, 'health ' + (entry[2] ? 'green' : 'amber')), document.createTextNode(entry[0])); li.append(label, make('strong', entry[1])); health.append(li); });
      text(q('#overview .system-brief .status-badge'), 'LIVE SHADOW');
      text(q('#overview .readiness'), '1 / 5');
      const scoreNotes = qa('#overview .scorecard .score-rows small');
      ['Collecting shadow outcomes','Uncalibrated · non-blocking','Mutation intentionally disabled','Clean','Collecting survival evidence'].forEach((value, index) => text(scoreNotes[index], value));
    }
  }

  function renderOpportunities(status) {
    const cycle = status.latestCycle || {};
    const rows = cycle.opportunities || [];
    const chips = qa('#opportunities .chip');
    if (chips[0]) text(chips[0], 'Current candidates ' + rows.length);
    if (chips[1]) text(chips[1], 'Eligible ' + rows.filter(row => row.admissible).length);
    if (chips[2]) text(chips[2], 'Declined ' + rows.filter(row => !row.admissible).length);
    if (chips[3]) text(chips[3], cycle.outcome || 'NO CYCLE');
    text(q('#opportunities .as-of'), cycle.at ? ('As of ' + when(cycle.at)) : 'No completed cycle');
    renderRows(q('#opportunities .detailed tbody'), rows, [
      (_item, index) => String(index + 1).padStart(2, '0'), item => item.underlying || '—',
      item => structure(item.structure), () => '—', () => '—', () => '—',
      item => money(item.cvar), () => '—', item => money(item.nev), item => percent(item.raroc),
      item => item.admissible ? 'ELIGIBLE' : (item.rejection || 'DECLINED'),
    ]);
    const detail = q('#opportunities .candidate-detail');
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
    text(q('#evidence .chain-valid strong'), records.length ? 'VALID' : 'EMPTY');
    const layout = q('#evidence .evidence-layout'); clear(layout);
    const list = make('article', undefined, 'panel evidence-list');
    const head = make('div', undefined, 'panel-head'); const title = make('div'); title.append(make('p', 'Append-only D1 index · immutable R2 packages', 'kicker'), make('h3', records.length + ' sealed evidence record' + (records.length === 1 ? '' : 's'))); head.append(title, make('span', 'SHA-256 chained', 'hash')); list.append(head);
    const tableWrap = make('div', undefined, 'table-wrap'); const table = make('table'); const thead = make('thead'); const hr = make('tr'); ['Sequence','Cycle','Decision','Authority','Fingerprint','Created'].forEach(label => hr.append(make('th', label))); thead.append(hr); const body = make('tbody');
    records.forEach(record => { const row = make('tr'); [record.sequence, record.cycle_id, record.decision, record.authority_level, (record.decision_fingerprint || '').slice(0, 16) + '…', when(record.created_at)].forEach(value => row.append(make('td', String(value ?? '—')))); body.append(row); });
    if (!records.length) { const row = make('tr'); const cell = make('td', 'No evidence records have been sealed.'); cell.colSpan = 6; row.append(cell); body.append(row); }
    table.append(thead, body); tableWrap.append(table); list.append(tableWrap); layout.append(list);
    const side = make('aside', undefined, 'evidence-side'); const facts = make('article', undefined, 'panel'); facts.append(make('p', 'Protected evidence storage', 'kicker'), make('h3', status.evidence.storage)); const dl = make('dl', undefined, 'package-facts'); [['Index','Cloudflare D1'],['Raw packages','Protected R2'],['Records',String(records.length)],['Mutation request','None'],['Authority','1 · Shadow']].forEach(pair => { const div = make('div'); div.append(make('dt', pair[0]), make('dd', pair[1])); dl.append(div); }); facts.append(dl); side.append(facts); layout.append(side);
    text(q('#evidence .preview-disclaimer'), 'Live protected evidence metadata. Raw evidence packages remain private and are not exposed to the browser.');
  }

  function renderSystem(status) {
    text(q('#system .readiness-banner strong'), 'Operational live shadow system');
    text(q('#system .readiness-banner p'), 'Schwab custody is read-only, Massive market data is fail-closed, and D1/R2 evidence is active. Live-order mutation remains constitutionally and technically unavailable.');
    text(q('#system .readiness-number'), 'SHADOW');
    const connectors = qa('#system .connector');
    const market = status.marketCheck;
    const states = [
      { status: market ? (market.ok ? 'Verified live' : 'Blocked safely') : 'Not checked', note: market ? ('Last check ' + when(market.checkedAt)) : 'Run the live chain verification.', values: ['Private service binding','Options chains + Greeks','Strict freshness gate','Session + event data'] },
      { status: status.schwab && status.schwab.status || 'Unknown', note: 'Custody reads only. No order mutation route exists.', values: ['Account + cash live','Positions + orders live','Baseline reconciliation','Order mutation locked'] },
      { status: status.evidence.records + ' records', note: 'Ordered D1 index with protected immutable R2 packages.', values: ['Decision metadata in D1','Raw packages in R2','Append-only hash chain','Raw packages not browser-exposed'] },
      { status: status.schedule || 'Every 15 minutes', note: 'Single-flight cycles use distributed D1 leases and deterministic IDs.', values: ['Market-session gate','Distributed idempotency','Single-flight lease','Fail-closed refusal evidence'] },
    ];
    connectors.forEach((card, index) => { const state = states[index]; if (!state) return; text(q('.connector-status', card), state.status); text(q('.connector-note', card), state.note); qa('li b', card).forEach((node, valueIndex) => text(node, state.values[valueIndex] || 'Active')); });
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
      [['refresh','Refresh status'],['cycle','Run shadow cycle'],['replay','Replay latest evidence'],
        ['pause','Global pause'],['resume','Resume cycles'],['kill','Trip kill switch'],['clearKill','Clear kill switch']]
        .forEach(pair => { const button = make('button', pair[1], 'chip'); button.dataset.action = pair[0]; actions.append(button); });
      const reason = make('input', undefined, 'control-reason');
      reason.type = 'text'; reason.maxLength = 240; reason.placeholder = 'Required reason for pause / resume / kill / clear';
      controls.append(actions, reason, make('p', 'Normal mission-control actions are limited to running a shadow cycle or replaying sealed evidence. Global pause and the independent kill switch are separate safety controls. None can submit, replace, or cancel an order.', 'connector-note'), make('pre', 'Ready.', 'operator-output'));
      ladderPanel.parentNode.insertBefore(controls, ladderPanel);
    }
    const safety = status.controls || {};
    text(q('.control-status', controls), 'GLOBAL PAUSE: ' + (safety.globalPause ? 'ACTIVE' : 'CLEAR')
      + ' · INDEPENDENT KILL: ' + (safety.independentKill ? 'TRIPPED' : 'CLEAR')
      + (safety.updatedAt ? ' · ' + when(safety.updatedAt) : ''));
  }

  let currentStatus = null;
  async function refresh() {
    currentStatus = await api('/api/status');
    renderOverview(currentStatus); renderOpportunities(currentStatus); renderSystem(currentStatus); await renderEvidence(currentStatus);
    text(q('.header-status strong'), 'Shadow connected'); text(q('.header-status small'), 'Updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }));
    text(q('.safety-title'), '◇  LIVE PROTECTED SHADOW');
    text(q('.safety-banner p'), 'Live Schwab custody, Massive market data, and D1/R2 evidence are connected. Broker order mutation is disabled.');
    text(q('footer span:nth-child(3)'), 'Worker ' + String(currentStatus.version || '').slice(0, 12));
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
      cycle: () => api('/api/cycle', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: '{}' }),
      replay: () => api('/api/operator/replay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cycle_id: currentStatus && currentStatus.latestCycle && currentStatus.latestCycle.cycleId }) }),
      pause: () => control('PAUSE', 'PAUSE_SHADOW_CYCLES'),
      resume: () => control('RESUME', 'RESUME_SHADOW_CYCLES'),
      kill: () => control('KILL', 'TRIP_INDEPENDENT_KILL_SWITCH'),
      clearKill: () => control('CLEAR_KILL', 'CLEAR_INDEPENDENT_KILL_SWITCH'),
    };
    const confirmations = {
      cycle: 'Run a live-data shadow opportunity simulation? It cannot place an order.',
      pause: 'Pause all shadow cycles?', resume: 'Resume shadow cycles?',
      kill: 'Trip the independent kill switch and block every new cycle?',
      clearKill: 'Clear the independent kill switch after verifying its cause is gone?',
    };
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

  document.addEventListener('click', event => { const button = event.target.closest('[data-action]'); if (button) operate(button.dataset.action, button); });
  scrubPreviewLanguage();
  refresh().catch(error => {
    text(q('.header-status strong'), 'Live data unavailable');
    text(q('.safety-title'), '◇  FAIL-CLOSED');
    text(q('.safety-banner p'), 'The protected live state could not be loaded: ' + error.message + '. No synthetic account or opportunity values are displayed.');
    qa('.metric-value').forEach(node => text(node, 'UNAVAILABLE'));
    qa('tbody').forEach(clear);
  }).finally(() => document.body.classList.add('live-ready'));
})();`;
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === '/health') return json(publicStatus(env));
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
    if (url.pathname === '/design/live.js') return new Response(liveDashboardScript(), { headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    } });
    if (url.pathname !== '/') return json({ error: 'NOT_FOUND' }, 404);
    try { return await fullDashboard(); }
    catch (error) {
      console.error('Full dashboard unavailable; serving protected fail-safe console', error);
      return new Response(dashboardHtml(), { headers: {
        ...DASHBOARD_HEADERS,
        'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      } });
    }
  }
  if (!url.pathname.startsWith('/api/')) return json({ error: 'NOT_FOUND' }, 404);

  let owner;
  try { owner = await authenticateAccess(request, env); }
  catch (error) { return json({ error: error.message }, 401); }

  const client = new SchwabD1Client(env);
  if (url.pathname === '/api/status' && request.method === 'GET') return json(await apiStatus(env, owner.id));
  if (url.pathname === '/api/integrations/schwab/connect' && request.method === 'GET') {
    const destination = await client.beginOAuth(owner.id);
    const safeDestination = destination.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Connect Schwab read-only</title><style>body{color-scheme:dark;background:#07100e;color:#e8f1ec;font:16px system-ui;display:grid;min-height:100vh;place-items:center;margin:0}.card{max-width:620px;background:#0d1a16;border:1px solid #22382f;border-radius:12px;padding:28px}h1{margin-top:0}p{color:#a9bbb2;line-height:1.55}.warn{color:#f4ba61}a{display:inline-block;margin-top:12px;border:1px solid #315445;background:#10271f;color:#60e2a8;padding:11px 15px;border-radius:7px;text-decoration:none;font-weight:700}</style></head><body><main class="card"><h1>Connect Schwab read-only</h1><p>This authorizes custody reads for account balances, positions, and open orders. NUVO VSIM v5 remains at Authority 1 and has no order submission, replacement, or cancellation capability.</p><p class="warn">You will review and approve the connection on Schwab.</p><a href="${safeDestination}" rel="noreferrer">Continue to Schwab</a></main></body></html>`, {
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
    const snapshot = await client.snapshot(owner.id);
    await audit(env, owner.id, 'CUSTODY_READ_ONLY_REFRESHED', {
      snapshotHash: snapshot.snapshotHash,
      positionCount: snapshot.positions.length,
      openOrderCount: snapshot.openOrders.length,
      observedAt: new Date(snapshot.asOf).toISOString(),
    });
    return json({ ok: true, observedAt: snapshot.asOf, snapshotHash: snapshot.snapshotHash });
  }
  if (url.pathname === '/api/operator/market/check' && request.method === 'POST') {
    try { requireSameOrigin(request, env); } catch (error) { return json({ error: error.message }, 403); }
    return json(await verifyLiveMarket(env, owner.id));
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

export default {
  async fetch(request, env, ctx) {
    try { return await route(request, env, ctx); }
    catch (error) {
      console.error('NUVO VSIM v5 shadow error', error);
      return json({ error: 'FAIL_CLOSED', reason: error.message }, 503);
    }
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil((async () => {
      const owners = await env.DB.prepare(`SELECT owner_id FROM broker_connections
        WHERE status IN ('CONNECTED','DEGRADED') ORDER BY updated_at ASC`).all();
      for (const owner of owners.results ?? []) {
        try { await triggerShadowCycle(env, owner.owner_id, { source: 'SCHEDULED' }); }
        catch (error) { await audit(env, owner.owner_id, 'SCHEDULED_SHADOW_FAILED', { error: error.message }); }
      }
    })());
  },
};
