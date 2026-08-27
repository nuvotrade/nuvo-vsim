# VSIM Copilot Phase 0 — Mandate Resolution Record

**Status:** PRINCIPAL DECISIONS RECORDED — MEASUREMENTS DRAFTED, NOT ACTIVATED
**Prepared:** 2026-08-26
**Current authority:** 2 / PROPOSE ONLY
**Current execution boundary:** manual Schwab execution; no broker mutation route
**Current custody account:** Schwab brokerage account ••••4315, equities and options surface

This record resolves the governance facts that must be settled before the
Copilot lifecycle schemas are designed. It does not amend the Constitution,
change a runtime value, authorize a product, or classify the current book.
Principal approval and a separate reviewed activation are required.

**Draft mandate artifact:**
`governance/drafts/copilot-phase0-v1/principal-mandate.json`
**Artifact SHA-256:**
`0861fe054621788a884bf3ede7998458dabddd08222f9f31d62c0d2617c3672c`
**Draft mandateRootHash:**
`601fb1ee02ddeddb7dc1197ea0910cdfeb39e05aaa384b155b374b0124b1bba1`

The root is the SHA-256 of the exact `manifest.json` bytes. It records the
approved P0-1 through P0-5 policy choices and the draft M0-1 through M0-5
measurement definitions. It is a reproducible draft identity, not an active
governance identity.

## 1. Audit result: what the current V5 source actually governs

The active checked-in limit object is `DEFAULT_LIMITS`, version
`constitution-v5.2.1`. The Worker, Guardian, and covered-call calculator all
import that object. The dashboard risk instrumentation receives those limits
from the Worker rather than owning separate cap constants.

| Control | Current checked-in value | Current consumers | Audit disposition |
|---|---:|---|---|
| Single-underlying ceiling | 20% of NAV | Governor, Guardian, dashboard, sizing | Active and regression-tested |
| One-expiration ceiling | 25% of NAV | Governor and dashboard ladder | Active and regression-tested |
| Portfolio deployment ceiling | 65% of NAV | Capital ledger and dashboard | Active runtime value; approved to become 80% only on activation |
| Minimum reserve | 20% of NAV | Capital ledger and dashboard | Active and regression-tested |
| Authority-2 capital fraction | 20% | Sizing only | Active, but its interaction with the 65% ceiling is under-documented |

The previously reported 12% display cap and 35% expiration cap are not present
as governing values in the current source. They survive as historical audit
findings from an earlier dashboard state, not as active alternatives. The
proposal's 80% deployment ceiling remains a genuine competing policy value.

### Deployment has two distinct controls

V5 currently calculates new deployable capital as:

```text
NAV × portfolio max deployed pct × authority fraction
```

At Authority 2 this is:

```text
NAV × 65% × 20% = NAV × 13%
```

`docs/OPERATING.md` describes Authority 2 as “20% of capital,” which can be
read as 20% of NAV. The code instead treats it as 20% of the portfolio
deployment ceiling. Phase 0 records them as separate controls:

- `portfolioMaxDeployedPct`: maximum total governed deployment;
- `authorityCapitalFraction`: fraction of that deployment ceiling available
  to new proposals at the current authority.

No downstream schema may use the unqualified word `deployment` for both.

## 2. Principal resolutions

The Principal approved these policy decisions on 2026-08-26. They remain
inactive until the governance artifact and its measurement definitions are
reviewed, signed, and activated in a separate change.

### Decision P0-1 — single-underlying ceiling

**Approved value:** 20% of account NAV.
**Reason:** 20% is the value in the checked-in Constitution, Governor,
Guardian, dashboard report, handoff record, and regression tests. No current
governing source supports 12%.

**Approved transition behavior:** a position above 20% is `MANAGE_ONLY`.
Existing exposure may be held, closed, or reduced under lifecycle rules, but
may not be increased.

**Principal decision:** `APPROVED`

### Decision P0-2 — one-expiration ceiling

**Approved value:** 25% of account NAV.
**Reason:** 25% is the value in the checked-in Constitution, Governor,
dashboard report, handoff record, and regression tests. No current governing
source supports 35%.

**Measurement note:** the denominator is account NAV. The numerator must be
defined by product before implementation: covered-share notional for covered
calls and assignment notional for cash-secured puts are the current dashboard
convention. That convention must be ratified as part of the governing artifact.

**Principal decision:** `APPROVED`

### Decision P0-3 — portfolio deployment and reserve

**Approved values:** 80% maximum total deployment and 20% minimum settled,
unborrowed, unencumbered cash reserve.

The ceiling and floor are exact complements. There is no intermediate band:

```text
deployment pct = 1 − reserve pct
deployment pct > 80%  iff  reserve pct < 20%
```

The 20% reserve funds unscheduled action, including early-assignment response,
buy-to-close activity, re-entry after call-away, fees, and drawdown de-risking.
The 80% ceiling deliberately loosens the running system's 65% value and
supersedes it upon activation.

**Principal decision:** `APPROVED WITH REVISION`

### Decision P0-4 — Authority-2 proposal capital

**Approved interpretation:** Authority-2 proposal capacity is standalone and
does not multiply the deployment ceiling by a fixed authority fraction.

```text
remaining deployment headroom = max(0, NAV × 80% − currently deployed capital)
max single proposal commitment = remaining deployment headroom × 20%
```

The proposal remains subject to every tighter limit. The proposed 10%
per-contract NAV cap is not yet approved and is not part of this decision.

This ceiling governs new proposals. It must not block risk-reducing lifecycle
recommendations on pre-existing positions.

**Principal decision:** `APPROVED WITH REVISION`

### Decision P0-5 — account and product scope

**Approved monitoring scope:** every position, order, transaction, transfer,
and lifecycle event returned for account ••••4315. All activity in the account
consumes the applicable account-level deployment, concentration, drawdown, and
reserve measurements regardless of whether VSIM recommended it.

**Approved recommendation/ticket scope:**

- buy fully paid shares;
- sell owned shares;
- sell fully cash-secured puts;
- sell covered calls against verified unencumbered shares;
- buy to close an existing short option as a risk-reducing action;
- hold current positions;
- hold cash or return `NO_TRADE` / `NO_DATA`.

**Outside the approved ticket scope:** new futures, 0DTE, long-option,
spread, margin-funded, or uncovered-option exposure. Manual activity outside
ticket scope remains visible, consumes account-level limits when it belongs to
••••4315, and is recorded as `OPERATOR_DIRECTED_OUT_OF_SCOPE` rather than being
made invisible or retroactively described as agent activity.

Closed futures activity may remain in the performance ledger. Open futures
cannot be included in current custody compliance until the relevant futures
account and endpoint are explicitly connected and named.

**Principal decision:** `APPROVED`

## 3. Draft measurement definitions for activation review

Approval of a percentage is not sufficient. These definitions are included in
the draft mandate so two correct implementations cannot disagree.

### M0-1 — NAV

`nav` is Schwab net liquidation for account ••••4315 at the custody packet's
observation time. Booked premium is not added. `positionEquity` or any measure
that adds booked premium to net liquidation is not a constitutional denominator.

### M0-2 — single-underlying concentration

Concentration is measured against `nav` and grouped by canonical underlying.
Contributions are additive when more than one exposure exists in the same name:

- owned shares: absolute current market value;
- short puts: full assignment notional, `strike × multiplier × abs(contracts)`;
- covered calls: no additional notional beyond the verified covering shares;
- long options: absolute current market value, representing remaining premium
  at risk, while Greeks and stress limits govern their nonlinear exposure;
- working orders: projected contribution if every still-live order fills;
- unsupported, uncovered, or unobservable exposure: never assigned zero;
  compliance becomes `NO DATA / SCOPE_INCOMPLETE` until measured.

Existing and proposed exposure use the same units. Economic capital remains a
sizing and risk measure and is not substituted for concentration notional.

### M0-3 — one-expiration concentration

Expiration exposure is grouped by exact expiration date. Covered calls
contribute the current market value of their verified covering shares. Short
puts contribute full assignment notional. A covered call and its covering
shares are counted once, not twice. W1/W2/W3/W4 are display buckets only and
cannot replace the exact-date constitutional grouping.

### M0-4 — deployment and reserve

The constitutional cash quantity is `unencumberedSettledCash`:

```text
unencumberedSettledCash = max(0,
  Schwab settled unborrowed cash
  − CSP assignment collateral
  − cash committed to live working orders
  − other verified cash encumbrances)

reserve pct    = unencumberedSettledCash / nav
deployed pct   = 1 − reserve pct
deployed amount = nav − unencumberedSettledCash
```

Buying power, withdrawal capacity, margin availability, and borrowed cash are
excluded. Net marked positions divided by NAV remains an operational market
value measurement but is not the constitutional deployment calculation; it
would understate deployment for cash-secured puts by counting only the marked
option liability instead of its pledged cash.

The dashboard labels must remain distinct:

- `CONSTITUTIONAL DEPLOYED CAPITAL` — NAV less unencumbered settled cash;
- `NET MARKED POSITIONS` — signed marked position value divided by NAV.

The two may coincide in a shares-and-covered-calls book and will diverge when
cash-secured-put collateral or working-order commitments exist.

### M0-5 — scope denominator and completeness

NAV and cash come only from account ••••4315. Every product in that account
must be observed for a compliance verdict. If Schwab holds an in-scope product
behind a different endpoint or account surface, the system reports
`SCOPE_INCOMPLETE` and may not state that the whole account is compliant.
Adding another account or combining denominators requires a mandate amendment.

Completeness is evaluated per limit and product surface, never as one global
audit flag. A measurable concentration breach remains reported when deployment
is incomplete, and an observed breach cannot be cleared by missing data.
Unobservable in-scope activity is classified as a
`MANDATE_ENFORCEMENT_GAP`, not merely a transient feed warning.
Any affected numeric result is labeled `OBSERVED_FLOOR` with the missing
surface named; it may not be presented as a complete account total.

## 4. Open mandate decisions

These remain deliberately outside the Phase 0 root and may not be inferred:

- DTE policy for cash-secured puts and covered calls;
- per-contract NAV cap;
- factor/cluster, Greeks, and beta limits;
- drawdown ladder rungs, high-water-mark definition, and permitted rung actions;
- initial tax treatment and the threshold at which tax uncertainty can change
  a pre-tax lifecycle ranking.

## 5. Activation requirements

Phase 0 is complete only after:

1. the Principal confirms the recorded disposition of P0-1 through P0-5;
2. each measurement definition is reviewed without an unresolved
   numerator or denominator;
3. the approved record is incorporated into a versioned principal-mandate
   artifact under one governance root;
4. the artifact receives a canonical content hash and Principal signature;
5. activation occurs in a separate reviewed change;
6. the prior governance hash and effective time are preserved;
7. no application behavior changes merely because this draft exists.

## 6. Principal decision block

```text
P0-1 SINGLE UNDERLYING:  APPROVED               20%
P0-2 ONE EXPIRATION:    APPROVED               25%
P0-3 DEPLOYMENT/RESERVE:APPROVED WITH REVISION 80% / 20%, complementary
P0-4 AUTHORITY-2 CAP:   APPROVED WITH REVISION 20% of remaining deployment headroom
P0-5 ACCOUNT SCOPE:     APPROVED               account-wide monitoring, restricted ticket products

Principal:
Decision time:
Decision record hash: 601fb1ee02ddeddb7dc1197ea0910cdfeb39e05aaa384b155b374b0124b1bba1
Notes:
```

## 7. Source map used for this audit

- `src/constitution/limits.js` — current hard limits and version.
- `src/constitution/authority.js` — authority capabilities and capital fractions.
- `src/portfolio/capital_states.js` — reserve and multiplicative deployment calculation.
- `src/portfolio/governor.js` — single-underlying and expiration enforcement.
- `cloudflare/worker.js` — current limits passed into dashboard calculations.
- `cloudflare/portfolio-report.js` — dashboard measurement definitions.
- `cloudflare/guardian.js` — current 20% single-name check.
- `docs/OPERATING.md` — human-readable authority ladder.
- `docs/PRINCIPAL_PROPOSAL_WORKFLOW.md` — current proposal product boundary.
- `docs/V5_2026-08-26_HANDOFF.md` — preserved current-dashboard limit provenance.
- `test/constitution.test.js`, `test/guardian.test.js`, and
  `test/portfolio_report.test.js` — regression assertions.

## 8. Reproduce the draft root

From the repository root:

```sh
shasum -a 256 -c governance/drafts/copilot-phase0-v1/SHA256SUMS
shasum -a 256 governance/drafts/copilot-phase0-v1/manifest.json
```

The second command must return the draft `mandateRootHash` recorded above.
