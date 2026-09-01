# Wave 0 live-account delta — 2026-08-31 19:28 PDT

The first read-only inventory request returned 401 for most account collections, 429 for Workers, and 403 for zones. Empty arrays were rejected as a coverage fault, not recorded as zero inventory. A normal Wrangler identity check refreshed the OAuth session and confirmed the expected account and scopes. One bounded retry then completed without API failures.

The refreshed live collections match the preserved inventory by exact count and exact name set: 31 Workers, 10 Pages projects, 13 D1 databases, 2 KV namespaces, 2 R2 buckets, 8 queues, and 1 Workflow. Account-level Access and Worker-domain collections still returned empty without an API error; prior signed-in UI and DNS evidence remains controlling, and the empty API collections are not deletion evidence.

The BOT card Worker version `b8fbe997-b918-4c69-809c-bd024c3713f8` remains the named live/rollback release. The held custody-refresh candidate is source `2131240ecbdab401819933585ac2f1f0864d3fcd`, bundle `35600d1361a7a8221ea97e01522aea4c50c8f92bf0eee56f09d00437cb3e67fb`, 2,044,026 bytes, with three matching builds, 692/692 tests, 12/12 refresh mutations, and the existing 11/11 DISARM mutations. It is not deployed.

Q1 remains unknown at secret-value identity. Q2 remains held because the historical $99 line is unlabeled. Q3–Q5 remain resolved at the boundaries stated in the original Wave 0 report. No held item was promoted to deletion and no deploy, upload, switch, ARM, DISARM, broker request, subscription change, key change, route change, isolation, or deletion occurred.

The owner-only local full record is `LIVE_ACCOUNT_DELTA_2026-08-31_1928.md`, SHA-256 `7ff7ea9e4b76a7b724d36f52c64012c149046cdd34a16974301972ded836cc1f`.
