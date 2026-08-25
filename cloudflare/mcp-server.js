import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';

const TOOL_VERSION = 'nuvo-vsim-mcp-1.0.0';

function toolResponse(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: payload?.ok === false,
  };
}

function register(server, name, description, inputSchema, handler) {
  server.registerTool(name, { description, inputSchema }, async (input) => {
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
  const server = new McpServer({ name: 'nuvo-vsim', version: TOOL_VERSION });

  register(server, 'get_account_truth',
    'Return the live read-only Schwab custody snapshot and reconciliation status. Fails closed on disconnect or mismatch.',
    {}, () => service.getAccountTruth());

  register(server, 'get_market_state',
    'Return verified market session, regime, VIX, authoritative provider, contract coverage, and quote freshness. Non-RTH or stale data is a veto.',
    {}, () => service.getMarketState());

  register(server, 'run_shadow_cycle',
    'Start one deterministic Authority 1 shadow cycle for the fixed VSIM universe. Never places orders and accepts no strike list.',
    {}, () => service.runShadowCycle());

  register(server, 'get_cycle',
    'Return one stored cycle by its exact cycle ID, including state, decision, timestamps, reason, and evidence fingerprint.',
    { cycle_id: z.string().min(1).max(100).describe('Exact sealed or active VSIM cycle ID.') },
    ({ cycle_id }) => service.getCycle(cycle_id));

  register(server, 'list_cycles',
    'List recent VSIM cycles. Defaults to 20 and never returns raw R2 evidence bodies.',
    { limit: z.number().int().min(1).max(100).default(20).optional() },
    ({ limit }) => service.listCycles(limit ?? 20));

  register(server, 'list_ranked_opportunities',
    'Return engine-computed ranked opportunities from a sealed cycle, including probabilities, risk charges, NEV, RAROC, economic capital, and governor verdict.',
    { cycle_id: z.string().min(1).max(100).optional().describe('Defaults to the latest sealed cycle.') },
    ({ cycle_id }) => service.listRankedOpportunities(cycle_id ?? null));

  register(server, 'explain_candidate',
    'Return stored engine fields and gate reasons for one sealed candidate. Does not recalculate or invent any value.',
    {
      cycle_id: z.string().min(1).max(100),
      candidate_id: z.string().min(1).max(240).optional(),
      rank: z.number().int().min(1).max(1000).optional(),
    },
    ({ cycle_id, candidate_id, rank }) => service.explainCandidate({ cycleId: cycle_id, candidateId: candidate_id, rank }));

  register(server, 'explain_rejection',
    'Return the exact stored refusal code, failing gate, session, quote age, and reconciliation mismatches for a cycle.',
    { cycle_id: z.string().min(1).max(100) },
    ({ cycle_id }) => service.explainRejection(cycle_id));

  register(server, 'replay_evidence',
    'Replay a sealed R2 evidence package through the deterministic VSIM engine. Returns MATCH or DRIFT with field differences; DRIFT requires quarantine.',
    {
      cycle_id: z.string().min(1).max(100).optional(),
      fingerprint: z.string().regex(/^[a-f0-9]{8,64}$/u).optional(),
    },
    ({ cycle_id, fingerprint }) => service.replayEvidence({ cycleId: cycle_id ?? null, fingerprint: fingerprint ?? null }));

  register(server, 'list_evidence',
    'List sealed evidence metadata only: sequence, cycle ID, fingerprint prefix, decision, and creation time. Raw R2 bodies are not returned.',
    { limit: z.number().int().min(1).max(100).default(20).optional() },
    ({ limit }) => service.listEvidence(limit ?? 20));

  // Future authority tools are visible as explicit locked stubs so clients
  // cannot mistake absence for an integration problem. Their handlers read
  // engine authority and always fail closed at Authority 1.
  register(server, 'create_trade_proposal',
    'LOCKED at Stage 2. Future tool freezes an engine-selected candidate; it never accepts arbitrary order terms.',
    { cycle_id: z.string().min(1).max(100), candidate_id: z.string().min(1).max(240) },
    (input) => service.authorityDenied('create_trade_proposal', 2, input.cycle_id));

  register(server, 'request_operator_approval',
    'LOCKED at Stage 2. Future tool requests Principal approval for a frozen intent.',
    { intent_id: z.string().min(1).max(160) },
    () => service.authorityDenied('request_operator_approval', 2, null));

  register(server, 'execute_approved_intent',
    'LOCKED at Stage 2. Future isolated execution service accepts only an approved frozen intent and idempotency key.',
    {
      intent_id: z.string().min(1).max(160),
      approval_id: z.string().min(1).max(160),
      idempotency_key: z.string().min(16).max(128),
    },
    () => service.authorityDenied('execute_approved_intent', 3, null));

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
