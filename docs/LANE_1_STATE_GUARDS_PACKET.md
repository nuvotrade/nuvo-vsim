# LANE_1 state guards — local review packet, 2026-08-31

Status: **GUARDS BUILT; NOT DEPLOYED. Four-direction release remains held.**

No TradingView editor opened. No alert, webhook, preview, real broker order, ARM,
deployment, cleanup, secret change, or production-data write was performed.
Tests intercept broker HTTP; their successful POSTs are synthetic, not live proof.
Production was not queried during this work. ARM was not changed.

## Identity and rebuild

| Item | Identity |
| --- | --- |
| Baseline source | `ed08909f3b3cdab2404a790d2a2a777e1b9d8afb` |
| Guard source/test commit | `198a9db26b92ad8c22bf0f7b6f9dfd25ee0798f4` |
| Review branch | `codex/lane1-state-guards-20260831` |
| Last recorded production / eventual rollback target | `nuvo-vsim-v5-shadow`, version `42a4f738-5e2e-4e69-8c91-c451a609b3a7` |
| Baseline bundle, reproduced this turn | `8ff5da076e633838ab4828ae8e0a09e491ea7c3723a45481c96d611dbd542a65` · 1,971,149 bytes |
| Guard bundle, two identical builds | `ecb735b497a031d05e78b3930c349b2c024f20bbaf1c96060d0cc541674626bb` · 1,982,602 bytes |
| Runtime bundle delta | +11,453 bytes |
| Toolchain | Node 24.18.0, npm 11.16.0, pinned Wrangler 4.125.0 |
| Dependencies | Isolated `npm ci --ignore-scripts --no-audit --no-fund`; no dependency changes or symlinked dependency tree |

Review worktree: `/Users/nuvo/Documents/Codex/2026-08-31/nuvo-vsim-lane1-state-guards`.
It shares the existing Git repository; it is not another deployment or Git root.
Builds are under `cloudflare/.wrangler/guard-final-a/entry.js` and
`cloudflare/.wrangler/guard-final-b/entry.js` in that worktree. Baseline rebuild is
under `cloudflare/.wrangler/guard-baseline/entry.js` in `nuvo-vsim-155-lineage`.

Reproduce locally from the guard source commit:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
node scripts/lane1-state-guard-mutations.mjs
node scripts/check-preview-mutations.mjs
WRANGLER_SEND_METRICS=false node_modules/.bin/wrangler deploy --dry-run --config cloudflare/wrangler.jsonc --outdir .wrangler/guard-review
```

Only `--dry-run` was executed. No candidate version was uploaded.

## Behavior difference

1. Missing/null/malformed `securitiesAccount.positions`, unidentified position rows,
   or missing/non-numeric SPY quantities refuse. An explicit valid empty positions
   array can establish FLAT; omitted data cannot. Gross exposure must also fit one
   share: netting +2/-1 or +1/-1 is not accepted.
2. Initial live positions and the bounded orders list are checked before a claim.
   Unknown broker/coordinator state extends `LANE_1_POSITION_STATE_DRIFT`; the
   detail names `BROKER_POSITION_UNKNOWN`, `COORDINATOR_POSITION_UNKNOWN`, or the
   changed field. Known coordinator/broker disagreement retains the existing
   `reconciliation-required` no-send disposition. Unknown reconciliation state
   now faults instead of being skipped.
3. A separate, pure guard checks explicit broker instructions against position
   state. It does **not** parse TradingView messages, infer direction, or change
   the existing TV aliases.
4. Immediately before the existing market POST, after credential/account
   selection, positions and orders are fetched again. The account, gross position,
   query floor, and relevant terminal-order identities must agree. A newly filled
   external round trip can therefore invalidate the check even when quantity is
   still flat. Working/pending SPY orders refuse; all legs and nested children are
   inspected, including children of terminal parents.
5. The latest coordinator state must still be ARMED, unexpired, in the matching
   sending stage, and hold the same client ID/instruction with no accepted order.
   The final broker read must be at most 5 seconds old, measured from its start.
   Missing baseline/check callback, read failure, partial data, changed state, or
   expired authority refuses before POST. There is no send retry.

These checks do not create an atomic lock at Schwab. Outside activity after the
last read or during the network handoff remains possible. No claim of eliminating
that broker-side race is made. A failed check after a claim uses the existing
FAULT/disarm path and leaves evidence/state for reconciliation; it does not clear
or reuse the claim silently.

## Explicit internal state machine (numeric quantity 1)

| Known position | BUY | SELL | SELL_SHORT | BUY_TO_COVER |
| --- | --- | --- | --- | --- |
| FLAT | Open LONG | Refuse S | Open SHORT | Refuse C |
| LONG | Refuse B | Close LONG | Refuse SS | Refuse C |
| SHORT | Refuse B | Refuse S | Refuse SS | Close SHORT |
| UNKNOWN | Refuse U | Refuse U | Refuse U | Refuse U |

- B: `LANE_1_BUY_REQUIRES_FLAT`
- S: `LANE_1_SELL_REQUIRES_LONG`
- SS: `LANE_1_SELL_SHORT_REQUIRES_FLAT`
- C: `LANE_1_BUY_TO_COVER_REQUIRES_SHORT`
- U: `LANE_1_POSITION_STATE_DRIFT:POSITION_UNKNOWN`
- Wrong quantity: `LANE_1_QUANTITY_MUST_BE_ONE`; unknown instruction: `LANE_1_INSTRUCTION_UNKNOWN`.

Other distinct refusals: `LANE_1_WORKING_ORDER_PRESENT`,
`LANE_1_WORKING_ORDER_STATE_UNKNOWN`, `LANE_1_ORDER_READ_LIMIT_REACHED`,
`LANE_1_ORDER_READ_INCOMPLETE`, `LANE_1_PRE_DISPATCH_ORDER_STATE_CHANGED`,
`LANE_1_PRE_DISPATCH_READ_STALE`, `LANE_1_SEND_SNAPSHOT_REQUIRED`,
`LANE_1_DISPATCH_COORDINATOR_REQUIRED`, `LANE_1_DISPATCH_CLAIM_CHANGED`,
`LANE_1_ARM_WINDOW_EXPIRED`, and `LANE_1_DISARMED`.
Broker HTTP/read errors remain errors, never empty order lists.

## 60-day bound — DOCUMENTED LIMITATION, not a release hold

**PRINCIPAL_ASSERTED · 2026-08-31 · account …315:** no SPY orders older than
60 days exist, and none will be placed. This is the Principal's assertion,
not an API observation, historical audit, or technical guarantee. It is not an
additional ARM gate. No refusal was weakened because of this assertion.

Query: account-scoped `GET /accounts/{hash}/orders`, `fromEnteredTime` = initial
read time minus 60 days, `toEnteredTime` = each read time plus 60 seconds,
`maxResults=3000`, **no status filter**. The initial query floor is reused for the
final read so the comparison covers the same interval plus intervening activity.
Snapshot metadata carries both dates and the exact bound:
`NO_WORKING_SPY_ORDER_IN_60_DAY_QUERY`.

What it does **not** establish: absence of orders entered before the query floor,
absence in other accounts, or absence after the last broker read. Unknown broker
omissions cannot be detected merely because an HTTP body looks complete.

Refusals are mandatory for 3,000 or more returned top-level rows; non-array or
malformed bodies; partial HTTP status (including 206); known pagination/truncation
headers; inconsistent `x-total-count`; and oversized/unreadable bodies. Pending
cancel/replace remains working, not terminal. Explicit pagination metadata in an
object instead of the expected array also refuses.

Wider/unbounded open-orders API availability: **UNKNOWN**. The repository uses
the dated orders endpoint. The official developer specification page did not
expose a readable schema to the public documentation check. No authenticated
broker request or browser session was used to guess another endpoint. Prefer a
verified wider/unbounded endpoint if one is established later; the assertion
removes this release blocker, not that preference.

## Test accounting

Baseline rerun: **573/573**. Candidate: **642/642**. **69 added, zero removed,
zero renamed**, no skipped/cancelled/todo tests. All added names and exact mutation
targets are in [VERIFICATION.json](evidence/lane1-state-guards/VERIFICATION.json).

- 38 new pure guard tests: every state/instruction cell, strict unknown/quantity
  handling, order structure/limits, identity, freshness, authority, and positive controls.
- 26 new broker/runtime tests: four synthetic legal directions; exact refusal
  plus zero POST for drift, malformed/partial/capped data, unreachable broker,
  changed authority, and missing guard inputs; full adapter wiring checked.
- 5 new controller/reconciliation tests: unknown broker/coordinator cases and
  unchanged DISARMED behavior, including no broker read/claim on that path.

Existing-test edits are limited to two files:

| File | Existing assertions / fixture changes |
| --- | --- |
| `test/lane-1-spy-v2.test.js` | Existing assertions and titles retained. Shared synthetic position fixture now supplies explicit numeric quantities, account, timestamps, and bounded order fingerprint. Existing positive send tests gain an assertion that the exact snapshot reaches the broker adapter. Five new tests appended. |
| `test/lane-1-production-adapters.test.js` | Only “durable dashboard ARM authorizes only the V2.1 lane market send while env stays OFF” gains synthetic live-read/claim inputs. Its existing zero-send refusal and exact-order assertions are unchanged. |

No previous expected-refusal assertion was removed, rewritten, or made a comparison
against a missing field. Synthetic state fixtures are explicitly labeled synthetic;
they are **not** new TradingView messages or production Schwab response fixtures.

Mutation proof: **26/26** state/dispatch mutations detected, including unknown
state, comparison bypass, each illegal-direction gate, broker-unreachable treated
as empty, partial responses, final DISARM, stale reads, and skipped runtime wiring.
Each selected test passes healthy, then fails an assertion with its intended
in-memory defect. Application files are never changed by the mutation runner.
The existing preview mutation runner also remains **13/13**, unchanged.

## Runtime hunk scope and unchanged controls

Four runtime files only:

- `src/lane/lane-1-position-guards.js`: new payload-independent guards.
- `src/lane/lane-1-spy-v2.js`: import, initial snapshot/agreement, instruction guard,
  snapshot handoff to both send branches, unknown reconciliation handling.
- `cloudflare/schwab-client.js`: import, opt-in complete-order-list read checks,
  strict position extraction, bounded live snapshot, mandatory final send checks.
- `cloudflare/lane-1-runtime.js`: broker adapter passes snapshot/client identity
  and supplies a current coordinator reader.

No edits to `cloudflare/worker.js`, `cloudflare/platform.js`, Wrangler config,
package/lockfile, bindings, crons, custody snapshot writer, auth/secret comparison,
preview capture/redaction, receipt projection, or retired 410 routes.
Local config equality is verified; no claim of a new live 49-binding audit is made.

Exact baseline equality checks:

- TV normalization function SHA-256: `b2c0bed814a083d25c19a343141ddeee2e9a381c449272f11e5c8fc03eb46508`
- Preview method SHA-256: `db0ac988404dc8f2f45929e167245ad1fed2c9e400cf88311c2b6296fe644e34`
- Receipt projection SHA-256: `58eb0d880c702f057d9c26a3b0988ad1e70764af9a7f918b1249d3d34b0dd3e1`

The unrelated dirty document in the canonical worktree was preserved, not staged:
`docs/LANE_1_PREVIEW_LIVE_MAPPING_RELEASE.md`, SHA-256
`240b05d299e88a8087388a8555ae4ddd8234cd910d5bb51d2349abe332c0c551` before/after.

## Hold, next input, and rollback

Still required: **four Principal-supplied alert message strings, verbatim except
the secret replaced by `[REDACTED]`**. Chart and current alerts being 5m is accepted
as closed. Editors remain closed. No conclusion about two versus four alerts is
drawn from names, and no raw-instruction parser was written.

The current legacy parser still means SELL/EXIT can close either side. The new
internal state table does not claim to fix that alert contract. Once the strings
arrive, determine whether the alert layer expresses all four explicit instructions.
If it cannot, the Principal must change the Pine/alert set before parser work.

Four-direction broker mapping/capture remains separate and unproven except for
the previously proven BUY. SELL_SHORT, SELL, and BUY_TO_COVER need their own
DISARMED receipts; flat-position close refusals must be captured, not bypassed.
Borrow remains Principal-asserted, not API-proven and not a build gate.
ARM stays OFF; no deployment or validation is authorized by this packet.

If this guard release is approved and deployed later, the immediate predecessor
recorded here is `42a4f738-5e2e-4e69-8c91-c451a609b3a7`, **not** capture-only
`c567783f…`. Reverify live identity, OFF/DISARMED, and bindings before any switch.
Prepared rollback command (not executed):

```sh
node_modules/.bin/wrangler rollback 42a4f738-5e2e-4e69-8c91-c451a609b3a7 --config cloudflare/wrangler.jsonc
```

Rollback changes code; it does not wipe coordinator claims/faults, D1, R2,
credentials, or undo a broker order. Production state must be reconciled separately.

Cloudflare review guidance informed the awaited, bounded, no-new-binding checks:
[Worker practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/),
[Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/).
Current Worker type signatures were inspected without changing project dependencies.
