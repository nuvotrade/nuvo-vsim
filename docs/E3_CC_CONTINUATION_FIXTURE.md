# E3 — Covered-Call Continuation Fixture

**Status:** SYNTHETIC CONTINUATION FIXTURE — RULES ONLY — NOT PRODUCTION  
**Class:** PREREQUISITE  
**Governing contract SHA-256:** `c6aaef205bb20980e4075f5b3ef7f4d5a6699bc2f78081f867699dfdb031edf3`  
**Parent fixture SHA-256:** `16589e4c45523b97ec6eebe1f6c6eb43608ea326aeb7334b832fbfe40145b003`  
**Parent episode:** `EP-FIXTURE-E3-000001`  
**Authority:** 2 / PROPOSE ONLY  
**Production effect:** None

## 1. Purpose

This synthetic fixture continues the exact episode created by the first E3 fixture. The parent put
assignment created these two durable share lots:

- `LOT-FIXTURE-SPY-000001` — 100 SPY shares, total cost `USD 5002.50`;
- `LOT-FIXTURE-SPY-000002` — 100 SPY shares, total cost `USD 5002.50`.

The continuation sells two covered calls against those 200 shares, receives one fill, reserves the
two existing lots, allows both calls to expire worthless, and releases the same lots. It creates no
shares, sells no shares, and leaves the episode `OPEN_SHARES`.

A separate three-call attempt is included and must produce a typed `FAULT`: three calls require 300
deliverable shares, while the episode owns only 200.

All values and evidence are invented. Identifiers and arithmetic are complete and deterministic.

## 2. Continuation identity

| Field | Synthetic value |
|---|---|
| `resolvedUnitId` | `RU-FIXTURE-E3-CC-000002` |
| `economicEpisodeId` | `EP-FIXTURE-E3-000001` |
| parent resolved unit | `RU-FIXTURE-E3-000001` |
| `decisionId` | `DEC-FIXTURE-E3-CC-000002` |
| `proposalId` | `PROP-FIXTURE-E3-CC-000002` |
| `proposalHash` | `cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc` |
| `positionContractId` | `PC-FIXTURE-SPY-20261016-C55` |
| `positionContractHash` | `dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd` |
| `clientOrderId` | `COID-FIXTURE-E3-CC-000002` |
| `brokerOrderId` | `BOID-FIXTURE-E3-CC-900002` |
| `fillId` | `FILL-FIXTURE-E3-CC-000001` |
| `positionId` | `POS-FIXTURE-E3-CC-000002` |
| `lifecycleId` | `LC-FIXTURE-E3-CC-000002` |
| expiry event | `TERM-FIXTURE-E3-CC-EXPIRE-000002` |
| P&L record | `PNL-FIXTURE-E3-CC-000002` |
| option-unit status | `RESOLVED_EXPIRED` |
| economic-episode status | `OPEN_SHARES` |

## 3. Coverage decision and third-call fault

At `2026-09-21T14:29:50.000Z`, both parent lots are `AVAILABLE` and unreserved.

| Quantity | Required shares | Deliverable shares | Result |
|---:|---:|---:|---|
| 2 covered calls | 200 | 200 | `PASS` |
| 3 covered calls | 300 | 200 | `FAULT` |

The accepted decision is:

- `decisionId: DEC-FIXTURE-E3-CC-000002`;
- strategy `COVERED_CALL`;
- quantity `2 contracts`;
- `maxCoveredContracts = floor(200 / 100) = 2`;
- reserved source lots `LOT-FIXTURE-SPY-000001` and `LOT-FIXTURE-SPY-000002`;
- sealed at `2026-09-21T14:29:56.000Z`.

The rejected third-call attempt is a separate record:

| Field | Value |
|---|---|
| `proposalAttemptId` | `PROP-ATTEMPT-FIXTURE-E3-CC-000003` |
| `faultId` | `FAULT-FIXTURE-E3-CC-000001` |
| outcome | `FAULT` |
| fault class | `CONTRACT_FAULT` |
| fault stage | `SHARE_RESERVATION` |
| fault code | `COVERED_CALL_INSUFFICIENT_DELIVERABLE_SHARES` |
| requested contracts | `3` |
| required shares | `300` |
| deliverable shares | `200` |
| shortfall | `100` |
| proposal created | `false` |
| order created | `false` |
| reservation created | `false` |

The third call is not mislabeled as covered, does not invent a third lot, and never reaches an order.

## 4. Sealed two-call proposal

| Field | Value |
|---|---|
| `proposalId` | `PROP-FIXTURE-E3-CC-000002` |
| `proposalHash` | `cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc` |
| parent decision | `DEC-FIXTURE-E3-CC-000002` |
| OCC contract | `SPY261016C00055000` |
| right | `CALL` |
| strike | `USD 55.00 per share` |
| expiration | `2026-10-16` |
| multiplier | `100 shares per contract` |
| opening side | `SELL_TO_OPEN` |
| quantity | `2 contracts` |
| limit | `USD 0.75 per share` |
| required shares | `200` |
| cited share lots | `LOT-FIXTURE-SPY-000001`, `LOT-FIXTURE-SPY-000002` |
| sealed at | `2026-09-21T14:29:58.000Z` |

The proposal references the two parent lots. It creates no share inventory.

## 5. Reservation, order, and fill

Before submission, the share ledger appends:

| Movement ID | Lot | Action | Quantity | Effective at |
|---|---|---|---:|---|
| `SHARE-RESERVE-FIXTURE-CC-000001` | `LOT-FIXTURE-SPY-000001` | `RESERVE_COVERED_CALL` | 100 | `2026-09-21T14:29:59.000Z` |
| `SHARE-RESERVE-FIXTURE-CC-000002` | `LOT-FIXTURE-SPY-000002` | `RESERVE_COVERED_CALL` | 100 | `2026-09-21T14:29:59.000Z` |

The order is `COID-FIXTURE-E3-CC-000002`, accepted by the broker as
`BOID-FIXTURE-E3-CC-900002`. It submits two contracts at a `USD 0.75` limit.

One fill completes the order:

| Field | Value |
|---|---|
| `fillId` | `FILL-FIXTURE-E3-CC-000001` |
| broker execution ID | `EXEC-FIXTURE-E3-CC-700001` |
| quantity | `2 contracts` |
| execution price | `USD 0.80 per share` |
| multiplier | `100` |
| gross call premium | `USD +160.00` |
| opening fee | `USD -1.30` |
| broker occurred at | `2026-09-21T14:30:05.000Z` |
| acquired at | `2026-09-21T14:30:06.000Z` |

Filled quantity is two contracts, remaining order quantity is zero, and the two lots remain
reserved while the call position is open.

## 6. Cash ledger

The continuation adds exactly two cash entries:

| Cash entry ID | Named line | Amount |
|---|---|---:|
| `CASH-FIXTURE-CC-PREMIUM-000001` | `COVERED_CALL_PREMIUM_RECEIPT` | `USD +160.00` |
| `CASH-FIXTURE-CC-FILL-FEE-000001` | `COVERED_CALL_OPENING_FILL_FEE` | `USD -1.30` |

Continuation net cash is:

`USD 160.00 − 1.30 = USD +158.70`.

The parent unit's net cash movement was `USD -9656.95`, so cumulative episode cash movement becomes:

`USD -9656.95 + 158.70 = USD -9498.25`.

There is no share-sale cash entry, strike credit, assignment cash, or closing-option debit.

## 7. Worthless expiry and release

Both covered calls expire worthless through terminal event
`TERM-FIXTURE-E3-CC-EXPIRE-000002` at `2026-10-16T20:00:00.000Z`.

Expiry results:

- expired contracts: `2`;
- remaining call contracts: `0`;
- share-sale proceeds: `USD 0.00`;
- shares delivered: `0`;
- shares created: `0`;
- expiry fees: explicit empty list;
- option-unit status: `RESOLVED_EXPIRED`.

The share ledger then appends:

| Movement ID | Lot | Action | Quantity | Effective at |
|---|---|---|---:|---|
| `SHARE-RELEASE-FIXTURE-CC-000001` | `LOT-FIXTURE-SPY-000001` | `RELEASE_COVERED_CALL` | 100 | `2026-10-16T20:02:00.000Z` |
| `SHARE-RELEASE-FIXTURE-CC-000002` | `LOT-FIXTURE-SPY-000002` | `RELEASE_COVERED_CALL` | 100 | `2026-10-16T20:02:00.000Z` |

After release:

- the same two lots still exist;
- each lot contains 100 shares;
- available shares are 200;
- reserved shares are zero;
- new share lots are zero;
- consumed or sold shares are zero;
- episode status remains `OPEN_SHARES`.

## 8. Named P&L lines

The covered-call unit records:

| P&L line | Amount |
|---|---:|
| `COVERED_CALL_PREMIUM_GROSS` | `USD +160.00` |
| `COVERED_CALL_OPENING_FILL_FEES` | `USD -1.30` |
| `COVERED_CALL_OPTION_REALIZED_PNL` | `USD +158.70` |
| `SHARE_SALE_PROCEEDS` | `USD 0.00` |
| `SHARES_DELIVERED` | `0` |
| `REMAINING_SHARE_INVENTORY_COST` | `USD 10005.00` |

At the synthetic expiry mark of `USD 52.00` per share:

- share mark value is `200 × USD 52.00 = USD 10400.00`;
- unrealized share P&L is `USD 10400.00 − 10005.00 = USD +395.00`;
- cumulative option realized P&L is `USD 348.05 + 158.70 = USD +506.75`;
- cumulative marked episode P&L is `USD 506.75 + 395.00 = USD +901.75`.

The call option unit is resolved, but the episode is not economically closed because both share lots
remain.

## 9. Replay acceptance

An independent replay must reproduce:

1. parent episode `EP-FIXTURE-E3-000001` and the two original lot IDs;
2. maximum covered-call quantity of two contracts;
3. a typed insufficient-shares fault for the third-call attempt;
4. reservation of exactly 100 shares from each existing lot;
5. one fill for two calls at `USD 0.80`;
6. gross premium `USD 160.00`, fees `USD 1.30`, and continuation net cash `USD +158.70`;
7. expiry of both calls with no share sale and no shares delivered;
8. release of the same two lots;
9. no new share lots and 200 remaining shares;
10. cumulative episode cash `USD -9498.25`;
11. covered-call realized P&L `USD +158.70` and cumulative option realized P&L `USD +506.75`;
12. option-unit status `RESOLVED_EXPIRED`;
13. economic-episode status `OPEN_SHARES`.

## 10. Production boundary

This fixture does not alter the frozen E3 files, either JSON bundle, Worker 126, broker authority, or
production. It is a rules-and-replay artifact only.
