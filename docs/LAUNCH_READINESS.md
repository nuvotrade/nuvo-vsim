# NUVO VSIM v5 launch readiness

Status: **SHADOW DEPLOYED; DO NOT REPLACE `vsim.nuvotrade.co`; DO NOT ENABLE LIVE MUTATION.**

## Deployed shadow boundary

The v5 engine is deployed separately at the protected Cloudflare Worker
`nuvo-vsim-v5-shadow`. The existing production website is not routed to this
Worker and was not modified.

The shadow runtime is fixed at Authority 1 and has no submit, replace, or
cancel route. Its Schwab adapter implements custody reads only; its mutation
methods return `SCHWAB_MUTATION_DISABLED_SHADOW_ONLY`.

Cloudflare resources:

- D1 `nuvo-vsim-v5-shadow` for OAuth state, encrypted-token metadata,
  broker observations, reconciliation baseline, leases, audit rows, cycle
  summaries, and the ordered evidence index;
- R2 `nuvo-vsim-v5-evidence-shadow` for immutable full evidence packages;
- Schwab Market Data Production as the authoritative quote, history, VIX, and
  live options-chain source;
- private service binding `MARKET -> master` retained only for fail-closed ETF
  corporate-action clearance and as a disabled-by-default legacy fallback;
- a weekday 15-minute shadow schedule;
- Cloudflare Access plus Worker-side JWT audience/signature verification and
  a secret owner-identity allowlist.

## Verified production behavior

- Schwab OAuth is connected to the approved production application.
- Access and refresh tokens are AES-GCM encrypted at rest; refresh rotation is
  protected by a D1 lease.
- Each custody read normalizes liquidation value, net cash/margin, buying
  power, positions, and open orders from one timestamped snapshot.
- The operator dashboard displays the current snapshot and never presents
  missing numeric fields as zero.
- The full four-tab operator design now runs directly on the protected Worker.
  Its account, position, opportunity, evidence, connector, and cycle state is
  loaded from the authenticated APIs; hard-coded preview values are never
  shown while live state is loading or unavailable.
- Existing positions are mapped into the Portfolio Governor. A missing
  quantity, unsupported instrument, unpriceable position, or undefined-risk
  short call refuses the entire map.
- New listings may be risk-managed with 30 sessions, but receive an 80%
  annualized volatility floor until 120 sessions exist. New trade candidates
  still require at least 120 sessions.
- SPY, QQQ, and IWM quotes, histories, VIX, market hours, and live option
  chains are loaded through Schwab with strict real-time, bid, ask, IV,
  Greeks, session, and freshness checks. Delayed or incomplete Schwab packets
  fail closed.
- A live compatibility proof returned VIX 15.58 plus 368 SPY, 379 QQQ, and
  375 IWM executable contracts (1,122 total) across the requested 14/30/45-day
  tenor neighborhoods.
- Schwab session values are normalized without treating extended hours as
  open. Once quotes age beyond the configured limit, the scan refuses instead
  of displaying a stale opportunity as executable.
- ETFs skip the inapplicable corporate-issuer earnings calendar, while their
  corporate-action clearance remains mandatory and fail-closed.
- Scheduled cycles are idempotent per 15-minute slot. Operator cycles require
  a distinct idempotency key; retrying the same key returns the same cycle.
- Every normal engine decision writes a SHA-256, hash-chained package to R2
  and its ordered index to D1. Operational refusals before model entry use the
  same durable evidence path.
- A downloaded live R2 package passed payload verification and deterministic
  replay with the identical decision fingerprint and zero differences.
- The production custody baseline contains all four current positions, zero
  open orders, and reconciled cash/buying-power state.
- The final open-market cycle `CY-ba629ba31c-FINAL3-20260825T1815` passed Truth,
  chain audit, reconciliation, regime, and universe gates. It correctly
  returned `NO_TRADE` because forward volatility premium was negative; its
  sealed R2 package replayed with an identical decision fingerprint and zero
  differences.
- The environment classified `NORMAL` with independently sourced VIX 15.56.
  VIX3M remains explicitly unknown rather than duplicating VIX and inventing
  a term-structure signal.
- The complete local suite passes: **303/303 tests**.

## What remains blocked

1. **No demonstrated trading edge.** Passing correctness and live connector
   checks proves reliable behavior, not profitable expectancy. Promotion
   requires a sustained, pre-registered shadow record and calibrated mature
   outcomes.
2. **No live order workflow.** This deployment deliberately has no production
   mutation adapter, distributed order outbox, broker-side intent lookup,
   partial-fill recovery, or live lifecycle loop.
3. **No authority promotion.** Shadow observations cannot promote live
   authority. Any future Authority 2 proposal/canary is a separate reviewed
   change with human approval, a narrow allowlist, hard dollar caps, and
   broker-confirmed idempotency.
4. **No production hostname cutover.** Design acceptance, shadow evidence,
   and live-order authority are independent gates. The current site stays in
   place unless a separate cutover is explicitly approved.
5. **No forced opportunity.** The production opportunity loop is working, but
   the final open-market proof returned `NO_TRADE`. SPY and QQQ failed the
   IV/RV and forward-premium screens; IWM cleared the trailing IV/RV floors
   but failed forward VRP. An empty opportunity table is therefore the correct
   live result, not a connector failure.

## Massive subscription boundary

The $199/month Massive Options Advanced plan is no longer required for live
quotes, Greeks, history, VIX, or opportunity chains. Those production inputs
now come from Schwab. NUVO still uses the Massive credential boundary for ETF
corporate-action clearance; Massive documents corporate actions as included
in the free Basic plan. Downgrade the options subscription only after the
Principal confirms the billing change, then rerun the compatibility proof to
confirm the free entitlement still serves that clearance endpoint.

## Launch decision

Use this deployment as a private operator dashboard and real-data shadow
laboratory. It is appropriate for account reconciliation, live options-chain
screening, refusal analysis, evidence/replay verification, and calibration.
It is not approved for autonomous capital or replacement of the current
website.
