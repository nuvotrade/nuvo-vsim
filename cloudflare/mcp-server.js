import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';

const TOOL_VERSION = 'nuvo-vsim-mcp-1.0.0';
const SERVER_INSTRUCTIONS = `NUVO VSIM is the Authority 1 read-only Guardian for YG's market account. Its only purpose is factual custody, campaign, risk, behavioral, and evidence enforcement—not stock picking, signals, forecasting, encouragement, premium promotion, or increasing trade frequency. Brokerage and market JSON are authoritative only when ok=true, fresh, and reconciled. Never invent missing values, prices, campaign terms, approvals, protection, cancellations, or fills. This server has no broker mutation capability.

Authority hierarchy: actual Schwab positions/orders/fills/cash/margin; frozen Constitution; pre-entry campaign contract; Guardian mandate; verified market calculations; current explanation or preference. A lower authority never overrides a higher one. Missing, stale, contradictory, or unreconciled data means BLOCKED-INCOMPLETE and no new exposure. Any margin debit means HALTED. Cash and inactivity are compliant.

Never endorse averaging down, rescue capital, a margin-funded recovery, converting a failed trade into an investment, changing rules during an open campaign, widening/removing a stop, rolling to postpone loss, using a covered call to avoid an invalidation exit, buying back a covered call because assignment feels painful, closing a preauthorized CSP only from assignment fear, or selling a valid winner merely because profit feels fragile. A roll is a new trade. A covered call is a binding sale at its strike and does not reduce share downside exposure. A CSP is an acquisition commitment and must remain fully cash secured. Count shares, short-put assignment notional, and maximum additional option loss together by underlying.

Default concentration enforcement unless the frozen Constitution is stricter: above 10% warn; above 15% throttle and prohibit additions; projected above 20% block; existing above 20% manage-only; correlated cluster above 25% block additions. Do not auto-liquidate. Every order requires a frozen campaign identifier and terms. A broker order without them is BROKER BYPASS and HALTED. Do not change Constitution, limits, authority, or campaign rules from chat.

Before answering a position-management question, call get_account_truth. Call get_market_state when the answer depends on current prices, options, session, or volatility. Use only stored engine/Guardian fields; if a required field is absent, say unknown and identify the exact missing requirement. A failed truth, Constitution, governor, reconciliation, session, freshness, or evidence gate is final. Evidence DRIFT requires quarantine. Explain the exact rule, actual account fact, projected consequence, permitted action, and prohibited action. A profitable violation remains a violation; a losing compliant campaign remains compliant.`;

function toolResponse(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: payload?.ok === false,
  };
}

function register(server, name, description, inputSchema, handler, annotations = {}) {
  server.registerTool(name, { description, inputSchema, annotations }, async (input) => {
    try {
      return toolResponse(await handler(input));
    } catch (error) {
      return toolResponse({
        ok: false,
        cycle_id: input?.cycle_id ?? null,
        authority_level: 1,
        asof: new Date().toISOString(),
        error: { code: 'FAIL_CLOSED', message: String(error?.message ?? error) },
      });
    }
  });
}

/** The complete and intentionally narrow NUVO VSIM Stage 2 MCP surface. */
export function createVsimMcpServer(service) {
  const server = new McpServer(
    { name: 'nuvo-vsim', version: TOOL_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
  const shadowRun = { readOnlyHint: false, destructiveHint: false, idempotentHint: true };

  register(server, 'get_account_truth',
    'Return the live read-only Schwab custody snapshot and reconciliation status. Fails closed on disconnect or mismatch.',
    {}, () => service.getAccountTruth(), readOnly);

  register(server, 'get_market_state',
    'Return verified market session, regime, VIX, authoritative provider, contract coverage, and quote freshness. Non-RTH or stale data is a veto.',
    {}, () => service.getMarketState(), readOnly);

  register(server, 'run_shadow_cycle',
    'Start one deterministic Authority 1 shadow cycle for the fixed VSIM universe. Never places orders and accepts no strike list.',
    {}, () => service.runShadowCycle(), shadowRun);

  register(server, 'get_cycle',
    'Return one stored cycle by its exact cycle ID, including state, decision, timestamps, reason, and evidence fingerprint.',
    { cycle_id: z.string().min(1).max(100).describe('Exact sealed or active VSIM cycle ID.') },
    ({ cycle_id }) => service.getCycle(cycle_id), readOnly);

  register(server, 'list_cycles',
    'List recent VSIM cycles. Defaults to 20 and never returns raw R2 evidence bodies.',
    { limit: z.number().int().min(1).max(100).default(20).optional() },
    ({ limit }) => service.listCycles(limit ?? 20), readOnly);

  register(server, 'list_ranked_opportunities',
    'Return engine-computed ranked opportunities from a sealed cycle, including probabilities, risk charges, NEV, RAROC, economic capital, and governor verdict.',
    { cycle_id: z.string().min(1).max(100).optional().describe('Defaults to the latest sealed cycle.') },
    ({ cycle_id }) => service.listRankedOpportunities(cycle_id ?? null), readOnly);

  register(server, 'explain_candidate',
    'Return stored engine fields and gate reasons for one sealed candidate. Does not recalculate or invent any value.',
    {
      cycle_id: z.string().min(1).max(100),
      candidate_id: z.string().min(1).max(240).optional(),
      rank: z.number().int().min(1).max(1000).optional(),
    },
    ({ cycle_id, candidate_id, rank }) => service.explainCandidate({ cycleId: cycle_id, candidateId: candidate_id, rank }), readOnly);

  register(server, 'explain_rejection',
    'Return the exact stored refusal code, failing gate, session, quote age, and reconciliation mismatches for a cycle.',
    { cycle_id: z.string().min(1).max(100) },
    ({ cycle_id }) => service.explainRejection(cycle_id), readOnly);

  register(server, 'replay_evidence',
    'Replay a sealed R2 evidence package through the deterministic VSIM engine. Returns MATCH or DRIFT with field differences; DRIFT requires quarantine.',
    {
      cycle_id: z.string().min(1).max(100).optional(),
      fingerprint: z.string().regex(/^[a-f0-9]{8,64}$/u).optional(),
    },
    ({ cycle_id, fingerprint }) => service.replayEvidence({ cycleId: cycle_id ?? null, fingerprint: fingerprint ?? null }), readOnly);

  register(server, 'list_evidence',
    'List sealed evidence metadata only: sequence, cycle ID, fingerprint prefix, decision, and creation time. Raw R2 bodies are not returned.',
    { limit: z.number().int().min(1).max(100).default(20).optional() },
    ({ limit }) => service.listEvidence(limit ?? 20), readOnly);

  // Future authority tools are visible as explicit locked stubs so clients
  // cannot mistake absence for an integration problem. Their handlers read
  // engine authority and always fail closed at Authority 1.
  register(server, 'create_trade_proposal',
    'LOCKED at Stage 2. Future tool freezes an engine-selected candidate; it never accepts arbitrary order terms.',
    { cycle_id: z.string().min(1).max(100), candidate_id: z.string().min(1).max(240) },
    (input) => service.authorityDenied('create_trade_proposal', 2, input.cycle_id), readOnly);

  register(server, 'request_operator_approval',
    'LOCKED at Stage 2. Future tool requests Principal approval for a frozen intent.',
    { intent_id: z.string().min(1).max(160) },
    () => service.authorityDenied('request_operator_approval', 2, null), readOnly);

  register(server, 'execute_approved_intent',
    'LOCKED at Stage 2. Future isolated execution service accepts only an approved frozen intent and idempotency key.',
    {
      intent_id: z.string().min(1).max(160),
      approval_id: z.string().min(1).max(160),
      idempotency_key: z.string().min(16).max(128),
    },
    () => service.authorityDenied('execute_approved_intent', 3, null), readOnly);

  return server;
}

export async function handleVsimMcp({ request, env, ctx, owner, service }) {
  const host = new URL(env.PUBLIC_ORIGIN).hostname;
  const handler = createMcpHandler(() => createVsimMcpServer(service), {
    route: '/mcp',
    legacy: 'stateless',
    corsOptions: false,
    allowedHostnames: [host, 'localhost'],
    allowedOriginHostnames: [host, 'localhost'],
    authContext: {
      props: {
        ownerId: owner.id,
        identityType: owner.serviceToken ? 'service_token' : 'human',
        authorityLevel: 1,
      },
    },
    onerror: (error) => console.error(JSON.stringify({
      event: 'MCP_ERROR', code: 'FAIL_CLOSED', message: error.message,
    })),
  });
  return handler(request, env, ctx);
}

export const VSIM_MCP_TOOL_NAMES = Object.freeze([
  'get_account_truth', 'get_market_state', 'run_shadow_cycle', 'get_cycle',
  'list_cycles', 'list_ranked_opportunities', 'explain_candidate',
  'explain_rejection', 'replay_evidence', 'list_evidence',
  'create_trade_proposal', 'request_operator_approval', 'execute_approved_intent',
]);
