# NUVO VSIM

**An autonomous capital-allocation and options-underwriting system.**

> Compound capital by selling mispriced risk only when compensation exceeds
> modelled risk after costs.

That mandate does not change when the preferred instrument changes. CSPs,
spreads, shares, covered calls, futures and cash are implementation vehicles.
They are not the identity of the business.

```
TRUTH  >  SURVIVAL  >  EXPECTANCY  >  CAPITAL EFFICIENCY  >  INCOME
```

This hierarchy is executable code, not a slogan. Every refusal carries the
tier it happened at, and a lower tier can never overrule a higher one: a trade
with spectacular expectancy that violates a survival limit is rejected as
`SURVIVAL`, not as "low score".

---

## Quick start

```bash
npm install                           # Cloudflare MCP/Workers adapter packages
npm test                              # 288 deterministic and Stage 2 tests

node bin/nuvo.js cycle                # one decision cycle + the dashboard
node bin/nuvo.js simulate --cycles 12 # repeated cycles against a synthetic market
node bin/nuvo.js constitution         # the operative limits and authority ladder
node bin/nuvo.js registry             # the strategy registry
node bin/nuvo.js research             # research gates and the bootstrap
node bin/nuvo.js evidence             # build and inspect an evidence package
```

The deterministic engine under `src/` remains zero-dependency plain ES modules
on Node 20+. The Cloudflare adapter adds the official MCP/Agents SDK, Zod, and
Wrangler as deployment dependencies; it does not move calculations into AI.

---

## What the system actually decides

```
                  Where is the market currently offering NUVO more
                  compensation than the risk it must assume?

  regime ─► IV/realised dislocation ─► skew ─► conditional loss distribution
     ─► event clearance ─► liquidity clearance ─► every strike and structure
     ─► RAROC ranking ─► portfolio correlation ─► size ─► order ─► lifecycle
     ─► calibration

                  If nowhere:  DO NOTHING.
```

`NO_TRADE` is a first-class output, not a fallback. It is scored and ranked
like any other candidate, with zero EV and zero capital consumption, so a
field of negative-NEV candidates genuinely loses to it.

Verified across a volatility-risk-premium sweep:

| IV / realised | Decision  | What was chosen                    |
|---------------|-----------|------------------------------------|
| 1.03          | NO_TRADE  | RAROC below the regime hurdle      |
| 1.19          | ORDER     | small defined-risk spread          |
| 1.30          | ORDER     | spread, RAROC 118%                 |
| 1.45          | ORDER     | spread, RAROC 185%                 |

---

## Architecture

| Layer | Directory | Responsibility |
|---|---|---|
| 1. Truth Engine | `src/truth/` | Verify, or refuse. Fail closed. |
| 2. Research Lab | `src/research/` | Discover whether an edge exists. Forbidden from trading. |
| 3. Market State | `src/market/` | Volatility, skew, term structure, regime. |
| 4. Underwriter | `src/underwriter/` | EV, NEV, CVaR, three probabilities, RAROC. |
| 5. Structure Optimizer | `src/structures/` | Which shape to take the risk in — decided after the opportunity. |
| 6. Portfolio Governor | `src/portfolio/` | Sizing, correlation, clusters, Greeks, stress, capital states. |
| 7. Execution | `src/execution/` | Order construction, limit policy, idempotency, fills. |
| 8. Lifecycle | `src/lifecycle/` | Harvest, re-underwrite, hold, close, roll, assignment. |
| 9. Constitution | `src/constitution/` | Authority tiers, risk limits, kill switches. |
| 10. Evidence & Scoreboards | `src/evidence/`, `src/scoreboard/` | Reproducible decisions and five separate measures. |

The decision cycle that composes them is `src/pipeline/cycle.js`.
`src/engine.js` wires the long-lived components together.

### Stage 2 AI desk

`cloudflare/mcp-server.js` exposes the narrow authenticated `nuvo-vsim` MCP
surface. MASTER CHIEF may read, explain, replay, and start autonomous shadow
cycles. The MCP server has no free-form broker order, Constitution mutation,
gate override, or LLM calculation tool.

A per-account SQLite Durable Object supplies the single-flight lock and a
Cloudflare Workflow runs the existing deterministic cycle. D1 indexes cycle
states and hashes; R2 stores immutable evidence and CycleContext bodies. The
human dashboard remains read-only mission control.

See `docs/AI_DESK.md` for the exact authority boundary and deployment gates.

---

## The ideas that shaped the code

### Three probabilities, and the honesty of the third

`p_market` is extracted at the **strike's own implied vol**, never at ATM —
using ATM vol discards the skew, which is exactly the compensation being
measured. `p_model` comes from an ensemble of forward distributions
(lognormal, Student-t, Merton jump-diffusion, block bootstrap). `p_cal`
applies NUVO's own track record.

Until enough live evidence exists, `p_model` is labelled `UNCALIBRATED` —
and that label is not a disclaimer, it is a number that suppresses position
size downstream. The store detects overconfidence via reliability slope: a
forecaster whose slope is 0.42 has a claimed 90% shrunk to 65%.

### NEV, and why the lambdas are what they are

```
NEV = EV − λ₁·CVaR − λ₂·GapRisk − λ₃·LiquidityRisk
```

The λ values were **solved empirically, not assumed**. The first values tried
rejected every trade including the good ones, which is not conservatism — it
is a broken instrument. They are calibrated against the EV/CVaR ratio of a
genuinely well-priced short put.

`λ_gap` and `λ_liquidity` are deliberately set *higher per unit* than
`λ_cvar`. CVaR is risk NUVO chose and can manage down; gap risk arrives
overnight with no opportunity to react. Unmanageable risk is priced higher
than managed risk of the same size.

Gap risk is isolated as the **difference in tail loss between the full
distribution and a diffusion-only counterfactual** — precisely the risk a
Black-Scholes view is blind to.

### Economic capital, and the deep-wing trap

Ranking by RAROC has a failure mode that the first implementation walked
straight into. For a 5-delta put, `P(loss)` sits below the 95% cutoff
entirely, so `CVaR₉₅` collapses toward zero and RAROC divides by almost
nothing. The ranking preferred the furthest, thinnest wing on the board —
one candidate scored **1704%** while risking almost nothing by its own model.
That is picking up pennies in front of the steamroller, arrived at by
arithmetic.

Economic capital is now the **largest** of four measures, each blind to a
different failure:

1. `CVaR₉₉`, which sits inside the loss region where it belongs;
2. a deterministic 3σ stress, independent of the tail model being right;
3. the mandated −20% crash shock;
4. a floor — 25% of max loss for defined risk, or **10% of locked buying
   power** for undefined risk. The broker demands that collateral for a
   reason; so does NUVO.

The same deep wing now ranks at −2%.

Max loss alone is rejected as the measure: for a CSP it is the strike going
to zero, and reserving against that would permit about three positions. Max
loss is a solvency fact, not an allocation basis.

### Structure chosen after the opportunity

NUVO identifies an economically attractive risk premium first, then asks what
shape to take it in. Every structure implements one interface and is scored
through one code path, so nothing gets a sentimental advantage. The system
reproduces §10's scenario unprompted:

```
CSP              RAROC   8.3%   NEV $24   BP $46,661
BULL_PUT_SPREAD  RAROC  50.9%   NEV $69   BP  $1,655   ← wins
```

More absolute EV in the CSP; the spread wins on capital.

There is also an emergent behaviour worth naming: while `UNCALIBRATED`, the
confidence multiplier shrinks the risk budget enough that only defined-risk
structures fit. Nothing hardcodes that preference — it falls out of §15.

### Lifecycle: reallocation, not repair

The comparison is derived so the sunk entry credit **cancels algebraically**:

```
structure.payoff(S) = entryCredit − obligation(S)
⟹  forwardPnl(S)    = structure.payoff(S) + currentMark − entryCredit
```

The entry credit appears only to be eliminated. It is read from the
*structure*, never from the position, so a restated entry price cannot reach
the decision. Anchoring is structurally impossible rather than merely
discouraged.

Position contracts freeze their lifecycle rules at inception. A losing
position cannot renegotiate its own exit criteria, because the object holding
those criteria is frozen and mutation throws.

Assignment runs a **fresh** decision and does not default to covered calls.
Cost basis is reported for accounting and excluded from the decision.

### Correlation, not sector labels

Clustering is single-linkage — the *pessimistic* choice, so NUVO errs toward
declaring concentration rather than away from it. Same-sector membership
forces a union even when the sample disagrees, because a short history can
hide a relationship that a shock will reveal.

Ten correlated tech short puts register as one 32% cluster, not ten 8%
positions, and breach the 25% limit.

### Determinism as an audit requirement

`Math.random()` is banned engine-wide. Every simulation is seeded from the
cycle id, and position ids are derived from content rather than a counter,
so a decision replayed in a fresh process is identical. A Monte Carlo run
that cannot be reproduced is an anecdote, not evidence.

Evidence packages record the **raw** inputs verbatim — chains, histories,
quotes, account state, positions, open orders — alongside the regime call
*with every component that produced it*, the full candidate field including
both rejections and coarse-screen discards, the selection, the governance
decision, and the order. SHA-256 hash-chained, so alteration or deletion is
detectable, and durable behind a persistence port that refuses to extend a
chain it cannot verify.

And the claim is testable rather than asserted:

```js
const rep = await replay(pkg);   // rebuilds provider + broker from the capture
rep.reproduced === true          // decision fingerprint matches exactly
```

Two hashes, deliberately: `hash` covers the whole record (integrity), while
`decisionFingerprint` covers decision content with provenance excluded
(reproducibility). A faithful replay reads from a different provider, so
judging reproduction on the full-record hash would fail every correct replay.

---

## The authority ladder

NUVO does not graduate from recommendation engine to autonomous trader by
decree.

| Tier | Name | May do | Capital |
|---|---|---|---|
| 0 | RESEARCH_ONLY | research | 0% |
| 1 | SHADOW | rank | 0% |
| 2 | PROPOSE | build order plans, human approves | 20% |
| 3 | AUTO_ENTRY | submit within narrow limits | 35% |
| 4 | AUTO_LIFECYCLE | manage positions | 60% |
| 5 | AUTO_PORTFOLIO | full operation | 100% |

Promotion thresholds are **pre-registered** so they cannot be relaxed after a
good month, require *live* evidence (backtests promote nothing past SHADOW),
and move one step at a time. Authority 3 requires proven *execution*, not just
proven theory. Authority 4 requires a survived drawdown, not an unhurt record.

Demotion is automatic and always beats promotion. A single constitutional
breach costs everything above PROPOSE; a data-integrity failure costs
everything.

---

## Failing closed

If NUVO cannot verify account state, market state, the option chain, Greeks,
positions, open orders, buying power, model version, events, or data
freshness — **no new order**.

A missing value is not representable as a number: `Fact.require()` throws
rather than handing back a placeholder. There is no default vol, no assumed
Greek, no last-known-good chain quietly reused an hour later.

The UI stays operational; trading authority does not. `observable` and
`tradeable` are separate booleans, and collapsing them is the exact failure
§18 forbids. A drawdown halt still permits closing positions — a halt that
prevented de-risking would be self-defeating — while losing broker truth
blocks everything.

If broker state and engine state disagree: **QUARANTINE**.

---

## Strategies are killable

The system is permanent. Strategies live, compete for capital, and die.

| ID | Name | Ships as |
|---|---|---|
| VSIM-001 | Fear-regime downside underwriting | RESEARCH |
| VSIM-002 | Defined-risk downside VRP | RESEARCH |
| VSIM-003 | Post-event volatility compression | RESEARCH |
| VSIM-004 | 0DTE index premium | **REJECTED** |

A strategy cannot be constructed without declared kill criteria. When they
breach, it is killed — `REJECTED` if it never risked capital, `TERMINATED` if
it did. There is no repair path, no rename, no refit. Research may propose a
successor, which is a new hypothesis with a new ID, its own out-of-sample
burden, and recorded lineage.

VSIM-004 ships rejected on purpose: 0DTE is out of scope for core VSIM, and
its variance would contaminate the statistical record the authority ladder
depends on. Recording the rejection stops the question being reopened
informally every few weeks.

---

## Research cannot be gamed

Thresholds are pre-registered and frozen against mutation. Gates run in
order — a holdout cannot be peeked at before validation — and a gate cannot
be re-run after its result is seen. Promotion requires every gate to have run
*and* passed.

The block bootstrap preserves loss clustering, walk-forward scores
**consistency** across folds rather than a flattering average, and selection
adjustment deflates the best of N so a strategy cannot be promoted on the
strength of having been the luckiest of forty.

What that machinery is for, demonstrated by `nuvo research`:

> An **85% win rate** series where **82% of resampled paths end below
> starting capital.**

"80% POP means it's safe" is a doctrine the system removes.

---

## The five scoreboards

Kept separate on purpose. A single blended score is precisely the instrument
that would hide the thing worth seeing.

- **Economic** — expectancy, profit factor, return on capital, and the
  governing objective `G = return / (capital × risk)`.
- **Calibration** — Brier score, skill score against the base rate,
  reliability bins, calibration slope.
- **Execution** — slippage, fill rate, and how much modelled edge survived
  contact with the market.
- **Constitutional** — a gate, not a percentage.
- **Survival** — drawdown, CVaR, stress, concentration, ruin probability
  *with its standard error*.

`overallPassed` requires **constitutional AND survival**. Economic
performance cannot compensate for either — the hierarchy applied to
measurement. A profitable unauthorised trade is still a system failure, and
the scoreboard says so.

---

## What was removed

- "We need $2,000 this week" — encourages forced deployment.
- "80% POP means it's safe" — see the bootstrap above.
- "Assignment is fine because I like the company" — irrelevant to whether the
  original trade had positive expectancy.
- "I'll wheel it until I recover" — sunk cost, structurally excluded.
- "Premium is high, therefore attractive" — high premium generally exists
  because risk is high.
- "We need more filters" — not without proof of incremental out-of-sample value.
- Moving averages, RSI, MACD, Fibonacci, chart patterns as sources of
  autonomous edge. Research can admit a technical feature that demonstrates
  statistically significant incremental explanatory power out of sample. Not
  before.

---

## Layout

```
src/
  constitution/   hierarchy, authority tiers, limits, kill switches
  math/           deterministic RNG, stats, Black-Scholes, distributions
  truth/          fact verification, reconciliation, providers
  market/         realised vol, implied vol, VRP, regime, market state
  universe/       Tier A/B/C classification and upstream filters
  underwriter/    probabilities, costs, EV/NEV, capital, underwriting
  structures/     CSP, spread, shares, covered call, no-trade, optimizer
  portfolio/      capital states, clusters, sizing, stress, governor
  execution/      orders, idempotency, broker adapters, paper broker
  lifecycle/      position contracts, reallocation engine
  research/       hypotheses, backtest, walk-forward, bootstrap
  registry/       strategy registry and the VSIM catalogue
  evidence/       decision packages, hash-chained store
  scoreboard/     the five scoreboards
  pipeline/       the decision cycle
  dashboard/      the five-panel view
  engine.js       assembled engine
test/             270 tests
docs/             architecture and operating notes
```

See `docs/ARCHITECTURE.md` for the layer-by-layer walkthrough and
`docs/DECISIONS.md` for the calibration choices and what changed when the
system was run rather than read.
