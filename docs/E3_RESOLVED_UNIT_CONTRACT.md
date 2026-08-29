# E3 — Resolved Unit Contract

**Status:** CONTRACT CANDIDATE — RULES ONLY — NOT DEPLOYED  
**Class:** PREREQUISITE  
**Authority:** 2 / PROPOSE ONLY  
**Production effect:** None  
**Live dashboard:** Worker 126 remains unchanged

## 1. Purpose

A resolved-unit file is the immutable evidence needed for a person who did not build the system to
replay one trade from its sealed decision through its economic result and reproduce every state,
quantity, cash movement, share movement, fee, and P&L number.

The required order is:

**decision → proposal → order → fill(s) → position → expiry or assignment → cash → shares → P&L**

Forecast evidence is optional. It may appear only when the forecast was sealed before the outcome.
A trade without a prospective forecast can be economically complete and must not be converted into
a calibration observation after the fact.

This contract defines records and replay rules. It does not authorize an order, send an order,
change Authority 2, alter a Worker, or deploy code.

## 2. Governing invariants

1. **Seal before mutation.** The decision and proposal must be sealed before any broker-facing
   action. A later reconstruction is evidence about history, not the original proposal.
2. **Append events; fold state.** Broker and economic events are immutable. Current order,
   position, cash, shares, and P&L are deterministic folds of those events.
3. **Broker records are not the economic ledger.** Broker acknowledgements and fills are source
   evidence. Cash, shares, fees, and P&L are separately derived, linked economic records.
4. **Every interpretation is versioned.** The bundle names the engine, schema, adapter, contract,
   fee, settlement, and P&L formula versions used to interpret the evidence.
5. **No unnamed conversion.** Dollars, shares, contracts, multipliers, probabilities, timestamps,
   and rates remain named quantities. No generic `score` or inferred unit may enter replay.
6. **No silent omission.** A missing required fact produces a typed unresolved or fault state. It
   must not produce a plausible zero, empty list, clearance, or economic refusal.
7. **No double counting.** Each fill, fee, cash movement, and share movement is applied exactly
   once by a stable identifier.
8. **The bundle is self-identifying.** A manifest names every included file, its SHA-256, the
   governing versions, and the root record. A hash without its interpretation version is
   insufficient.

## 3. Bundle manifest

Every resolved-unit bundle must begin with one manifest containing:

- `resolvedUnitId`
- `economicEpisodeId`
- `rootDecisionId`
- `bundleSchemaVersion`
- `engineVersion` and executable artifact SHA-256
- every relevant `adapterVersion`
- `positionContractVersion`, `feeFormulaVersion`, `settlementFormulaVersion`, and
  `pnlFormulaVersion`
- ordered file list with byte length and SHA-256 for every file
- creation timestamp and canonical serialization version
- the final unit status and, when assignment leaves shares, the episode status

The manifest must distinguish the option unit from the wider wheel episode. An option can reach a
terminal assignment while the episode continues through the resulting share inventory and a later
covered call.

## 4. Canonical identity chain

The bundle must resolve this chain without guessing:

1. `decisionId`
2. `proposalHash`
3. `positionContractHash`
4. `clientOrderId` and, when accepted by the broker, `brokerOrderId`
5. `fillIds[]`
6. `positionId`
7. `lifecycleId`
8. `terminalEventId`
9. `cashEntryIds[]`
10. `shareLotIds[]` and `shareMovementIds[]`
11. `pnlRecordId`
12. optional `forecastHash → calibrationObservationId`

Every child record names its parent identifiers and the hash of the contract used to interpret it.
The chain is invalid if a record can be attached only by ticker, date, amount, or narrative text.

## 5. Required records in replay order

### 5.1 Decision

The decision record must contain:

- `decisionId`, `economicEpisodeId`, strategy, symbol, account, and authority level
- requested structure and side
- the exact market, custody, capital, risk, and policy inputs used
- `requestedAt`, `acquiredAt`, and `vendorAsOf` for cited facts; `vendorAsOf` may be explicitly
  absent when the vendor supplied none and must never be fabricated
- raw evidence hashes and the versions of the adapters that produced the facts
- typed gate results and reasons
- decision timestamp, decision payload hash, and seal timestamp

A decision must remain distinguishable from `NO_DATA` and `SYSTEM_FAULT`. A system fault cannot be
folded into an economic refusal.

### 5.2 Proposal

The proposal record must contain:

- `proposalHash` and parent `decisionId`
- immutable option contract identity: underlying, OCC symbol when available, right, strike,
  expiration, multiplier, quantity, opening side, and account
- limit price or governed pricing instruction and its unit
- expected credit or debit as an estimate, never as booked cash
- maximum defined obligation and the named capital quantity used by each gate
- cited decision inputs and raw hashes
- proposal schema, pricing, and policy versions
- proposal seal timestamp and signer identity

The `positionContractHash` must be computed from the immutable contract and account fields, not
from display text. Proposal credit is not economic value and is not realized P&L.

At Authority 2, sealing a proposal does not authorize sending it. Any later order must carry a
separate authorization record permitted by the constitution then in force.

### 5.3 Order

The order record must contain:

- `clientOrderId`, parent `proposalHash`, and `positionContractHash`
- authorization record hash, submitting actor, and submission timestamp
- exact broker request bytes or canonical request hash
- order type, duration, quantity, limit, legs, and broker account
- broker acknowledgement events, status events, rejection or cancellation events
- `brokerOrderId` when supplied; absence before acknowledgement is valid and must remain explicit
- adapter and broker-protocol versions

Broker events may arrive out of order, including a fill before an acknowledgement. Ingestion order
must be preserved, correlation must use stable identifiers, and the fold must not assume that an
acknowledgement always precedes a fill.

### 5.4 Fill(s)

`fillIds` is always an array. One order may produce more than one fill.

Each fill must contain:

- stable `fillId`, `clientOrderId`, and `brokerOrderId` when known
- broker execution identifier or a canonical deduplication hash
- executed contract quantity, price per unit, multiplier, and side
- broker event time, acquisition time, and append sequence
- fee and regulatory-charge identifiers, amounts, currencies, and formula version
- raw broker evidence hash and adapter version

Partial fills are first-class events. The position quantity, premium cash, fees, and remaining order
quantity must update after every fill. Replay must reject duplicate application of the same fill and
must not collapse several fills into one unkeyed average. An average fill price may be derived for
display only from the preserved fills.

### 5.5 Position

The option position is a fold of accepted fills, exercises, assignments, expiries, closing fills,
and corrections. It must contain:

- `positionId`, `positionContractHash`, and contributing `fillIds[]`
- opened, closed, assigned, expired, and remaining contract quantities
- exact weighted cost or credit derivation from the fills
- opening and closing premium cash-entry references
- allocated fee-entry references
- lifecycle status and the event sequence used to compute it

The position cannot be created from a proposal, order, broker mark, or candidate row. Only economic
events create or change position quantity.

### 5.6 Terminal event: expiry or assignment

Every option position must terminate through an explicit branch. Terminal records contain
`terminalEventId`, `lifecycleId`, affected quantity, effective date and time, source evidence,
acquisition time, settlement version, and all resulting economic-entry identifiers.

#### Expiry

Expiry reduces the expired option quantity to zero. It creates no assignment shares and no strike
cash movement. Premium and fees already booked from fills remain in the economic ledger. Any broker
expiry charge is a separately identified fee entry.

#### Cash-secured put assignment

Put assignment is an economic exchange, not a status label. For each assigned contract quantity:

- `sharesReceived = assignedContracts × contractMultiplier`
- strike cash debit equals `sharesReceived × strikePrice`
- assignment fees are separate negative cash entries
- one or more durable share lots are created for exactly `sharesReceived`
- the share lots cite the put position, assignment event, cash debit, and source fill lineage
- the cash ledger and share ledger must balance to the same assigned quantity

The assignment cannot complete if either the cash debit or the created shares are missing. Premium
received from the put remains a separate cash event; it must not be hidden by rewriting the strike
cash debit.

#### Covered-call assignment

Call assignment is also an economic exchange. For each assigned call contract quantity:

- `sharesDelivered = assignedContracts × contractMultiplier`
- strike cash credit equals `sharesDelivered × strikePrice`
- assignment fees are separate negative cash entries
- the share ledger consumes the exact pre-existing deliverable share lots
- the consumed lots and their acquisition costs flow into realized share P&L

An uncovered short call cannot be represented as a covered call. If deliverable shares are less
than the call obligation, replay must fault rather than invent shares or omit concentration capital.

## 6. Cash ledger

The economic cash ledger is append-only and contains signed, currency-specific entries. At minimum
it records:

- option premium receipts and closing debits from fills
- per-fill commissions and regulatory charges
- put-assignment strike debits
- call-assignment strike credits
- assignment or exercise fees
- dividends or other cash events only when explicitly linked to the episode
- corrections as new reversing and replacement entries, never overwritten history

Each entry names its source event, account, currency, amount, sign convention, formula version, and
idempotency key. Broker-reported cash is reconciliation evidence; it does not replace the economic
ledger.

`settledCash`, `withdrawableCash`, and `NAV minus marks` are distinct quantities. No replay step may
silently convert one into another.

## 7. Share inventory ledger

Share inventory is separate from cash inventory and option position quantity. Every lot contains:

- durable `shareLotId`, symbol, account, quantity, acquisition event, acquisition time, and cost
- parent assignment or share-purchase event
- linked cash debit and fee allocation
- remaining deliverable quantity
- every later reservation, release, delivery, sale, transfer, or correction

A covered call must reserve and reference existing deliverable `shareLotIds`. It does not create a
second pile of shares. Reserved quantity cannot be reserved again. When the call expires, the
reservation releases back to the same lots. When the call is assigned, delivery consumes those same
lots.

The wheel therefore forms a directed acyclic graph:

- a cash-secured-put unit may create share lots;
- a later covered-call unit references those lots;
- call expiry returns the lots to available inventory;
- call assignment consumes the lots and creates cash.

The graph is linked by identifiers, never inferred from matching symbol and quantity.

## 8. P&L record

P&L is computed only after the cash and share folds. The record must expose its components rather
than only a scalar total:

- opening and closing option premium
- option realized P&L
- share acquisition cash
- share sale or assignment proceeds
- realized share P&L from consumed lots
- fees by source
- dividends or other linked cash events
- remaining share inventory cost
- unrealized share P&L only from a cited, timestamped mark
- total realized P&L and, when applicable, total marked P&L

For a fully closed episode with no remaining option obligation or shares, the realized total is:

`option cash + share-disposal cash + linked dividends − share-acquisition cash − fees`

Every term is the sum of named ledger entries. If assigned shares remain, the option unit may be
`RESOLVED_ASSIGNMENT_TO_INVENTORY`, but the wider episode must remain `OPEN_SHARES`. It must not be
reported as fully realized or economically closed.

Opportunity cost may appear only if a named, versioned formula and all of its inputs are included.
It cannot be silently added to realized P&L.

## 9. Optional prospective forecast and calibration

Forecast fields are absent by default. Their absence does not invalidate an economic unit.

A calibration observation is permitted only when all of the following exist:

- a `forecastHash` sealed before the outcome window began
- forecast target, horizon, unit, probability meaning, model version, and input hashes
- immutable seal timestamp and evidence that the seal preceded the outcome
- outcome definition, outcome source, outcome timestamp, and raw hash
- scoring-rule version and reproducible score components

A forecast reconstructed, copied, inferred, or selected after the outcome is illegal for
calibration. It may be retained as retrospective analysis only with `calibrationEligible:false`.

Risk-neutral `pRnItmPut = N(-d2)` is not automatically a physical forecast. If it is ever scored,
the observation must name the risk-neutral quantity and the governed interpretation being tested;
it must not be mislabeled as an empirical event probability.

## 10. Friday tape boundary

The Friday capture is matcher evidence only. Its classification is:

- `evidencePurpose: MATCHER_VALIDATION`
- `promotionEligible: false`
- `observationUnit: null`
- `reason: NO_PROSPECTIVELY_DESIGNATED_FORECAST`

Friday tape may test matching, parsing, event correlation, or later replay fixtures. It is not
learning evidence, calibration evidence, promotion evidence, or `RESOLVED UNIT #000001`. It must
not be restamped to appear prospective.

## 11. Deterministic replay acceptance test

A bundle passes only when an independent replayer can:

1. verify the manifest and every file hash;
2. verify the decision and proposal seals precede broker mutation;
3. rebuild the order event stream, including out-of-order events;
4. apply every unique partial fill and fee exactly once;
5. reproduce option position quantity after each event;
6. reproduce the expiry or assignment branch;
7. reproduce every cash entry and balance;
8. reproduce every share lot, reservation, release, and consumption;
9. reproduce every P&L component and total using the named formula version;
10. reproduce forecast scoring only when the prospective seal is valid;
11. obtain the same identifiers, states, quantities, and numbers as the sealed result.

Any missing parent, hash, version, quantity, cash leg, share leg, fee, or required timestamp fails
the replay. A plausible dashboard value is not a substitute.

## 12. Current production boundary

Worker 126 remains the live dashboard and is untouched by this contract. This file is a rules
artifact, not a Worker build, deployment packet, broker authorization, calibration record, or claim
that the engine is complete.

No implementation may claim E3 complete until production emits a bundle satisfying this contract
and an independent person reproduces it. The first success remains one replayable resolved unit,
not a dashboard state, readiness fraction, test count, candidate count, or weekend deployment.
