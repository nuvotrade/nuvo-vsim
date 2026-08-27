# NUVO VSIM autonomy readiness roadmap

**Status:** DRAFT FOR PRINCIPAL REVIEW  
**Authority effect:** NONE  
**Production state:** Authority 2 / PROPOSE ONLY; broker mutation disabled

This document plans a path toward autonomous operation. It is not a mandate, an authority amendment, an execution authorization, or permission to change the live account. No phase advances because a date arrives. Each phase has evidence-based exit gates and requires an explicit Principal decision where stated.

## Decisions recorded

### Account boundary — decided

Future autonomous activity will operate in a dedicated Schwab account. Account ••••4315 remains a manually governed legacy account and stays visible in the dashboard with an explicit `OUTSIDE AUTONOMOUS MANDATE` scope label.

The autonomous account begins from cash with no inherited positions. SPCX, CBRS, and every other position already in ••••4315 remain manual-account obligations. They cannot be transferred into the autonomous account merely to make the legacy account look compliant.

This decision removes manual/agent attribution from the autonomous compliance calculation: everything held in the dedicated account is governed by the active autonomous mandate by construction.

## Operating standard

The standard established during the 2026-08-26 V5 investigation is load-bearing:

> Plausible explanations are not evidence.

An autonomous system must apply that suspicion to its own outputs. The mechanical requirements are:

1. Preserve complete raw inputs before normalization or filtering.
2. Attach source, field, timestamp, transformation, and governing-version provenance to every derived value that can affect a decision.
3. Reconcile independent derivations and display both `RECONCILED` and `DRIFT` states.
4. Refuse with a named reason when truth is absent, stale, contradictory, or unverifiable.
5. Record shadow predictions before outcomes arrive; never retune a threshold to fit an observed outcome without a versioned amendment.
6. Permit automatic demotion and self-suspension, but never automatic self-resumption or self-amendment.

## Current blockers

Autonomy remains blocked by governance and evidence, not by the ability to add an order API.

- Two governing documents disagree on products, DTE, concentration, expiration, and deployment limits.
- The live book is outside both candidate limit sets on concentration, expiration, deployment, and reserve.
- The reviewed strategy has little live calibration evidence. Existing historical activity is not equivalent to pre-registered shadow predictions.
- A durable account high-water mark and drawdown-authority ladder do not exist in the deployed runtime.
- Authority promotion metrics exist in the engine but are not yet driven by a complete durable production observation pipeline.
- The execution boundary is intentionally absent. The current Worker cannot place, replace, or cancel a broker order.
- Authority 3 currently permits entry while lifecycle management remains human. Before enabling it, risk-reducing actions and responsibility for every open position must be unambiguous.

## Target governance structure

V5 already has a partial machine-readable constitution in `src/constitution/limits.js`. It is not yet a single authority because products, authority, DTEs, universe settings, display caps, and model thresholds also live in Worker variables and separate modules.

Use one immutable root governance manifest as the identity stamped into evidence. The manifest references separately hashed artifacts so policy amendments and model recalibrations remain distinguishable:

```text
governance manifest
├── principal mandate       products, account scope, hard limits, human-only powers
├── universe policy         admissibility and lot-size rules
├── model specification     ensemble, NEV charges, probability/VRP methodology
├── execution policy        order types, price limits, hours, retries, idempotency
├── escalation policy       blocking alerts, self-suspension, resumption authority
└── transition policy       treatment of inherited nonconforming positions
```

The root manifest has one version and one canonical content hash. Every referenced artifact is immutable and content-addressed. Every sealed decision records the root hash plus component hashes. Human prose explains the artifacts but cannot override them.

The agent may read these artifacts. It may not write, select, amend, activate, or weaken them.

## Phase 0 — preserve the current boundary

**Objective:** keep preparing without creating accidental authority.

- Keep production at Authority 2 / PROPOSE ONLY.
- Keep broker order mutation disabled.
- Preserve Guardian, raw Schwab packets, evidence sealing, and the domain checkpoint.
- Treat Friday's expiries and the first live scan as observations, not promotion evidence unless their forecasts were sealed before the outcome.
- Keep the current bundled-UI successor tag as the rollback baseline.

**Exit:** the Principal approves the governance-design process below. No trading parameter must be chosen to complete this phase.

## Phase 1 — one authoritative mandate

**Objective:** decide the rules before measuring compliance or gathering promotion evidence.

### Principal decisions

1. **Autonomous products:** recommended initial scope is covered calls and cash-secured puts only. Decide whether futures, 0DTE, long options, and spreads are prohibited only for the agent or prohibited in the governed account.
2. **Universe:** fixed ticker list or rule-based admission. Recommended: rule-based admission with liquidity, chain completeness, event, leverage/inverse-product, and maximum one-lot percentage-of-NAV gates.
3. **DTE policy:** decide eligible CSP and CC windows. The current 7-day concentration and the proposed 30–45-day cycle are materially different businesses.
4. **Hard limits:** one value each for single underlying, expiration, deployed capital, reserve, per-contract NAV, factor/cluster, Greeks, and beta.
5. **Drawdown ladder:** high-water-mark definition; warning, de-risk, halt, and independent-kill rungs; allowed actions at each rung.
6. **Human-only powers:** mandate amendment, authority promotion, self-suspension clearance, account-scope changes, new products, and any weakening of collateral or survival limits.

### Engineering outputs after the decisions

- Versioned governance schema and canonical hashing rules.
- Draft artifacts validated against the schema but marked `DRAFT` until signed.
- Inventory of every current hardcoded or environment-configured governing value.
- Tests proving each live consumer receives its value from the activated manifest.
- Evidence and UI surfaces showing the governing version and content hash.
- Amendment record containing author, reason, supporting evidence, prior hash, new hash, and effective time.

**Exit gate:** one activated mandate; no unresolved duplicate source of authority; byte-reproducible governance bundle; Principal signature recorded. Activation is a separate reviewed deployment.

## Phase 2 — inherited-book transition

**Objective:** keep the manual legacy book explicit without importing its nonconformity into the autonomous account.

The dedicated autonomous account starts from cash and therefore has no inherited nonconformity. The transition policy below governs account ••••4315 as a manual-account wind-down and observation surface. It is not a waiver that allows the autonomous account to inherit those positions.

The transition policy must distinguish:

- `COMPLIANT` — within the activated mandate;
- `PREEXISTING_NONCONFORMING` — inherited before the mandate became effective;
- `AGENT_BREACH` — created or worsened by an agent decision;
- `MANAGE_ONLY` — no additional exposure; only hold, expire, close, or reduce under named rules.

Preexisting status does not make a position compliant. It prevents inherited exposure from being mislabeled as an agent-created breach while keeping the breach visible.

Create a dated position-by-position transition plan with:

- governing limit and current measurement;
- prohibited additions;
- allowed risk-reducing actions;
- expiry/assignment scenarios;
- target compliance date;
- expected cash and concentration after each step;
- escalation if market movement makes the plan worse.

**Exit gate:** the account is compliant, or every exception is explicitly time-bounded and manage-only. The agent cannot receive entry authority while it could worsen an inherited breach.

For the dedicated account, the exit gate is stricter: opening custody contains cash only, no positions, no open orders, no margin debit, and a captured reconciliation baseline before the first governed shadow cycle.

## Phase 3 — durable observation and calibration

**Objective:** make promotion evidence real rather than inferred.

Build or complete:

- Durable account high-water mark, drawdown duration, and rung history.
- Shadow forecast record sealed before the terminal outcome.
- Terminal-outcome matcher for expiry, assignment, exercise, buy-to-close, and cash settlement.
- Separate calibration boards for terminal probability, touch probability, product, DTE bucket, and regime.
- Execution scoreboard matching frozen proposals to actual broker fills, including slippage and edge retained.
- Governance compliance scoreboard using the mandate version effective at decision time.
- Visible reconciliation across custody, ledger, prediction, outcome, execution, and governance totals.
- Data-quality scoreboard: stale/blocked duration, disagreement frequency, missing fields, source changes, and refusal correctness.

### Promotion-counting rule

All forecasts remain preserved, but the Authority 3 promotion counter uses a narrower unit:

- One countable unit is one prospectively designated, sealed terminal forecast for a unique `underlying × expiration × terminal event`.
- The first forecast designated under the registered sampling rule owns that unit. Later cycles, alternate strikes, and alternate structures sharing the same underlying, expiration, and terminal event are diagnostic records and add zero to promotion `n`.
- Forty strikes from one option chain at one timestamp are one outcome cluster, never forty observations.
- A model or mandate amendment cannot recount the same terminal outcome. The unit key excludes model and mandate hashes; those hashes remain provenance on the chosen forecast.
- A unit counts only after the terminal event resolves unambiguously through expiry, assignment, exercise, cash settlement, or the registered terminal-price source.
- `NO DATA` and operational failures are scored on the data-quality board, not added to probability calibration `n`.
- A sealed proposal is the preferred designated forecast. If the system counts a no-trade reference forecast, its selection rule must be fixed in the mandate before the measurement window opens.

The proposed Phase 1 minimum for Authority 3 is **100 resolved promotion units**, preserving the existing engine gate while removing candidate-row inflation. It becomes pre-registered only when the Principal approves the mandate before the observation window opens. After activation, changing 100 is a Principal amendment and cannot occur after results are visible. The proposed execution minimum is **20 proposal-matched live executions**, matching the existing execution-scoreboard sufficiency floor; a numerical edge-retention average with fewer executions cannot promote authority. This also requires Principal approval in Phase 1.

**Exit gate:** automated checks can reconstruct every counted observation from raw input through outcome and show why excluded observations were excluded.

## Phase 4 — extended shadow operation

**Objective:** learn whether the fixed rules work without risking capital.

Run full scheduled cycles through multiple regimes. Record `NO DATA`, `NO EDGE`, `NO CAPITAL`, candidates, exclusions, and hypothetical lifecycle actions. Do not optimize thresholds during the measurement window.

Minimum readiness evidence should include:

- at least 100 resolved promotion units under the Phase 3 counting rule;
- at least 20 proposal-matched live executions before Authority 3 review;
- Brier score and calibration slope within the registered limits;
- zero agent-created constitutional breaches;
- zero unsealed or unreplayable decisions;
- correct refusal classification under known data failures;
- durable drawdown and HWM behavior tested through adverse scenarios;
- successful expiry/assignment matching;
- operational reliability over a pre-registered number of market sessions.

**Exit gate:** the system may become eligible for a Principal review. It cannot promote itself.

## Phase 5 — supervised execution evidence

**Objective:** measure real execution while the human still controls every broker mutation.

- Produce frozen, short-lived, exact order tickets from sealed proposals.
- Principal manually submits only the exact approved ticket.
- Match the broker order and fills back to the proposal.
- Classify any variation as a bypass, not a successful agent execution.
- Measure fill rate, slippage, latency, edge retained, cancellation behavior, and lifecycle outcomes.
- Keep Guardian and reconciliation active at the mutation boundary.

This phase supplies the real-fill evidence required by Authority 3 without granting autonomous submission.

**Exit gate:** execution metrics satisfy the pre-registered gate, and the full proposal-to-fill-to-outcome chain is replayable.

## Phase 6 — restricted canary autonomy

**Objective:** test the smallest useful autonomous capability with bounded loss.

Before implementation, review the authority ladder. Allowing autonomous entry while all lifecycle management remains manual can create unattended obligations. Risk-reducing close authority should be available no later than new-exposure authority, while risk-increasing rolls remain prohibited until separately earned.

The canary must specify:

- dedicated account or explicit capital partition;
- one product and a narrowly admitted universe;
- absolute contract and dollar caps below general portfolio limits;
- one order type, DAY-only duration, deterministic limit-price boundary;
- RTH only with fresh custody, market, mandate, and evidence checks at submission;
- no replace-to-worse, no market order, no uncovered option, no margin debit;
- idempotent outbox and broker-order correlation;
- independent kill switch and one-click human pause;
- automatic demotion on any integrity, calibration, governance, or reconciliation failure;
- human-only resumption.

The execution component should be a separate minimal authority boundary rather than adding broad Schwab mutation credentials to the dashboard Worker.

**Exit gate:** Principal explicitly activates Authority 3 for the canary scope and records the governing hashes, capital ceiling, start/end dates, and rollback procedure.

## Later authority

Authority 4 and 5 are separate programs, not automatic continuations:

- **Lifecycle autonomy:** tested expiration, assignment, exercise, close, and risk-reducing adjustment behavior through adverse conditions.
- **Portfolio autonomy:** survived drawdown, reliable cross-position risk, complete factor/Greek enforcement, and evidence across multiple regimes.

Profit alone cannot promote either tier. A profitable unauthorized action is a system failure.

## Near-term observation plan

### Friday expiry

- Record the pre-expiry custody packet, marks, strike distance, basis relationship, and governing rule.
- Confirm whether Schwab reports expiry, assignment, or cash settlement in a form the FIFO matcher closes.
- Confirm Aug. 28 calendar cells, trade counts, and totals reconcile to the lifetime ledger.
- Record SPCX and CBRS outcomes without changing the rule afterward.

### First live scan

- Confirm every rejection carries `NO DATA`, `NO EDGE`, or `NO CAPITAL` with the correct governing tier.
- Confirm the full pre-filter field, excluded rows, market timestamps, mandate hash, model hash, and selected/null result are sealed.
- Do not treat a successful render or a plausible candidate as validation; replay from raw inputs.

## Amendment and promotion rules

- The agent cannot amend governance, promote authority, clear self-suspension, or expand its account/product scope.
- Demotion and suspension are immediate and automatic.
- Promotion is one tier at a time, requires live evidence, and requires explicit Principal approval even when numerical gates pass.
- Failed or insufficient data is authorized refusal and does not create pressure to trade.
- Every promotion decision records both the supporting evidence and the observations excluded from it.
- Any material model change resets or partitions the affected calibration record; it cannot inherit incompatible observations silently.

## Next planning session

### Dedicated-account onboarding questions

Before choosing the universe or concentration limits:

1. Determine the initial cash funding amount and permitted future funding process.
2. After the account exists, verify whether the current Schwab authorization returns it from the account-number endpoint; do not assume token scope from account ownership alone.
3. Decide whether Guardian observes both accounts for visibility while only the dedicated account feeds autonomous compliance and authority.
4. Add permanent account-scope labels to Overview, Performance, System, evidence, and alerts.
5. Capture a cash-only baseline and confirm that no manual order or position can enter the governed account outside the agent proposal/execution path.

Resolve the remaining Phase 1 Principal decisions in this order:

1. initial funding amount;
2. automated products and manual-trading boundary;
3. rule-based universe and one-lot affordability gate;
4. DTE policy;
5. portfolio and per-contract limits;
6. drawdown ladder and resumption authority;
7. Authority 3 ladder amendment for risk-reducing lifecycle actions.

Only after those decisions should the draft governance artifacts be created. Until activation, the existing production constitution remains authoritative and the deployed system remains proposal-only.
