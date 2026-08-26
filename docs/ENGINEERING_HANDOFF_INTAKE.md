# Engineering handoff intake

Source reviewed: `NUVO_VSIM_ENGINEERING_HANDOFF.docx` (24 rendered pages), 2026-08-26.

The handoff describes the retired `vsim.nuvotrade.co` system. It is audit evidence, not executable authority. No legacy Worker, database, policy, calculation, or UI source was copied into v5.

## Material concepts retained

- Never turn unavailable broker facts into zero.
- Keep signed cash, margin debit, withdrawable cash, and buying power separate.
- Keep market-implied probability and model probability explicitly labeled.
- Derive records and performance from an append-only broker ledger with stable transaction identity.
- Match realized P&L only from complete opening/closing lifecycles; flag missing historical openings.
- Include fees exactly once and never copy transaction-level cash onto every leg.
- Show capital commitment, inventory, open short-option obligations, current P&L, and theta as read-only operational views.
- Preserve release provenance and deterministic evidence/replay.

These concepts were implemented independently against the current Schwab-normalized custody and broker-event schemas. The v5 ensemble, Constitution, Guardian, evidence chain, broker boundary, and proposal workflow remain authoritative.

## Explicitly rejected

- The legacy six-tab application shell, Workers, Pages project, D1 database, and one-minute operator.
- Legacy policy limits or authority rules.
- GBM-only probability or pricing paths that would replace the current v5 ensemble.
- Acquisition, tactical, trend, QVU, social, or unrelated research systems.
- Any cached value presented as current broker truth.
- Any record whose profit cannot be reconstructed from imported Schwab lifecycle data.
- Bull-put or bear-put spreads; the Principal mandate is shares, cash-secured puts, and covered calls only.

## New v5 reporting boundary

`/api/portfolio` derives the Portfolio view from the latest normalized Schwab custody snapshot. Open option theta is returned only when a real-time Schwab option quote is complete and fresh.

`/api/performance` derives realized results from raw Schwab transaction packets retained in the append-only ledger. Currency fee rows are allocated once across security legs. FIFO matching reports only matched lifecycles. Unmatched closing transactions remain visible as incomplete history and are excluded from realized P&L.

The browser receives normalized reporting fields, not raw broker packets or R2 evidence bodies. All surfaces remain read-only.
