# AMENDMENT 3 — Forward Event Source (Revision 1)

**Issued:** 2026-08-27
**Status:** `SIGNED — PENDING IMPLEMENTATION GATES`
**Supersedes draft:** `68c58cd8445905bd1d5d788139745fb1f53ee9dcd76a3ef50a51d749668dbe72`
**Resolves:** H-09 / `CSP-FR-009`
**Authority:** 2 / PROPOSE ONLY — unchanged

## Predecessor chain — verified

```
Packet 0     55052d32ab03c3eb46b8c8a8af52770b479428a5
Amendment-1  bff748201613d6a1cf1e57d3645324a6807f57541b577925ca7eb63b1024738f
Amendment-2  2615a55b559d759a0ed053b775943eb95c137af9f2a2f2aaeb5775b4ecbf580b
```

Digests independently recomputed from the original files, hashed before opening, in an environment separate from the one that produced them. Transfer container `babd0998882c8670c34eb323f34c64b7f5146c39e5bbe00b882ed602cc78f4fe`.

## Clause superseded — exact

**Amendment-1 §3, decision D-3, first bullet:**

> Price, chain, history, **events**, ADV, session: live Schwab DataProvider only.

**The term `events` is struck from that list.** Every other element — price, chain, history, ADV, session — remains Schwab. The fundamentals half of D-3, naming a separate vendor with required `asOf` and fail-closed on missing, is unaffected and remains in force.

## Why the clause fails

Schwab has no forward earnings calendar.

- `src/truth/providers/schwab.js:266-268` — no Schwab calendar call exists; `events()` delegates entirely to an injected provider
- `cloudflare/schwab-client.js:481-511` — quote path requests quote and reference fields, no forward calendar method
- Observed Schwab fundamental fields include `lastEarningsDate`, which is backward-looking

Amendment-1 named a source that cannot satisfy the requirement it was written to govern. That is an amendment defect and it cannot be closed by changing code.

### Closure trap

**Do not resolve H-08 by pointing `events()` at Schwab's `lastEarningsDate`.**

A backward-looking date cannot clear a forward blackout window. Treating its absence of future dates as an empty calendar would silently pass every tenor and disable the gate that most distinguishes a single-name book from an ETF book.

Conformance would pass. The gate would be gone.

---

## 1. The named source

The qualifying forward event source is:

```
BENZINGA via MASSIVE, through BENZINGA_COMPENSATING_ADAPTER_CONTRACT_V1
```

**Benzinga without the adapter contract does not satisfy this amendment.** Live verification found four defects, two of which fail open on the earnings gate. The adapter is not a convenience layer — it is the reason the source qualifies.

Entitlement confirmed 2026-08-27: HTTP 200, `MASSIVE_BENZINGA_EARNINGS`, schema `BENZINGA_V1_EARNINGS_V4`.

---

## 2. Source contract — verified against live responses

| Requirement | Result | Evidence |
|---|---|---|
| Entitlement | PASS | HTTP 200 after subscription |
| Forward coverage beyond 45 DTE | PASS | NVDA projected 2026-11-18, 83 days out |
| Vendor vintage | PASS | `lastUpdated` populated on all live rows |
| `date_status` enumerated | PASS | NVDA `projected`, ADBE `confirmed` |
| Known-empty distinguishable from failure | **PASS only with §3** | AAPL empty window verified; inverted range also returns `cleared: true` |
| Release time present | PASS, field only | `timeEst` populated |
| Time normalization | **FAIL — §3.5 compensates** | Declares `EST_FIXED_UTC_MINUS_05`, one hour late for eight months |
| Named error taxonomy | **FAIL — §3.1 compensates** | Missing and invalid tickers collapse; malformed and inverted dates fail open |

---

## 3. Compensating adapter contract — mandatory

All eight clauses must hold before an earnings result may clear a tenor.

**3.1 · Validate before calling.** Ticker, `from`, and `through` are validated before any provider call. Malformed dates and `from > through` return distinct named failures and make **no** provider request.

**3.2 · Echo verification.** The response must echo the requested ticker and window exactly, in both `queryWindow` and the top-level `from`/`through`. Any mismatch is `EARNINGS_WINDOW_ECHO_MISMATCH` and fails closed.

**3.3 · Known-empty acceptance.** An empty result clears a tenor only when the exact window is echoed, `events=[]`, `resultCount=0`, `status=VERIFIED`, `cleared=true`, and `emptyResultValidated=true`.

**3.4 · Empty freshness.** An empty result must additionally carry a vendor freshness stamp no older than `freshnessMaxMs`, derived as:

```
freshnessMaxMs = cycleIntervalMs      (governed, not a standalone constant)
```

Absent a stamp → `EARNINGS_EMPTY_UNVERIFIABLE`. Stamp older than the bound → `EARNINGS_EMPTY_STALE`. Both fail closed.

**Rationale.** The six conditions in 3.3 are all payload properties. A cached empty result computed before an earnings date was announced satisfies every one of them. Structural validity is not temporal validity.

**3.5 · Time normalization.** Interpret the vendor's Eastern wall clock with the IANA zone `America/New_York`. A unique mapping supplies the governing UTC instant. An overlap returns `AMBIGUOUS_LOCAL_TIME` with both candidates recorded in evidence; a spring-forward gap returns `NONEXISTENT_LOCAL_TIME`. Both fail closed.

**3.6 · Provider time as diagnostic.** Treat `eventTimeUtc` as a comparison value until Massive corrects its declared `EST_FIXED_UTC_MINUS_05` behavior. A divergence records `PROVIDER_EVENT_TIME_MISMATCH`; the IANA-derived instant governs. When the mismatch count reaches zero, the vendor has fixed it.

**3.7 · Required event fields.** Every event carries `timeEst`, `lastUpdated`, and an enumerated `dateStatus` ∈ {`projected`, `confirmed`}. An unrecognized `dateStatus` fails closed. Missing time is `EARNINGS_EVENT_TIME_MISSING` (`NO_DATA`) — **no UTC instant may be invented.**

**3.8 · Error isolation.** Provider, network, and schema errors remain distinct from verified empty results. No error, default, parse failure, or partial response may set `cleared=true`.

---

## 4. Single source — recorded gap

**Principal decision:** this amendment names one forward-event source. The two-source requirement of the superseded draft is withdrawn.

```
CSP-FR-004  EARNINGS_SINGLE_SOURCE_DEPENDENCY
status      RECORDED_GAP
severity    MEDIUM
effect      no disagreement detection — a wrong date is undetectable;
            an absent source fails closed
rationale   failure mode is fail-closed, the tolerable direction.
            Every ticket is human-approved at Authority 2.
closure     prerequisite for authority above 2, not for single-name
            approval at Authority 2
```

**What is given up.** Two independent sources catch a *wrong* date; one source catches only an *absent* one. That distinction matters when an agent acts unattended and matters less when every ticket is approved by hand.

**Any future secondary must use a different upstream origin.** Another Benzinga redistributor does not satisfy independence. Finnhub was investigated and stopped at a preserved 401 credential preflight; its upstream lineage was never established.

---

## 5. Implementation

One canonical adapter module. **Not three implementations.**

- production cycle — `src/pipeline/cycle.js`
- autonomy shadow — `nuvo-command/worker/autonomy-shadow-preview.ts`
- standalone probe

All three invoke the same module, directly or through a private service binding. The probe tests the production contract rather than reimplementing it.

**Every event result exposes source identity and vintage.** A tenor cleared by an unnamed source is not cleared.

**Result envelope:**

```
status · faultCode · faultStage · sourceId · upstreamOrigin
vendorAsOf · fetchedAt · requestedRange · echoedRange
coverageThrough · schemaVersion · events · rawPayloadHash
```

---

## 6. Activation gates

Signed. **Not active.** Remaining:

1. Compensating adapter promoted from prototype to production — `RESOLVED_PROTOTYPE_ONLY` today
2. All eight §3 clauses implemented in the canonical module with exact-value tests
3. Live parity evidence: production emits corrected UTC instants for ADBE 2026-09-10 (`20:05Z`, not `21:05Z`) and AAPL 2026-10-29 (`20:00Z`, not `21:00Z`)
4. `FR-024` and `FR-026` closed — inverted ranges and invented `16:00:00Z` are both fail-open
5. H-08 closes only after all three consumers implement identically and a live tenor-coverage test passes

**No deploy from this amendment.**

---

## 7. Vendor escalation

Massive support notified 2026-08-27 regarding `EST_FIXED_UTC_MINUS_05` with `daylightSavingApplied: false`, and the inverted-range behavior returning `VERIFIED` with `cleared: true`.

The compensating adapter is a workaround, not a permanent design. If the vendor corrects both, §3.5 and §3.6 may be revisited under a successor amendment — **not** removed silently.

---

## 8. Unchanged

`approved-universe` remains **TLT, SLV, GDX**. No universe member admitted, no `NUVO_SYMBOLS` edit, no authority change.

The earnings blackout remains **whole-tenor for single names** at DTE ≥ 7, forward-window below that per Amendment 4 §4.1, and `WINDOW` for ETFs. **This amendment names who supplies the dates. It does not change what the gate does with them.**
