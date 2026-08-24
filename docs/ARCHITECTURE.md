# NUVO VSIM — Architecture

The system is ten layers with one rule between them: **a lower layer may
refuse what a higher layer wants, never the reverse.** The Underwriter can
love a candidate the Portfolio Governor kills. The Governor can approve a
position the Truth Engine refuses to let an order exist for. Authority flows
down; refusal flows up.

---

## 1. Truth Engine — `src/truth/`

Answers one question: *is what we believe about the world verified?*

**The invariant:** a missing value must never be representable as a number.

```js
const f = new Fact('greeks', { error: 'provider timeout' });
f.require();  // throws TruthViolationError
f.peek();     // undefined — never a default
```

`verify()` returns a `TruthReport` with **two independent booleans**:

- `observable` — always true. The dashboard renders.
- `tradeable` — the order path.

Collapsing these is the failure §18 forbids: an outage must not become a
position, and a blank screen helps nobody.

`auditChain()` catches the more dangerous case — a chain that arrives intact
but incoherent. Crossed markets, zero bids, missing Greeks. A structurally
broken chain is as dangerous as a missing one and far more convincing.

`reconcile()` compares the engine's book against the broker's **at leg level
in the broker's own schema**. A position the engine doesn't know about, a
phantom it thinks it holds, a quantity mismatch, or an order it never
issued — any of these quarantines capital.

> This layer earned its regression tests the hard way. The first
> implementation compared strategy-level contracts (`shortStrike`/`longStrike`)
> against broker leg reports (`strike`/`right`). The keys could never match,
> so every filled position read as *simultaneously* phantom and unknown, and
> the engine quarantined itself permanently after its first fill. A single
> cycle looked perfect; a twelve-cycle simulation showed cycles 2–12 all
> refusing.

### Providers

`DataProvider` methods return `{ value, asOf, source }` or `{ error }`. Never
a plausible substitute. `NullProvider` refuses everything, which is correct
behaviour for an unconfigured system.

`SyntheticProvider` is not a mock. It generates an internally consistent
market — GARCH(1,1) paths with volatility clustering and Poisson downside
gaps, and an option surface with genuine downside skew that steepens into
shorter tenors — so tests, research and the backtester all exercise the same
code paths a live provider would.

---

## 2. Research Lab — `src/research/`

Discovers whether an edge exists. **Forbidden from trading**, structurally:
nothing here can reach an execution path.

Seven gates, in mandatory order:

```
training → validation → holdout → walkForward → monteCarlo → costSimulation → shadow
```

Three defences against fitting the criteria to the outcome:

1. Thresholds are **pre-registered and frozen** — mutation throws.
2. Gates **run in order** — a holdout cannot be peeked at early.
3. A gate **cannot be re-run** once its result is seen. A revision is a new
   hypothesis with a new ID.

`walkForward` reports **consistency** — the fraction of folds with positive
expectancy — not the mean. A strategy that works in three folds and collapses
in two has not been shown to work.

`bootstrapTrades` resamples in **blocks**, preserving the serial dependence
in trade outcomes. Losses cluster because the regimes causing them cluster;
an i.i.d. bootstrap reports a drawdown distribution far kinder than reality.

`selectionAdjusted` applies a family-wise correction. Testing forty variants
turns p = 0.0009 into p = 0.0366.

---

## 3. Market State Engine — `src/market/`

Volatility is the commodity, so the system carries several estimates of it
rather than one.

**Realised** — close-to-close, Parkinson, Garman–Klass, **Yang–Zhang**
(the only common estimator handling overnight gaps correctly, which matters
because gap risk *is* the risk in a short-downside book), EWMA, and
GARCH(1,1) fitted by variance-targeted maximum likelihood.

The GARCH forecast **mean-reverts across the horizon**. A vol spike therefore
does not price 45-DTE risk off today's number. Verified: fitting a path
generated at 25% recovers a long-run vol of 25.3%, with the 7-day forecast at
23.9% rising toward it.

Estimator *disagreement* is itself a data-quality signal and gates the
universe.

**Implied** — ATM, IV-at-delta by interpolation only (**never**
extrapolation; outside the quoted delta range the answer is NaN), downside
skew, risk reversal, butterfly, term structure. IV rank and IV percentile are
kept distinct, because quoting one as the other is a common way to make a
mediocre setup look like an opportunity.

**VRP** — measured **forward**, against the GARCH forecast over the option's
own horizon, not against trailing realised vol. Selling 30-DTE vol because IV
exceeds the last 20 days of realised vol is backward-looking: if vol is
mean-reverting upward from a calm patch, that premium is a mirage and the
position is short gamma into a rising-vol regime.

Conditional VRP refuses to report on thin samples rather than producing a
number with no support.

### Regime

Nine weighted inputs produce a score, and the score produces a state.
Transparency is chosen over sophistication deliberately: an HMM would
classify better and explain nothing, and when a regime call blocks a trade
the system has to be able to say which input caused it.

Thresholds are calibrated against five reference states, locked by tests —
changing one is an amendment to what "FEAR" *means*.

The regime carries an **allowed-action matrix**. `FORBIDDEN` cannot be
overridden by an attractive RAROC; `RESTRICTED` doubles the expectancy hurdle.
A restricted regime demands *more* compensation, not less.

**Coverage matters.** A regime call built on a third of its inputs is a guess,
and guesses do not get trading authority. Insufficient inputs never default
to NORMAL.

---

## 4. Underwriter — `src/underwriter/`

Every position is an insurance contract.

### Three probabilities

`p_market` uses the **strike's own IV**. Using ATM vol discards the skew,
which is exactly the compensation a downside underwriter is being paid, and
produces a `p_market` systematically too low for OTM puts.

`p_model` comes from an ensemble — lognormal, Student-t, jump-diffusion —
whose *disagreement* (`modelSpread`) feeds position sizing.

`p_cal` corrects for NUVO's own record. `CalibrationStore` bins forecasts
against outcomes and fits a reliability slope. Slope below 1 means
overconfidence, and the correction is applied:

```
truthful forecaster    slope 0.92  →  CALIBRATED
compressed forecaster  slope 0.42  →  DEGRADED, claimed 90% shrunk to 65%
```

While `UNCALIBRATED` the raw probability passes through **unchanged** and is
flagged. Inventing a correction from twelve observations would be worse than
admitting there isn't one.

### NEV

```
NEV = EV − λ_cvar·CVaR − λ_gap·GapRisk − λ_liq·LiquidityRisk
```

Costs are charged at underwriting time, **round trip by default** — the
system's own harvest rule means most positions are closed, not expired, so
modelling only the entry overstates edge on every managed trade.

Gap risk is the **jump-vs-diffusion CVaR difference**: the tail that exists
only because markets gap. Liquidity risk is scaled by the probability of
actually needing to exit and assumes spreads widen under stress, because
today's spread is not the exit spread.

See `docs/DECISIONS.md` for how the λ values were solved.

---

## 5. Structure Optimizer — `src/structures/`

The whole admissible chain is evaluated. **Delta is an input, not the
decision rule.**

Structure is chosen *after* the opportunity. CSP, bull put spread, shares,
covered call and `NO_TRADE` implement one interface and are scored through
one code path.

`screenAndRefine` runs two passes — a coarse Monte Carlo to rank the field,
full resolution to decide. The screen is deliberately generous (it keeps a
shortlist, not a winner) so sampling noise cannot silently discard a
candidate that would have won. Screened-out candidates are still recorded.

---

## 6. Portfolio Governor — `src/portfolio/`

Sits above the Underwriter and may **shrink or refuse, never enlarge or
permit**.

**Capital states.** Six buckets with a journal. Deployable capital is
computed, never inferred by subtraction — that inference is how a
reconciliation gap becomes an oversized position. Overdrafts are refused;
reconciliation failure quarantines.

**Clusters.** Single-linkage over the correlation matrix — the *pessimistic*
choice. Same-sector membership forces a union even when the sample disagrees.

**Sizing.** `Size = BaseRisk × Q × C × R × D`, every multiplier able only to
reduce. There is no path by which enthusiasm increases size. When size comes
out small, the **binding constraint is named**; when it comes out zero, the
reason is stated.

**Stress.** Eight mandated scenarios shocking price *and* vol together,
because a short-vol book loses on both legs at once and modelling the price
move alone halves the answer. The single-factor loss distribution includes
the leverage effect. Ruin probability is reported **with its standard error**.

The Governor walks *down* the ranking. A top candidate that cannot be sized
is not evidence that the next one cannot either.

---

## 7. Execution — `src/execution/`

Client order IDs are **content-addressed**: a retry seconds later hashes
identically and is refused as a duplicate; a different size, or the same
order tomorrow, is a different order. Duplicate protection exists at both the
order book and the broker — defence in depth, because the failure it guards
against (a lost response after a timeout doubling a position) is unrecoverable.

The price ladder walks toward the market in bounded steps. An order that
chases gives back the edge the underwriting just measured.

`PaperBroker` models partial fills and slippage. A paper broker that always
fills at mid teaches the system a lie, and Authority 3 is gated on execution
evidence that would then be worthless.

---

## 8. Lifecycle — `src/lifecycle/`

Position contracts are complete at inception and their rules are **frozen**.
A losing position cannot renegotiate its own exit criteria. Missing fields
are refused, not defaulted — an incomplete contract is the situation this
exists to prevent.

The engine does not repair. It **reallocates**:

```
EV(hold)  vs  EV(close)  vs  EV(roll)  vs  EV(alternative)
```

ranked on forward NEV, so the risk taken to earn the remaining premium is
part of the comparison. Options that cannot be scored are excluded from
ranking but **kept in the record** — an evidence package that silently omits
the rejected roll cannot show why it lost.

A roll must stand on its own merits. Rolling into a position NUVO would not
otherwise open is repair wearing a disguise.

Assignment creates a new asset state and runs a fresh decision. It does not
default to covered calls.

---

## 9. Constitution — `src/constitution/`

Hard limits, six authority tiers with pre-registered promotion gates, and
kill switches that withdraw trading authority without withdrawing
observability.

Amendments require a stated reason and produce a **new frozen object** with
the change recorded. The constitution cannot be mutated in place.

Kill switches distinguish what they block. A drawdown halt still permits
closing positions — a halt preventing de-risking would be self-defeating.
Losing broker truth blocks everything. Clearing requires a stated reason;
switches do not time out on their own.

---

## 10. Evidence and Scoreboards — `src/evidence/`, `src/scoreboard/`

Packages capture raw observations, the regime call *with every component that
produced it*, the universe including prohibitions and their reasons, **every
candidate scored** with each rejection's reason, the selection, the
governance decision, sizing multipliers, and the order.

Records are hash-chained. Altering one is detected and its position named;
deleting one breaks the chain. Sealing an outcome preserves the decision hash
so the path from decision to result stays provable.

Five scoreboards, never blended. `overallPassed` requires constitutional AND
survival — the hierarchy applied to measurement.

---

## The cycle — `src/pipeline/cycle.js`

Every stage can terminate with a fully-evidenced `NO_TRADE`, and **nothing
throws its way out of a decision**. A business failure produces a recorded
refusal carrying the tier it happened at.

```
0.  authority        →  may this tier even rank opportunities?
0b. kill switches    →  anything tripped blocks new exposure
1.  truth            →  verify every required fact; audit every chain
1b. reconciliation   →  broker vs engine at leg level, or QUARANTINE
2.  market state     →  regime; an unconfident call blocks new exposure
3.  universe         →  Tier A/B/C; eliminate upstream, never score garbage
4.  event clearance  →  a binary inside the window is not a premium
5.  VRP screen       →  is there compensation here at all?
6.  underwrite       →  screen the whole chain, refine the shortlist
7.  rank             →  by RAROC, with NO_TRADE competing
8.  govern           →  size, cluster, stress; walk down the ranking
9.  contract         →  complete lifecycle object, before any order exists
10. order            →  content-addressed, idempotent
11. evidence         →  hash-chained, whatever the outcome
```
