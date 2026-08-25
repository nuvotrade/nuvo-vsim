# NUVO VSIM × MASTER CHIEF — Stage 2 operations

## Active authority

The deployed worker is fixed at engine Authority 1 and desk Stage 2:
autonomous shadow only. MASTER CHIEF may start cycles, read structured state,
explain stored engine results, and replay sealed evidence. It cannot create a
live ticket, mutate Schwab, amend the Constitution, override a failed gate, or
calculate an underwriting number.

Calibration history is informative, not a runtime gate. Shadow cycles run even
when `p_cal_status` is `UNCALIBRATED`; that label simply prevents the desk from
presenting an unproven calibrated probability as established edge. Authority
promotion is not an MCP tool and remains an explicit Principal amendment to the
Constitution. Chat cannot promote the system.

## Private MCP surface

Endpoint: `/mcp`, protected by the same Cloudflare Access application as the
dashboard. Human Access sessions work for operator testing. MASTER CHIEF must
use a Cloudflare Access service token whose verified client ID is configured
as `MCP_SERVICE_TOKEN_ID`. The service-token policy must cover only the shadow
application. No Schwab execution credential exists on this Worker.

Stage 2 tools:

- `get_account_truth`
- `get_market_state`
- `run_shadow_cycle`
- `get_cycle`, `list_cycles`
- `list_ranked_opportunities`
- `explain_candidate`, `explain_rejection`
- `replay_evidence`, `list_evidence`

The three future intent/approval/execution names are locked stubs. They return
`AUTHORITY_DENIED` at Authority 1. There is no `place_order`, `cancel_order`,
`replace_order`, `set_authority`, `set_constitution`, or `override_gate` tool.

## Runtime path

1. The schedule or MASTER CHIEF requests one shadow cycle.
2. RTH and Schwab connection are checked before work is admitted.
3. A per-account Durable Object returns the active cycle if a lock is held.
4. A Workflow runs the existing VSIM engine; the LLM does no math.
5. D1 records ordered states and metadata.
6. R2 receives an immutable evidence package and immutable CycleContext.
7. `replay_evidence` reconstructs the decision. A mismatch returns `DRIFT`
   and requires quarantine.

Outside RTH, one refusal is sealed per market day so the fifteen-minute
schedule does not spam. A Schwab disconnect refuses before underwriting.

## Production bindings

The Worker requires:

- `DB`: D1 `nuvo-vsim-v5-shadow`
- `EVIDENCE`: R2 `nuvo-vsim-v5-evidence-shadow`
- `MARKET`: private service binding to `master` production
- `ACCOUNT_COORDINATOR`: `VsimAccountCoordinator` SQLite Durable Object
- `SHADOW_CYCLE_WORKFLOW`: `nuvo-vsim-stage2-shadow-cycle`
- Existing read-only Schwab and Access secrets
- `MCP_SERVICE_TOKEN_ID`: MASTER CHIEF Access service-token client ID

The Access service-token secret belongs in the Grok Bot connection, not in
the Worker. The Worker sees only the Access-verified JWT client identity.

## Deployment checklist

1. Run all tests; all 288 must pass.
2. Apply D1 migration `0005_ai_stage2.sql`.
3. Deploy the Worker version with Authority 1 unchanged.
4. Verify `/mcp` is still Access-protected.
5. Confirm tool discovery contains only the contracted names.
6. Run an after-hours refusal and replay it to `MATCH`.
7. During RTH, verify Schwab Market Data freshness, Schwab custody reconciliation, candidate
   labels, and evidence sealing in shadow.
8. Issue MASTER CHIEF a shadow Access token only after the above pass.

The dashboard is not the agent control plane. It remains human mission
control and exposes metadata, not raw R2 packages.
