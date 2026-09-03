# UNDERWRITE U1 — deployment record

**Switched:** 2026-09-02 21:23 PDT  
**Named config:** `/Users/nuvo/.codex/.chatgpt-projects/g-p-6a8f887336308191a81e7bbda9e1bdd8/work/nuvo-vsim-post-fill-repair/cloudflare/wrangler.jsonc`

1. Preflight confirmed production at 100% U0 version
   `c45b241c-c5ca-4cd6-878b-7d0bdc29d632`. The U1 packet SHA-256 was
   `bcd0372e79a978184dc856927d2322fd208adca52cd8632e60a69265ed97355e`,
   its manifest SHA-256 was
   `977198bb10b5554af5a71c048ce1971cac29078d041e42496d89e55e9e2c0040`,
   and 765/765 tests passed.
2. A fresh exact-config dry build reproduced sealed `entry.js` SHA-256
   `7e430e77394240a61f104e53cccf7c1fe25de0439102da6ebe0d09b7ac58d05e`
   at 2,179,606 bytes. U1 was uploaded first as zero-traffic Worker version
   `4aae00e8-31b2-40aa-ab77-38e5a3573f47`.
3. U0 and U1 matched all 49 bindings, including the same Durable Object,
   Workflow, D1, R2, market service, queue, secrets, and environment values.
   Immediately before the switch, BOT, D1, Discord, market, Schwab, and TV were
   GREEN; fresh custody showed no SPY position and zero open orders.
4. One traffic switch placed U1 version
   `4aae00e8-31b2-40aa-ab77-38e5a3573f47` at 100%. Cloudflare reports version
   number 189 and script etag
   `5e1a21f489ee490bba8bc5608e6d1ba28e06920e6995597a3dd8ae107ac4b5a8`.
   Post-switch control-plane status is 100% U1; the D1/custody read remained
   unchanged, with no SPY position and zero orders. No lane, alert, broker,
   coordinator, or portfolio mutation request was sent. A read-only GET to the
   existing `/lane/tv` ingress returned its expected HTTP 405 method boundary,
   proving the switched Worker is serving without invoking an order path.
5. The authenticated Chrome page could not be inspected because its
   administrator-enforced browser security check was unavailable. That control
   was not bypassed. Therefore this record proves the Cloudflare switch,
   bindings, preserved custody state, startup validation, and local contracts;
   it does not claim a post-switch visual dashboard render.

## Fail-safe rollback

Preserved rollback version:
`c45b241c-c5ca-4cd6-878b-7d0bdc29d632`

Exact rollback command, from the repository root:

```text
npx wrangler versions deploy c45b241c-c5ca-4cd6-878b-7d0bdc29d632@100 --yes --message "Rollback Underwrite U1 to sealed U0 c45b241c" --config cloudflare/wrangler.jsonc
```

Rollback is required if the live dashboard fails to load, the Underwrite tab
throws, any binding differs, or a fresh self-audit reports a new red source
attributable to U1.
