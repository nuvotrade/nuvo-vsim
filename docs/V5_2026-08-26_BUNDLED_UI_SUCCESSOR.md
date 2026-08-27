# NUVO VSIM V5 bundled-UI successor record — 2026-08-26

## Release identity

- Predecessor tag: `v5-2026-08-26-consolidated`
- Successor tag: `v5-2026-08-26-consolidated-ui-bundled`
- Worker: `nuvo-vsim-v5-shadow`
- Worker version: `cd5a0ca8-6858-4d83-8dff-23c860ad8b14` (version 123)
- Version creation: `2026-08-27T04:54:17.732221Z`
- Code commit that produced the Worker artifact: `e814e249ba0e7b79cc70646ac563ac3bea2b86d6`
- Worker entry size: `1,764,848` bytes
- Worker entry SHA-256: `74f90bc31777953bd2a5a4be208beb059993d1b9c37844d9cfc2c60460fe4a37`
- Cloudflare script ETag: `5d4289192b9bd5b41c88cbebddb44a7d22d71f63be6b3b4102e7a22bb38ae3a6`

This is the successor to the original consolidated checkpoint. The predecessor tag remains immutable and can still restore version 122. This successor makes the checkpoint complete by placing the reviewed interface and the Worker backend under the same version-controlled source tree.

## Recovered interface provenance

As of 2026-08-26, the reviewed V5 interface was outside Git. It existed in an original Codex output directory and in pinned Pages preview deployment `c8c17621.nuvo-vsim-v5-preview.pages.dev`. Losing both copies would have made the five-tab dashboard, realized-P&L calendar, and Phase 1 risk instrumentation unrecoverable even though the backend preservation tag appeared complete.

Before copying anything into the repository, the local source files were downloaded from the pinned deployment and compared byte for byte. All three matched:

- `cloudflare/design/index.html`: `1630efa01047645b723ecc69452b919953bfc6230b2c44c83cc132b563d34fb6` (`19,461` bytes)
- `cloudflare/design/styles.css`: `0f42575c47f7883a223a578220e37623b0806db2a6a49d94c22b48e8c164bb48` (`17,083` bytes)
- `cloudflare/design/app.js`: `a851dac026ae4c444ff7f37225f926ff7c6fb7056a5354cee879480bc2e72970` (`1,201` bytes)

The raw files are now the source of truth. `scripts/build-design-assets.mjs` generates `cloudflare/design-assets.js`; the generated module is build output. Tests pin the deployment hashes, compare the raw bytes with the generated constants, and fail if either side drifts.

From a clean clone, run this from the repository root:

```bash
shasum -a 256 -c cloudflare/design/SHA256SUMS
npm run build:design-assets
npm test
```

`cloudflare/design/SHA256SUMS` uses repository-root-relative paths so the command does not depend on the caller first changing into the design directory.

## Runtime change

`cloudflare/worker.js` no longer fetches dashboard HTML, CSS, or JavaScript from the pinned Pages preview during a request. It serves the bundled assets and still preserves the protected operator console as a fail-safe if dashboard rendering throws. The failure path is exercised by an injected render-failure test.

The live Worker artifact contains neither `c8c17621.nuvo-vsim-v5-preview.pages.dev` nor `DESIGN_ORIGIN`. One `DESIGN_UNAVAILABLE` string remains intentionally as the tested fail-safe diagnostic.

## Verification

- Focused production-adapter tests: 54 passed.
- Full suite: 378 passed across 66 suites; 0 failures.
- Local dry-run entry and downloaded live version-123 entry are byte-for-byte identical.
- Both entries are `1,764,848` bytes and hash to `74f90bc31777953bd2a5a4be208beb059993d1b9c37844d9cfc2c60460fe4a37`.
- `https://vsim.nuvotrade.co/` renders the five-tab V5 dashboard, not the fail-safe console.
- `https://vsim.nuvotrade.co/?v=cd5a0ca8#overview` renders the same dashboard.
- Overview, Underwrite, Performance, Decisions, and System all loaded through the service-bound Pages front door.
- The August 2026 `ALL` calendar endpoint returned 138 lifecycles, `+$3,609.53`, and the visible `RECONCILED` badge.
- URL state for `pnlMonth`, `pnlScope`, `pnlFrom`, and `pnlTo` survived loading and filtered the shared ledger drill-down to seven Aug. 12 trades without changing lifetime KPIs.
- A live proxied `POST /api/cash-secured-put/calculate` completed. After-hours blocked/stale data produced `NO DATA` with the explicit infrastructure/input-failure explanation; it did not misclassify the result as `NO CAPITAL` or `NO EDGE`.
- The calculator POST did not append a sealed evidence package. The preserved and post-check chain head is still sequence 61, hash `163fd237cbcf143cb1311a353bbfb69370726b552ec60825f8115372b3563e8f`.

**Correction recorded 2026-08-27:** the two preceding calculator conclusions were false. The POST returned HTTP 503 because `evidence_index` rejected Authority 2 under its Authority-1-only check constraint. The UI collapsed that persistence failure into a plausible `NO DATA` refusal. The unchanged chain head was evidence of a stalled decision stream, not expected refusal behavior. This check did not validate gate ordering. Authority-2 evidence and the `execution-cost-v2` stamp remain unverified until storage compatibility is corrected and a new record seals successfully.
- Live version-123 request logs for the final bare-root and URL-state reloads showed successful responses with empty application log arrays and no `DESIGN_UNAVAILABLE` event.
- The Worker footer reported `cd5a0ca8-685…`, matching the deployed version.

The calculator's active `Specify manually` and `Cash-secured puts` controls currently use the outlined treatment while inactive controls appear filled. State and content are correct, but the visual convention can read backwards. This is recorded as a separate UI finding and was not changed in this deployment.

## External checkpoint

The downloaded live artifact, matching local dry-run artifact, version metadata, release identity, and checksums are stored outside Git at:

`/Users/nuvo/Documents/Codex/2026-08-23/vsim-v5-checkpoints/2026-08-26-consolidated-precommit/cloudflare/successor-cd5a0ca8`

Verify it with:

```bash
cd /Users/nuvo/Documents/Codex/2026-08-23/vsim-v5-checkpoints/2026-08-26-consolidated-precommit/cloudflare/successor-cd5a0ca8
shasum -a 256 -c SHA256SUMS
cmp local-dry-run.entry.js live-worker.entry.js
```

## Rollback

Rollback the deployed Worker without rebuilding:

```bash
cd /Users/nuvo/Documents/Codex/2026-08-23/referenced-chatgpt-conversation-this-is-an-2/work/claude-review.8xjXJ5
npx wrangler rollback 0139fd54-8237-40ae-8ae9-e27261b936b1 \
  --name nuvo-vsim-v5-shadow \
  --config cloudflare/wrangler.jsonc \
  --message "Rollback bundled UI successor to v5-2026-08-26-consolidated" \
  --yes
```

Restore source for the successor release:

```bash
git fetch origin --tags
git switch --detach v5-2026-08-26-consolidated-ui-bundled
npm ci
shasum -a 256 -c cloudflare/design/SHA256SUMS
npm test
```

No DNS, Pages binding, Access policy, Schwab OAuth registration, storage binding, scheduler, or Guardian cadence changed in this release. Do not restore D1 or R2 to roll back UI code; doing so would discard valid append-only history.
