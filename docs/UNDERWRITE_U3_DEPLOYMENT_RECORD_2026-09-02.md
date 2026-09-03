# UNDERWRITE U3.1 DEPLOYMENT RECORD — 2026-09-02

## Outcome

- Status: `DEPLOYED`
- Traffic: `100% U3.1`
- Switch count: one
- Deployment ID: `41339cbf-d81b-407b-9603-bf8baca67bde`
- Version ID: `310aefde-9fe9-4a0c-ab65-2e15807da601`
- Version number: `193`
- Script etag: `7d08cd6dcb183b204361beedbb17a0171467f6c95736afa15adb81ac0c0a74ab`
- Switched: `2026-09-03T06:08:29.210837Z`

## Sealed input

- Absolute config: `/Users/nuvo/.codex/.chatgpt-projects/g-p-6a8f887336308191a81e7bbda9e1bdd8/work/nuvo-vsim-post-fill-repair/cloudflare/wrangler.jsonc`
- Dry bundle SHA-256: `76eb4ee2dee0b5f6a7927f072cf4a8b0d8c9c8cd6ffea49093f53db1b7609dbb`
- Dry bundle size: `2,192,292 bytes`
- Tests: `791/791 PASS`
- Review packet SHA-256: `84fb7571fd241a741b9f6ddbf90e0ca71b17033277e7dd5cec098087fb8189fb`
- Manifest SHA-256: `de047fe2dae0d0315d8946f5239fb6560fae45deb036d015123f749c93df9ab6`
- `mutation_eligible: false`

The original U3 dry SHA `86c6756d…` was retired before upload because the
authorized theta correction changed Worker bytes. The corrected tree was fully
retested and resealed before this deployment.

## Migration 0017

- Migration file SHA-256: `6075e03ea16ebd6c68ba4fe77396335c421a53492a8a541402873e0b06e6365a`
- Live D1 database: `nuvo-vsim-v5-shadow`
- Live D1 database ID: `20eb40a8-c162-43b8-b480-0d28042501de`
- Wrangler recorded `0017_underwrite_forecast_outcomes.sql` as applied.
- `underwrite_forecast_outcomes` exists.
- `underwrite_forecast_scores` exists.

The U3.1 Worker was uploaded at zero traffic before migration 0017 was applied.
The database change was verified before the one traffic switch.

## Binding comparison

- U2 bindings: 49
- U3.1 bindings: 49
- Exact matches: 49
- Mismatches: 0
- Durable Object namespace, Workflow, D1, R2, market service, queue, secrets,
  compatibility date, handlers, and environment values: unchanged

## Post-switch verification

- Cloudflare reports only U3.1 version
  `310aefde-9fe9-4a0c-ab65-2e15807da601` at 100%.
- Schwab custody: `CONNECTED`, reconciled, zero mismatches.
- Positions before and after: SOFI 1,000 shares; CBRS 600 shares; six short CBRS
  2026-09-04 $200 calls.
- Open orders before and after: zero.
- Broker snapshot hash before and after:
  `0596e110fa1e98899c5fd98eca5404e2c3f25b041bf60a530c714411a37107e6`.
- Market session: `CLOSED`; no fresh option quote or theta was invented.
- U3 surfaces remain read-only and the deployed code reports
  `mutation_eligible: false`.
- No lane, alert, coordinator, broker-order, or trade endpoint was called during
  deployment.

Automated Chrome inspection was refused by its administrator-enforced browser
security check. No bypass was attempted. Consequently, the control plane,
database, bindings, code contracts, and live custody were verified, but the
rendered ARM label and theta line were not visually claimed by this record.

## Theta correction

Schwab theta is treated as option-premium dollars per share per calendar day.
The deployed conversion is:

`short theta/day = -raw long theta/share/day × equity multiplier × contracts`

For the stale CBRS evidence, `-(-0.57309031) × 100 × 6 = $343.854186`, displayed
as `$343.85/day`. The card prints the raw per-share theta, `×100`, `×6`, total,
and `STALE` plus the quote time. Portfolio Economics and custody risk apply the
same one-multiplier conversion. Delta, gamma, and vega were not changed.

## Rollback

### HARD STOP — verify the prior 100% version in Cloudflare before rollback

Two different U2 versions exist in the deployment history and must not be
treated as interchangeable:

- Initial U2: version `cb573b19-7e7d-4c01-a828-b66ca89618b4`, sealed bundle
  `2284ccb8d38c17e49964c0a0f372337316422ae517f164710de20c08a088d43a`.
  This version produced the Overview `null.append` regression and was rolled
  back. It is **not** an acceptable fail-safe target.
- Repaired final U2: version `5d3ad448-47eb-475d-b6c7-ac982f88b437`, sealed
  bundle `c3e4ee7591b668b05c223167b9f750bf9a80e86146477985fa3fb6fbd23e1b0b`.
  The local U2 deployment record says this repaired version was subsequently
  switched to 100% and restored the Overview.

The local records therefore identify repaired U2 `5d3ad448…` as the intended
fail-safe candidate, but this record does **not** claim that the control-plane
predecessor relationship has been freshly verified. Before any rollback,
inspect Cloudflare deployment/version history and confirm that the version
immediately preceding U3.1 at 100% is the repaired U2 version and that its
uploaded Worker bytes correspond to `c3e4ee75…`. If that check does not match,
stop. Do not substitute the initial U2 version or run a printed command blind.

Documented candidate (pending that action-time control-plane verification):

- U2 version ID: `5d3ad448-47eb-475d-b6c7-ac982f88b437`
- U2 dry bundle SHA-256:
  `c3e4ee7591b668b05c223167b9f750bf9a80e86146477985fa3fb6fbd23e1b0b`

No executable rollback command is retained in this record while the
control-plane predecessor check remains outstanding.
