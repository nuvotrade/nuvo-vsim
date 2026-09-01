# Lane 1 BOT status card deployment record

Date: 2026-08-31 PDT

## Release identity

- Source commit: `2368b45144cd43e33cbabe106f15bfe4085f4524`
- Candidate bundle SHA-256: `125a6a06f01376f8ae5e76bbe7d7e3969cc57da373615e0218ed3a83a29acc1f`
- Candidate bundle bytes: `2,035,222`
- Three byte-identical `entry.js` builds, including a clean Git export
- Tests: `688` passed, `0` failed; one test added, none removed
- DISARM mutation runner: `11/11` detected

## Production switch

- Confirmed predecessor `40bc9dae-8403-4843-8dbb-c3c7605b681f` was the sole `100%` version.
- Uploaded candidate version: `b8fbe997-b918-4c69-809c-bd024c3713f8`.
- Compared predecessor and candidate bindings before the switch: `49/49` exact match.
- Compared Worker runtime settings before the switch: exact match.
- Switched once to candidate version at `100%`.
- Deployment ID: `23c77183-de28-484f-a9e8-59a536987f60`.
- Reloaded the signed-in dashboard after the switch. Both coordinator-backed lane-state surfaces rendered `DISARMED`; neither control-error surface was active.

## Rendered card

The production card renders only bot state:

- `Schwab · SPY`
- coordinator position (`FLAT` at verification)
- OPEN P/L for a complete open bot position and a fresh market mark, otherwise an em dash
- DAY P/L from recorded `EXIT_FILLED.realizedPnlCents` for the current New York trading date, otherwise an em dash
- custody freshness, coordinator ARM state, and connector health

It does not render account balance or account-wide P&L. ARM is available from the control menu while disarmed. Emergency DISARM remains directly visible. FLATTEN is disabled with the literal reason `Available after live-exit validation`.

The exact committed production bundle was measured before the switch at a true `390px` CSS viewport: document width equaled viewport width, the `370px` card fit without horizontal overflow, and ARM/DISARM were reachable above the fold. After the switch, the live signed-in Chrome page rendered the same bundle and control set. Chrome's temporary viewport override did not alter the existing desktop window, so no separate claim of a post-switch live `390px` browser measurement is made.

## Scope and rollback

This release changes the dashboard projection and existing coordinator control surface only. It adds no broker order path, parser, guard, persistence write, Schwab read, or FLATTEN capability. The lane was not re-armed.

Named rollback: deploy `40bc9dae-8403-4843-8dbb-c3c7605b681f` at `100%`.
