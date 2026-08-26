import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCycleContext, D1R2CycleContextStore } from '../cloudflare/cycle-context.js';
import { handleVsimMcp, VSIM_MCP_TOOL_NAMES } from '../cloudflare/mcp-server.js';
import { createMcpService, triggerShadowCycle } from '../cloudflare/worker.js';

const HOST = 'nuvo-vsim-v5-shadow.yulgutierrez.workers.dev';

class MemoryBucket {
  constructor() { this.objects = new Map(); }
  async head(key) { return this.objects.has(key) ? { key } : null; }
  async put(key, value) { this.objects.set(key, String(value)); }
  async get(key) {
    if (!this.objects.has(key)) return null;
    const body = this.objects.get(key);
    return { text: async () => body, json: async () => JSON.parse(body) };
  }
  async delete(key) { this.objects.delete(key); }
}

class MemoryD1 {
  constructor({ connection = null } = {}) {
    this.connection = connection;
    this.evidence = [];
    this.summaries = new Map();
    this.contexts = new Map();
    this.events = [];
    this.operatorControl = null;
  }

  prepare(sql) {
    const db = this;
    return {
      args: [],
      bind(...args) { this.args = args; return this; },
      async first() { return db.#first(sql, this.args); },
      async all() { return db.#all(sql, this.args); },
      async run() { return db.#run(sql, this.args); },
    };
  }

  #key(owner, cycle) { return `${owner}|${cycle}`; }

  #first(sql, args) {
    if (/FROM broker_connections/u.test(sql)) return this.connection;
    if (/FROM operator_controls/u.test(sql)) return this.operatorControl;
    if (/FROM cycle_summaries/u.test(sql)) {
      if (/cycle_id=\?/u.test(sql)) return this.summaries.get(this.#key(args[0], args[1])) ?? null;
      return [...this.summaries.values()].at(-1) ?? null;
    }
    if (/FROM evidence_index/u.test(sql)) {
      const rows = this.evidence.filter((row) => row.owner_id === args[0]);
      if (/cycle_id=\?/u.test(sql)) return rows.find((row) => row.cycle_id === args[1]) ?? null;
      if (/decision_fingerprint LIKE/u.test(sql)) {
        const prefix = String(args[1]).replace('%', '');
        return rows.find((row) => row.decision_fingerprint?.startsWith(prefix)) ?? null;
      }
      if (/COUNT\(\*\)/u.test(sql)) return { count: rows.length };
    }
    if (/FROM cycle_context_index/u.test(sql)) {
      if (/cycle_id=\?/u.test(sql)) return this.contexts.get(this.#key(args[0], args[1])) ?? null;
      return [...this.contexts.values()].filter((row) => row.owner_id === args[0]).at(-1) ?? null;
    }
    return null;
  }

  #all(sql, args) {
    if (/SELECT object_key FROM evidence_index/u.test(sql)) {
      return { results: this.evidence.filter((row) => row.owner_id === args[0])
        .sort((a, b) => a.sequence - b.sequence).map(({ object_key }) => ({ object_key })) };
    }
    if (/FROM cycle_state_events/u.test(sql)) {
      return { results: this.events.filter((row) => row.owner_id === args[0] && row.cycle_id === args[1]) };
    }
    return { results: [] };
  }

  #run(sql, args) {
    if (/INSERT INTO evidence_index/u.test(sql)) {
      this.evidence.push({
        owner_id: args[0], cycle_id: args[1], sequence: args[2], evidence_hash: args[3],
        previous_hash: args[4], chain_hash: args[5], decision_fingerprint: args[6],
        decision: args[7], authority_level: args[8], object_key: args[9], created_at: args[10],
      });
    } else if (/INSERT INTO cycle_summaries/u.test(sql)) {
      this.summaries.set(this.#key(args[0], args[1]), {
        owner_id: args[0], cycle_id: args[1], outcome: args[2], reason: args[3],
        regime: args[4], summary_json: args[5], created_at: args[6], state: args[7],
        decision: args[8], reason_code: args[9], evidence_fingerprint: args[10], updated_at: args[11],
      });
    } else if (/INSERT INTO cycle_state_events/u.test(sql)) {
      this.events.push({ owner_id: args[0], cycle_id: args[1], sequence: args[2], state: args[3],
        role: args[4], detail_json: args[5], created_at: args[6] });
    } else if (/INSERT INTO cycle_context_index/u.test(sql)) {
      this.contexts.set(this.#key(args[0], args[1]), {
        owner_id: args[0], cycle_id: args[1], authority_level: args[2], engine_version: args[3],
        constitution_version: args[4], account_snapshot_hash: args[5], session: args[6],
        massive_status: args[7], decision: args[8], evidence_fingerprint: args[9],
        context_hash: args[10], object_key: args[11], created_at: args[12],
      });
    }
    return { success: true, meta: { changes: 1 } };
  }
}

function marketFetcher(session = 'open') {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/v1/market-status') {
      return Response.json({ status: 'VERIFIED', market: session, as_of: new Date().toISOString() });
    }
    if (url.pathname === '/v1/vix') return Response.json({ vix: 15.8, vix3m: 17.1 });
    if (url.pathname === '/v1/bars') {
      return Response.json({ bars: Array.from({ length: 252 }, (_, index) => ({ c: 500 + index })) });
    }
    return Response.json({ error: 'NOT_TESTED' }, { status: 404 });
  };
}

function testEnv({ session = 'open', connection = null, coordinator = null, workflow = null } = {}) {
  return {
    DB: new MemoryD1({ connection }),
    EVIDENCE: new MemoryBucket(),
    MARKET: { fetch: marketFetcher(session) },
    ACCOUNT_COORDINATOR: { getByName: () => coordinator },
    SHADOW_CYCLE_WORKFLOW: workflow,
    NUVO_AUTHORITY_LEVEL: '1',
    NUVO_BROKER_MODE: 'READ_ONLY',
    NUVO_BROKER_EXECUTION_MODE: 'SHADOW_ONLY',
    NUVO_SYMBOLS: 'SPY,QQQ,IWM',
    NUVO_FUND_SYMBOLS: 'SPY,QQQ,IWM',
    NUVO_DTE_TARGETS: '14,30,45',
    PUBLIC_ORIGIN: `https://${HOST}`,
  };
}

function parseMcpBody(text) {
  const data = text.split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(data.slice(6));
}

async function mcpRequest(service, method, params, id = 1) {
  const request = new Request(`https://${HOST}/mcp`, {
    method: 'POST',
    headers: {
      host: HOST,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const response = await handleVsimMcp({
    request,
    env: { PUBLIC_ORIGIN: `https://${HOST}` },
    ctx: { waitUntil() {} },
    owner: { id: 'OWNER', serviceToken: true },
    service,
  });
  return { response, body: parseMcpBody(await response.text()) };
}

describe('NUVO VSIM Stage 2 MCP acceptance', () => {
  test('initialization gives the machine the fail-closed Guardian operating mandate', async () => {
    const service = {};
    const { body } = await mcpRequest(service, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'nuvo-test-client', version: '1.0.0' },
    });
    assert.match(body.result.instructions, /Authority 1 read-only Guardian/u);
    assert.match(body.result.instructions, /no broker mutation capability/u);
  });

  test('exposes only the contracted surface and never exposes place/cancel/replace order', async () => {
    const service = new Proxy({}, { get: () => async () => ({ ok: true, authority_level: 1, asof: new Date().toISOString(), error: null }) });
    const { body } = await mcpRequest(service, 'tools/list', {});
    const names = body.result.tools.map((tool) => tool.name);
    assert.deepEqual(names, [...VSIM_MCP_TOOL_NAMES]);
    assert.ok(!names.some((name) => /place_order|cancel_order|replace_order|override_gate|set_authority/u.test(name)));
  });

  test('Authority 1 refuses execute_approved_intent through the real MCP handler', async () => {
    const service = {
      authorityDenied: (tool, required) => ({
        ok: false, cycle_id: null, authority_level: 1, asof: new Date().toISOString(),
        error: { code: 'AUTHORITY_DENIED', message: `${tool} requires ${required}` },
      }),
    };
    const { body } = await mcpRequest(service, 'tools/call', {
      name: 'execute_approved_intent',
      arguments: { intent_id: 'INTENT', approval_id: 'APPROVAL', idempotency_key: '1234567890abcdef' },
    });
    assert.equal(body.result.structuredContent.ok, false);
    assert.equal(body.result.structuredContent.error.code, 'AUTHORITY_DENIED');
  });

  test('POST session refuses once, seals evidence, and returns zero candidates', async () => {
    const env = testEnv({ session: 'post' });
    const result = await triggerShadowCycle(env, 'OWNER-POST');
    assert.equal(result.ok, false);
    assert.equal(result.state, 'REFUSED');
    assert.equal(result.decision, 'REFUSED');
    assert.equal(result.reason_code, 'TRUTH/SESSION_NOT_RTH');
    assert.ok(result.evidence_fingerprint);
    const ranked = await createMcpService(env, 'OWNER-POST').listRankedOpportunities(result.cycle_id);
    assert.deepEqual(ranked.candidates, []);
  });

  test('Schwab disconnect refuses before lock or underwriting and seals the refusal', async () => {
    let lockCalls = 0;
    let workflowCalls = 0;
    const env = testEnv({
      session: 'open',
      connection: { status: 'DISCONNECTED', last_error_code: 'TOKEN_EXPIRED' },
      coordinator: { acquire: async () => { lockCalls += 1; return { acquired: true }; } },
      workflow: { create: async () => { workflowCalls += 1; } },
    });
    const result = await triggerShadowCycle(env, 'OWNER-DISCONNECTED');
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'TRUTH/SCHWAB_DISCONNECTED');
    assert.equal(lockCalls, 0);
    assert.equal(workflowCalls, 0);
  });

  test('global pause refuses before market or Schwab access', async () => {
    const env = testEnv({ session: 'open' });
    env.DB.operatorControl = {
      global_pause: 1, global_pause_reason: 'Principal maintenance window',
      independent_kill: 0, independent_kill_reason: null,
      updated_at: new Date().toISOString(), updated_by: 'PRINCIPAL_ACCESS_SESSION',
    };
    env.MARKET.fetch = async () => { throw new Error('MARKET_MUST_NOT_BE_CALLED'); };
    const result = await triggerShadowCycle(env, 'OWNER-PAUSED');
    assert.equal(result.reason_code, 'CONSTITUTION/GLOBAL_PAUSE');
    assert.equal(result.decision, 'REFUSED');
  });

  test('two starts in one slot return the same cycle and create one Workflow', async () => {
    let active = null;
    let workflowCalls = 0;
    const coordinator = {
      async acquire(cycleId) {
        if (active) return { acquired: false, cycle_id: active, state: 'TRIGGERED' };
        active = cycleId;
        return { acquired: true, cycle_id: cycleId, state: 'TRIGGERED' };
      },
      async finish() { active = null; },
    };
    const env = testEnv({
      session: 'open', connection: { status: 'CONNECTED' }, coordinator,
      workflow: { create: async () => { workflowCalls += 1; } },
    });
    const first = await triggerShadowCycle(env, 'OWNER-IDEMPOTENT');
    const second = await triggerShadowCycle(env, 'OWNER-IDEMPOTENT');
    assert.equal(first.cycle_id, second.cycle_id);
    assert.equal(first.state, 'TRIGGERED');
    assert.equal(second.error.code, 'LOCK_HELD');
    assert.equal(workflowCalls, 1);
  });

  test('replay of a sealed operational refusal is MATCH', async () => {
    const env = testEnv({ session: 'closed' });
    const refusal = await triggerShadowCycle(env, 'OWNER-REPLAY');
    const replay = await createMcpService(env, 'OWNER-REPLAY').replayEvidence({ cycleId: refusal.cycle_id });
    assert.equal(replay.ok, true);
    assert.equal(replay.status, 'MATCH');
    assert.deepEqual(replay.differences, []);
  });

  test('candidate JSON includes UNCALIBRATED p_cal and NEV per day', () => {
    const selected = {
      underlying: 'SPY', kind: 'CSP', expiration: '2026-09-23', shortStrike: 500,
      longStrike: null, dte: 30, ev: 70, cvar: 900, gapRisk: 80, liquidityRisk: 15,
      nev: 45, raroc: 0.14, economicCapital: 1600, admissible: true, violations: [],
      probabilities: { pMarket: 0.21, pModel: 0.15, pCal: 0.16, calibration: 'UNCALIBRATED', confidence: 0.4 },
    };
    const context = buildCycleContext({
      result: {
        evidence: { candidates: [selected], selected, codeVersion: 'git:test', modelVersion: 'model', limitsVersion: 'constitution' },
        governance: { approved: true, sizing: { multipliers: { confidence: 0.5 } }, portfolioBefore: { nav: 100000 }, portfolio: { nav: 100000 } },
        governanceAttempts: [{ underlying: 'SPY', kind: 'CSP', shortStrike: 500, approved: true, reasons: [] }],
        trace: [],
      },
      summary: { cycleId: 'CY-CONTEXT', outcome: 'PROPOSAL', at: Date.now(), reasonCode: null, reason: null },
    });
    assert.equal(context.candidates[0].p_cal, null);
    assert.equal(context.candidates[0].p_cal_status, 'UNCALIBRATED');
    assert.equal(context.candidates[0].nev_per_day, 1.5);
    assert.equal(context.candidates[0].governor, 'REDUCED');
  });

  test('sealed governor rejection remains rejected and cannot be flipped by another read', () => {
    const candidate = {
      underlying: 'QQQ', kind: 'BULL_PUT_SPREAD', expiration: '2026-09-23',
      shortStrike: 450, longStrike: 445, dte: 30, ev: 40, cvar: 400, gapRisk: 20,
      liquidityRisk: 10, nev: 12, raroc: 0.1, economicCapital: 500, admissible: true,
      violations: [], probabilities: { calibration: 'UNCALIBRATED' },
    };
    const input = {
      result: {
        evidence: { candidates: [candidate], selected: candidate },
        governance: null,
        governanceAttempts: [{ underlying: 'QQQ', kind: 'BULL_PUT_SPREAD', shortStrike: 450, approved: false, reasons: ['GAMMA_LIMIT'] }],
        trace: [],
      },
      summary: { cycleId: 'CY-REJECT', outcome: 'NO_TRADE', at: Date.now(), reasonCode: 'GAMMA_LIMIT', reason: 'Governor rejected.' },
    };
    const first = buildCycleContext(input).candidates[0];
    const second = buildCycleContext(input).candidates[0];
    assert.equal(first.governor, 'REJECT');
    assert.deepEqual(first.governor_reasons, ['GAMMA_LIMIT']);
    assert.deepEqual(second, first);
  });

  test('CycleContext R2 tampering is detected before a tool can read it', async () => {
    const db = new MemoryD1();
    const bucket = new MemoryBucket();
    const store = new D1R2CycleContextStore({ db, bucket, ownerId: 'OWNER' });
    const context = {
      cycle_id: 'CY-TAMPER', authority_level: 1, engine_version: 'git:test',
      constitution_version: 'constitution', account_snapshot_hash: 'abc', quote_timestamps: {},
      candidates: [], decision: 'REFUSED', session: 'POST', massive_status: 'LIVE',
      evidence_fingerprint: 'fingerprint', created_at: new Date().toISOString(),
    };
    await store.put(context);
    const row = db.contexts.get('OWNER|CY-TAMPER');
    const record = JSON.parse(bucket.objects.get(row.object_key));
    record.decision = 'ELIGIBLE';
    bucket.objects.set(row.object_key, JSON.stringify(record));
    await assert.rejects(() => store.get('CY-TAMPER'), /CYCLE_CONTEXT_DRIFT/u);
  });

  test('shadow MCP service has no execution credential or raw-package method', () => {
    const env = testEnv();
    env.SCHWAB_EXECUTION_SECRET = 'MUST_NOT_LEAK';
    const service = createMcpService(env, 'OWNER');
    assert.equal('placeOrder' in service, false);
    assert.equal('rawEvidencePackage' in service, false);
    assert.doesNotMatch(JSON.stringify(Object.keys(service)), /SECRET|placeOrder|rawEvidencePackage/u);
  });
});
