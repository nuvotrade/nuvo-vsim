# Lane-1 omission-only preview parser candidate — 2026-08-31

## Status: LOCAL ONLY; schema verification blocks upload and deployment

The Principal authorized the proposal, including verification that Schwab's
documented preview schema permits omitted validation lists. That condition is
not yet satisfied. The Schwab Developer Portal is signed out; its public product
catalog did not expose the response schema. The observed receipt proves omission
occurred, not that omission is contractually equivalent to an empty list.

The Principal was asked to sign into the developer portal in Chrome. Do not
upload, deploy, or run another live preview until that schema has been checked.
No credential, authentication policy, broker order, ARM state, or ingress was
changed during this work. No alert was sent. No live VALIDATE was pressed.

## Exact scope

- `cloudflare/schwab-client.js`: only `previewLane1V21Market` changes. A present
  object validation result may omit lists. Present lists must be arrays; null,
  scalar, and object values still refuse. Any nonempty rejects or reviews still
  refuse, even if their contents say WARN. Warnings and alerts remain evidence,
  not newly waived reviews. Existing echoed-order checks are unchanged.
- `cloudflare/lane-1-runtime.js`: keep returned validation fields and types on
  successful proofs as well as refusal receipts. Add a bounded allowlisted
  expected/actual order summary so the next contract mismatch is diagnosable.
  Do not save the full response, account identity, token, or ingress secret.
- `test/lane-1-ingress-preview.test.js`: omission, malformed shape, explicit
  reject/review, warning retention, raw hash, and echoed-order mismatch tests.
- This document records the hold and handoff.

No route, authorization check, order builder, coordinator operation, live order
method, configuration, cron, binding, secret, master Worker, or cleanup change.
The retired routes remain 410. The same-row binding and two ARM guards remain.

## Source and build identity

- Parent Git: `0bdabdabc3b103a6b6696816e0409366ee7d559a`.
- Candidate branch: `codex/preview-optional-lists-20260831`.
- Candidate Git identity is the commit containing this document; obtain with
  `git rev-parse codex/preview-optional-lists-20260831`.
- Parent bundle SHA-256:
  `09d73e0ab872f30299ec3dd127354a7efa2c10f20110bab7e20492e3ef012790`.
- Parent bundle bytes: 1,954,379.
- Candidate bundle SHA-256:
  `73a22d76e5b75603bc7245db00dcf40fce6acf2432d73c9ceb20aec82e687c71`.
- Candidate bundle bytes: 1,955,995; increase 1,616 bytes.
- Two independent Wrangler 4.125.0 dry runs produced identical `entry.js` bytes.
- No version was uploaded; no candidate Cloudflare version ID exists.

## Test accounting

Baseline: 476 tests, 66 suites, all passing.
Candidate: 518 tests, 66 suites, all passing; zero skipped or pending.

The prior missing-lists refusal case is replaced by four omission success cases.
Added: 20 explicit malformed-list cases, five malformed validation-object cases,
two nonempty rejection/review cases with the other list omitted, 11 echoed-order
mismatches, and one missing echoed-order case. Net increase: 42 tests.
The existing warning success test additionally asserts retained warnings/alerts
and exact expected/actual order evidence. Exact names are in the test file.

The existing `/lane/tv` disarmed regression, pre-schema refusal, both ARM guards,
coordinator no-claim/state equality, and `/orders`-before-network refusal tests
remain passing. Tests mock broker responses; they do not prove the external
schema or successful live preview.

## Live baseline and rollback

Read-only deployment status still shows 100%:
`bbfded7b-dba5-4579-886c-75e80c5e7317` on `nuvo-vsim-v5-shadow`.

If this candidate later deploys and requires rollback, from the canonical repo:

```sh
node node_modules/wrangler/bin/wrangler.js rollback bbfded7b-dba5-4579-886c-75e80c5e7317 --config cloudflare/wrangler.jsonc --message "Rollback omission-only preview parser; preserve receipt capture" --yes
```

No database migration or destructive data change is involved. Any later
preview proof is append-only and remains history after rollback.

## Remaining sequence — do not skip the first condition

1. Read Schwab's authoritative response schema. Record whether `rejects` and
   `reviews` are optional, plus any documented acceptance semantics. If the
   schema contradicts this candidate, stop and revise; do not reinterpret it.
2. Recheck clean Git, reproduce the committed bundle, and preserve the rollback.
3. Confirm live version and unchanged bindings, environment ARM OFF and durable
   DISARMED. Upload/deploy only this candidate under the existing authorization.
4. Press VALIDATE exactly once for Monday ingress
   `327c1bcb-e57c-4f9e-9611-5f94a3ef076f`, timestamp
   `2026-08-31T15:33:13.437Z`, body SPY / BUY / 1, binding SHA
   `21baaecb3006248b6bf21c186684c855d55e5255b5c004970033221762a2188c`.
5. Record the new proof or exact refusal. Verify no order dispatch and ARM still
   off; stop. A further mismatch is a finding, not permission to weaken checks.

No new TradingView alert, no fabricated ticket, no ARM, no `/orders`, no cleanup.
The prior ingress and refusal receipt remain untouched.
