# Live-derived preview mapping — one release packet

2026-08-31. Principal approved one mapping packet, one deployment, one VALIDATE of ingress `327c1bcb-e57c-4f9e-9611-5f94a3ef076f`. ARM stays OFF/DISARMED. No new alert, order, cleanup, credential change, or master change.

## Behavioral diff

Two runtime files only:

1. `cloudflare/schwab-client.js`: use the captured response's `orderStrategy.quantity` (strict number equal to 1) together with exactly one `orderLegs` element. Read symbol only from `orderLegs[0].instrument.symbol`, strictly `SPY`. Require both leg and instrument asset fields to be members of `EQUITY | COLLECTIVE_INVESTMENT` and equal. No coercion or old-field fallback. Existing instruction matching, MARKET/SINGLE/NORMAL/DAY, no children/mixed request shape, omitted-versus-malformed validation handling, and nonempty reject/review refusals remain.
2. `cloudflare/lane-1-runtime.js`: record those same actual values on success and refusal, explicit mapped paths, both asset fields, shared asset policy, and original field types (missing/null/array/object/string/number/boolean remain distinguishable). Values remain restricted by the existing redaction allowlist; no new sensitive fields are persisted.

Outgoing order construction, authenticated ingress/replay, two ARM checks, coordinator behavior, network destination guard, capture encryption/redaction, D1 schema, R2 bindings, Worker routes, crons, UI code, OAuth and master are unchanged. The retired preview/flatten routes remain 410. The old multi-direction validation function is still behind a retired route; this release does not activate it or prove a live SHORT preview.

## Source and byte identity

- Base Git: `86df03d8eb86ed7cbbeab84296cc14c31ba16819`.
- Immediate predecessor and rollback: `c567783f-0d50-40fa-b7c5-68e3a2cecd2e` (capture-only).
- Base bundle SHA: `b2c1da801481310ed50bfd5292cb184d6b0a73a8daaa3b026db89a30c7871510`, 1,969,832 bytes.
- Candidate bundle SHA: `8ff5da076e633838ab4828ae8e0a09e491ea7c3723a45481c96d611dbd542a65`, 1,971,149 bytes; **+1,317 bytes**.
- Two independent candidate builds match. Baseline exported from its commit reproduces the base SHA with an isolated dependency directory.
- Build note: an initial temporary baseline with symlinked dependencies changed source-path comments in the bundle. Replacing that temporary link with an isolated dependency copy reproduced the baseline bytes without source/config edits. Do not claim symlink-layout output is byte-identical.
- Wrangler remains pinned at 4.125.0; no dependency/config/compatibility-date update. The candidate Git SHA is the commit containing this packet; record its full SHA and eventual Cloudflare version in the external execution report and upload annotation, avoiding a self-referential commit hash.

## Test accounting and evidence

Full suite **549 → 572**, all passing, 66 suites, no skips. **23 added, 0 removed**; 64 existing tests have fixture/direct edits, including 14 renamed/replaced titles. Exact old/new names, substitution scope, different passing reasons and refusal preservation are in `LANE_1_PREVIEW_MAPPING_TEST_AUDIT.md`.

The additional offline mutation runner detected **12/12** deliberate guard/projection defects. It edits loaded source only in child-process memory, never application files or a live Worker. The core negative cases include absent real fields with tempting legacy fallbacks, string `"1"`, two legs with order quantity one, nonempty rejects/reviews, unknown matching assets, and allowed-but-disagreeing assets. The unchanged live warns-only body passes; the outgoing test ticket remains BUY/SPY/1/MARKET/DAY and the network stub only admits `/previewOrder`. Coordinator claims remain zero and the source row is unchanged in each integration case.

Fixture: captured inspection parent original SHA `73646c14e46642dee8d9dd752cc11efb561d70501eb34c13b611439697ccd3a4`; canonical inspection SHA `ee10f96829bee206f98ed6013b0bd6b8ab143a49078d71da157412b05d02131f`. Fixture identity is asserted. Alternate directions/classifications are explicitly synthetic mutations, not additional live receipts.

## File/hunk scope

- `cloudflare/schwab-client.js`: one frozen asset allowlist; one response contract-check block.
- `cloudflare/lane-1-runtime.js`: import shared allowlist; receipt projection; pass original for type metadata.
- `test/helpers/schwab-preview-order.js`: replace document-derived helper with cloned live inspection body; label synthetic direction mutations.
- `test/fixtures/schwab-preview-20260831.inspection.json`: versioned redacted live fixture only.
- `test/lane-1-ingress-preview.test.js`: corresponding field mutations, receipt assertions, live compatibility case and 23 new cases.
- `test/lane-1-production-adapters.test.js`: fixture-helper rename/import and two calls only; throws/refusals unchanged.
- `scripts/check-preview-mutations.mjs`: offline fault-injection verification, not bundled.
- `docs/LANE_1_PREVIEW_MAPPING_TEST_AUDIT.md` and this packet: audit/release record, not bundled.

## Release gate and rollback

Before traffic changes: check predecessor at 100%; environment ARM OFF; dashboard/coordinator DISARMED and exact morning source ID. Upload once with candidate Git/bundle annotation, inspect the uploaded version, and compare all bindings and runtime settings against capture-only. Stop on any mismatch. Do not deploy triggers or change preview-host settings.

After the one approved deployment: verify candidate at 100%, environment OFF, fresh dashboard DISARMED and source ID. Click VALIDATE once; do not retry. Read the new D1 receipt and confirm actual SPY/numeric 1 on mapped paths, warning/reject classification, capture hashes, matching source binding, coordinator unchanged and `sent:false`. No /orders dispatch and no new TV signal. Stop and report even if Schwab refuses.

Immediate rollback, not an instruction to execute now:

```sh
node node_modules/wrangler/bin/wrangler.js rollback c567783f-0d50-40fa-b7c5-68e3a2cecd2e --config cloudflare/wrangler.jsonc --message "Rollback live mapping; preserve encrypted capture; ARM OFF" --yes
```

Rollback removes this mapping/projection change while retaining encrypted capture. It does not undo append-only evidence. Read-only Cloudflare inspection confirmed the older `98f7b19a-7874-49e9-b3a3-7f1a697acaa4` version is annotated to Git `aab2f6e8f677fbc41f5435268218880c5870081e`, bundle `2a9fb432796b9e6409c856e8eb78ec0ac39551104b8e225117f147a212a20223`: the pre-capture preview implementation, not the immediate mapping rollback.

Cloudflare rollback behavior reference: https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/
