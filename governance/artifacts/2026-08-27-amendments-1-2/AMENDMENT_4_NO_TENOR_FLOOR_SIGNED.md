# AMENDMENT 4 — No Tenor Floor

**Issued:** 2026-08-27
**Status:** `SIGNED — PENDING IMPLEMENTATION GATES`
**Supersedes:** `NUVO_RULES.minDte = 7` — an unratified runtime default
**Authority:** 2 / PROPOSE ONLY — unchanged
**Supersedes draft:** `a5309bf962a87617cdbe1880af6775bc080d0b4b113316c01be15fe2732fd59f`

## Predecessor chain — verified

```
Packet 0     55052d32ab03c3eb46b8c8a8af52770b479428a5
             tag v5-2026-08-27-packet-0-freeze · pushed to origin

Amendment-1  bff748201613d6a1cf1e57d3645324a6807f57541b577925ca7eb63b1024738f
             AMENDMENT_1_LIVE_UNIVERSE_SCAN_2026-08-27.docx · 13,889 bytes

Amendment-2  2615a55b559d759a0ed053b775943eb95c137af9f2a2f2aaeb5775b4ecbf580b
             AMENDMENT_2_MIN_MARKET_CAP_4B_2026-08-27.docx · 13,086 bytes

Amendment-3  68c58cd8445905bd1d5d788139745fb1f53ee9dcd76a3ef50a51d749668dbe72
             DRAFT REFERENCE ONLY — never activated, revised to single-source.
             Not a predecessor of this amendment.
```

Amendment-1 and Amendment-2 digests were independently recomputed from the original `.docx` files, transferred without modification and hashed before opening, in an environment separate from the one that produced them. Transfer container `babd0998882c8670c34eb323f34c64b7f5146c39e5bbe00b882ed602cc78f4fe`.

**Clause superseded:** none. This amendment supersedes a runtime default, not a governing clause.

---

## 1. The principle

**Days to expiration is a search window, never an admission gate.**

A contract at any tenor is admissible if it passes every gate on its own terms. A contract at any tenor is refused if it does not. **Tenor itself is not a reason.**

Explicitly: **1 DTE is not prohibited.** No floor exists. `minDte = 7` is superseded.

## 2. What this does not do

This amendment removes a floor. It does not weaken a gate, create an exemption, or admit a contract that fails on its economics.

**Every gate still runs at every tenor.** Where a gate is defined in terms that do not hold at short tenors, §4 defines how it is measured there — it is not skipped.

**Annualized ROC does not select.** Display field at every tenor, prohibited as a decision criterion. At 1 DTE the annualizer is 365×, so a 0.3% one-day credit reads as roughly 110% annualized. That number is why short tenors look attractive and it is not evidence of edge. **NEV per calendar day already accounts for time.**

---

## 3. Why the gates need sub-7-DTE definitions

Two gates are written in terms that make them inert below roughly a week. Admitting 1 DTE without addressing them would not be permitting a trade — it would be admitting a tenor where two protections do not apply.

**Whole-tenor earnings blackout.** The rule blocks a contract whose life spans an earnings date. At 1 DTE the life is one day. A name reporting in three days passes cleanly, assignment occurs the day before the print, and the position is held through the event. The gate does not reject it; the gate never sees it.

**Wheel stranding test.** Measures the fraction of assignment paths requiring more than 1.0σ of recovery over a covered-call horizon. If that horizon scales with contract DTE, the ensemble's terminal distribution collapses toward spot at 1 DTE and nearly all paths pass — by construction, not by measurement.

---

## 4. Sub-7-DTE gate definitions

Applies when `DTE < 7`. Above that, existing definitions unchanged.

### 4.1 Earnings — forward-looking window

```
DTE ≥ 7    blackout if a confirmed or estimated earnings date falls
           within the contract's life                        (unchanged)

DTE < 7    blackout if a confirmed or estimated earnings date falls
           within max(DTE, shortTenorEarningsHorizon) days of the
           decision instant
```

`shortTenorEarningsHorizon = 7 days` — `CHOSEN`, `applies_to: SINGLE_NAME`.

**Rationale.** A cash-secured put is an acquisition commitment. Assignment delivers shares that are then held — the exposure does not end at expiry. Measuring the blackout against the contract's life understates the exposure at short tenors, because the shares survive the contract.

Seven days is a judgment. It is the shortest window covering assignment plus a normal settlement and re-underwriting cycle. Sunsets once resolved assignment outcomes exist.

The comparison is exactly `DTE < 7`. At 6 DTE the short-tenor branch applies; at 7 DTE the contract-life branch applies. Both produce a seven-day window at that boundary, so **the definition label, not the window value, is the testable distinction.**

**ETF sleeve unaffected** — issuer earnings do not apply, `WINDOW` mode governs.

### 4.2 Wheel stranding — fixed recovery horizon

```
recoveryHorizonDays = 14      at every DTE, never scaled to contract tenor
strandedPath        = recoverySigmaRequired > 1.0
strandedPct         = strandedPaths / assignedPaths
pass                = strandedPct ≤ sleeve maximum
```

The stranding test asks whether an assigned lot could be overwritten. That question concerns the **post-assignment covered-call horizon**, not the put's tenor. A 1-DTE put that assigns produces exactly the same inventory problem as a 45-DTE put that assigns.

**Explicitly: do not scale the recovery horizon with contract DTE.** Scaling it is what made the test inert at short tenors.

**Sleeve maximum — unchanged by this amendment:**

```
maxCspStrandedAssignmentPct
  ETF   0.40
  MEGA  0.40
  SMID  0.30
```

**Correction to the superseded draft.** Draft `a5309bf9…` stated a universal 0.40. That was an error: it would have silently relaxed SMID from 0.30. Amendment 4 changes **only** `recoveryHorizonDays`. The sleeve map and the 1.0σ threshold are untouched, and the existing governed row retains hash `18d6383a9a1c2e7b5a6e2448ed5016ae03b90a98c501ea546b50824d5d315e95`.

### 4.3 NEV — costs dominate at short tenors

Formula unchanged. Stated because short tenors are where it binds hardest:

```
NEV_put = P·100n
        − E[(K − S_T)⁺]_ens·100n
        − C_exec
        − Collat·(r_f + h)·T

pass iff NEV > b·σ̂_NEV
```

`C_exec` includes **round-trip** execution costs plus modeled slippage. At 1 DTE the collateral hurdle is small because `T` is small — but so is the credit. Many 1-DTE contracts will fail NEV on execution costs alone.

**That is the gate working.** A tenor whose premium does not survive its own transaction costs is refused on economics, not on tenor.

### 4.4 Gates needing no tenor-specific handling

Unchanged at every tenor: `p^RN ≤ p_star`, per-unit entry cap, single-name and cluster concentration, expiration concentration, contract liquidity (OI ≥ 250, volume ≥ 50, spread ≤ 8% of mid), quote freshness, history sufficiency, structure prohibitions, WTO.

---

## 5. Recorded consequences

Not prohibitions. Facts a reader should have.

**Expiration concentration binds harder.** Everything written at 1 DTE lands on the same date. The 25% single-expiration cap is the control and will be the binding constraint more often than any other limit at short tenors. The current book demonstrates the failure mode at 98.5% on one date.

**Estimation noise annualizes.** A one-day edge measured with error carries that error into any annualized view. Further reason ROC does not select.

**Assignment frequency rises per unit of calendar time.** More cycles, more transitions, more round-trip costs, more inventory events. The renewal model exists to price this and does not yet exist — until it does, short-tenor NEV understates the cost of repeated cycles.

**Gamma exposure is largest near expiry.** No gate currently measures it. Recorded as a known unmeasured risk.

---

## 6. Relationship to 0DTE

0DTE remains prohibited by the governing proposal.

The distinction is not arbitrary. At 0DTE there is no overnight, no next session in which to act, and assignment resolves within hours of the decision. At 1 DTE there is a session boundary between the decision and the terminal event.

**This amendment does not reopen 0DTE.**

---

## 7. Register rows

Every row carries `source` and `activation` as separate axes.

| ID | Value | source | activation | applies_to | Sunset |
|---|---|---|---|---|---|
| `minDte` | removed | — | `SUPERSEDED` | — | — |
| `dteSearchWindow` | `[1, 7, 14, 30, 45]` | CHOSEN | PROPOSED | probe | renewal model |
| `shortTenorEarningsHorizon` | 7 days | CHOSEN | PROPOSED | SINGLE_NAME, DTE < 7 | resolved assignment outcomes |
| `recoveryHorizonDays` | 14 | CHOSEN | PROPOSED | all tenors | renewal model |
| `maxCspStrandedAssignmentPct` | `{ETF: 0.40, MEGA: 0.40, SMID: 0.30}` | CHOSEN | ACTIVE | per sleeve | unchanged by this amendment |
| `annualizedRoc` | `holdingPeriodRoc × (365 / DTE)` | **DERIVED** | **ACTIVE** | all tenors | never — `DISPLAY_ONLY_NEVER_SELECTS` |

**Correction to the superseded draft.** Draft `a5309bf9…` left `source` blank on `annualizedRoc` while asserting every row carries both axes. It is `DERIVED` from `grossCredit / collateral × 365 / DTE`, `ACTIVE`, and its selection effect is `NONE`.

---

## 8. Implementation

- Remove the `minDte` floor from `NUVO_RULES` and any gate reading it as an admission threshold
- Add `1` to the probe's search tenors; independent listed-expiration resolution applies as at any other tenor
- Implement §4.1 and §4.2 as tenor-aware branches with exact-value tests at 1, 6, 7, and 30 DTE, asserting the **definition label** as well as the window value
- Source the risk-free rate by **resolved listed DTE**, not requested search target
- Confirm `annualizedRoc` reaches no selector or sort at any tenor
- Every sealed decision records the tenor and which gate definitions applied

**Required fixtures:**

```
1 DTE, earnings in 3 days   →  REFUSED       the case this exists to close
1 DTE, earnings in 8 days   →  event gate passes
                               proves the branch is a boundary,
                               not a blanket short-tenor refusal
```

---

## 9. Activation gates

Signed. **Not active.** Remaining:

1. §4.1 and §4.2 implemented with exact-value tests; both §8 fixtures pass
2. **H-09 resolved** — a governed forward earnings source. §4.1 cannot function without one.
3. **FR-020 resolved** — versioned assignment-path ensemble and NEV confidence inputs. §4.2 and §4.3 cannot function without them. Until then a contract returns `GATES_INCOMPLETE` naming `WHEEL_STRANDING_INPUT_UNAVAILABLE` and `NEV_INPUT_UNAVAILABLE`, and cannot emit `REACHES_UNDERWRITER`.
4. Production-wide proof that every `minDte` consumer is removed — the standalone audit proves only the mirror
5. Friday expiry observation resolved; separately authorized route and deployment work unchanged

**No deploy from this amendment.**

---

## 10. Unchanged

`approved-universe` remains **TLT, SLV, GDX**. No universe member admitted, no `NUVO_SYMBOLS` edit, no authority change, no gate weakened.

**This amendment removes a floor and closes the two holes that removing it would otherwise open.**
