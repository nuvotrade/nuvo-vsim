# NUVO VSIM V5 working checkpoint — 2026-09-03

## Recovery identity

- Git branch: `codex/post-fill-reconciliation`
- Immutable recovery tag: `vsim-v5-wheel-engine-2026-09-03`
- Shadow Worker version: `2ae95a34-6b20-4628-a777-4463a126ab7d`
- Market Worker version configured in VSIM: `3e8c51cf-afb0-4b9f-a927-dcaea11b6627`
- Shadow D1 database: `nuvo-vsim-v5-shadow`
- Migration `0018_trade_learning_analysis.sql`: present in shadow production
- Verification: 844 tests passed; `git diff --check` passed; Worker dry-run passed

The tag identifies the source, tests, migrations, and operating documentation that produced
the deployed Worker. The deployed Worker version is the runtime rollback reference.

## Preserved operating posture

- Authority remains `2 / PROPOSE ONLY`.
- Schwab custody remains read-only to the wheel dashboard.
- Wheel order execution remains manual by the Principal.
- CSP runs only after a ticker is entered and returns one decision for each of the nearest
  three weekly expirations.
- Covered calls return one decision for each of the nearest three weekly expirations and do
  not expose an option-chain dump on the primary surface.
- Position Management returns one action per open wheel position.
- History is the canonical Schwab-derived trade ledger; Performance consumes that ledger.
- Post-close LLM learning storage exists but remains disabled pending the Copilot operating
  mandate and mandatory pre-trade context design.
- Existing autonomous BOT behavior and settings are unchanged by this checkpoint.

## Recovery procedure

1. Create a recovery branch from `vsim-v5-wheel-engine-2026-09-03`.
2. Run the full test suite and Worker dry-run from that branch.
3. Redeploy only after explicit production-deployment authorization.
4. Confirm the dashboard footer reports the intended Worker version and re-run the protected
   live smoke checks for Overview, CSP, Covered Calls, Position Management, History,
   Performance, BOT, and System.

Migration 0018 is additive. A code rollback does not require dropping its table, and the table
must not be destructively removed during recovery. New broker, history, learning, or evidence
rows written after this checkpoint are durable runtime records and are not erased by a source
rollback.

## Known boundary at the checkpoint

This is a stable single-engine dashboard checkpoint, not an autonomous LLM-trading release.
No Codex service identity is connected to the VSIM MCP surface. Trade learning is not yet a
mandatory pre-trade input, and no LLM-generated lesson can alter either the wheel engine or
the autonomous BOT.
