# UNDERWRITE U2 repair predeployment packet — 2026-09-02

**Status:** `U2_REPAIRED_LOCAL · PACKET_SEALED · DEPLOY_HOLD`  
**Live:** sealed U1 `4aae00e8-31b2-40aa-ab77-38e5a3573f47` at 100%  
**Manifest SHA-256:** `296d6ee58c3b4e2246d5c507dc45ffde6a6c2a5c4a6272ac3cb184629b994a8b`  
**Mutation:** `mutation_eligible: false`; no order route; no upload

## Incident and root cause

Failed U2 `cb573b19-7e7d-4c01-a828-b66ca89618b4` removed the legacy
`top-opportunities-panel` from the Underwrite DOM. The initial Overview renderer
still queried that removed table and passed its null `tbody` into `renderRows`.
When the latest cycle had no legacy opportunities, `renderRows` attempted
`tbody.append(row)`. That exception occurred before the live custody-position
panel rendered, so the dashboard correctly failed closed and displayed no
synthetic positions.

This was a presentation-layer regression. The fresh Schwab read after rollback
proved that custody itself never disappeared: CBRS 600 shares, SOFI 1,000 shares,
six short CBRS calls, zero open orders, and no reconciliation mismatches.

## Repair

1. Removed the obsolete legacy opportunity-table update from `renderOverview`.
2. Made `renderRows` return safely when an optional table body is absent.
3. Added a regression fixture that proves the removed U2 table cannot crash the
   initial Overview and that the same path still constructs the live-position
   panel.

No U2 economics, Portfolio Review rules, U1 calculators, Lane 1 code, broker
send path, alerts, coordinator state, or bindings changed.

## Verification

- Targeted dashboard/adapter/system tests: **85/85 PASS**.
- Full suite: **775/775 PASS**.
- Absolute config:
  `/Users/nuvo/.codex/.chatgpt-projects/g-p-6a8f887336308191a81e7bbda9e1bdd8/work/nuvo-vsim-post-fill-repair/cloudflare/wrangler.jsonc`
- Dry build: **PASS**.
- Repaired `entry.js`: **2,164,223 bytes**.
- Predicted repaired Worker SHA-256:
  `1f7f39cc2ea837faba28a26b8c26c3a62a98d77da81f11131e4d912593231fd4`.

## Changed files relative to failed U2

| File | Failed U2 SHA | Repaired U2 SHA |
| --- | --- | --- |
| `cloudflare/worker.js` | `db89613d0408530c419493207a846dc321c96660f2f8d742f29508e3258ad79c` | `a77b45b81a07b8add031313c64ebe39d0b4e49489dd990a364fe8a667dad6705` |
| `test/underwrite_u2.test.js` | `d50f3210aa78216c2b6503731fe948220853d2b7edd0e7e84fcbc11427bc638d` | `2d1d2279c4871caa431665ca7f3769e5f31bff33297689a00566f5d195c46ada` |

All other U2 file hashes are unchanged and are enumerated in the manifest.

## Deployment fence

Production remains U1. A later switch requires separate authorization and the
same ritual: exact absolute config, dry SHA reprint, zero-traffic upload, 49/49
binding comparison, one switch, immediate initial-Overview verification, and
rollback to U1 if any live account surface fails. U3 remains unopened.
