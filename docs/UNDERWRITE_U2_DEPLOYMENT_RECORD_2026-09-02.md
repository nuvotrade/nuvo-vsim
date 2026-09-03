# UNDERWRITE U2 DEPLOYMENT RECORD — 2026-09-02

## Outcome

- Status: DEPLOYED
- Traffic: 100% U2
- Switch count: one
- Deployment ID: `b67dd3f6-503c-41c0-94b9-5faf5f468de7`
- Version ID: `cb573b19-7e7d-4c01-a828-b66ca89618b4`
- Version number: `190`
- Script etag: `5a0dd81e5efdfe9890527a1003ca92a1b0d84bb9e6f88841da8da9a33a2a8397`
- Switched: `2026-09-03T05:14:05.884786Z` (`2026-09-02 22:14:05 PDT`)

## Sealed input

- Absolute config: `/Users/nuvo/.codex/.chatgpt-projects/g-p-6a8f887336308191a81e7bbda9e1bdd8/work/nuvo-vsim-post-fill-repair/cloudflare/wrangler.jsonc`
- Dry bundle SHA-256: `2284ccb8d38c17e49964c0a0f372337316422ae517f164710de20c08a088d43a`
- Dry bundle size: `2,164,848 bytes`
- Tests: `774/774`
- Predeploy packet SHA-256: `d165d2d14b765860cac60e8d2920fc6870658818110947cab5fb3d5e4e6daf85`
- Manifest SHA-256: `2732e5c0f978716deedb1f4fe9fe2c09116b961a348fd9d94cd0e66870d5a976`
- `mutation_eligible: false`

The absolute-config dry build reprinted the sealed bundle SHA and size before upload. The upload was created as zero traffic and tagged `underwrite-u2-2284ccb8`.

## Binding comparison

- U1 bindings: 49
- U2 bindings: 49
- Exact matches: 49
- Mismatches: 0
- Runtime, handlers, Durable Object namespace, Workflow, D1, R2, service, queue, and secret bindings: unchanged

## Switch

Immediately before the switch, production remained 100% U1. U2 was then moved from zero traffic to 100% in one percentage deployment. Final Cloudflare deployment status reports only version `cb573b19-7e7d-4c01-a828-b66ca89618b4` at 100%.

## Post-switch verification

- Worker API: reachable through the authenticated NUVO VSIM connector.
- Schwab custody: connected and reconciled; no mismatches.
- SPY position: flat.
- Open SPY orders: zero.
- Account snapshot hash before and after: `35c67c4420fb6312dbe4b04706e264d4d9afb3d5ddedde19327907c4d4275f44` (unchanged).
- Market state: `CLOSED`; live market data correctly reports unavailable rather than substituting stale data.
- Review, covered-call, and CSP surfaces remain read-only with `mutation_eligible: false`; U2 has no order route.
- No lane, alert, coordinator, broker, or order endpoint was called during deployment.
- The coordinator Durable Object namespace is identical to U1, so the switch did not replace coordinator storage.

Direct visual confirmation of the dashboard's ARM label was unavailable because the browser session was stopped by its administrator policy check. No bypass was attempted. Control-plane comparison and the unchanged broker snapshot prove the deployment did not mutate broker custody; they do not substitute for a fresh direct read of the coordinator's displayed ARM field.

## Rollback

Rollback is sealed U1, not U0:

- U1 version ID: `4aae00e8-31b2-40aa-ab77-38e5a3573f47`
- U1 bundle SHA-256: `7e430e77394240a61f104e53cccf7c1fe25de0439102da6ebe0d09b7ac58d05e`
- U1 script etag: `5e1a21f489ee490bba8bc5608e6d1ba28e06920e6995597a3dd8ae107ac4b5a8`

Rollback command:

```sh
npx wrangler versions deploy 4aae00e8-31b2-40aa-ab77-38e5a3573f47@100 --yes --message "Rollback Underwrite U2 to sealed U1 4aae00e8; bundle 7e430e77" --config /Users/nuvo/.codex/.chatgpt-projects/g-p-6a8f887336308191a81e7bbda9e1bdd8/work/nuvo-vsim-post-fill-repair/cloudflare/wrangler.jsonc
```

## Production regression and rollback

At `2026-09-02 22:20 PDT`, the Principal reported that the Overview failed
closed after U2 with `Cannot read properties of null (reading 'append')` and
therefore displayed no positions. U3 was stopped immediately.

The pre-authorized rollback was executed to sealed U1:

- Rollback deployment ID: `5fdd0baa-e08e-4d5a-81e8-a61620ce9568`
- Rollback time: `2026-09-03T05:20:48.907928Z`
- Live version after rollback: `4aae00e8-31b2-40aa-ab77-38e5a3573f47`
- Traffic after rollback: 100% U1
- Fresh post-rollback Schwab read: connected and reconciled, three positions,
  zero open orders, no reconciliation mismatches

U2 is not approved for another switch until the null-append regression is
reproduced locally, repaired, and covered by an initial-load Overview fixture.
U3 remains unopened.

## Repaired U2 and final legacy-panel removal

The null-append regression was reproduced and repaired. Repaired U2 version
`7abdf719-4a07-4d5a-a235-0cbbc7e3b3ac` restored the live Overview and Schwab
positions. The Principal then identified a separate legacy design artifact on
Overview: a hard-coded `Top opportunities` table containing synthetic SPY, IWM,
and QQQ examples. It was not fed by Schwab or Portfolio Review.

The final U2 patch removes that legacy table before the live page is revealed.
It does not change Portfolio Review, calculator economics, Lane 1, broker
custody, alerts, coordinator state, or any order path.

- Full suite: `775/775` PASS
- Final dry bundle: `2,164,505 bytes`
- Final dry bundle SHA-256:
  `c3e4ee7591b668b05c223167b9f750bf9a80e86146477985fa3fb6fbd23e1b0b`
- Worker source SHA-256:
  `dd5ea7a05dde91939760deab67ee23db34e7b8574e4864218150a3f8bf6e13ea`
- U2 fixture SHA-256:
  `ad4c1c16bc3db89de88f47cd549edb3f26ee88cae71806d48e90d94d3dd6dbbf`
- Candidate/final version: `5d3ad448-47eb-475d-b6c7-ac982f88b437`
- Final deployment ID: `9f6e728b-489c-40a8-a65c-afac4c7b6f9d`
- Traffic: `100%`
- Bindings: `49/49` exact against repaired U2
- Fresh post-switch Schwab read: connected, reconciled, CBRS 600, SOFI 1,000,
  six short CBRS calls, zero open orders, no mismatches
- `mutation_eligible: false`

Chrome's administrator policy check prevented an automated post-switch visual
refresh; no bypass was attempted. U3 remains paused pending the Principal's
visual confirmation that the synthetic Overview table is absent.
