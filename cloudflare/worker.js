import { NuvoEngine } from '../src/engine.js';
import { MassiveProvider } from '../src/truth/providers/massive.js';
import { SchwabReadOnlyBroker } from '../src/execution/broker/schwab_readonly.js';
import { EvidenceStore } from '../src/evidence/store.js';
import { buildEvidence } from '../src/evidence/package.js';
import { AUTHORITY } from '../src/constitution/authority.js';
import { DEFAULT_LIMITS } from '../src/constitution/limits.js';
import { contentHash, ORDER_STATE } from '../src/execution/order.js';
import { authenticateAccess } from './access-auth.js';
import { D1R2EvidencePersistence } from './evidence-persistence.js';
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

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function publicStatus(env) {
  return {
    ok: true,
    service: 'nuvo-vsim-v5-shadow',
    environment: env.NUVO_ENVIRONMENT ?? 'unknown',
    authority: '1_SHADOW',
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
    economicCapital: candidate.capital?.economicCapital ?? null,
    admissible: Boolean(candidate.admissible),
    rejection: candidate.admissible ? null : candidate.violations?.map(String)?.[0] ?? null,
  }));
  return {
    cycleId: result.cycleId,
    at: result.evidence?.at ?? Date.now(),
    outcome: result.outcome,
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
    (owner_id,cycle_id,outcome,reason,regime,summary_json,created_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(owner_id,cycle_id) DO NOTHING`).bind(
    ownerId, summary.cycleId, summary.outcome, summary.reason, summary.regime,
    JSON.stringify(summary), new Date(summary.at).toISOString(),
  ).run();
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
    cycleId, at: Date.now(), outcome: 'REFUSED', reason, authority: '1_SHADOW',
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
  } catch { return false; }
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

async function runShadowCycle(env, ownerId, { source = 'MANUAL', idempotencyKey = null } = {}) {
  const cycleId = cycleIdFor({ ownerId, source, idempotencyKey });
  if (!await acquireCycleLease(env, ownerId, cycleId)) {
    const existing = await env.DB.prepare(`SELECT summary_json FROM cycle_summaries
      WHERE owner_id=? AND cycle_id=?`).bind(ownerId, cycleId).first();
    return existing ? parseJson(existing.summary_json, { cycleId, outcome: 'REFUSED', reason: 'DUPLICATE_CYCLE' })
      : { cycleId, outcome: 'REFUSED', reason: 'CYCLE_ALREADY_RUNNING' };
  }
  let finalStatus = 'FAILED';
  try {
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
  const [connection, baseline, custody, latest, evidenceCount, marketCheck] = await Promise.all([
    client.status(ownerId),
    loadBaseline(env, ownerId),
    loadLatestCustody(env, ownerId),
    env.DB.prepare(`SELECT summary_json FROM cycle_summaries WHERE owner_id=? ORDER BY created_at DESC LIMIT 1`).bind(ownerId).first(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM evidence_index WHERE owner_id=?').bind(ownerId).first(),
    env.DB.prepare(`SELECT detail_json FROM operational_audit WHERE owner_id=?
      AND event_type='MASSIVE_LIVE_CHAIN_CHECK' ORDER BY created_at DESC LIMIT 1`).bind(ownerId).first(),
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
    latestCycle: latest ? parseJson(latest.summary_json, null) : null,
  };
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
      ['Collecting shadow outcomes','Awaiting 50 mature observations','Mutation intentionally disabled','Clean','Collecting survival evidence'].forEach((value, index) => text(scoreNotes[index], value));
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
    const ladder = qa('#system .ladder > div'); if (ladder[1]) { text(q('small', ladder[1]), 'Current live shadow'); }
    let controls = q('#system .operator-controls');
    if (!controls) {
      controls = make('article', undefined, 'panel operator-controls');
      controls.append(make('p', 'Protected operator controls', 'kicker'), make('h3', 'Live shadow operations'));
      const actions = make('div', undefined, 'filter-row');
      [['refresh','Refresh status'],['custody','Refresh Schwab'],['market','Verify Massive chains'],['baseline','Capture reconciliation baseline'],['cycle','Run opportunity scan']].forEach(pair => { const button = make('button', pair[1], 'chip'); button.dataset.action = pair[0]; actions.append(button); });
      controls.append(actions, make('p', 'These controls read custody, verify market data, capture a reconciliation baseline, or run a shadow simulation. None can submit, replace, or cancel an order.', 'connector-note'), make('pre', 'Ready.', 'operator-output'));
      const ladderPanel = q('#system .authority-ladder'); ladderPanel.parentNode.insertBefore(controls, ladderPanel);
    }
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
    const operations = {
      refresh: () => Promise.resolve(),
      custody: () => api('/api/operator/custody/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'REFRESH_READ_ONLY_CUSTODY' }) }),
      market: () => api('/api/operator/market/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      baseline: () => api('/api/operator/baseline', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'CAPTURE_READ_ONLY_BASELINE' }) }),
      cycle: () => api('/api/cycle', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: '{}' }),
    };
    const confirmations = { custody: 'Refresh the read-only Schwab custody snapshot?', baseline: 'Capture the current Schwab state as the reconciliation baseline?', cycle: 'Run a live-data shadow opportunity simulation? It cannot place an order.' };
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

async function route(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/health') return json(publicStatus(env));
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
  if (url.pathname === '/api/cycle' && request.method === 'POST') {
    try { requireSameOrigin(request, env); } catch (error) { return json({ error: error.message }, 403); }
    const idempotencyKey = request.headers.get('idempotency-key');
    if (!idempotencyKey) return json({ error: 'OPERATOR_IDEMPOTENCY_KEY_REQUIRED' }, 400);
    return json(await runShadowCycle(env, owner.id, { source: 'OPERATOR', idempotencyKey }));
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
  async fetch(request, env) {
    try { return await route(request, env); }
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
        try { await runShadowCycle(env, owner.owner_id, { source: 'SCHEDULED' }); }
        catch (error) { await audit(env, owner.owner_id, 'SCHEDULED_SHADOW_FAILED', { error: error.message }); }
      }
    })());
  },
};
