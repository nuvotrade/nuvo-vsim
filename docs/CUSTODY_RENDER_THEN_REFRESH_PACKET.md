# Custody render-then-refresh packet

Date: 2026-08-31 PDT

## Candidate identity

- Source commit: `2131240ecbdab401819933585ac2f1f0864d3fcd`
- Candidate bundle SHA-256: `35600d1361a7a8221ea97e01522aea4c50c8f92bf0eee56f09d00437cb3e67fb`
- Candidate bundle bytes: `2,044,026`
- Three byte-identical `entry.js` builds, including an isolated clean Git export
- Tests: `688 -> 692`; four added, one changed, zero removed; `692` passed and `0` failed
- Refresh mutation runner: `12/12` detected
- Existing DISARM mutation runner: `11/11` detected

This packet is built and held. It is not deployed.

## Behavior

The dashboard renders the last stored custody snapshot immediately. After the initial render it requests a genuine Schwab custody refresh. The BOT Refresh control invokes the same path directly.

- No spinner replaces NAV, cash, today's P&L, bot position, or bot P&L.
- A 60-second server-side debounce is enforced inside the account coordinator.
- Concurrent refreshes are serialized. Every follower rechecks the stored snapshot after the preceding request completes, so ten tabs do not create ten broker reads.
- A successful broker read updates the existing custody snapshot and then rerenders from stored data.
- Schwab throttling keeps the stored snapshot visible and labels it `Stored snapshot · Schwab rate limited`; it does not turn the page into an error panel.
- Other broker failures keep the stored snapshot visible and show `CUSTODY REFRESH FAILED — showing stored snapshot` on the BOT surface.
- A browser request is bounded to 20 seconds and the Refresh control is single-flight.
- Custody older than 20 minutes visibly degrades NAV, cash, and today's P&L with snapshot age. The header becomes `Custody stale` / `CUSTODY DEGRADED`; it cannot remain green solely because a stored row exists.
- Today's P&L is never silently presented as current when its custody snapshot is stale.

## Boundaries

The Schwab operation is custody-read-only: account directory, positions, and open orders. It has no order submission, replacement, cancellation, FLATTEN, parser, guard, or ARM-state path.

The read uses the existing normal access-token cycle. A successful read uses the existing D1 custody persistence and append-only broker observation/audit paths. That is an existing write side effect of a custody read, not a new schema or a new record type. The account coordinator's trading state is not mutated.

The existing cron window ends at 15:00 PDT while extended hours continue to 17:00 PDT. On-refresh reads solve freshness for an actively viewed dashboard, but do not make the cron question moot for an unattended dashboard. Extending the cron window should be considered as a separate, explicitly reviewed scheduling change; this packet does not change cron.

## Files and hunk scope

- `cloudflare/custody-refresh.js`: freshness policy, rate-limit classification, serialized refresh queue
- `cloudflare/platform.js`: account-coordinator refresh method with an authoritative stored-age recheck
- `cloudflare/worker.js`: read-only route, render-then-refresh client, visible age/degradation, BOT control
- `test/custody-refresh.test.js`: debounce, concurrency, throttling, failure, and presentation tests
- `test/production_adapters.test.js`: acknowledges the newly intentional read-only dashboard endpoint
- `scripts/custody-refresh-mutations.mjs`: 12 offline in-memory mutations

## Release boundary and rollback

No Cloudflare upload, version creation, binding comparison, or traffic switch occurred in this packet. Before any later deployment: confirm the current sole live predecessor, upload the candidate, compare all live bindings before the switch, switch once, and verify coordinator state after the switch.

Current named rollback version: `b8fbe997-b918-4c69-809c-bd024c3713f8`.
