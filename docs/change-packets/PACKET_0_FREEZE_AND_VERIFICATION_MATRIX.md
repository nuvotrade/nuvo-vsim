# Packet 0 — Freeze and Verification Matrix

**Status:** Complete; preservation and read-only verification only  
**Freeze date:** 2026-08-27  
**Runtime authority:** 2 / PROPOSE ONLY  
**Runtime changes:** None  
**Deployments:** None  
**Next packet:** Not started

## 1. Objective

Freeze a reproducible baseline before any correctness change. This packet records the exact source, deployed Worker, storage state, tests, custody/cash provenance, and known evidence discontinuity. It does not relabel an unverified field as authoritative and does not change runtime behavior.

## 2. Authoritative identities

The remote repository and pushed tag are authoritative. The local review directory is an incidental working copy and is not the recovery authority.

| Identity | Frozen value | Verification |
|---|---|---|
| Repository | `https://github.com/nuvotrade/nuvo-vsim` | `git remote get-url origin` |
| Branch | `claude/nuvo-vsim-architecture-il96te` | Local tracked branch |
| Working-copy HEAD | `5b47aa29a766d77706fe44568f1744855422c9b9` | `git rev-parse HEAD` |
| Recovery tag | `v5-2026-08-27-authority-storage-recovery` | Present on origin |
| Remote tag object | `e018013a830af9d929befd799a0621e9c17bd580` | `git ls-remote` |
| Tagged commit | `5b47aa29a766d77706fe44568f1744855422c9b9` | Peeled remote tag |
| Local review path | `work/claude-review.8xjXJ5` | Incidental; not authoritative |
| Worker | `nuvo-vsim-v5-shadow` | Cloudflare version inventory |
| Worker version | `c909de83-308c-4a56-9336-5db2edf0b463` (126) | Current immutable version |
| Worker source commit | `b9474f218042497331e530424babcb1f23d7d3ab` | Deployment annotation |
| Worker artifact SHA-256 | `7e9b775c59d7c84cf34e673162284fe1e702ae38445809b1c5a92bf13315067e` | Preserved live artifact and tested local bundle match byte-for-byte |
| Worker script ETag | `6333858ec976fac4f6c9651e2a57cee42830aadf2b98061236b7cadf241a9208` | Cloudflare deployment metadata |
| Limits version | `constitution-v5.2.1` | Live runtime |
| Model version | `nuvo-model-5.0.1-execution-cost-v2` | Live runtime and sealed evidence |

The preserved live Worker artifact and the tested local bundle are both 1,771,781 bytes and have the same SHA-256. `cmp` reports an exact match. The deployed version ID remains the immutable version associated with that preserved download; this packet did not perform a new deployment.

## 3. Preservation inputs

| Artifact | Result |
|---|---|
| Complete snapshot ZIP | `NUVO_VSIM_V5_COMPLETE_SNAPSHOT_2026-08-27.zip` |
| Snapshot SHA-256 | `39fd1a73b649b8f8454df9f404c40781e7a3329893076c1ea2a9e8d9ec8021dd` |
| Snapshot manifest | 192 entries verified; 183 are project files and the remainder are preservation/support artifacts |
| Repository bundle SHA-256 | `8f42dc813807a198d00d696920248ee574b6018f21f61078947283d842d9b35c` |
| Packet 0 D1 export | `/Users/nuvo/Documents/Codex/2026-08-23/vsim-v5-checkpoints/2026-08-27-packet-0-freeze/d1-packet-0-freeze.sql` |
| D1 export SHA-256 | `e977b3fe20ada45b638a39b9d2b8b652f1f3fb19a38ba07735f09da0d65f8bc8` |
| Restored SQLite SHA-256 | `dc14916075208df87d9949d7ad3ab4d1f628eda54a180aadc060505df8c25620` |

The D1 dump and restored database remain outside Git. The paths, checksums, counts, and verification result are recorded here so the backup can be located and validated without placing account data in the repository.

## 4. Freeze verification matrix

| Area | Expected | Observed | Status | Evidence/method |
|---|---|---|---|---|
| Git recovery | Pushed tag resolves to frozen source | Tag object `e018013a…`; commit `5b47aa29…` | **CONFIRMED** | Local Git plus remote tag lookup |
| Live artifact | Tested bundle equals deployed artifact | SHA-256 `7e9b775c…`; byte comparison matches | **CONFIRMED** | Preserved live download, immutable version identity, local bundle |
| Test suite | No failures | 390 tests in 66 suites; 390 pass, 0 fail, 0 skipped | **CONFIRMED** | `npm test` on frozen working copy |
| D1 restore | Restorable and internally valid | `integrity_check=ok`; zero foreign-key errors | **CONFIRMED** | Fresh export restored locally; PRAGMAs run only on restore |
| Evidence schema | Storage accepts authority ladder | `CHECK(authority_level BETWEEN 0 AND 5)` | **CONFIRMED** | Read-only production schema query |
| Cycle schema | Storage accepts authority ladder | `CHECK(authority_level BETWEEN 0 AND 5)` | **CONFIRMED** | Read-only production schema query |
| Evidence index | Contiguous chain | 74 records; sequences 0–73; zero gaps; zero link errors | **CONFIRMED** | D1 index plus package reconciliation |
| Freeze chain head | Latest preserved state | Sequence 73; chain `4347666d8097a63d2134a5b1dbbe0fa224b314e88ec8acd09dd821663a3438b9` | **CONFIRMED** | D1 export and restored database |
| Recovery milestone | First Authority-2 seal remains legible | Sequence 62; chain `d116cf612234caac69736f0c8fe03ce9f8377f6212b9be83d979989217d43fc7` | **CONFIRMED** | Preserved record 62 and D1 index |
| Cycle contexts | Indexed contexts | 76 | **CONFIRMED** | D1 and R2 |
| R2 evidence: D1 → R2 | Every index row has a package | 74/74; zero missing | **CONFIRMED** | Full R2 list and parsed object comparison |
| R2 evidence: R2 → D1 | No orphan evidence packages | 74/74; zero orphaned | **CONFIRMED** | Full R2 list and D1 key set |
| R2 contexts: D1 → R2 | Every context row has a package | 76/76; zero missing | **CONFIRMED** | Full R2 list and parsed object comparison |
| R2 contexts: R2 → D1 | No orphan context packages | 76/76; zero orphaned | **CONFIRMED** | Full R2 list and D1 key set |
| R2 package content | Indexed fields and hashes agree | 150 objects parsed; zero parse or field mismatches | **CONFIRMED** | Sequence/hash/link/cycle/decision/authority comparisons |
| Dashboard | Production surface identifies current release | Five tabs; 74 evidence records; footer shows `c909de83` | **CONFIRMED** | Authenticated browser read |
| Broker mutation | Must remain unavailable | Authority 2 / PROPOSE ONLY; no order route | **CONFIRMED** | Runtime configuration and UI |
| `settledCash` authority | Must be an actual settlement-status field | No such authoritative field is used; value is a derived plug | **UNVERIFIED / MISNAMED** | Source trace below |
| `/MNQ` account scope | Full governed-account exposure observable | Not proven while no futures position is open | **OBSERVED_FLOOR** | Existing scope audit; unchanged here |

## 5. Evidence discontinuity and storage reconciliation

### Known incident

The chain is intact but contains a known time discontinuity between sequences 61 and 62. Authority changed to level 2 while the old D1 constraint accepted only Authority 1. Cycle contexts continued to write while evidence indexing rejected the decisions. R2 cleanup removed any package whose D1 index write failed, so the result is a stalled, uncorrupted chain rather than orphaned packages.

The first successful Authority-2 decision is sequence 62. The freeze head is sequence 73. These are different facts and are intentionally preserved separately.

### Context-only cycles

All 12 context-only cycles fall inside the known 2026-08-26 outage window; none occur after recovery:

| Cycle | UTC timestamp | Decision |
|---|---|---|
| `CY-ba629ba31c-1986402` | 2026-08-26T16:31:00.611Z | REFUSED |
| `CY-ba629ba31c-1986403` | 2026-08-26T16:45:51.132Z | REFUSED |
| `CY-ba629ba31c-1986404` | 2026-08-26T17:00:55.841Z | REFUSED |
| `CY-ba629ba31c-1986407` | 2026-08-26T17:45:53.350Z | REFUSED |
| `CY-ba629ba31c-1986408` | 2026-08-26T18:01:02.385Z | REFUSED |
| `CY-ba629ba31c-1986409` | 2026-08-26T18:15:53.388Z | REFUSED |
| `CY-ba629ba31c-1986410` | 2026-08-26T18:30:54.560Z | REFUSED |
| `CY-ba629ba31c-1986411` | 2026-08-26T18:45:50.014Z | REFUSED |
| `CY-ba629ba31c-1986412` | 2026-08-26T19:00:52.919Z | REFUSED |
| `CY-ba629ba31c-1986413` | 2026-08-26T19:15:51.358Z | REFUSED |
| `CY-ba629ba31c-1986414` | 2026-08-26T19:30:50.643Z | REFUSED |
| `CY-ba629ba31c-1986415` | 2026-08-26T19:45:51.077Z | REFUSED |

There are also 10 evidence-only cycles, IDs ending 1986222 through 1986231, dated 2026-08-24T19:30:12Z through 21:45:22Z. They predate cycle-context indexing. Therefore the net count difference of two (76 contexts versus 74 evidence records) is explained by schema history and the known incident; it is not an unexplained current write failure.

## 6. Post-recovery production baseline

Eleven evidence records sealed after sequence 62, covering 2026-08-27T13:45:39.792Z through 16:15:38.182Z. All are `REFUSED`, proving scheduled sealing continued after the one-off recovery test.

| Sequences | Count | Reason | Interpretation |
|---|---:|---|---|
| 63–71 | 9 | `FACT_UNVERIFIED` / `SCHWAB_HISTORY_SHORT:52` | C-01 baseline: unavailable/insufficient history is not distinguished from adapter/auth/transport/parser failure |
| 72 | 1 | `CUSTODY_RISK_MAPPING_REQUIRED` / `CUSTODY_CHAIN_UNAVAILABLE:CBRS260828C00210000` | Availability-chain failure for the CBRS short call; not an uncovered-call or unmappable-instrument structural code |
| 73 | 1 | `FACT_UNVERIFIED` / `SCHWAB_HISTORY_SHORT:52` | Same C-01 ambiguity baseline |

Sequence 62 is separate: `TRUTH/SESSION_NOT_RTH`, market `CLOSED`. Packet 0 records these values; it does not change the adapter taxonomy or custody-risk mapper.

The chain-unavailable reason appeared once, at sequence 72. Adjacent cycles returned the history-short refusal, so Packet 0 records it as a transient one-cycle observation rather than an established pattern of final-session chain degradation. The current envelope still cannot distinguish a failed chain fetch from a valid near-expiry chain with no meaningful quote. The sequence-72 reason is therefore the comparison point for the Aug 28 expiry. If the equity-only book maps cleanly afterward, the result isolates the observation to option-chain retrieval. If it still fails, the fault is upstream of the contracts. A later structural mapping code would be new evidence rather than a continuation of this baseline.

### C-01 production signature and unsupported UI cause

`SCHWAB_HISTORY_SHORT:52` is not a generic absence marker. It records a response containing exactly 52 bars. The identical sub-reason occurred in 10 of the 11 post-recovery cycles (sequences 63–71 and 73), including regular-trading-hours cycles. A constant bar count repeated across cycles is consistent with a fixed response limit or truncation and must remain distinguishable from a timeout, authentication failure, transport failure, parser failure, or a genuinely absent response. The literal value `52` is the regression baseline for the later adapter-taxonomy packet.

The Decisions surface narrated the same class of refusal as “the market-data provider did not respond before the safety timeout” and “Timestamp missing.” Those claims are not supported by `SCHWAB_HISTORY_SHORT:52`: a received 52-bar response and a no-response timeout are different events. Packet 0 therefore records a provenance defect: the UI asserted a cause that the sealed record did not establish. No wording or adapter behavior is changed in this packet.

## 7. Cash and funding provenance

### Source trace

The value passed to the Governor as `settledCash` is not sourced from a Schwab settlement-status field:

1. `cloudflare/schwab-client.js:777` sums position market value.
2. `cloudflare/schwab-client.js:782` captures `reportedCash` from `cashBalance`, `moneyMarketFund`, or `availableFunds`.
3. `cloudflare/schwab-client.js:786` sets `cash = nav - positionMarketValue` whenever both inputs are finite; `reportedCash` is only the fallback.
4. `cloudflare/schwab-client.js:793` separately captures `withdrawableCash` from `cashAvailableForWithdrawal`, `availableFundsNonMarginableTrade`, or `cashAvailableForTrading`.
5. `src/pipeline/cycle.js:490` passes `account.value.cash` into the Governor under the name `settledCash`.
6. `src/portfolio/governor.js:116` and `:125` use that value for the assignment-funding gate.

This plug is useful for account reconciliation. It is not proof of settlement status.

### Observed values

Custody snapshot captured 2026-08-27T16:20:09.866Z (09:20:09 PDT), snapshot hash `803f7d959d27039e5802dee1c35f5eee9249c4441f80f57886abbc3f629ab07e`:

| Field | Observed value | Current use |
|---|---:|---|
| `cash` | $3,433.02 | Passed to Governor as `settledCash` |
| `reportedCashBalance` | $3,433.02 | Recorded, not selected while the plug is computable |
| `withdrawableCash` | $89,318.34 | Recorded; not used by the funding gate |
| `buyingPower` | $178,636.68 | Display/operations; explicitly not reserve cash |
| `nav` | $164,440.52 | Input to the cash plug |
| `marginDebit` | $0.00 | Fails the gate closed when positive; its fallback can reference `cash` |

The roughly 26× gap between displayed cash and withdrawable cash is a live unresolved semantic question. Packet 0 does not choose a replacement field.

### Demonstrated residual behavior

The earlier baseline recorded NAV of $167,242.68 and cash of $3,468.00, implying $163,774.68 of marked positions under the plug. The freeze recorded NAV of $164,440.52 and cash of $3,433.02, implying $161,007.50 of marked positions.

| Quantity | Earlier baseline | Packet 0 freeze | Change |
|---|---:|---:|---:|
| NAV | $167,242.68 | $164,440.52 | −$2,802.16 |
| Implied marked positions | $163,774.68 | $161,007.50 | −$2,767.18 |
| `cash = NAV − marked positions` | $3,468.00 | $3,433.02 | −$34.98 |

This is the demonstrated property: the Governor’s funding input is the residual between two independently moving marked totals. It moved by $34.98 as NAV and the summed position marks moved by different amounts. It did **not** move by the full $2,802.16 NAV decline, so these two snapshots do not establish that a falling share mark reduces cash dollar-for-dollar. Agreement between `cash` and `reportedCashBalance` at $3,433.02 is reassuring for this snapshot but does not validate the plug generally because the implementation still prefers the plug whenever NAV and position market value are finite.

### Mark quality at freeze

The live dashboard showed option marks timestamped approximately 2026-08-27 09:21 PDT: CBRS $0.08 and SPCX $1.02. They were current on the surface and not carrying a stale badge. The cash observation above was captured at 09:20:09 PDT; the quote observation was made separately at approximately 09:21 PDT and must not be read as the same atomic snapshot.

Both contracts expire Aug 28. At the frozen marks, the CBRS $210 call retained approximately $40 of marked liability across five contracts, while the SPCX $143 call retained approximately $510. Against SPCX’s recorded $675 entry credit, the latter implies approximately $165 of open option profit before fees. These figures preserve the pre-expiry setup; they are not expiry predictions and do not assert that either contract will expire or assign.

Because `cash` is `NAV - positionMarketValue`, the funding input inherits every valuation error or stale mark inside position market value. It also cannot distinguish settled proceeds from unsettled proceeds already included in net liquidation. The UI phrase “settled unborrowed cash” is therefore stronger than the preserved provenance supports.

**Disposition:** retain the current behavior for this packet, mark the field semantically unverified, and require a separately reviewed packet before changing the funding source or its label.

## 8. Regression baseline and release blockers

The following become automatic blockers for later packets:

1. Any source, model, mandate, or runtime identity differs without an explicit successor record.
2. The full test suite fails or drops tests without explanation.
3. A deployed artifact does not byte-match the reviewed bundle.
4. Either direction of D1/R2 reconciliation produces a missing or orphaned package.
5. The evidence chain develops a gap or link mismatch.
6. A post-recovery context lacks evidence without a named, reviewed reason.
7. A field of uncertain provenance is relabeled as authoritative.
8. A change modifies calculator mode isolation, request stamps, Today's P&L reconciliation, raw packet sealing, or Authority 2 boundaries outside its approved packet.

## 9. Rollback and recovery

No rollback is needed for Packet 0 because it makes no runtime or storage change. Recovery anchors for future packets are:

- source: remote tag `v5-2026-08-27-authority-storage-recovery`;
- runtime: Worker version `c909de83-308c-4a56-9336-5db2edf0b463` and artifact SHA-256 `7e9b775c…`;
- storage: fresh Packet 0 D1 export and its restored/checksummed SQLite database;
- evidence: sequence 73 / chain head `4347666d…` at freeze, while sequence 62 remains the Authority-2 recovery milestone.

Any later rollback must restore code and schema as a reviewed pair. Repointing only the Worker while leaving an incompatible schema is not a complete rollback.

## 10. Review boundary

Packet 0 is complete when this document, the machine-readable matrix, the pre-packet worktree inventory, test baseline, and checksums verify. It authorizes no implementation. Packet 3 mixed-metric containment remains stopped pending separate review.
