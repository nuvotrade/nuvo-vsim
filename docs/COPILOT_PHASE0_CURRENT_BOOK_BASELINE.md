# VSIM Copilot Phase 0 — Current Book Baseline

**Status:** READ-ONLY MEASUREMENT AGAINST DRAFT MANDATE
**Measured:** 2026-08-26
**Custody observation:** 2026-08-27T03:26:29.035Z / 2026-08-26 20:26:29 PDT
**Custody packet hash:**
`49e1e6836c7ee026f729b77c73c39c56a253f269c5fad4336911fc4d2e628d17`
**Draft mandateRootHash:**
`601fb1ee02ddeddb7dc1197ea0910cdfeb39e05aaa384b155b374b0124b1bba1`

This is the latest persisted custody packet, not a newly triggered broker
refresh. No Worker, D1, R2, scheduler, broker, or runtime state was mutated to
produce this report.

## Observed custody

| Measurement | Observed value |
|---|---:|
| Schwab net liquidation | $167,242.68 |
| Cash projection | $3,467.68 |
| Schwab reported cash balance | $3,467.68 |
| Margin debit | $0.00 |
| Open orders | 0 |
| Open positions | 4 |
| CBRS shares | 500 · $93,930 market value |
| SPCX shares | 500 · $70,795 market value |
| CBRS short calls | 5 · $210 strike · Aug. 28 expiry |
| SPCX short calls | 5 · $143 strike · Aug. 28 expiry |

The adapter's `cash` field is ordinarily an economic projection of net
liquidation less signed marked positions. In this packet it exactly matches
Schwab's separately preserved reported cash balance. The packet does not yet
name a distinct settlement-status field. The reserve breach is invariant to
that limitation because even the full reported $3,467.68 is far below the
required reserve.

## Breach set

### B0-1 — single-underlying concentration: CBRS

```text
observed       $93,930.00   56.16% of NAV
20% ceiling    $33,448.54
excess         $60,481.46
multiple       2.81× the ceiling
```

**State:** `BREACH · MANAGE_ONLY`
**Consequence:** no additional CBRS exposure may be proposed. Hold, close, or
reduce remains subject to lifecycle analysis and fresh data.

### B0-2 — single-underlying concentration: SPCX

```text
observed       $70,795.00   42.33% of NAV
20% ceiling    $33,448.54
excess         $37,346.46
multiple       2.12× the ceiling
```

**State:** `BREACH · MANAGE_ONLY`
**Consequence:** no additional SPCX exposure may be proposed. The below-basis
call is a lifecycle-review trigger, not by itself a close instruction.

### B0-3 — exact-expiration concentration: 2026-08-28

Under M0-3, the two covered calls contribute the current market value of their
verified covering shares once:

```text
CBRS covering shares      $93,930.00
SPCX covering shares      $70,795.00
exact-expiration exposure $164,725.00   98.49% of NAV
25% ceiling                $41,810.67
excess                    $122,914.33
multiple                         3.94× the ceiling
```

**State:** `BREACH · EXPIRATION_CLUSTER`
**Consequence:** no additional Aug. 28 exposure may be proposed. This exact-date
measurement supersedes the older W1 percentage for constitutional evaluation;
W1 remains a display aggregation.

### B0-4 — minimum reserve

There are no open orders or cash-secured puts in the packet, so no observed
cash encumbrance is deducted from the reported balance for this baseline.

```text
observed reserve    $3,467.68    2.07% of NAV
20% floor          $33,448.54
shortfall          $29,980.86
```

**State:** `BREACH · RESERVE`

### B0-5 — maximum deployment

The approved deployment and reserve definitions are complementary:

```text
deployed amount = NAV − unencumbered settled cash
                = $167,242.68 − $3,467.68
                = $163,775.00

observed deployment             97.93% of NAV
80% ceiling                    $133,794.14
excess                          $29,980.86
```

**State:** `BREACH · DEPLOYMENT`
The deployment excess equals the reserve shortfall by construction.

## Authority-2 proposal capacity

```text
remaining deployment headroom
  = max(0, $167,242.68 × 80% − $163,775.00)
  = $0.00

max single proposal commitment
  = $0.00 × 20%
  = $0.00
```

**State:** `NO CAPITAL FOR NEW EXPOSURE`
This does not block risk-reducing lifecycle recommendations on existing
positions. Those still require fresh, complete market and custody evidence.

## Scope completeness

The packet identifies account ••••4315 and contains four equities/options
positions with no open orders. The current dashboard adapter explicitly marks
futures as unverified.

The preserved transaction ledger resolves the two observed symbols:

- `SPXW260825C07700000`: five contracts opened Aug. 25 and closed by a
  `RECEIVE_AND_DELIVER` event for all five contracts at
  2026-08-26T05:34:34Z;
- `SPXW260828C07700000`: one contract opened at 2026-08-26T17:57:19Z and
  closed at 2026-08-26T18:02:19Z;
- `/MNQU26:XCME`: two contracts opened and closed back to zero, followed by a
  one-contract short opened and closed back to zero by
  2026-08-26T05:03:58Z.

All of those ledger rows carry account mask `4315`. SPX and `/MNQ` were closed
activity, not missing open positions in the latest packet. The ledger therefore
disproves the separate-futures-account hypothesis for these `/MNQ` trades.

The enforceability gap remains narrower but real: V5 has evidence that futures
trade in ••••4315, while the custody adapter declares futures observation
unverified. The available history proves the cited futures round trips were
flat by the latest snapshot; it does not prove that an open futures position
would be detected and incorporated into limits while it exists.

Completeness is attached to each result:

| Limit result | Observed result | Completeness |
|---|---|---|
| NAV denominator | $167,242.68 | Complete for the returned brokerage account packet |
| CBRS concentration | Breach; observed floor at 56.16% | Breach proven; futures observation capability unverified |
| SPCX concentration | Breach; observed floor at 42.33% | Breach proven; futures observation capability unverified |
| Aug. 28 expiration | Breach; observed floor at 98.49% | Breach proven for equities/options; futures expiry surface unverified |
| Reserve/deployment | Breach; observed floors at 2.07% / 97.93% | Breach proven from the most favorable full reported cash; cash encumbrance and futures observation remain incomplete |
| New-proposal capacity | $0 | Complete refusal; missing exposure cannot create headroom |

No global `SCOPE_INCOMPLETE` status suppresses these results. Missing exposure
could worsen the breaches but cannot remove them. Each affected numeric value
is an `OBSERVED_FLOOR`, not a complete account measurement.

## Limits deliberately not evaluated

The draft root does not authorize a conclusion for:

- DTE eligibility;
- a per-contract NAV cap;
- factor/cluster, Greek, or beta compliance;
- drawdown or high-water-mark state;
- after-tax lifecycle ranking.

No implementation may infer those values from older code or prose.

## Transition starting position

At this baseline:

1. both owned names are `MANAGE_ONLY` for concentration;
2. the Aug. 28 expiration is in breach;
3. deployment and reserve are complementary breaches;
4. new-exposure proposal capacity is zero;
5. risk-reducing lifecycle analysis remains permitted but must not pattern-match
   from basis or breach status to an action;
6. the post-expiry packet is required before an unwind schedule can be priced.
