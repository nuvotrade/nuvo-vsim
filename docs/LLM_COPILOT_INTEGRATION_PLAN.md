# NUVO VSIM V5 LLM Copilot integration plan

**Status:** proposed sequence; no new LLM authority granted

## Governing architecture

The Copilot is one read-and-explain layer over two separately governed systems:

```text
Canonical account, market, ledger, and evidence truth
                         |
            +------------+------------+
            |                         |
     Wheel decision engine      Autonomous BOT lane
     CSP / CC / lifecycle       Existing state machine
            |                         |
            +------------+------------+
                         |
          Versioned performance and lesson memory
                         |
                 ChatGPT / Codex Copilot
```

The deterministic engines own math, eligibility, sizing, and state transitions. The Copilot
may inspect, summarize, compare, explain, and propose. It may not invent numbers, override a
gate, change settings, activate a lesson, amend policy, or place an order. Wheel and BOT data
share a learning interface but never share unversioned policy or authority.

## Complete VSIM study scope

The Copilot must study the whole system, not only successful or completed trades:

- source architecture, model specifications, formulas, tests, deployments, and version history;
- the active Constitution, operating mandate, authority ladder, amendments, and unresolved
  governance decisions;
- account custody, balances, positions, orders, fills, transfers, reconciliation, and freshness;
- market data sources, clocks, option chains, events, volatility, regime, and data-quality faults;
- every wheel decision and transition across cash, CSP, assignment, shares, covered call,
  lifecycle management, call-away, and return to cash;
- every autonomous BOT signal, accepted/refused instruction, state transition, order/fill
  receipt, P&L result, operational fault, and recovery event;
- dashboard outputs, History, Performance, alerts, evidence packages, reason codes, and
  discrepancies between surfaces;
- post-trade lessons, repeated patterns, model calibration, execution quality, drawdowns,
  missed opportunities, refusals, and what changed between versions.

Build a versioned VSIM knowledge index over Git for source/governance, D1 for structured
operating records, and R2 for immutable evidence. Every Copilot response must identify the
versions and timestamps it studied. Secrets, authentication material, and unrestricted raw
broker exports remain outside the LLM context; the MCP service supplies only the bounded facts
needed for analysis. Complete study access does not grant mutation or trading authority.

## Audit of the eight proposed layers

### 1. Learnings / reflection after every close — partially built, not active

Migration 0018 and `trade-learning.js` provide append-only, content-hashed analysis for a
completed canonical lifecycle. The feature is disabled, it currently covers wheel trades
only, and the resulting lessons are not read before decisions. Extend its scope to a namespaced
`WHEEL` or `BOT` strategy lane, preserve the original trade and decision evidence, and make
reflection failure visible without corrupting the trade ledger.

The durable D1 table should be the source of record. A human-readable learnings document may
be exported, but a mutable Markdown file should not govern production behavior.

### 2. Mandatory pre-trade read — missing

Build one `DecisionContext` for every wheel decision and BOT evaluation. It must include the
active goal version, operating one-pager hash, current account/market truth, relevant open
campaign, comparable completed trades, active lessons, and data freshness. The context hash
must be sealed with the decision. A missing or stale mandatory component produces `ERROR` or
`REVIEW_REQUIRED`, never a plausible recommendation.

LLM-written lessons begin as `PROPOSED`. They can inform the Principal immediately, but they
cannot change deterministic behavior until approved and compiled into a versioned rule. This
prevents a hallucinated reflection from silently changing the strategy.

### 3. Explicit goal object — missing

Do not optimize a single unconstrained P&L number. Use a lexicographic goal object:

1. establish fresh, reconciled truth;
2. preserve capital and obey the active mandate;
3. complete valid wheel or BOT lifecycles without unauthorized state;
4. maximize net realized return after verified fees within the approved drawdown and capital
   budget;
5. improve capital velocity, premium efficiency, execution quality, and calibration only when
   the higher goals remain satisfied.

The Principal must approve the exact measurement window, drawdown thresholds, account scope,
and relative priorities before this object becomes active.

### 4. Forward / regime layer — partial

VSIM already has market session, VIX, volatility, event, and deterministic regime machinery.
It does not yet have a complete forward-context record covering verified earnings, dividends,
macro events, material news, source timestamps, and an explicit `different_from_history`
comparison. Add those as sourced facts. LLM news summaries remain advisory; only approved,
deterministic event or regime rules may gate a trade.

### 5. LLM and MCP split — foundation exists, Codex is not connected

The protected MCP server already exposes narrow account, market, cycle, evidence, proposal,
and ticket-review tools and has no broker mutation tool. Extend it with read-only tools for the
single dashboard snapshot, History, Performance, lessons, wheel decisions, and BOT status.
Connect Codex with a path-scoped service identity only after the tool contract and code of
conduct are approved. Keep raw broker packets, credentials, secrets, and unrestricted database
queries outside the tool surface.

### 6. Canonical one-pager every cycle — missing

Create a short, immutable operating context containing purpose, products, account scope,
authority, goal hierarchy, hard limits, human-only powers, execution boundary, and escalation
rules. Store it as a versioned governance artifact, inject its content hash into every
`DecisionContext`, and refuse when the active hash cannot be resolved.

### 7. Paper-first path — library exists, production path is incomplete

The repository has a paper broker and shadow evidence, but no first-class Copilot paper
environment with isolated storage and an end-to-end dashboard path. Build a separate paper
namespace with its own ledger, evidence, fills, performance, lessons, and visible `PAPER`
identity. Paper evidence proves workflow reliability; it must not be counted as live execution
or live calibration evidence.

### 8. Hard isolated capital and versioned memory — capital isolation missing; memory foundation exists

D1 and R2 are the correct durable memory foundation. Add versioned lesson status, provenance,
supersession, retrieval scope, and context hashes rather than stuffing months of trades into a
prompt. Retrieval should be structured by strategy lane, symbol, setup, regime, DTE, outcome,
and governing version.

Trade memory is only one namespace. Add separate versioned namespaces for governance decisions,
model and formula changes, deployment/test evidence, operating incidents, data-quality faults,
dashboard discrepancies, wheel lifecycle outcomes, BOT lifecycle outcomes, and Principal
instructions. The Copilot reads the applicable namespaces before each task and records which
items were used.

Software kill switches exist, and the LLM has no tool to override them. That is not equivalent
to broker-level capital isolation. Before any new LLM or BOT execution authority, use a
dedicated sub-account or another broker-enforced capital boundary with an absolute dollar cap.
Wheel and BOT capital budgets must be distinct even if the Copilot reviews both.

## Recommended build sequence

### Phase 1 — sign the operating contract

Produce and approve:

- Copilot code of conduct;
- operations manual;
- explicit goal object;
- canonical one-pager;
- wheel/BOT lane and account scope;
- lesson approval and supersession rules;
- human-only powers and escalation matrix.

No LLM integration should precede this contract.

### Phase 2 — close the memory loop in observation mode

- Build the complete VSIM knowledge index across source, governance, operations, wheel, BOT,
  History, Performance, incidents, and evidence.
- Reconcile every completed History lifecycle.
- Backfill one immutable reflection per eligible wheel and BOT trade.
- Display analysis status, confidence, evidence limitations, and proposed lessons.
- Build the mandatory pre-decision `DecisionContext` read and hash it into every decision.
- Keep lessons advisory and execution manual while quality is audited.

### Phase 3 — connect the read-only Copilot through MCP

- Add the bounded History, Performance, lesson, wheel, and BOT tools.
- Connect Codex with a path-scoped identity.
- Require the Copilot to read the one-pager and `DecisionContext` before analysis.
- Test stale truth, missing memory, conflicting lessons, prompt injection, evidence drift, and
  model unavailability.

### Phase 4 — forward context and comparison

- Add sourced event/news/regime facts.
- Record what differs from the applicable historical sample.
- Measure whether the context improves decisions before allowing it to affect policy.

### Phase 5 — first-class paper operation

- Run wheel and BOT through isolated paper ledgers and simulated fills.
- Test the full decision-to-close-to-reflection-to-next-context loop.
- Require replayable evidence and zero authority or reconciliation breaches.

### Phase 6 — isolated canary review

Only after the earlier phases pass, establish broker-enforced capital isolation and decide
whether any narrowly bounded autonomous action should be proposed. Promotion remains a
Principal decision. The Copilot cannot promote itself, clear a kill switch, change a limit, or
expand its account, product, or strategy scope.

## Definition of done for the next phase

Phase 1 is complete only when one signed, hashed operating bundle answers: what the Copilot is
trying to accomplish; what it must read; what it may do; what it must refuse; what remains
human-only; how wheel and BOT are separated; how lessons become active; and how every action
is reconstructed from canonical evidence.
