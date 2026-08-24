# NUVO VSIM v5 launch-readiness review

Status: **DO NOT REPLACE `vsim.nuvotrade.co`; DO NOT ENABLE LIVE MUTATION.**

This review covers the corrected v5 bundle and the inherited web/Cloudflare
files in the repository. It distinguishes a sound research engine from a
production trading service and from a deployable operator website.

## What is verified

- Claude's six correction areas are present: multi-leg Greeks, portfolio
  gates, empirical bootstrap, event-separated calibration, SHA-256 evidence,
  and deterministic replay/persistence primitives.
- The independent review added regression coverage and corrected further
  failures that the 225-test bundle did not catch:
  - filled positions now retain all legs and scale Greeks to filled size;
  - unpriceable positions invalidate stress/CVaR instead of silently passing;
  - terminal calibration is both written and read in the same event namespace;
  - calibration stores `P(finish below strike)` against that exact outcome;
  - replay captures the non-empty portfolio, ledger, calibration history,
    limits, approved universe, sampling configuration, internal reconciliation
    state, and distinct observation timestamps;
  - evidence schema v2 binds the full position contract and detaches evidence
    from mutable order objects;
  - durable evidence-write failure removes mutation authority;
  - authority, evidence, freshness, market session, and broker reconciliation
    are re-checked immediately before submission;
  - cash, buying power, positions, and working orders are compared against an
    independent engine mirror instead of the broker snapshot against itself;
  - material cash drift and broker-only or engine-only working orders
    quarantine the system;
  - paper/shadow observations cannot promote live authority;
  - capital moves to COMMITTED before broker submission and working orders are
    included in subsequent portfolio risk.
- The complete local suite passes from a clean process: **239/239 tests**.

## What this repository is today

The v5 `src/` tree is a capable deterministic research/shadow engine. It is
not the website currently served by the inherited deployment files:

- `index.html` is the existing **NUVO Unified v4.1** interface.
- `worker.js` is the older **NMR dealer terminal** and only fetches historical
  aggregate bars from the legacy Polygon endpoint.
- `src/dashboard/view.js` renders a terminal text view, not a browser operator
  dashboard.
- No Worker or Pages entry point imports or runs `NuvoEngine`.

Deploying the current `wrangler.toml` would therefore deploy the old NMR
Worker, not the v5 architecture.

## Production blockers

Every item below is a hard gate, not a cosmetic improvement.

1. **No demonstrated edge.** The research command uses synthetic gate output.
   A pre-registered, point-in-time, cost-aware historical implementation and
   an out-of-sample shadow record do not yet exist.
2. **No Massive production provider.** There is no normalized quote, option
   chain, Greek, history, event, entitlement, pagination, retry, rate-limit,
   or stale-data adapter implementing the v5 `DataProvider` contract.
3. **No Schwab production broker adapter.** There is no credential-tested v5
   adapter for account state, positions, tax lots, open orders, idempotent
   submit/cancel/replace, partial fills, rejects, expirations, assignments,
   or deterministic account-impact reporting.
4. **Lifecycle is not a closed loop.** Close, roll, assignment, cancellation,
   working-order recovery, and partial-fill recovery are libraries or absent;
   they are not reconciled scheduled workflows.
5. **Runtime state is not durable.** Positions, orders, capital buckets,
   authority, kill switches, calibration, and broker mirrors live in process
   memory. Cloudflare isolates may restart at any time.
6. **Distributed idempotency is absent.** The in-memory order book protects one
   process only. D1/Durable Object transactions and broker-side lookup must
   prove exactly-once intent across retries, restarts, concurrent requests,
   and at-least-once scheduled delivery.
7. **D1/R2 evidence adapters are absent.** JSONL proves the port in Node, but
   the engine has no D1 chain index/outbox and no R2 raw-input writer/readback
   verification. `externalizeRaw` currently omits the payload without storing
   it anywhere.
8. **Cloudflare v5 wiring is absent.** `wrangler.toml` has no D1 binding, R2
   binding, Durable Object/Workflow/Queue, cron trigger, preview environment,
   or v5 Worker entry point. The present Monte Carlo cycle is also too heavy
   to assume it belongs in an ordinary request handler without runtime tests.
9. **The inherited write APIs are not production-safe.** The Pages functions
   accept unauthenticated POST writes to config, positions, and watchlist with
   no authorization or schema validation. They must not become the v5 control
   plane.
10. **No browser operator console exists for v5.** The required read-only
    views, freshness indicators, reconciliation detail, evidence drill-down,
    approval audit, kill-switch controls, and explicit authority banner still
    need a web implementation and accessibility/security testing.
11. **No end-to-end production shadow proof exists.** Synthetic and paper
    tests do not validate Massive/Schwab semantics, market calendars, corporate
    actions, option symbology, tax lots, restarts, duplicate cron delivery, or
    real fill reconciliation.

## Safe deployment sequence

1. Keep the current hostname and production project untouched.
2. Create an isolated Cloudflare preview environment and separate preview
   D1/R2 resources; use read-only Massive and Schwab credentials.
3. Persist normalized observations and broker snapshots. Prove freshness,
   tax-lot, position, cash, buying-power, and open-order reconciliation.
4. Add the D1 transactional state/outbox plus R2 evidence payload adapters.
   Restart and duplicate-delivery tests must reproduce the same decision and
   never duplicate an order intent.
5. Wire the v5 engine only at SHADOW authority. The broker adapter must reject
   `submit`, `cancel`, and `replace` regardless of caller input.
6. Build the browser dashboard against read-only APIs and publish it only to a
   preview URL for design/operational review.
7. Run a pre-registered historical study and a sustained end-to-end shadow
   period. Review evidence, calibration, execution assumptions, and every
   refusal manually.
8. Only after all gates pass, conduct a separately approved canary with a new
   authority amendment, narrow allowlist, hard dollar cap, human approval,
   rollback plan, and broker-confirmed idempotency. Do not make the public-site
   cutover and live-order activation the same change.

## Current launch decision

The project is worth continuing as a disciplined research and shadow system.
The v5 engine should be previewed separately, but **production-site replacement
and autonomous trading remain blocked** by the items above.
