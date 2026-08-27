# Copilot Phase 1 — per-unit entry cap

**Status:** PRINCIPAL APPROVED; DRAFT NOT ACTIVE  
**Authority effect:** NONE until a separate reviewed activation  
**Decision ID:** P1-1  
**Predecessor mandate root:** `601fb1ee02ddeddb7dc1197ea0910cdfeb39e05aaa384b155b374b0124b1bba1`

## Executive decision

The Principal approves a **per-unit entry cap of 10% of NAV**.

The name is deliberate. The rule caps the indivisible capital unit being added,
not every option contract and not a risk-reducing close. It is an admission
rule for new exposure. It does not by itself compel liquidation when an
existing unit later exceeds the threshold.

```text
per-unit entry limit = custody NAV × 10%
```

NAV and every input used by the test come from the same sealed custody packet.
The proposal must be revalidated before execution. If a NAV change, deliverable
change, or other falsification condition causes the unit to exceed 10%, the
ticket becomes `VOID` with a named reason. Missing, stale, or unverifiable
inputs produce `NO DATA`; the ticket may not silently disappear.

## Capital-unit measurements

| Entry | Constitutional capital unit |
|---|---:|
| Standard cash-secured put | `strike × contract multiplier × abs(contracts)` |
| New fully paid share lot | `share-order limit × quantity + estimated fees` |
| Buy-write | Same newly acquired share-lot commitment |
| Covered call on verified existing shares | No new capital unit from the covering shares |
| Buy to close or sell owned shares | Exempt as risk-reducing exposure |

A standard option normally represents 100 shares, but the engine may not assume
that value for an adjusted contract. It must use the broker or OCC deliverable
record preserved in the packet. If the complete deliverable, including any cash
component, cannot be determined, the result is `NO DATA`.

Premium received from a cash-secured put may not reduce assignment notional.
Assignment requires the full strike obligation regardless of the premium
collected. Netting the credit would understate committed capital by the exact
amount that makes the proposed trade appear more attractive, just as buying
power would overstate the constitutional cash reserve.

A covered call written against verified existing, unencumbered shares does not
create another share-capital unit and therefore is not rejected merely because
the inherited lot exceeds 10% of NAV. The covering lot's observed unit notional
must still be disclosed. This exemption does not authorize the call: account
concentration, deployment, expiration, lifecycle, admission, freshness, and
all other applicable gates still govern it. The exemption cannot be used to
buy additional shares or increase the number of covered contracts.

## Interaction with existing limits

Passing P1-1 is necessary but not sufficient. Every risk-increasing entry must
also fit within:

1. constitutional deployment headroom;
2. the P0-4 Authority-2 proposal-capacity limit;
3. the 20% aggregate single-underlying cap;
4. the 25% exact-expiration cap and the subsequently approved DTE policy; and
5. every applicable product, liquidity, data-quality, and admission rule.

At the Phase 0 baseline, remaining deployment headroom is zero. P1-1 therefore
does not authorize any current new exposure.

## Pending-capital reservation and release

A risk-increasing ticket reserves its maximum capital commitment when issued.
Reservations count in deployment headroom, proposal capacity, concentration,
and expiration measurements wherever applicable.

The reservation has an explicit terminal path:

- **fill:** the filled amount stops being pending and becomes observed position
  or order exposure;
- **partial fill:** the filled portion becomes observed exposure and the
  unfilled portion remains reserved until another terminal event;
- **ticket expiry:** the unfilled reservation is released;
- **void:** the unfilled reservation is released and the named void reason is
  preserved;
- **cancellation:** the unfilled reservation is released only after broker or
  local ticket state confirms cancellation.

Releasing a reservation does not erase its evidence record.

## Anti-splitting rule

All risk-increasing tickets for the same canonical underlying during one New
York trading session form one logical proposal batch. Pending and filled
commitments aggregate across sequential proposals against both the
single-underlying cap and the P0-4 proposal-capacity gate. The batch's P0-4
ceiling is fixed from the sealed custody state used for its first live ticket;
later tickets cannot manufacture a larger allowance by splitting the intended
trade over time.

A replacement for an expired, voided, or cancelled unfilled ticket retains the
same batch identity and counts only its maximum live commitment, rather than
double-counting the abandoned ticket. Filled commitments remain part of the
session batch. A new market session creates a new batch and recomputes every
limit from current sealed custody.

## Numerical consequences

At the Phase 0 baseline NAV of `$167,242.68`:

```text
per-unit entry limit = $16,724.27
```

One SPCX share lot at the baseline mark fits the unit cap; one CBRS share lot
does not. Neither is currently admissible as new exposure because P0-4 reports
zero deployment headroom.

For the planned dedicated account at `$50,000` NAV:

```text
per-unit entry limit         = $5,000
maximum new CC share price   = approximately $50 for 100 shares
maximum standard CSP strike  = $50
```

An underlying trading above $50 may still have an admissible cash-secured-put
strike at or below $50. Passing this arithmetic never relaxes liquidity or
quality gates.

## Roadmap correction

The roadmap previously carried a provisional 65% deployment ceiling. That was
the legacy running-system value; it was never approved or activated as the
copilot mandate. Phase 0 deliberately approved complementary limits of 80%
maximum deployment and 20% minimum unencumbered settled-cash reserve. Those
values remain draft-not-active until the separate mandate activation.

## Decision record

```text
P1-1 PER-UNIT ENTRY CAP: APPROVED              10% of NAV
Premium netting:         PROHIBITED            full assignment obligation
Adjusted deliverable:    REQUIRED              NO DATA if unverifiable
Pending reservation:     REQUIRED              explicit terminal release
Anti-splitting:           REQUIRED              same underlying × NY session

Principal: recorded in the source decision
Decision date: 2026-08-26 America/Los_Angeles
Successor mandate root: 818f96eb0cfc6c0ee08a9f0735757036843df50fb59422952247509450766550
```

## Reproduce the successor root

From the repository root:

```sh
shasum -a 256 -c governance/drafts/copilot-phase1-v1/SHA256SUMS
shasum -a 256 governance/drafts/copilot-phase1-v1/manifest.json
```

The second command must return the successor `mandateRootHash` recorded above.
