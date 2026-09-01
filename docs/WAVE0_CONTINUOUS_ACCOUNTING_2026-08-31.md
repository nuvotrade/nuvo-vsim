# Wave 0 continuous accounting — 2026-08-31

## Live prerequisite

- BOT card deployed.
- ARM previously confirmed from coordinator-backed live state after the Principal armed.
- repaired DISARM confirmed through authoritative readback during a live idempotent press while disarmed.
- current dashboard: DISARMED, coordinator FLAT, 0 fills.

## Current account

- 31 Workers; all 31 bundles downloaded successfully.
- 10 Pages projects.
- 13 D1 databases, 2 KV namespaces, 2 R2 buckets, 8 queues, 1 Workflow.
- 5 Access applications verified in the signed-in UI; current OAuth inventory token returns zero and is not accepted as proof of absence.
- no newly listed application relative to the 19:28 PDT delta.

## Q1–Q5

1. `master` binds secret name `POLYGON_API_KEY`; exact Massive key identity remains UNKNOWN because Cloudflare does not expose a value or key ID. Current usage still points operationally to `NUVO VSIM`. No key action.
2. Benzinga is separable at product-entitlement level; Billing shows no active subscription. Historical $99 line remains unlabeled. No cancellation.
3. `vsim.nuvotrade.co` is served by `nuvo-command.pages.dev`, whose `NUVO_APP` service binding targets `nuvo-vsim-v5-shadow`.
4. Guardian Discord output is separable; `runGuardianReview` custody/reconciliation remains load-bearing.
5. Live Worker does not fetch `nuvo-vsim-v5-preview`; it only contains a legacy external link.

## TradingView gate

All four active SPY 5m alerts point directly to `https://vsim.nuvotrade.co/lane/tv`. None targets the five router candidates. Stage 0's four fills remain outstanding, so no additional Wave 2 action is authorized.

## Exposure and disable result

The 18 previously isolated Workers remain with production and preview URLs disabled. `nuvo-qvu-manual-market` and `nuvo-qvu-manual-model` also remain non-public. No new reversible disable was safe in this pass:

- ingress/notification/Wheel/Telegram URLs are fill-gated;
- `timdicator` remains public but returns a zero-byte bundle and has no proved Git ancestor, so preservation has not passed;
- core Worker, `master`, required Pages/Access/storage/coordinator, OAuth callbacks, and both direct VSIM crons remain protected;
- Pages projects have no equivalent reversible URL switch in this packet.

## Findings not in the plan

1. The preservation push triggered a new `nuvo-vsim.pages.dev` deployment from commit `72c5ffa5df1cf61186eb40c050f7fc7d925a45ea` at 2026-09-01T02:29:04Z. The project is publicly reachable and serves a legacy “NUVO Unified v4.1” surface. `/lane/tv` returns the same HTML surface, not the Worker webhook. It is not the production custom-domain front door, but it is a public duplicate candidate that must be retired separately after preservation and destructive authorization.
2. Historical Worker “bundle SHA” values hashed the multipart boundary and therefore are exact-download evidence, not stable code identities. A new canonical part-based manifest now records all 31 Workers. Owner-only manifest SHA-256: `a2b59fd38293f2f8b36ea68a595ff0d58eb512ae685a66d4423de40a80c8918f`.
3. Earlier Wave 2 public-URL isolation occurred before the current two-part gate was satisfied. It remains a recorded process exception and is not precedent.

## Git preservation

- repository: `https://github.com/nuvotrade/nuvo-vsim`
- branch: `codex/lane1-state-guards-20260831`
- remote head before this accounting update: `72c5ffa5df1cf61186eb40c050f7fc7d925a45ea`
- exposed commits `5006bedd8171d2d4a376c43e2e7e5ef0dd867bae` and `ed08909f3b3cdab2404a790d2a2a777e1b9d8afb` are both contained in that remote branch.

## Stop boundary

No Worker, Pages project, D1 database, API key, or secret was deleted. No subscription, OAuth, Access, production route, broker, order, ARM, or coordinator mutation occurred. Permanent deletion remains a separate action-time authorization.
