# UNDERWRITE U2 predeployment packet — 2026-09-02

**Status:** `U2_SCOPE_ACCEPTED · PACKET_SEALED · DEPLOY_HOLD`  
**Live unchanged:** U1 Worker `4aae00e8…`; bundle `7e430e77394240a61f104e53cccf7c1fe25de0439102da6ebe0d09b7ac58d05e`  
**Manifest SHA-256:** `2732e5c0f978716deedb1f4fe9fe2c09116b961a348fd9d94cd0e66870d5a976`  
**Packet SHA-256:** detached in `UNDERWRITE_U2_PREDEPLOY_PACKET_2026-09-02.packet.sha256`  
**Mutation:** `mutation_eligible: false`; no order route; no upload

## Candidate and verification

- Absolute config: `/Users/nuvo/.codex/.chatgpt-projects/g-p-6a8f887336308191a81e7bbda9e1bdd8/work/nuvo-vsim-post-fill-repair/cloudflare/wrangler.jsonc`
- Dry build: **PASS**; `entry.js` **2,164,848 bytes**; predicted SHA-256
  `2284ccb8d38c17e49964c0a0f372337316422ae517f164710de20c08a088d43a`
- Tests: **774/774 PASS**, including all Lane 1 suites. Lane production code was not changed.
- Review-path string check: zero legacy Governor, custody-risk precondition, whole-cycle
  refusal, 8.5% cash tax, modeled-mid fill, MAX, mixture, mixed-unit rank, raw
  gamma/NAV, structure-universe gate, or share-candidate identifiers. Preserved
  Worker send-path protections remain outside Portfolio Review by explicit fence.

## U1 engine continuity

| File | U1 SHA | U2 SHA | Result |
| --- | --- | --- | --- |
| `cloudflare/underwrite-model-engine.js` | `3e5e720b…ed9e0` | `3e5e720b…ed9e0` | Unchanged |
| `cloudflare/cash-secured-put-calculator.js` | `746b5413…5f895` | `cc3c03c8…fba2` | Two-field broker-Greek passthrough only |
| `cloudflare/covered-call-calculator.js` | `8568c7a9…24e4` | `8568c7a9…24e4` | Unchanged |

The CSP diff only exposes `gamma`, `vega`, `theta`, and `greek_units` already
present on the broker contract so U2 can print informational dollar gamma.
Deleting those two passthrough lines reprints the exact sealed U1 SHA
`746b5413460a621679383adf36981966ab14a9558cba79a83fa99c867e05f895`.
No CSP model, probability, rate, cash-carry, or ranking arithmetic changed.

## Required fixtures

- **Peer isolation:** `AAA = CALCULATED`, 3 rows; `IPO = REFUSED / HISTORY_SHORT`,
  76 sessions versus 121 required. Cycle = `PORTFOLIO_REVIEW_COMPLETE`.
- **Policy visibility:** a one-contract AAA put breaching deployed-cap, cash-floor,
  projected-single-name, and settled-cash references prints
  `PRIMARY RAW_NEV_0 = $239.35` and `POLICY_BLOCK`. Cycle remains
  `PORTFOLIO_REVIEW_COMPLETE`, never `REFUSED`; the row remains visible and rankable.
- **CC clock isolation:** the covered-call review row prints RAW value only. It has
  no `cash_carry_cost_0`, `cash_adjusted_nev_0`, or `CASH_CARRY` field.
- **Execution boundary:** policy-blocked evidence candidates remain `admissible: true`
  with the policy object stored separately as `referencePolicy`; the page cannot
  approve, size, submit, or mutate a trade.

## Per-file SHA-256

| File | SHA-256 |
| --- | --- |
| `cloudflare/underwrite-model-engine.js` | `3e5e720b9e39339023b9290576dce515bb8f05fc8967f41e4bd45522663ed9e0` |
| `cloudflare/cash-secured-put-calculator.js` | `cc3c03c8a203a199db6ca984bc5563248f61c8d37b439797e61e7f210478fba2` |
| `cloudflare/covered-call-calculator.js` | `8568c7a9d620314160e12c67e40cbe451b87bd50eb723f14aa734e5ab23224e4` |
| `cloudflare/portfolio-review.js` | `d72787f9afaa3721d6a829a07ad22293b3839f2a00682fb0abb6f747a9f92ae5` |
| `cloudflare/worker.js` | `db89613d0408530c419493207a846dc321c96660f2f8d742f29508e3258ad79c` |
| `test/portfolio_review.test.js` | `eb5b51d1effc29cf85f5634a3ddff02764039d84f78b38094ad6b9cfc9570ad6` |
| `test/underwrite_u2.test.js` | `d50f3210aa78216c2b6503731fe948220853d2b7edd0e7e84fcbc11427bc638d` |
| `test/underwrite_u0.test.js` | `245d7f11cca3eebfd91f4ebbd85d8613bc1d635796a9dbf82fbdc8b9405d4f15` |
| `test/production_adapters.test.js` | `59bd7ea136390e38927420175a8938b2bffcda93f4211acb1ac63c7b8d341896` |

No zero-traffic candidate was created. The 49/49 binding comparison and one-switch
ritual remain deployment-time requirements after separate Principal authorization.
U3 is unopened.
