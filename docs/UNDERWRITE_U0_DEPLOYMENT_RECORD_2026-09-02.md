# UNDERWRITE U0 — deployment record

**Switched:** 2026-09-02 21:03 PDT  
**Named config:** `/Users/nuvo/.codex/.chatgpt-projects/g-p-6a8f887336308191a81e7bbda9e1bdd8/work/nuvo-vsim-post-fill-repair/cloudflare/wrangler.jsonc`

1. Migration `0016_underwrite_forecasts.sql` SHA-256 `5351f6b6fcac98a1036e05991015649c45863c9a622dbe1f1a112153c67d3966` was applied once to live D1 `20eb40a8-c162-43b8-b480-0d28042501de`; no migration remains pending and table `underwrite_forecasts` exists.
2. Pre-switch production was 100% version `5a30ca69-f15f-4470-8e76-8e1e9128b5c1`. Its current control-plane record was `BOT=GREEN` (which requires ARMED and no lane fault), `SCHWAB=GREEN`; custody observed `2026-09-03T04:02:35.775Z` held no SPY position and zero open orders; the latest scan recorded `mutationEligible=false`.
3. Zero-traffic candidate `c45b241c-c5ca-4cd6-878b-7d0bdc29d632` passed the exact pre-switch bundle lock (`entry.js` 2,173,197 bytes, SHA-256 `53779147009d9ba61b9999727101ef1288c6732a2b017768ab5e0bd7a92e9a09`) and a `49/49` binding comparison, then received one 100% traffic switch. Production now reports that version at 100% with the upload annotation mapping it to the sealed bundle.
4. Post-switch the Durable Object, D1, R2, market, queue, workflow, secrets, and environment bindings remain `49/49`; no ARM, lane, broker, alert, or coordinator mutation request was sent. Exact-bundle fixtures pass: a closed CC session renders `NOT_EVALUATED`, scan summaries remain `mutationEligible=false`, and CC/CSP responses remain `mutation_eligible=false` with no order route. The authenticated browser's admin-policy check was unavailable, so no direct post-switch API rendering is claimed; the preserved control-plane/custody state and unchanged Durable Object binding are the recorded state proof.

Rollback Worker version: `5a30ca69-f15f-4470-8e76-8e1e9128b5c1`.
