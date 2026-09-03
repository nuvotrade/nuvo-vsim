# UNDERWRITE U3 local review packet — 2026-09-02

**Status:** `U3.1_LOCAL_COMPLETE · PACKET_RESEALED · DEPLOY_AUTHORIZED`  
**Live at seal:** U2 unchanged; no U3 upload, traffic switch, D1 migration, lane operation, or broker operation occurred  
**Manifest SHA-256:** `de047fe2dae0d0315d8946f5239fb6560fae45deb036d015123f749c93df9ab6`  
**Mutation:** `mutation_eligible: false`; no order route; no scheduler required

## What U3 adds

U3 turns the existing append-only forecast ledger into a measurement system. The
forecast row remains immutable. After the option's expiration session, a separate
outcome row may attach to it only when the exact official underlying close for that
expiration session is present with its provider source and timestamp. A third,
append-only score row records Brier and realized RAW NEV measurements. Nothing in
U3 changes PRIMARY, changes a rank, hides a row, gates a calculation, or enables a
trade.

## Locked terminal event

- Event: `FINISH_ITM_AT_EXPIRY`.
- Put outcome: `y = 1` only when `S_T < K`.
- Call outcome: `y = 1` only when `S_T > K`.
- Equality is `y = 0` (`OTM_FALSE`).
- Early assignment is not this event and cannot change `y`.
- `S_T` is the Schwab price-history daily close for the expiration session. The
  source, provider candle timestamp, full source bar, and source-bar hash are
  persisted. A later session's open or close is never substituted.
- Missing, ambiguous, unfinished-session, or source-less data produces
  `OUTCOME_UNAVAILABLE` with a named reason. No outcome or score row is written.

## Sealed-clock realized economics

For each forecast row, U3 seals the same risk-free rate and model time used when
RAW NEV was produced. Time is the model's calendar DTE from the forecast session
to expiration divided by 365. It is not recomputed after expiration.

For a put:

`L_realized,0 = exp(-r_sealed × T_sealed) × max(K - S_T, 0) × 100`

For a call:

`L_realized,0 = exp(-r_sealed × T_sealed) × max(S_T - K, 0) × 100`

For either one-contract forecast:

`realized_RAW_NEV_0 = sealed_net_credit - L_realized,0`

Cash carry is not added to realized NEV, and today's rate or a post-expiry `T=0`
cannot replace the sealed clock.

## Scoring

- Per-row Brier is `(p - y)^2`.
- Headline: PRIMARY centered five-session block bootstrap.
- Additional columns: lognormal, variance-normalized Student-t5, and risk-neutral
  `p_RN` reference.
- Jump remains stored as `diagnostic: true`; it is not a physical headline.
- Calibration stamps are `UNCALIBRATED` below 50 unique symbol-expiry outcomes,
  `PROVISIONAL` from 50 through 199, and `CALIBRATED` at 200 or more.
- No `DEGRADED` label exists because no degradation test was registered.
- Calibration stamps are measurements only. They do not rewrite PRIMARY.

## Surface and version isolation

Every score is keyed by owner, surface, forecast, exact model-component hash, and
model name. The glass filters on the same surface plus hash. A changed model file
therefore begins at `n=0`; a challenger never inherits rows from an older hash or
another surface.

| Surface | Model-component hash |
| --- | --- |
| CSP single ticker | `53ffab7835da0b87fa72514698e09622dd351474b41892f339e30c7cd4acc5e8` |
| Covered-call single ticker | `079c54a3ebed3616e2de20e82602ad2606f373f5e3fdaab7ebd97b189bd66f3d` |
| Portfolio Review | `cb60d3ae00a9c086343c8a4bf9000e10b6829175a1dd46be204c1ec6b6a809b6` |

`underwrite-model-version-lock.js` lists each component SHA. The U3 test
recomputes every component and the aggregate hash; unregistered drift fails the
build.

## Glass

Portfolio Review gains a read-only Forecast calibration panel that prints:

1. settled forecast-row count;
2. unique contract + expiry count;
3. unique symbol + expiry count (headline independent `n`);
4. exact model hash;
5. PRIMARY, lognormal, Student-t5, and `p_RN` Brier;
6. mean one-contract realized RAW NEV.

The single-ticker CSP badge now names `n(symbol×expiry)`, and covered-call
diagnostics include the same isolated calibration and settlement facts.

## U3.1 theta unit correction

Schwab theta is normalized as option-premium dollars per share per calendar
day, the same price scale as an option quote. Position-dollar theta applies the
equity multiplier exactly once:

`short theta/day = -raw long theta/share/day × multiplier × contracts`

The stale CBRS fixture is therefore `-(-0.57309031) × 100 × 6 = $343.854186`,
displayed as `$343.85/day`, rather than `$3.44/day`. The covered-call card prints
the raw per-share value, multiplier, contract count, calculated total, and
quote freshness/time on the glass. Portfolio Economics and custody risk use the
same conversion. Delta, gamma, and vega were not changed.

## Persistence and idempotence

Migration `0017_underwrite_forecast_outcomes.sql` creates two append-only tables:
`underwrite_forecast_outcomes` and `underwrite_forecast_scores`. Inserts use
`ON CONFLICT DO NOTHING`; there is no update or delete path. Re-reading the same
forecast or refreshing the dashboard does not create another outcome or score.
Scores include both surface and model hash in their unique key. Settlement runs
only when one of the existing Underwrite calculations runs; U3 adds no cron.

The migration was successfully executed after migration 0016 against a temporary
SQLite database and its schema was inspected. It has **not** been applied to live
D1.

## Verification

- U3 fixtures: **15/15 PASS**.
- Full suite: **791/791 PASS**.
- Worker syntax check: **PASS**.
- Local 0016 + 0017 schema execution: **PASS**.
- Absolute config:
  `/Users/nuvo/.codex/.chatgpt-projects/g-p-6a8f887336308191a81e7bbda9e1bdd8/work/nuvo-vsim-post-fill-repair/cloudflare/wrangler.jsonc`
- Dry build: **PASS**.
- `entry.js`: **2,192,292 bytes**.
- Predicted Worker bundle SHA-256:
  `76eb4ee2dee0b5f6a7927f072cf4a8b0d8c9c8cd6ffea49093f53db1b7609dbb`.

Fixtures prove strict put/call boundaries, equality OTM, early-assignment
separation, sealed-clock PV, all requested Brier columns, official-close source
and timestamp, named unavailable outcomes, append-only idempotence, no scheduler,
surface-and-version isolation, hash drift detection, the three displayed `n`
values, unchanged PRIMARY, exact CBRS theta scaling, visible theta units and
freshness, and `mutation_eligible: false`.

## File inventory

The complete per-file SHA list is in the manifest. U3 materially adds
`underwrite-calibration.js`, `underwrite-model-version-lock.js`, migration 0017,
and `underwrite_u3.test.js`; it wires sealed forecast fields and calibration glass
through the Worker and the three existing Underwrite calculation surfaces. U3.1
also corrects the isolated Schwab theta unit across its display and aggregation
consumers. Lane 1, broker submission, alerts, coordinator state, rank rules,
delta, gamma, vega, and U1/U2 economics were not changed.

## Deployment fence

U3.1 is authorized but not deployed at packet seal. Deployment requires live D1
migration verification coupled to this exact Worker candidate, an exact dry SHA
reprint from the absolute config, a zero-traffic upload, 49/49 binding comparison,
one traffic switch, and rollback to the current U2 version on any dashboard or
custody regression.
