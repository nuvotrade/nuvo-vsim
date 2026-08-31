# LANE_1 four-action release packet — 2026-08-31

Status: **LOCAL CANDIDATE COMPLETE; NOT UPLOADED OR DEPLOYED. Backward-read finding disclosed; ship remains held.**

This packet supersedes the guard-only packet's unresolved alert-contract section.
The approved contract is now four explicit broker instructions. The guards remain
part of this same release, not a separate deployment.

No live preview, webhook, order, alert edit/creation, ARM action, credential change,
cleanup, migration, or production-data write occurred. Production identity, ARM,
and bindings were not queried during this local work. OFF/DISARMED is the required
hold, not a freshly measured production claim.

## 1. Identity and reproducibility

| Item | Identity |
| --- | --- |
| Combined source/test Git | `ffe157a0c0e23fbd43078a64d613e4fd82e445e8` |
| Included guard source Git | `198a9db26b92ad8c22bf0f7b6f9dfd25ee0798f4` |
| Production/rollback source Git | `ed08909f3b3cdab2404a790d2a2a777e1b9d8afb` |
| Last recorded Worker / rollback version | `nuvo-vsim-v5-shadow` / `42a4f738-5e2e-4e69-8c91-c451a609b3a7` |
| Candidate bundle SHA-256 | `b5dce61b1a129a8843f1b5392036e8cd241602b56cd9661830b3494bc9090e86` |
| Candidate bundle size | **1,984,156 bytes** |
| Reproduced rollback bundle SHA-256 | `8ff5da076e633838ab4828ae8e0a09e491ea7c3723a45481c96d611dbd542a65` |
| Reproduced rollback bundle size | **1,971,149 bytes** |
| Delta versus production | **+13,007 bytes**; +1,554 bytes versus guard-only |
| Candidate builds | **Three byte-identical builds**, including clean Git export |
| Toolchain | Node 24.18.0; npm 11.16.0; pinned Wrangler 4.125.0 |

Two builds are in the review worktree under `cloudflare/.wrangler/four-action-a`
and `four-action-b`. The third used `git archive` of the exact source commit in
`/tmp/nuvo-four-action-clean-3zqZ0G`, isolated locked dependencies, and no dependency
symlink. That export also passed all 672 tests. The fresh rollback build in the
canonical lineage worktree matches the previously recorded production bytes.
A fourth local build after the evidence-only additions also reproduces the same
candidate SHA and size; the full suite was rerun and remains 672/672.

The evidence/audit script and this documentation are separate from the source/test
commit. They add no runtime inputs and do not imply a new Worker version. Git
commits are local; no remote push was performed for this packet.

## 2. Backward-read result — receipt eba4d1ac

**Archive readable: PASS. Production historical receipt reader: NONE FOUND.
Backward-read through a production reader: NOT PROVEN.**

Saved receipt: `eba4d1ac-3e3f-4735-92bb-0309732c1f52`, event
`LANE_1_ORDER_PREVIEW`, timestamp `2026-08-31T17:55:40.448Z`, Worker
`42a4f738-5e2e-4e69-8c91-c451a609b3a7`.

The existing private `nuvo-preview-live-mapping/VALIDATION_RECEIPT.json` is 6,053
bytes, SHA-256 `16510810bc0badb255128c4bb0d80c83d0a99c8e289a18241311bc0e6d9fdc05`.
It is a saved export with an already-parsed `detail` object, **not original D1
wire bytes and not a fresh D1 read**. It was read in place, not copied into Git.
Before/after file hashes match. JSON decoding and detail round-trip preserve all
fields and types without error or mutation.

Preserved values:

| Historical field | Value, unchanged |
| --- | --- |
| `detail.signal` | `LONG` — an internal historical label, **not** an authored alias |
| `detail.brokerInstruction` | `BUY` |
| `detail.quantity` | numeric `1` |
| `detail.orderContract.actual.symbol` | `SPY` |
| `detail.orderContract.actual.quantity` | numeric `1` |
| `detail.replayBody.side` | `BUY` |
| `detail.tvBodyBindingSha256` | `21baaecb3006248b6bf21c186684c855d55e5255b5c004970033221762a2188c` |

The current binding function recomputes that same hash from the saved replay body.
It does not parse or translate `detail.signal`. The receipt's `rawMessage`,
`acceptedInstruction`, and `signalContract` fields are absent; no fields were
back-filled. The preview projection **writer** is byte-identical to production,
function SHA `58eb0d880c702f057d9c26a3b0988ad1e70764af9a7f918b1249d3d34b0dd3e1`.
Writer equality is not claimed as reader coverage.

Source trace explains the missing proof:

- `cloudflare/lane-1-runtime.js:107`: latest VALIDATE source queries only
  `LANE_1_TV_INGRESS`, not preview receipts.
- `cloudflare/lane-1-runtime.js:124`: direct preview lookup also filters by ingress
  event type. In the offline check, submitting this receipt ID as an ingress ID
  returns 404 `LANE_1_PREVIEW_SOURCE_NOT_FOUND`, without coordinator/network access.
- `cloudflare/worker.js:307`: health-proof query excludes `LANE_1_ORDER_PREVIEW`.
- `cloudflare/worker.js:3617`: dashboard renders the immediate VALIDATE POST
  response; it does not fetch the historical receipt afterward.

The offline check executes the actual candidate ingress selectors with a local
database adapter containing this receipt. No writes or network requests occur.
This proves exclusion from ingress replay, **not** successful receipt rendering.

### Versioning rule / disposition — no migration

1. Historical evidence remains immutable. Select interpretation by event type and
   its recorded contract/version. No contract marker means **legacy/unversioned**,
   not the new contract and not a parse failure.
2. Missing `acceptedInstruction` in an old receipt means **not recorded**. It must
   never be synthesized from `signal`, `side`, or `brokerInstruction`, and must not
   be displayed as the new explicit-null rejection result.
3. Preserve every stored value/type, including `signal: LONG`. A receipt is not a
   signal input. Do not feed historical receipt fields to the new instruction parser.
4. New ingress diagnostics carry `signalContract: LANE_1_FOUR_ACTION_V1` and
   `rawMessageFormat: REDACTED_SIGNAL_FIELDS_V1`. Unknown future versions must be
   shown as unsupported interpretation, without rewriting or inventing fields.
5. A historical receipt reader, if required, is separate scoped work with a
   fixture-based old/new/version-unknown test. **None is silently added here.**

This is an existing product gap, not evidence that the new parser corrupted a
receipt. It nevertheless means the requested runtime backward-read claim cannot
be marked green. Ship remains held for review of this finding, not a migration.

Reproducible check and output:
[check-lane1-historical-receipt.mjs](../scripts/check-lane1-historical-receipt.mjs),
[BACKWARD_READ.json](evidence/lane1-four-action/BACKWARD_READ.json).

## 3. Exact approved contract and behavioral difference

Same canonical webhook: `https://vsim.nuvotrade.co/lane/tv`. SPY, numeric quantity
1, 5-minute chart/alerts. These are the **approved contract**, not a claim that
the two short alerts already exist. Secret placeholders are not sendable payloads.

```json
{"ticker":"SPY","side":"BUY","qty":1,"secret":"[REDACTED]"}
{"ticker":"SPY","side":"SELL","qty":1,"secret":"[REDACTED]"}
{"ticker":"SPY","side":"SELL_SHORT","qty":1,"secret":"[REDACTED]"}
{"ticker":"SPY","side":"BUY_TO_COVER","qty":1,"secret":"[REDACTED]"}
```

| Position | BUY | SELL | SELL_SHORT | BUY_TO_COVER |
| --- | --- | --- | --- | --- |
| FLAT | Open long | REFUSE | Open short | REFUSE |
| LONG | REFUSE | Close long | REFUSE | REFUSE |
| SHORT | REFUSE | REFUSE | REFUSE | Close short |
| UNKNOWN | REFUSE | REFUSE | REFUSE | REFUSE |

**Intentional behavior change:** SELL while SHORT previously constructed
BUY_TO_COVER. It now refuses with `LANE_1_SELL_REQUIRES_LONG`. LONG/SHORT/EXIT
aliases no longer parse; COVER also refuses. Repeated/contradictory valid
instructions now produce named refusals before claim/send rather than the old
benign no-op dispositions. Existing FAULT handling disarms; no implicit retry.

Exact uppercase only, no trim or coercion. Parser/shape rejection remains HTTP400
`LANE_1_INVALID_SIGNAL`, `sent:false`. The controller's valid-signal state/fault
responses remain HTTP200, `sent:false`, with the named fault. Internal guard-only
`LANE_1_INSTRUCTION_UNKNOWN` is not advertised as the webhook parser response.

The seal requires the raw instruction and checks its agreement with the internal
normalized signal. Missing/mismatched intent refuses with
`LANE_1_INSTRUCTION_BINDING_MISMATCH`. The broker instruction is the authored
instruction, never selected from the position. Unknown preview coordinator
position is recorded as null, not invented FLAT.

The included guards reject unknown/malformed broker position data, compare live
Schwab versus coordinator state, preserve the 60-day complete-order-list bound,
and re-read positions/orders plus coordinator immediately before dispatch. Missing,
partial, truncated, stale, or unreachable reads refuse. The final check is not an
atomic Schwab lock; outside activity after it remains possible.

## 4. Raw diagnostics and rejection receipt

Authenticated ingress stores `rawMessage` plus `acceptedInstruction`.
Ticker/side/qty JSON **scalar** values retain exact type, case and whitespace:
`" buy "` remains `" buy "`, string `"1"` stays a string, absence stays absence.
Secret and extra/nested values are omitted by field allowlist, with `removedPaths`.
The artifact is explicitly `REDACTED_SIGNAL_FIELDS_V1`, not wire bytes. Non-scalar
expected fields are omitted with their paths recorded, not normalized.

`acceptedInstruction` is one exact allowed token for authenticated parser/shape
acceptance; it is **null** for rejected/malformed order signals. It is not broker
approval or ARM permission. TAPE remains distinct and has no order acceptance.

A malformed authenticated signal appends `LANE_1_TV_SIGNAL_REFUSED`, linked by
`sourceIngressId`, carrying the same raw fields, null acceptance, fault, HTTP400,
and `sent:false`. The HTTP response remains compatible. Valid DISARMED ingress
still writes exactly one ingress row. Wrong-secret requests write no authenticated
receipt. Existing audit writes remain best-effort: storage failure can prevent
these rows, and HTTP rejection alone is not persistence proof.

## 5. Non-replayable history — not deleted history

No historical row is updated, translated, or deleted. Classification uses the
stored **replay body's `side`**, never a receipt's internal `signal` label.

| Stored history | Candidate result | Reason / evidence scope |
| --- | --- | --- |
| Replay body `side: LONG` | NON-REPLAYABLE | Retired alias; no translation into BUY |
| Replay body `side: SHORT` | NON-REPLAYABLE | Retired alias; no translation into SELL_SHORT |
| Replay body `side: EXIT` | NON-REPLAYABLE | Ambiguous historic exit intent; no position-based reinterpretation |
| Replay body `side: COVER` or another invalid token | NON-REPLAYABLE | Not newly lost support; invalid under the approved contract |
| Missing replay body / hash, false eligibility, mismatched hash | NON-REPLAYABLE | Incomplete/unverifiable source; unchanged fail-closed rule |
| Monday ingress `327c1bcb-e57c-4f9e-9611-5f94a3ef076f`, BUY body | Binding remains valid | Saved receipt cites this source and the binding recomputes identically |
| Friday `b0db7b92…`, 23:47 row | Remains non-replayable | Previously documented absent replay body; not newly disabled, not reconstructed or edited |
| Receipt `eba4d1ac-3e3f-4735-92bb-0309732c1f52` | Archive intact; not an ingress candidate | Event type is `LANE_1_ORDER_PREVIEW`, regardless of internal `signal: LONG` |

**Affected production IDs/counts for LONG/SHORT/EXIT: UNKNOWN.** No live D1 inventory
was requested or performed for this local packet. The alias-history test uses
explicitly synthetic rows and proves selection skips/direct lookup refuses
`LANE_1_PREVIEW_SOURCE_NOT_REPLAYABLE`, with rows unchanged. It does not establish
that such live rows exist. Friday's abbreviated ID/provenance above is prior
recorded context, not a freshly recovered export. Monday's binding proof is from
the saved receipt, not a fresh ingress SELECT. An exact production affected-row
list remains a pre-switch read-only check if required; this table is not falsely
presented as that inventory.

A historic SELL replay body still means the exact SELL instruction under this
release; it is never silently covered. Its original stored evidence is untouched.
Current live position guards govern any later execution attempt, not the old row.

## 6. Tests and mutations — named accounting

Guard baseline **642/642** → combined **672/672**: **30 added, zero removed**,
zero skipped/cancelled/todo. Clean export also **672/672**. Production baseline was
573; guards added 69 and this parser/diagnostics packet adds 30.

All added names, seven edited existing-test bodies, exact old/new assertions,
five renamed/revised names, and mutation-to-test mapping are in
[VERIFICATION.json](evidence/lane1-four-action/VERIFICATION.json).
[TEST_NAME_INVENTORY.json](evidence/lane1-four-action/TEST_NAME_INVENTORY.json)
contains all baseline/candidate names and the **635 unchanged individual bodies**,
including an indexed 301 refusal-related names for review. That index is based on
titles, not a separate semantic proof or live test claim.

Existing body changes: **two assertion-changed, five fixture-token-changed**.
The two intentional assertion changes are the vocabulary test and the old
already-flat/already-in no-op test; both now assert the approved stricter semantics.
The other five update retired fixture tokens so their original intended checks
remain reachable. No claim that all renamed tests are title-only is made.

The shared preview helper's 90 existing callers retain BUY/FLAT defaults. Their
individual bodies/refusal assertions are unchanged. The helper is parameterized
for new directions and gains an independent exact-instruction assertion; the
90-caller instrumentation is listed in the verification file. Existing absent
field, numeric-type, two-leg, rejection, unknown/disagreeing-asset, capture,
retired-route and no-network guards remain covered.

| Runner | Healthy control / detected defects |
| --- | --- |
| `scripts/lane1-four-action-mutations.mjs` | **15/15** |
| `scripts/lane1-state-guard-mutations.mjs` | **26/26** |
| `scripts/check-preview-mutations.mjs` | **13/13** |
| Total | **54/54** |

Every mutation is in-memory, with a passing healthy control and a failing intended
defect. Includes restored SELL/EXIT, LONG/SHORT/COVER aliases, folding/trim/coercion,
SELL-short-cover and position reinterpretation, missing instruction binding,
normalized raw diagnostics, raw-to-accepted backfill, and omitted refusal receipt.
The additional offline historical-receipt audit is separately reported; it does
not inflate 672 into a new suite count or claim a runtime receipt reader.

## 7. Exact runtime scope and protected surfaces

Four runtime files versus production; 33 zero-context hunk entries:

- `src/lane/lane-1-position-guards.js`: pure state/order/freshness/authority guards.
- `src/lane/lane-1-spy-v2.js`: exact parser, intent seal, instruction/state refusal,
  initial and final state-guard handoff, unknown reconciliation handling.
- `cloudflare/schwab-client.js`: strict position extraction and complete bounded
  order reads; final pre-dispatch broker/coordinator comparison.
- `cloudflare/lane-1-runtime.js`: adapter wiring, no invented preview FLAT, raw/
  accepted diagnostic fields, append-only rejection receipt.

Versus the guard commit, only the lane parser/controller and lane runtime change.
Exact hunk lists versus both bases and file hashes are in `VERIFICATION.json`;
the complete production-to-candidate runtime patch is
[RUNTIME_DIFF.patch](evidence/lane1-four-action/RUNTIME_DIFF.patch).

Unchanged versus production: `cloudflare/worker.js`, `cloudflare/platform.js`,
Wrangler config, package/lockfile, capture/encryption/redaction modules and preview
response mapping/projection. No master, MARKET, cron, custody writer, OAuth,
Access, EVIDENCE, D1 schema, ACCOUNT_COORDINATOR storage, or 410-route changes.
No live binding comparison has been performed for this candidate; it remains
mandatory immediately before a separately approved traffic switch.

The canonical lineage worktree's unrelated document edit was preserved and
excluded: `docs/LANE_1_PREVIEW_LIVE_MAPPING_RELEASE.md`, SHA
`240b05d299e88a8087388a8555ae4ddd8234cd910d5bb51d2349abe332c0c551`.
Its origin remains unattributed. No silent cleanup or revert.

## 8. Stated limits, release hold, and rollback

local proofs only. Does not prove Schwab accepts SELL_SHORT
or BUY_TO_COVER, does not prove any fill, does not prove the
short alerts work — they do not exist yet.

Stage 0 completes at four real fills ending flat.

SELL acceptance/close preview is also unproven. New directional capture tests use
clearly synthetic non-2xx bytes, not invented production mappings. No new preview
receipt or fill is represented as live evidence.

**PRINCIPAL_ASSERTED · 2026-08-31 · account …315:** no SPY orders older than 60 days
exist and none will be placed. The query's claim is only no working SPY order
within its 60-day window (`maxResults=3000`, no status filter); older orders, other
accounts, and activity after the final read are not covered. This operational
assertion is not API proof. Truncated, partial, page-limited, malformed and
unreachable responses still refuse. A wider verified API remains preferable;
availability is UNKNOWN. Borrow availability is likewise Principal-asserted,
not a new pre-build gate or API confirmation.

Before any upload/switch: resolve the backward-read finding's disposition;
approve this exact source/bundle; read current version at 100%; verify env OFF
and coordinator DISARMED; compare all live bindings/runtime settings; and confirm
the named rollback. Those live checks have **not** been performed here.

After a separately approved deployment only: Principal authors the two short
alerts with the approved tokens. Separate DISARMED previews must capture each
unproven instruction's own response. If a close preview refuses while flat,
preserve/decrypt/report that refusal; do not fabricate a position or ARM to
manufacture proof. No first live ticket is authorized by this packet.

Named rollback, **not executed**, from the review repository root:

```sh
WRANGLER_SEND_METRICS=false node_modules/.bin/wrangler rollback 42a4f738-5e2e-4e69-8c91-c451a609b3a7 --config cloudflare/wrangler.jsonc
```

Rollback restores the old parser behavior, including SELL's old exit-either-side
meaning, and removes these new guards. It does **not** undo append-only D1/R2
evidence, change stored coordinator state, or switch off alerts. Therefore stay
DISARMED and keep new short alerts stopped if rollback is ever authorized.

Local reproduction (no uploads):

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
node scripts/lane1-four-action-mutations.mjs
node scripts/lane1-state-guard-mutations.mjs
node scripts/check-preview-mutations.mjs
WRANGLER_SEND_METRICS=false node_modules/.bin/wrangler deploy --dry-run --config cloudflare/wrangler.jsonc --outdir .wrangler/four-action-review
node scripts/check-lane1-historical-receipt.mjs /Users/nuvo/Documents/Codex/2026-08-31/nuvo-preview-live-mapping/VALIDATION_RECEIPT.json
```

The last script requires the existing private receipt and belongs to the separate
evidence commit; it is not available by checking out only the earlier runtime
commit. It performs no network activity and no writes to the receipt.
