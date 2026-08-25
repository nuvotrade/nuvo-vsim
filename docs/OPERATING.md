# Operating NUVO VSIM

## Starting from zero

A new deployment begins at **Authority 0 (RESEARCH_ONLY)** and can deploy no
capital. That is not a formality — `CAPITAL_AUTHORITY_FRACTION[0]` is 0, and
sizing returns zero contracts with the reason stated.

The path to autonomy:

```
0 RESEARCH_ONLY   research only
1 SHADOW          rank opportunities, no capital
2 PROPOSE         build order plans; a human approves      20% of capital
3 AUTO_ENTRY      submit within narrow limits              35%
4 AUTO_LIFECYCLE  manage positions autonomously            60%
5 AUTO_PORTFOLIO  full portfolio operation                100%
```

Promotion beyond PROPOSE needs **live** evidence. Backtests promote nothing.
Moving from SHADOW to PROPOSE requires an explicit Principal Constitution
amendment. Remaining thresholds are pre-registered in
`src/constitution/authority.js`, and promotion moves one step at a time.

There is a deliberate ordering here worth understanding:

- **Authority 2** requires an explicit Principal Constitution amendment.
  Shadow observations remain calibration evidence, but are not an
  observation-count gate and cannot promote the system automatically.
- **Authority 3** additionally requires proven *execution* — 60% of modelled
  edge surviving real fills. A system whose theory is right and whose fills
  are terrible is not ready to submit orders.
- **Authority 4** requires a **survived drawdown** (max 12%), not an unhurt
  record. Lifecycle autonomy is exactly the capability that matters when
  things go wrong, so it is not granted to a system that has never been tested.

Demotion is automatic and always beats promotion. One constitutional breach
costs everything above PROPOSE. A data-integrity failure costs everything.

```js
const review = engine.reviewAuthority();
// { changed: true, direction: 'DEMOTION', from: 4, to: 2, reasons: [...] }
```

## The shadow bootstrap

There is an apparent deadlock: calibration requires live observations, and
capital requires calibration. It resolves through SHADOW.

At Authority 1 the engine runs full cycles, ranks opportunities, and records
what it *would* have done. `recordOutcome()` feeds the calibration store the
forecast that was actually made — terminal `P(S_T < K)` — against the matching
terminal outcome. Touch probability is scored on a separate board and is never
substituted for the terminal event.
Authority 2 opens only after the Principal explicitly amends the Constitution.

Expect the system to prefer **defined-risk structures** while uncalibrated.
Nothing hardcodes that: the confidence multiplier shrinks the risk budget
enough that only spreads fit. It is §15 working as designed.

## Reading a NO_TRADE

`NO_TRADE` is a result, not a failure. Distinguish the varieties:

| Reason | Meaning |
|---|---|
| RAROC below hurdle | No compensation. Correct behaviour; wait. |
| Regime inputs insufficient | A data problem, not a market problem. Fix the feed. |
| Governor declined all candidates | Capital or concentration bound, not expectancy. |
| VRP screen | Realised vol exceeds implied. Do not sell into this. |
| Universe empty | Liquidity, data, or event gates. Check which. |

The `trace` array names every stage and whether it passed. The evidence
package carries the full candidate field with each rejection's reason.

## Reading a REFUSED

`REFUSED` means the Truth Engine or the Constitution stopped the cycle.
`governingTier` names the tier. This is fail-closed behaviour and needs
investigation, not a retry.

The dashboard keeps rendering. Trading authority is withdrawn; observability
is not.

## When a kill switch trips

Switches do not time out. Clearing requires a stated reason, because the
condition has to be shown to be gone:

```js
engine.killSwitches.clear(SWITCH.RECONCILIATION,
  'Broker and engine books match after manual review of order PB-4.');
```

`RECONCILIATION`, `BROKER_DISCONNECT` and `DATA_INTEGRITY` block risk
reduction too — without trustworthy state, closing a position is as dangerous
as opening one. `DRAWDOWN` does not: a halt that prevented de-risking would
be self-defeating.

## Amending the constitution

Limits are frozen. Amendments produce a new object and require a reason:

```js
const amended = amend(DEFAULT_LIMITS,
  { maxClusterPct: 0.30 },
  { reason: 'Evidence from 200 trades shows cluster CVaR overstated at 0.25.',
    evidence: 'docs/analysis/cluster-2026-03.md' });
```

Treat this as a genuine amendment. `LIMIT_BASIS` records why several limits
hold their values; if you change one, record why you changed it.

## Adding a strategy

Never modify an existing strategy to make it work. Register a new one:

```js
registry.register(new Strategy({
  id: 'VSIM-006',
  name: '...',
  hypothesis: '...',        // must be falsifiable as stated
  killCriteria: { ... },    // mandatory — construction throws without it
  allowedStructures: [...],
  allowedRegimes: [...],
}));
```

If it descends from an existing strategy, use `createSuccessor` so the
lineage is recorded. A family of refits should be visible as a family of
refits.

Run it through the research gates before it goes anywhere near SHADOW.

## Connecting a real broker

Implement `BrokerAdapter`. The contract that matters:

> **Every method must be able to say "I do not know".**

Return `{ error }` on failure. Never a plausible substitute, never a cached
value presented as live, never zero for "unavailable". The Truth Engine
cannot see past this boundary, so an adapter that guesses defeats every
protection above it.

Then verify:

1. Reconciliation passes across at least one fill and one close.
   `engine.brokerView()` must match the broker's positions exactly — this is
   where the hardest bug in the build lived.
2. Duplicate submission is refused at both layers.
3. Fill quality is recorded, so execution evidence can gate Authority 3.

## Running research

```js
const h = new Hypothesis({
  id: 'H7', strategyId: 'VSIM-006',
  statement: '...',
  preRegistered: { minExpectancy: 5, minProfitFactor: 1.15, maxDrawdownPct: 0.15, minTrades: 40 },
});
```

Write the thresholds down first. They freeze on construction. Gates run in
order and cannot be re-run once seen.

If a gate fails, the hypothesis failed. Do not adjust the thresholds and try
again — that is the behaviour the freezing exists to prevent. Form a new
hypothesis with a new ID and state what changed.

## What to watch

Daily: the five scoreboards. Watch **calibration slope** and **edge retained**
more closely than P&L. P&L over short horizons is mostly noise; a calibration
slope drifting below 0.7 means the model has started lying, and an edge
retention below 0.5 means the edge may not survive contact with the market at
all.

Weekly: the evidence chain verifies, and cluster exposure against the 25%
limit.

Whenever a strategy has 50+ live observations: run `enforceKillCriteria`.
Let it kill things. That is what it is for.
