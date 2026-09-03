# CSP single-ticker calculator — hashed local review packet

**Prepared:** 2026-09-02 18:49 PDT  
**Status:** MATH-ACCEPTED CANDIDATE · NOT DEPLOYED · NOT LIVE  
**Scope:** one operator-entered ticker, one-contract cash-secured-put mathematics  
**mutation_eligible:** `false`

No Worker version was uploaded or switched. No lane, coordinator, alert, broker,
Cloudflare configuration, credential, or production-data state was changed. The
candidate is a read-only calculator. It has no universe scan, ranking, Governor,
portfolio gate, recommendation, approval, sizing, or order route.

## Identity and verification

| Item | Identity |
| --- | --- |
| Source baseline commit | `9944a4bdeaeb848913c5b38c1915e5c9724b72f9` |
| Review branch | `codex/post-fill-reconciliation` |
| Tests | **758/758 passed** · 66 suites · 0 failed · 0 skipped · 0 cancelled · 0 todo |
| Dry build | **PASS** · Wrangler 4.125.0 · 2,109.60 KiB upload · 439.14 KiB gzip |
| Predicted Worker bundle | SHA-256 `7a9d8076bd08ce1bfb0fa3c11fa211d0ce2a5728254555caf5c405351ecc533c` · 2,160,233 bytes |
| Deployment | **NONE** |

The sidecar manifest hashes the exact working-tree files reviewed here. The
manifest itself is sealed by `CSP_SINGLE_TICKER_CALCULATOR_REVIEW_PACKET.manifest.sha256`.

## Reviewed file list

| File | Role |
| --- | --- |
| `cloudflare/cash-secured-put-calculator.js` | Calculator contract, model construction, one-clock economics, row evidence |
| `cloudflare/worker.js` | One-ticker GET route and the read-only glass |
| `src/math/distribution.js` | Terminal distributions; centered block bootstrap and normalized Student-t support |
| `src/truth/providers/schwab.js` | Put-only partial chain read for this calculator without weakening strict scan reads |
| `test/cash_secured_put_calculator.test.js` | Exact cash math, model locks, 8,000-path lock, unavailable-field behavior, parity fixture |
| `test/production_adapters.test.js` | Route, provider, glass, no-order, and no-Governor wiring |

## Seven locked mathematics decisions

1. **PRIMARY is the centered empirical block bootstrap.**
   `calculateCashSecuredPutRows` passes the last 400 sessions of close-to-close
   returns into `bootstrapTerminal` with five-session blocks, zero arithmetic
   drift, and the common sample count (`cloudflare/cash-secured-put-calculator.js:45-49`).
   `bootstrapTerminal` subtracts the sample log mean and then normalizes terminal
   factors so `E[S_T] = S_0` when drift is zero
   (`src/math/distribution.js:186-225`). It has no parametric sigma. It is PRIMARY
   because it retains ticker-specific empirical skew and clustered five-session
   shocks without imposing the uncalibrated global jump law
   (`cloudflare/cash-secured-put-calculator.js:330-336`).

2. **Every member receives 8,000 paths; every row prints NEV ± SE.**
   The production default is `samples = 8_000`; that same value is passed to
   lognormal, Student-t, jump, bootstrap, and 1.25x stress
   (`cloudflare/cash-secured-put-calculator.js:45-70,159-162`). The standard error
   is the sample P&L standard deviation divided by `sqrt(n)`
   (`cloudflare/cash-secured-put-calculator.js:99-120`). The locked test asserts
   `sample_count === 8000` for all five members
   (`test/cash_secured_put_calculator.test.js:68-76`).

3. **Drift is explicit and zero in arithmetic price space for every member.**
   Lognormal and stress receive `drift: 0`. Jump receives `drift: 0` and applies
   its theoretical jump compensator. Student-t receives `drift: 0` plus exact
   arithmetic-growth normalization. Bootstrap receives `drift: 0`, centers its
   sampled log returns, and exactly removes Jensen growth. The returned
   `model_assumptions` states each convention
   (`cloudflare/cash-secured-put-calculator.js:45-70,330-355`). No historical
   sample drift is silently carried into PRIMARY.

4. **One clock: premium today minus discounted terminal liability.**
   For every path,
   `Pi = netCredit - exp(-rT) * max(K - S_T, 0) * 100`
   (`cloudflare/cash-secured-put-calculator.js:77-100,213-216`). Premium is
   received today; assignment liability is discounted to today. There is no
   undiscounted subtraction on another clock.

5. **The legacy mixture is absent.**
   There is no mixture member, mixture headline, hidden weighted blend, or
   MAX-of-model selection in this calculator. Every model is printed separately.
   The locked test asserts that `mixture` is absent
   (`test/cash_secured_put_calculator.test.js:79`).

6. **The parametric sigma is the exact GARCH(1,1) DTE forecast—never the 35/35/30 blend.**
   `volatilityProfile(usableBars)` fits GARCH(1,1). Only when `garchOk` is true,
   the calculator calls `volProfile.garch.forecast(dte)`
   (`cloudflare/cash-secured-put-calculator.js:183-200`). That forecast is the
   `vol` passed unchanged to lognormal, Student-t, and jump, and multiplied by
   1.25 only for the named stress member
   (`cloudflare/cash-secured-put-calculator.js:45-70`). `garch.forecast(days)`
   averages the forward conditional daily variances with mean reversion and
   annualizes by 252 (`src/market/realized_vol.js:155-184`). The separate
   35% Yang-Zhang / 35% EWMA / 30% GARCH `profile.realized` blend is calculated
   by the shared profile for other consumers (`src/market/realized_vol.js:188-218`)
   but is never read by this calculator. If `garchOk` is false, `forecastVol` is
   null and lognormal, Student-t, jump, and stress are unavailable; no blend or
   fallback substitutes for GARCH. PRIMARY can remain available because it has
   no parametric sigma (`cloudflare/cash-secured-put-calculator.js:45-54,223-228`).

7. **Jump is an uncalibrated diagnostic, not a forecast or veto.**
   It uses the shared GARCH diffusion volatility plus global Poisson parameters
   `lambda=2.0`, mean log jump `-0.06`, jump volatility `0.10`
   (`cloudflare/cash-secured-put-calculator.js:59-62`). Because the GARCH input
   already contains realized jumps, its possible variance double count is
   carried in returned model assumptions and on every visible row. It is not
   PRIMARY and has no decision authority.

The adjacent 1.25x-volatility stress is display-only. It has no veto. PRIMARY and
stress both expose dollar NEV and Monte Carlo SE.

## Four glass corrections

1. The exact annualized GARCH DTE sigma is a visible column beside the models it
   scales (`cloudflare/worker.js:2276,3044-3049`).
2. Every visible row carries
   `JUMP_DIAGNOSTIC_UNCALIBRATED_POSSIBLE_DOUBLE_COUNT`, and the panel states the
   same product limitation in plain language
   (`cloudflare/cash-secured-put-calculator.js:221-225`; `cloudflare/worker.js:2276`).
3. `probTouch` is not imported, computed, returned, or rendered by this
   calculator. European risk-neutral finish-ITM remains and is explicitly not a
   physical assignment probability (`cloudflare/cash-secured-put-calculator.js:1,229-231,267-274`).
4. The glass reads **MODELED · UNCALIBRATED · n=0**. Calibration remains locked
   until sealed rows contain observed terminal `S_T`
   (`cloudflare/cash-secured-put-calculator.js:320-327`; `cloudflare/worker.js:2275,3030-3032`).

American early assignment remains unmodeled and is labeled on every row. Missing
IV, history, or GARCH disables the dependent cells and adds a warning; it does
not remove a quoted row.

## Put-call parity fixture identity

The regression is the four European legs of
`C - P = S*exp(-qT) - K*exp(-rT)`, not merely a pass count:

| Fixture input / leg | Exact value |
| --- | ---: |
| `S` | 101 |
| `K` | 100 |
| `T` | 30/365 = 0.0821917808219178 |
| `r` | 0.045 |
| `q` | 0.012 |
| `sigma` | 0.28 |
| European call `C` | 3.8847275866129536 |
| European put `P` | 2.6151150522470060 |
| Prepaid spot leg `S*exp(-qT)` | 100.90043267141164 |
| Discounted strike leg `K*exp(-rT)` | 99.63082013704570 |
| `C - P` | 1.2696125343659475 |
| `S*exp(-qT) - K*exp(-rT)` | 1.2696125343659332 |
| Absolute residual | 1.4210854715202004e-14 |

Fixture and tolerance are locked in
`test/cash_secured_put_calculator.test.js:108-118`.

## Covered-call alignment finding — not built in this packet

The deployed covered-call entry calculator does **not** have these locks. It
calls the shared weighted `buildDistribution` ensemble
(`cloudflare/covered-call-calculator.js:191-201`; `src/pipeline/cycle.js:58-97`),
then uses the maximum expected intrinsic value across members
(`cloudflare/covered-call-calculator.js:276-284`). It does not name PRIMARY,
does not print members separately with Monte Carlo SE, does not put the GARCH
sigma or jump double-count warning on the row, and does not expose `n=0`
calibration. Its use of call-side `probTouch` is mathematically distinct from the
removed put cell, but it still needs an explicit product label if retained.

Cost to align CC honestly: **one separate review packet**, approximately
150–250 runtime/UI lines across `cloudflare/covered-call-calculator.js` and
`cloudflare/worker.js`, plus roughly 10–15 focused assertions in
`test/covered_call_calculator.test.js` and `test/production_adapters.test.js`.
The work is a model-output refactor, not a formula copy: preserve the existing
covered-share/cost-basis economics while replacing ensemble/MAX presentation
with separate members, PRIMARY bootstrap, SE, explicit drift, exact GARCH sigma,
diagnostic jump warning, calibration `n=0`, and the same one-clock convention.
No CC changes are included here.

## Release boundary

This packet authorizes nothing. A later release would require separate Principal
authorization and would have predicted runtime bundle SHA-256
`7a9d8076bd08ce1bfb0fa3c11fa211d0ce2a5728254555caf5c405351ecc533c`
if and only if these exact hashed source bytes are built by the recorded toolchain.
Any source or toolchain change requires a new prediction and a new packet hash.

