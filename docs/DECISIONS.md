# Calibration decisions and what running the system changed

This file records the numbers that decide what NUVO trades, why they hold the
values they do, and the defects that only appeared when the system was run
rather than read. Every entry is here because getting it wrong would change
which trades happen.

---

## The λ coefficients in NEV

```
NEV = EV − λ_cvar·CVaR − λ_gap·GapRisk − λ_liq·LiquidityRisk
λ_cvar = 0.02    λ_gap = 0.40    λ_liq = 0.40
```

**The first attempt used λ_cvar = 0.35** and rejected every trade. For a
30-DTE short put with EV ≈ $94 and CVaR ≈ $606, the risk charge alone was
$212. Nothing could clear it.

That is not conservatism. A risk charge calibrated so that no trade ever
passes is a broken instrument, not a cautious one — it produces the same
output regardless of input, which means it measures nothing.

λ_cvar must be read against the EV/CVaR ratio of a *genuinely well-priced*
short-vol trade. Solving empirically for the IV/realised ratio at which a
30-DTE short put turns NEV-positive:

| λ_cvar | breakeven IV/realised |
|--------|----------------------|
| 0.005  | 1.234 |
| 0.02   | **1.286** |
| 0.05   | 1.373 |
| 0.08   | 1.442 |

Note what this table shows: even at λ_cvar = 0.005 the breakeven is 1.23, so
**CVaR is not the binding charge — gap risk is.** That is deliberate and it
is the correct economics for this business. The diffusive tail is risk NUVO
chose and can manage down. The jump tail arrives while the market is closed.
Setting λ_gap below λ_cvar would make the system most relaxed about the thing
most likely to end it.

At the chosen values, a flat-IV strike must be paid roughly 1.29× effective
realised vol before NUVO will underwrite it. Real chains carry downside skew,
so a strike at that moneyness typically trades several vol points above ATM.
Demanding, but reachable — the intended calibration.

**Verified end to end:** NO_TRADE at IV/RV 1.03 and 1.19, orders at 1.30 and
1.45.

---

## Neutral drift until a directional model is validated

The forward ensemble defaults to zero annual drift. The earlier uniform
`+5%` assumption lowered modeled downside probability for every underlying
and regime, mechanically manufacturing part of the apparent short-put edge.
The empirical block bootstrap was a second path for hidden drift because it
resampled raw historical returns, including the direction of the selected
lookback period. It now resamples centered historical shocks and adds only
the cycle's explicit drift. The terminal sample is normalized exactly to
`E[S_T] = S_0·exp(drift·DTE/365)`, removing Jensen drift without assuming
the empirical shocks are normally distributed.
A positive unconditional equity premium may be defensible over long periods,
but applying it inside a 7–45 DTE underwriting horizon without a validated,
regime-specific estimator is not. The drift used by each cycle is captured
in its distribution evidence. The bootstrap also converts calendar DTE to
the corresponding number of trading sessions instead of treating 30 calendar
days as 30 market sessions. Any future nonzero drift must be explicit and
independently calibrated; it may not be a hidden default.

---

## Economic capital, and the deep-wing trap

**This was the most consequential bug in the build.**

The first implementation used `CVaR₉₅` as the RAROC denominator. For a
5-delta short put, `P(loss)` sits below the 95% cutoff *entirely*, so CVaR₉₅
collapses toward zero. RAROC divides by almost nothing and explodes.

Observed in the first end-to-end run:

```
CSP  RAROC  1704%   —  a position risking almost nothing by its own model
```

The ranking had discovered, by arithmetic, that the optimal trade is the
furthest, thinnest wing on the board. That is picking up pennies in front of
the steamroller — precisely the trade the system exists to avoid, arrived at
by the metric meant to prevent it.

**Fixes considered and rejected:**

- *Raise λ_cvar.* Doesn't touch it — the denominator is the problem.
- *Use max loss as the denominator.* For a CSP that is the strike going to
  zero. Reserving against it permits about three positions. Max loss is a
  solvency fact, not an allocation basis.
- *Add a minimum absolute NEV.* Helps, but leaves the ranking distorted
  wherever the floor doesn't bind.

**The fix:** economic capital is the largest of four measures, each blind to
a different failure.

1. **CVaR₉₉** — sits inside the loss region where it belongs.
2. **3σ deterministic stress** — independent of the tail model being right,
   which is the assumption most likely to fail when it matters.
3. **The mandated −20% crash shock** — ties allocation to the constitution's
   own stress set.
4. **A structural floor** — 25% of max loss for defined risk; **10% of locked
   buying power** for undefined risk. The broker demands that collateral for
   a reason, and so should NUVO.

Capped at max loss, since nothing can consume more capital than it can lose.

Result on the same sweep:

| Strike | P(ITM) | CVaR₉₅ | Econ capital | RAROC before | RAROC after |
|--------|--------|--------|--------------|--------------|-------------|
| 95 | 0.279 | $1,362 | $2,130 | — | −114% |
| 80 | 0.021 | $171 | $798 | — | −97% |
| 75 | 0.008 | $52 | $749 | **+707%** | −31% |
| 65 | 0.001 | $0 | $650 | — | **−2%** |

The jump parameters in the pipeline's default distribution were hardened at
the same time (2 jumps/year, −6% mean, 10% jump vol). The cost of overstating
crash risk is trades not taken; the cost of understating it is the account.

---

## Regime thresholds

Calibrated against five reference states, which live in
`test/portfolio.test.js`. The first thresholds were a full band low — NORMAL
classified as CALM, FEAR as NORMAL.

| Reference state | Score | Classifies as |
|---|---|---|
| CALM | 0.17 | CALM |
| NORMAL | 0.88 | NORMAL |
| FEAR | 1.91 | FEAR |
| PANIC | 3.49 | PANIC |
| DISLOCATION | 3.85 | DISLOCATION |

Bands: CALM < 0.50 ≤ NORMAL < 1.50 ≤ FEAR < 2.60 ≤ PANIC < 3.40 ≤
DISLOCATION (which additionally requires broken liquidity — DISLOCATION is
not merely *more* panic; selling into a market that cannot absorb a hedge is
a different failure mode from selling into a scary but functioning one).

Changing a threshold without re-running those tests is an amendment to what
"FEAR" means, and should be treated as one.

---

## Defects found by running, not reading

Each of these passed inspection and failed in operation.

### 1. Reconciliation quarantined the engine after its first fill

The engine stored strategy-level position contracts
(`shortStrike`/`longStrike`); the broker reported legs (`strike`/`right`).
The reconciliation keys could never match, so every filled position read as
*simultaneously* phantom and unknown.

A single cycle looked perfect. A twelve-cycle simulation showed cycles 2–12
all refusing with `KILL_RECONCILIATION`.

This is exactly the failure mode §16 was written for, which makes it a
fitting place to have been bitten. The engine now maintains a leg-level
mirror in the broker's own schema, applied on fill and unwound on close, with
four regression tests including one that confirms a genuinely unexpected
broker position **still** quarantines.

### 2. The Governor's refusal ended the whole cycle

Refusing the top-ranked candidate on size returned `NO_TRADE` for the entire
cycle — silently converting a capital constraint into a false claim that no
opportunity existed. The Governor now walks down the ranking and records
every rejection.

### 3. An empty portfolio was penalised for being empty

`diversificationMultiplier` applied a 0.7 "correlation unknown" haircut when
correlation could not be measured. With **no positions**, correlation cannot
be measured — so the first position into an empty book was haircut for
diversification risk it could not possibly have. An empty portfolio is the
one state carrying no correlation risk at all.

The effect was not cosmetic: it shrank the risk budget just below one
contract, so the top-ranked candidate was declined and a lower-ranked one
taken instead.

### 4. Anchor-freedom was coincidental rather than structural

`evHold` read the entry credit from the *position*. It cancelled correctly
only because the position and its structure happened to hold the same number.
A restated entry price would have leaked into a forward decision — the exact
anchoring §13 removes.

It now reads from the structure, making the cancellation algebraic. The test
proves it by setting two positions to different entry credits and asserting
identical forward valuations.

### 5. `sealOutcome` produced packages that failed their own verification

The re-hash was computed over a payload still containing the prior hash,
while verification hashes everything *except* `hash`. Every sealed package
would have failed an audit.

### 6. A strategy in RESEARCH could not be killed

The transition table had no legal path from RESEARCH to any terminal state,
so `enforceKillCriteria` threw instead of terminating. Fixed in a way that
preserves a distinction worth having: `REJECTED` before deployment,
`TERMINATED` after. An idea that failed in research never cost money, and the
registry should not read as though it had.

### 7. Two performance defects made a cycle take 11.4 seconds

`payoffStats` re-sorted the same 20,000-element array for every order
statistic, and it is called three times per candidate across ~600 candidates.
One sort per call, reusing it for all statistics: **11.4s → 4.2s**.

Then the full chain was being scored at full Monte Carlo resolution when a
coarse estimate suffices to establish that most candidates are nowhere near
the bar. Screen the field, refine the shortlist: **4.2s → ~3.0s**, identical
decisions.

The second fix is also what §7 argues for on its own terms — eliminate
candidates upstream, do not score garbage.

### 8. `probTouch`'s up-barrier branch was incoherent

The expression conflated the two reflection cases. Rewritten from the
reflection principle and verified against the known analytic relation:
near the money, P(touch) ≈ 2 × P(ITM).

### 9. The synthetic market ignored its own configuration

`atmIv` was accepted per symbol and then discarded — volatility came purely
from the GARCH path, which drifted to 39% for a symbol configured at 16%. The
skew was also roughly a quarter of realistic steepness, and the jump process
had no Merton compensator, so `drift: 0.07` did not mean a 7% expected return.

All three mattered: a generator that flatters the strategy produces research
results that mean nothing.

---

---

## Defects found by external review

A structural review of the v5 package identified nine gaps. Six were
correctness defects and are fixed; three are scope, not bugs, and are
addressed at the end of this section. Each defect below was reproduced
before being changed.

### 1. Multi-leg Greeks were read from `legs[0]`

The Portfolio Governor took a spread's delta, gamma, vega and theta from its
**short leg alone**. A bull put spread's long leg exists precisely to offset
the short one:

```
short 25-delta / long 10-delta, 1 contract
  leg[0] only:  delta 25   gamma -3.0
  both legs:    delta 15   gamma -1.2
```

The consequence ran both ways. Sizing consumed 67% more delta budget than
the position actually used, and the reported book looked more directional
than it was. `structureGreeks()` now sums every leg with its correct sign
and quantity; `positionGreeks()` prefers a position's legs over any flat
single-leg shape.

### 2. Hypothetical positions carried no spot price

The line was:

```js
spot: candidate.structure.legs[0]?.contract ? undefined : undefined,
```

Unconditionally `undefined`. Beta-weighted delta is a **dollar** figure —
position delta × spot × beta — so every candidate contributed exactly zero
to it, and a book whose exposure could not be measured read as a book with
no exposure.

Spot is now required (the Governor refuses without a verified one), and
positions lacking a spot are counted and raised as `EXPOSURE_UNMEASURABLE`
rather than silently absorbed.

### 3. Five constitutional limits were never evaluated

`maxNetGammaPctNav`, `maxPortfolioCVaRPct`, `maxRuinProbability`,
`stressScenarioLossPct` and `maxNewCommitmentsPerCycle` were declared in the
constitution and never checked at entry. The stress test in particular was
skipped because the cycle supplied no repricer — and a stress test that is
silently skipped reads exactly like one that passed.

A limit that cannot block a trade is documentation. All five are now gates.
`src/portfolio/repricer.js` supplies Black-Scholes repricing that values a
spread by its legs (preserving each leg's position on the skew, since
shocking both legs to one vol collapses the skew and understates the loss),
and a **missing repricer now refuses** rather than passing quietly.

### 4. The ensemble ignored the empirical bootstrap

`buildDistribution` accepted a `returns` parameter and never used it. The
live forward model was three parametric members — lognormal, Student-t,
jump-diffusion — each of which imposes a shape on returns, and none of which
asks what the underlying has actually done.

The block-bootstrap member existed in `src/math/distribution.js` and was
simply never wired in. It is now the fourth member when at least 120
observations are available, and omitted with `bootstrapIncluded: false`
recorded when they are not.

### 5. Calibration scored the wrong event

The most consequential of the six, because calibration is what the authority
ladder promotes on.

`p_model` is a **terminal** probability: P(S_T < K) at expiry. The outcome
was recorded as `breached`, which normally means the strike was touched at
any point. These are different events with different probabilities — touch
is always the larger — and a position that finished above its strike having
traded through it mid-life scored a **correct** terminal forecast as a miss.

The effect is systematic, not random: it makes NUVO look overconfident when
it is merely being graded on a question it did not answer, and that
mis-scored slope is the number Authority 2 and above are gated on.

The two events are now namespaced apart (`VSIM-001|terminal`,
`VSIM-001|touch`), `recordOutcome` **refuses** the ambiguous flag, the touch
board is never inferred from the terminal outcome (an unobserved path is not
recorded at all), and the calibration scoreboard reads the terminal board
only.

### 6. Evidence packages were not reconstructable

Three separate problems behind one claim:

- **The hash was 64-bit FNV-1a** — a checksum. It detects accidental
  corruption and offers nothing against a deliberately substituted record,
  which is the only threat an audit trail exists to address. Replaced with
  SHA-256, written out in pure JavaScript so it stays synchronous and runs
  identically in Node and in a Worker, verified against the FIPS 180-4
  vectors including the million-byte case.
- **Only summaries were stored.** The package described a decision but could
  not reproduce one. Raw chains, histories, quotes, account state, positions
  and open orders are now captured verbatim, with an `externalizeRaw` path
  that keeps the hash and drops the payload for deployments putting the
  bytes in object storage.
- **Screened-out candidates were omitted**, so the recorded field looked
  like the field considered when it was only the shortlist.

`src/evidence/replay.js` now closes the loop: it rebuilds a provider and
broker that serve nothing but the captured payload, reruns the cycle, and
compares. Reproduction is judged on a `decisionFingerprint` computed over
decision content with provenance excluded — a faithful replay necessarily
reads from a different provider, so judging on the full-record hash would
report every correct replay as a failure. Replay reproduces the fingerprint
exactly, and raw inputs that do not match the recorded hash are rejected.

### Two defects the fixes themselves introduced

Worth recording, because both were found by running rather than reading.

**Position ids were a module-level counter.** The same decision replayed in
a fresh process produced `POS-000001` instead of `POS-000002`, so an
otherwise byte-identical reconstruction did not match. Ids are now derived
from position content.

**The new persistence layer raced.** `JsonlPersistence.append` fired
`appendFile` calls without serialising them, and the runtime does not order
concurrent appends to one path. Records persisted out of sequence, breaking
the hash chain on reload — **6 of 12 runs**. Writes now go through a promise
chain, with an ordering regression test that fires 25 appends without
awaiting any of them.

### What was NOT fixed, and why

Three of the nine findings are scope rather than defects, and the review is
right that they gate production use:

- **No demonstrated trading edge.** The Research Lab is a framework; there is
  no completed historical implementation of VSIM-001, and the demo command
  generates synthetic gate results. 270 tests prove code behaviour, not
  expectancy. This is Phase 2 and cannot be closed by writing code.
- **No live mutation adapter.** Schwab live market/options data and a Schwab
  read-only custody adapter are deployed in the private shadow runtime. Order submit,
  replace and cancel remain deliberately absent until the shadow evidence,
  execution outbox and canary authority gates are satisfied.
- **Lifecycle is a library, not a closed loop.** Scheduling, persistent
  position state, broker close/roll execution and partial-fill recovery are
  not wired into the engine.

The review's conclusion stands unchanged by this work: the software is
further along than the empirical proof, and shadow evidence — not more
code — is what should decide the next investment.

---

## Deliberate non-optimisations

**No parameter fitting.** Nothing here was tuned to make a backtest look
good. The λ values were solved for a stated behavioural property — that a
well-priced trade should be able to pass — not for a P&L outcome.

**No technical indicators.** Not because they cannot work, but because
admitting them without out-of-sample proof is how a system acquires
complexity it cannot justify. Research can admit a feature that demonstrates
statistically significant incremental explanatory power. Not before.

**No performance work beyond what was needed.** Two fixes took a cycle from
11.4s to ~3s. Further optimisation would trade clarity for speed the system
does not need — it operates on a 7–45 DTE horizon, not a microsecond one.

**No live broker adapter.** The `BrokerAdapter` interface is defined and
`PaperBroker` implements it faithfully, including partial fills and
slippage. A real adapter is credential-bound integration work, and shipping
an untested one would violate the layer's own rule: every method must be able
to say "I do not know", and that is only provable against the real API.
