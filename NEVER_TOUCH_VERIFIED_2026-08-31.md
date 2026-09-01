# NEVER TOUCH — verified live-account record

**Mandate:** ACCOUNT CLEANUP · LAW OF ONE · REVISION 3 §4

**Verified:** 2026-08-31 PDT

**Verifier:** Codex acting under Principal-authorized Wave 0 read-only accounting

**Effect:** preservation instruction only. This artifact authorizes no disable, delete, rotation, subscription change, deployment, ARM, or broker mutation.

## Signed list

| Protected item | Live verification | Status / qualification |
|---|---|---|
| Schwab OAuth app — `NUVO Autonomous Broker Execution` | Live Worker contains the Schwab connect/callback handlers and binds `SCHWAB_CLIENT_ID`, `SCHWAB_CLIENT_SECRET`, and `BROKER_TOKEN_ENCRYPTION_KEY`. The Schwab developer portal registration itself was not opened during Wave 0. | **NEVER TOUCH. PARTIALLY VERIFIED.** Secret names and routes are live; registered app metadata remains unverified. |
| Callback 1 — `vsim.nuvotrade.co/api/integrations/schwab/callback` | The route exists in the live Worker, and `vsim.nuvotrade.co` resolves through the `nuvo-command` Pages front door to the Worker service binding. | **NEVER TOUCH.** Registered callback status in Schwab is unverified. |
| Callback 2 — `nuvo-vsim-v5-shadow.yulgutierrez.workers.dev/api/integrations/schwab/callback` | Same Worker route is addressable on the Worker hostname. | **NEVER TOUCH NOW.** Potentially retirable only after a complete custom-domain OAuth login is separately proven. Registered callback status is unverified. |
| Access app `0eaebbb9-d1f1-4789-8686-5c29af75d447` | Present in the live Zero Trust dashboard with the `LANE_1_SPY webhook bypass` policy on `/lane/tv`. | **NEVER TOUCH. VERIFIED.** This is an Access application, not a Worker. |
| Site Access app | Live app ID `8b7134ef-3290-464a-b780-549d9caab830`; destination includes `nuvo-vsim-v5-shadow` / `vsim.nuvotrade.co`; allow policy `nuvo-wheel - Production`. | **NEVER TOUCH. VERIFIED.** The mandate's stated audience prefix was not independently exposed by the UI inspected. |
| Worker `nuvo-vsim-v5-shadow` | Present and deployed; 49 bindings; Worker version `b8fbe997-b918-4c69-809c-bd024c3713f8` at 100%, deployment `23c77183-de28-484f-a9e8-59a536987f60`; live entry part SHA-256 `125a6a06f01376f8ae5e76bbe7d7e3969cc57da373615e0218ed3a83a29acc1f`. | **NEVER TOUCH. VERIFIED.** |
| Worker `master` | Present and deployed; service target of live `MARKET` binding from `nuvo-vsim-v5-shadow`; bundle downloaded and hashed. | **NEVER TOUCH. VERIFIED.** Its asserted Git/version identity `version 29, 3e8c51cf…` was not recoverable from live metadata or local Git. |
| D1 `DB` | Live binding on `nuvo-vsim-v5-shadow` to database UUID `20eb40a8-c162-43b8-b480-0d28042501de`. | **NEVER TOUCH. VERIFIED.** |
| R2 `EVIDENCE` | Live binding to bucket `nuvo-vsim-v5-evidence-shadow`. | **NEVER TOUCH. VERIFIED.** |
| Durable Object `ACCOUNT_COORDINATOR` | Live namespace binding to class `VsimAccountCoordinator`; stores ARM, position, and coordinator history. | **NEVER TOUCH. VERIFIED.** |
| Cron `* 13-22 * * MON-FRI` | Attached to the live Worker. Source routes the schedule through `runGuardianReview`, whose custody/reconciliation work writes the stored truth used by the dashboard. | **NEVER TOUCH. VERIFIED.** |
| Cron `*/5 * * * *` | Attached to the live Worker. Current source runs `apiStatus` for each connected/degraded owner and records connector heartbeat failures. | **NEVER TOUCH. VERIFIED.** It is a direct VSIM connector-health path. |
| Pages `nuvo-command` | `vsim.nuvotrade.co` CNAME resolves to `nuvo-command.pages.dev`; the Pages project has live service binding `NUVO_APP → nuvo-vsim-v5-shadow`. | **NEVER TOUCH. VERIFIED.** It is the production front door, not a duplicate. |
| `master` market-data key | Live Worker binds a secret named `POLYGON_API_KEY`; the Massive account's only currently active key in the observed retention window was `NUVO VSIM`. Secret values were not read or compared. | **NEVER TOUCH. UNRESOLVED IDENTITY.** Operational evidence points to `NUVO VSIM`, but no cryptographic binding was possible without exposing secret values. |

## Live-account disagreements with the mandate baseline

1. The live account has **five** Access applications, not two. The TV bypass and site app are required; three additional apps must be inventoried before any Access cleanup.
2. The live account has **31 Workers and 10 Pages projects**, not a verified two-Worker baseline. The minimum-set table remains a target hypothesis, not current state.
3. Both required schedules are currently attached. This conflicts with the conversational statement that “Wave 1 crons are already disabled” if that statement was intended to include these two required schedules. The six legacy Wave 1 crons must be distinguished from the two live VSIM schedules.
4. `master` exposes secret name `POLYGON_API_KEY`, not `MASSIVE_API_KEY`. Massive is the current Polygon-branded service, but the deployed secret name remains legacy.
5. `master` commit `3e8c51cf…` was not found in any of the 21 local Git roots inspected and is not in Cloudflare deployment metadata. Treat the live bundle as the preservation source until an exact ancestor is proven.

## Signature

I verified each line above against the live Cloudflare account, the live signed-in VSIM dashboard, live DNS, downloaded production bundles, and the available local Git repositories. The Worker identity and schedule interpretation were re-verified after the BOT-card deployment. Where a claim could not be proved without exposing a secret value or changing an external system, I marked it **PARTIALLY VERIFIED** or **UNRESOLVED** rather than inferring it.

**Signed:** Codex / Wave 0 verifier / 2026-08-31 PDT
