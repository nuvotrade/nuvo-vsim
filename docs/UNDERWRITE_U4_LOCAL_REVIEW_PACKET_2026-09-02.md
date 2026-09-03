# UNDERWRITE U4 local review packet — 2026-09-02

## Decision state

- Scope: read-only covered-call lifecycle choice comparison for an already-open short call.
- Build state: local review candidate only.
- Live state: unchanged on U3.1, Worker `310aefde-9fe9-4a0c-ab65-2e15807da601`, bundle `76eb4ee2dee0b5f6a7927f072cf4a8b0d8c9c8cd6ffea49093f53db1b7609dbb`.
- `mutation_eligible: false`.
- Deployment authorized: **false**.
- D1 migration required: **none**.
- Lane 1, ARM, broker orders, Discord, coordinator and U3 settlement tables: untouched by U4.

## Product contract

U4 adds one explicit action to each existing covered-call lifecycle card: `COMPARE LIVE CHOICES`. It calculates HOLD, CLOSE and every visible later configured ROLL at one present-value origin. It does not select a row, recommend a trade, size a trade, approve a trade, construct an order or transmit an order.

The page requires:

1. a currently held short US equity call with a 100-share multiplier;
2. enough Schwab shares to cover the call;
3. no related order in flight;
4. the options regular session verified directly from Schwab option-market hours;
5. a current executable ask on the held call, a current underlying quote, and a bounded current call-chain snapshot;
6. at least 121 valid OHLC sessions, a successful GARCH forecast, and estimator spread no greater than 0.60.

If any required fact is unavailable, the result is `NOT_EVALUATED`; stale or closed-session prices are never compared.

## Common-clock identities

All values originate at the calculation timestamp `t0`. Shares and original option credit are common/sunk and excluded from every path.

```text
HOLD_NEV_0
  = -exp(-r*T0) * E_PRIMARY[(S_T0 - K0)+] * covered shares

CLOSE_NEV_0
  = -(current executable ask * covered shares + close fees)

ROLL_NEV_0
  = CLOSE_NEV_0
    + (new executable bid * covered shares - open fees)
    - exp(-r*T1) * E_PRIMARY[(S_T1 - K1)+] * covered shares

VERSUS_HOLD_0
  = PATH_NEV_0 - HOLD_NEV_0
```

The glass prints `r`, its constitutional source, each expiration, New York calendar DTE, `T=DTE/365`, discount factor, executable close ask, executable opening bid, quote-observation timestamp, snapshot skew, fees, modeled liability PV, path NEV and dollars versus HOLD.

PRIMARY is the unchanged U1 centered five-session block bootstrap with zero arithmetic drift and 8,000 paths. GARCH is required to keep the shared model contract intact; there is no fallback, MAX, mixture or Governor. Roll expirations use the configured 7/14/21-DTE universe and only later expirations than the held call are shown. Rows are sorted by expiration and strike, not ranked.

## Uncertainty

Every modeled value prints Monte Carlo standard error:

- HOLD path SE: PRIMARY payoff-estimator SE times the held contract count.
- CLOSE path SE: zero; CLOSE versus HOLD SE equals HOLD SE.
- ROLL path SE: PRIMARY new-call payoff-estimator SE times contract count.
- ROLL versus HOLD SE: `sqrt(ROLL_SE^2 + HOLD_SE^2)` because different-DTE simulations use independent deterministic seeds.

Displayed money is rounded to cents only after each path component is formed. The displayed path and displayed `versus HOLD` identities reconcile to the cent.

## Truth labels and exclusions

- PRIMARY finish-ITM is a physical terminal bootstrap probability, not American assignment probability.
- American early exercise is not modeled and is labeled once as a global limitation.
- Verified earnings and ex-dividend events are displayed with timestamp and cash amount when available; the tenor ends at 16:00 America/New_York on expiration day.
- Missing event or dividend verification remains visible but does not suppress otherwise computable math.
- Below-basis rolls remain visible with the exact strike and basis that produced the warning.
- Taxes are omitted because there is no verified tax input.
- Quote observations may differ inside the configured bounded snapshot. U4 prints the calculation timestamp, every row's source timestamp and total skew rather than inventing a simultaneous broker timestamp.
- Only the executable side is required: ask to close, bid to open.
- Non-100-share or mismatched deliverables are not priced and are named in `unavailable_rolls`.

## Glass behavior

The table columns are:

`Path · Expiry/clock · Strike · Executable prices · Cash now · Liability PV · Path NEV0 ± SE · vs HOLD ± SE · PRIMARY finish ITM · Observed · Warnings`

Global limitations print once above the rows. An unavailable listed contract is named below the table instead of disappearing. If there is no later configured expiry with an executable opening bid, the glass says so plainly.

The lifecycle footer continues to say `CLOSE · ROLL · EXIT recommendation: NO_TRUTH`; running U4 does not convert comparison math into a directive.

## Verification fixtures

- HOLD/CLOSE/ROLL reconcile on one PV origin.
- CLOSE uses the executable ask and exact configured close fees.
- ROLL uses the held-call ask plus the new-call executable bid and exact configured opening fees.
- Every displayed `versus HOLD` amount reconciles to displayed path minus displayed HOLD.
- Stale quotes return `NOT_EVALUATED`.
- History/GARCH failure has no fallback model.
- Ask-only close and bid-only opening rows calculate; the unused side is not made into a gate.
- New York expiration dates, rather than broker-reported DTE, determine `T`; disagreement is printed.
- The event tenor includes 15:59 New York on expiration day and excludes 16:01.
- Below-basis and event warnings never suppress the row.
- 100-share deliverable required; mismatched roll deliverable is named and not priced.
- No POST route, order-action button, storage write, broker mutation or order method exists on the U4 path.
- The U4 session check requests Schwab option-market hours only; it cannot fail because VIX or SPY history is unavailable.

## Continuity and verification results

- Full suite: `805/805` passed.
- Wrangler: `4.125.0`.
- Dry config: `/Users/nuvo/.codex/.chatgpt-projects/g-p-6a8f887336308191a81e7bbda9e1bdd8/work/nuvo-vsim-post-fill-repair/cloudflare/wrangler.jsonc`.
- Dry bundle SHA-256: `68e5686c7ad0ec14e072a366c706baad64c6b6618f28bb54ae3472184e92edf5`.
- Dry bundle bytes: `2,224,124`.
- Shared U1/U3 model engine SHA remains `3e5e720b9e39339023b9290576dce515bb8f05fc8967f41e4bd45522663ed9e0`.
- CSP, covered-call entry and U3 calibration/model-lock files are unchanged from the U3.1 tree; U4 is additive.

No live CBRS table is claimed in this packet because the market is closed and U4 deliberately refuses stale executable prices.

## Deployment fence

This packet is not deployment authority. Any later deployment requires a fresh authorization against this exact packet, a dry reprint of the sealed bundle from the absolute config, a zero-traffic upload, binding comparison, a single switch, and a separately verified rollback target. The retired original U3 bundle and the ambiguous earlier U2 rollback identifiers must not be used by assumption.

