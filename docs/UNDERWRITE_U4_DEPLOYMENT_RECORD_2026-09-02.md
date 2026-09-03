# UNDERWRITE U4 DEPLOYMENT RECORD — 2026-09-02

## Outcome

- Status: `DEPLOYED`
- Traffic: `100% U4`
- Switch count: one
- Deployment ID: `78c12de2-8417-4fbf-b77e-4a71fe609e34`
- Version ID: `1ef35dc2-b8c9-4bf6-9e0a-9342cafa22ef`
- Version number: `194`
- Script etag: `55957fe91c646e1378b129ce565ea51c95db8258c16d72989b7280bb8dc2699d`
- Switched: `2026-09-03T06:43:07.780141Z`
- Implementation commit: `2ff8f09` (`Deploy Underwrite U0-U4 read-only engine`)

## Sealed input

- Absolute config: `/Users/nuvo/.codex/.chatgpt-projects/g-p-6a8f887336308191a81e7bbda9e1bdd8/work/nuvo-vsim-post-fill-repair/cloudflare/wrangler.jsonc`
- Dry bundle SHA-256: `68e5686c7ad0ec14e072a366c706baad64c6b6618f28bb54ae3472184e92edf5`
- Dry bundle size: `2,224,124 bytes`
- Tests: `805/805 PASS`
- Review packet SHA-256: `dc3ebfc281b2d6e2f0fc03d744bca5324e5456c92db90c2ccbea2011cf3a950d`
- Manifest SHA-256: `38bb60b833d55474f3a330071373190366b12af568cacc6dffa4beb37494a3e4`
- `mutation_eligible: false`

The bundle was rebuilt from the exact absolute config after the implementation
commit and reprinted the sealed SHA and size. U4 required no database migration.

## Candidate and binding comparison

The candidate was uploaded first at zero traffic as version
`1ef35dc2-b8c9-4bf6-9e0a-9342cafa22ef`, tagged
`underwrite-u4-68e5686c`. Production remained 100% U3.1 during inspection.

- U3.1 bindings: 49
- U4 bindings: 49
- Exact matches: 49
- Mismatches: 0
- Runtime match: yes
- Handler match: yes
- Durable Object namespace, Workflow, D1, R2, market service, queue, secrets,
  compatibility date, and environment values: unchanged

## Switch and post-switch verification

Immediately before the switch, Cloudflare reported only U3.1 version
`310aefde-9fe9-4a0c-ab65-2e15807da601` at 100%. U4 then received one 100%
percentage switch. Cloudflare now reports only U4 version
`1ef35dc2-b8c9-4bf6-9e0a-9342cafa22ef` at 100%.

Fresh authenticated post-switch account truth:

- Schwab: `CONNECTED`
- Reconciliation: `CAPTURED`, zero mismatches
- Positions: SOFI 1,000 shares; CBRS 600 shares; six short CBRS 2026-09-04
  $200 calls
- Open orders: zero
- Margin debit: zero
- Account truth as-of: `2026-09-03T06:43:16.329Z`
- Reconciliation ID: `53ae922b-bc01-43df-bab9-f6120bd3a6c1`

Fresh market truth returned `CLOSED` and `MARKET_DATA_BLOCKED`. That is the
required overnight boundary: U4 must not substitute stale executable prices and
therefore cannot produce a current HOLD/CLOSE/ROLL comparison until a verified
option session and fresh bid/ask data are available.

The deployed route is GET-only, returns `mutation_eligible: false`, contains no
order action, and does not rank or recommend a path. Its closed/stale-session
behavior, executable ask-to-close and bid-to-open sides, shared U1 PRIMARY model,
single present-value clock, New York expiry clock, GARCH-or-nothing rule, and
100-share contract-unit checks are covered by the passing production-bundle
fixtures.

No lane, alert, coordinator, broker-order, trade, or database-mutation endpoint
was called during deployment. The account/custody proof confirms broker state
was unchanged. The rendered ARM label and live U4 table were not visually
inspected because the available Chrome automation was blocked by an
administrator-enforced browser security check; no bypass was attempted. A live
numerical U4 table also cannot be honestly validated while the market is closed.

## Rollback safeguard

The control plane confirmed the exact version immediately preceding U4:

- Rollback version: U3.1 `310aefde-9fe9-4a0c-ab65-2e15807da601`
- Rollback bundle SHA-256:
  `76eb4ee2dee0b5f6a7927f072cf4a8b0d8c9c8cd6ffea49093f53db1b7609dbb`
- Rollback script etag:
  `7d08cd6dcb183b204361beedbb17a0171467f6c95736afa15adb81ac0c0a74ab`

Rollback command (execute only if U4 must be reverted):

```sh
npx wrangler versions deploy 310aefde-9fe9-4a0c-ab65-2e15807da601@100 --yes --message "Rollback Underwrite U4 to sealed U3.1 310aefde; bundle 76eb4ee2" --config /Users/nuvo/.codex/.chatgpt-projects/g-p-6a8f887336308191a81e7bbda9e1bdd8/work/nuvo-vsim-post-fill-repair/cloudflare/wrangler.jsonc
```

After any rollback, recheck the deployment status, Schwab reconciliation,
positions, open orders, margin debit, and the dashboard before declaring recovery.
