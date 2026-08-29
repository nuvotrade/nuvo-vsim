# E3 — First Resolved Unit Fixture

**Status:** SYNTHETIC CONTRACT FIXTURE — RULES ONLY — NOT PRODUCTION  
**Class:** PREREQUISITE  
**Governing contract:** `docs/E3_RESOLVED_UNIT_CONTRACT.md`  
**Governing contract SHA-256:** `c6aaef205bb20980e4075f5b3ef7f4d5a6699bc2f78081f867699dfdb031edf3`  
**Authority:** 2 / PROPOSE ONLY  
**Production effect:** None  
**Forecast:** None

## 1. Fixture purpose

This is one deliberately awkward, entirely invented cash-secured-put trade. It proves the shape and
arithmetic required by the E3 contract. It is not broker evidence, calibration evidence, a Worker
build, a deployment packet, or `RESOLVED UNIT #000001`.

The fixture contains:

- one sealed decision and proposal for three short put contracts;
- one broker order filled through two partial fills;
- the later-executed fill arriving before the earlier-executed fill;
- an order acknowledgement arriving after the first acquired fill;
- assignment of two contracts;
- a strike cash debit and two durable 100-share lots;
- expiry of the remaining one contract;
- named cash, inventory, realized-P&L, and marked-P&L lines;
- no forecast and no calibration observation.

All market values, times, people, accounts, broker messages, and raw hashes are synthetic. Every
identifier is stable and explicit within the fixture.

## 2. Bundle identity

| Field | Synthetic value |
|---|---|
| `resolvedUnitId` | `RU-FIXTURE-E3-000001` |
| `economicEpisodeId` | `EP-FIXTURE-E3-000001` |
| `rootDecisionId` | `DEC-FIXTURE-E3-000001` |
| `bundleSchemaVersion` | `E3_RESOLVED_UNIT_BUNDLE_V1` |
| `engineVersion` | `FIXTURE_ENGINE_0.0.0` |
| executable artifact SHA-256 | `00000000000000000000000000000000000000000000000000000000000000e3` |
| `positionContractVersion` | `OPTION_POSITION_CONTRACT_V1` |
| `feeFormulaVersion` | `FIXTURE_FEE_FORMULA_V1` |
| `settlementFormulaVersion` | `OCC_EQUITY_OPTION_100_SHARE_FIXTURE_V1` |
| `pnlFormulaVersion` | `E3_COMPONENT_PNL_V1` |
| `canonicalSerializationVersion` | `CANONICAL_JSON_SORTED_KEYS_V1` |
| option-unit status | `RESOLVED_ASSIGNMENT_TO_INVENTORY` |
| economic-episode status | `OPEN_SHARES` |

The synthetic executable hash is an identifier inside the example. It is not the SHA-256 of this
Markdown file.

## 3. Complete identity chain

| Link | Identifier |
|---|---|
| decision | `DEC-FIXTURE-E3-000001` |
| proposal | `PROP-FIXTURE-E3-000001` |
| proposal hash | `1111111111111111111111111111111111111111111111111111111111111111` |
| position contract | `PC-FIXTURE-SPY-20260918-P50` |
| position contract hash | `2222222222222222222222222222222222222222222222222222222222222222` |
| authorization record | `AUTH-FIXTURE-HUMAN-000001` |
| client order | `COID-FIXTURE-E3-000001` |
| broker order | `BOID-FIXTURE-E3-900001` |
| fill 1 | `FILL-FIXTURE-E3-000001` |
| fill 2 | `FILL-FIXTURE-E3-000002` |
| position | `POS-FIXTURE-E3-000001` |
| lifecycle | `LC-FIXTURE-E3-000001` |
| assignment event | `TERM-FIXTURE-E3-ASSIGN-000001` |
| expiry event | `TERM-FIXTURE-E3-EXPIRE-000001` |
| terminal summary | `TERM-FIXTURE-E3-FINAL-000001` |
| P&L record | `PNL-FIXTURE-E3-000001` |

## 4. Decision

| Field | Value |
|---|---|
| `decisionId` | `DEC-FIXTURE-E3-000001` |
| `economicEpisodeId` | `EP-FIXTURE-E3-000001` |
| account | `ACCT-FIXTURE-CASH-0001` |
| strategy | `CASH_SECURED_PUT` |
| symbol | `SPY` |
| structure | short three `SPY 2026-09-18 50 PUT` contracts |
| authority | `2 / PROPOSE ONLY` |
| decision | `PROPOSE` |
| decision time | `2026-09-01T14:29:55.000Z` |
| sealed at | `2026-09-01T14:29:56.000Z` |
| decision payload hash | `3333333333333333333333333333333333333333333333333333333333333333` |
| capital input | `VERIFIED_SETTLED_UNBORROWED_CASH = USD 20000.00` |
| maximum strike obligation | `USD 15000.00` |
| capital gate | `PASS` |
| requested-at clock | `2026-09-01T14:29:50.000Z` |
| acquired-at clock | `2026-09-01T14:29:52.000Z` |
| vendor-as-of clock | `2026-09-01T14:29:49.500Z` |
| cited raw evidence hash | `4444444444444444444444444444444444444444444444444444444444444444` |
| market adapter version | `FIXTURE_MARKET_ADAPTER_V1` |
| capital adapter version | `FIXTURE_CAPITAL_ADAPTER_V1` |

The decision seal precedes every order and broker timestamp below.

## 5. Proposal

| Field | Value |
|---|---|
| `proposalId` | `PROP-FIXTURE-E3-000001` |
| `proposalHash` | `1111111111111111111111111111111111111111111111111111111111111111` |
| parent `decisionId` | `DEC-FIXTURE-E3-000001` |
| `positionContractId` | `PC-FIXTURE-SPY-20260918-P50` |
| `positionContractHash` | `2222222222222222222222222222222222222222222222222222222222222222` |
| OCC contract | `SPY260918P00050000` |
| right | `PUT` |
| strike | `USD 50.00 per share` |
| expiration | `2026-09-18` |
| multiplier | `100 shares per contract` |
| opening side | `SELL_TO_OPEN` |
| quantity | `3 contracts` |
| limit | `USD 1.10 per share` |
| estimated minimum gross credit | `USD 330.00` |
| maximum strike obligation | `USD 15000.00` |
| proposal schema | `FIXTURE_PROPOSAL_V1` |
| pricing version | `FIXTURE_LIMIT_PRICE_V1` |
| policy version | `FIXTURE_CSP_POLICY_V1` |
| sealed at | `2026-09-01T14:29:58.000Z` |
| signer | `ACTOR-FIXTURE-PRINCIPAL-0001` |

The estimated proposal credit is never booked as cash. Only fills create premium entries.

## 6. Order and out-of-order broker events

| Field | Value |
|---|---|
| authorization record | `AUTH-FIXTURE-HUMAN-000001` |
| authorization type | `HUMAN_SUBMIT_FIXTURE_ONLY` |
| `clientOrderId` | `COID-FIXTURE-E3-000001` |
| `brokerOrderId` | `BOID-FIXTURE-E3-900001` |
| parent proposal hash | `1111111111111111111111111111111111111111111111111111111111111111` |
| order request hash | `5555555555555555555555555555555555555555555555555555555555555555` |
| order type | `LIMIT` |
| duration | `DAY` |
| submitted quantity | `3 contracts` |
| submitted limit | `USD 1.10 per share` |
| submitted at | `2026-09-01T14:30:00.000Z` |
| broker adapter | `FIXTURE_BROKER_ADAPTER_V1` |

The append log preserves acquisition order:

| Append sequence | Event ID | Event | Broker occurred at | Acquired at | Quantity |
|---:|---|---|---|---|---:|
| 1 | `BEVT-FIXTURE-FILL-000002` | fill `FILL-FIXTURE-E3-000002` | `14:30:07Z` | `14:30:08Z` | 2 |
| 2 | `BEVT-FIXTURE-ACK-000001` | acknowledgement for `BOID-FIXTURE-E3-900001` | `14:30:04Z` | `14:30:09Z` | 3 |
| 3 | `BEVT-FIXTURE-FILL-000001` | fill `FILL-FIXTURE-E3-000001` | `14:30:05Z` | `14:30:10Z` | 1 |

The later-executed two-contract fill arrived first. The earlier-executed one-contract fill arrived
last. The acknowledgement also arrived after the first acquired fill. Replay preserves that append
order, correlates all three events by stable identifiers, and applies each fill once.

## 7. Partial fills

### Fill `FILL-FIXTURE-E3-000002` — acquired first, executed second

| Field | Value |
|---|---|
| `fillId` | `FILL-FIXTURE-E3-000002` |
| broker execution ID | `EXEC-FIXTURE-E3-700002` |
| canonical deduplication hash | `6666666666666666666666666666666666666666666666666666666666666662` |
| quantity | `2 contracts` |
| execution price | `USD 1.15 per share` |
| multiplier | `100` |
| gross premium | `USD +230.00` |
| fee | `USD -1.30` |
| premium cash entry | `CASH-FIXTURE-PREMIUM-000002` |
| fee cash entry | `CASH-FIXTURE-FILL-FEE-000002` |
| broker occurred at | `2026-09-01T14:30:07.000Z` |
| acquired at | `2026-09-01T14:30:08.000Z` |
| raw broker evidence hash | `7777777777777777777777777777777777777777777777777777777777777772` |

### Fill `FILL-FIXTURE-E3-000001` — acquired second, executed first

| Field | Value |
|---|---|
| `fillId` | `FILL-FIXTURE-E3-000001` |
| broker execution ID | `EXEC-FIXTURE-E3-700001` |
| canonical deduplication hash | `6666666666666666666666666666666666666666666666666666666666666661` |
| quantity | `1 contract` |
| execution price | `USD 1.20 per share` |
| multiplier | `100` |
| gross premium | `USD +120.00` |
| fee | `USD -0.65` |
| premium cash entry | `CASH-FIXTURE-PREMIUM-000001` |
| fee cash entry | `CASH-FIXTURE-FILL-FEE-000001` |
| broker occurred at | `2026-09-01T14:30:05.000Z` |
| acquired at | `2026-09-01T14:30:10.000Z` |
| raw broker evidence hash | `7777777777777777777777777777777777777777777777777777777777777771` |

Fill reconciliation:

- `fillIds[] = [FILL-FIXTURE-E3-000002, FILL-FIXTURE-E3-000001]` in acquisition order.
- Canonical economic allocation order is broker execution time, then `fillId`:
  `FILL-FIXTURE-E3-000001`, then `FILL-FIXTURE-E3-000002`.
- Filled quantity is `2 + 1 = 3 contracts`.
- Remaining order quantity is `3 − 3 = 0 contracts`.
- Gross premium is `USD 230.00 + USD 120.00 = USD 350.00`.
- Opening fill fees are `USD 1.30 + USD 0.65 = USD 1.95`.

## 8. Position fold

| Field | Value |
|---|---|
| `positionId` | `POS-FIXTURE-E3-000001` |
| `positionContractHash` | `2222222222222222222222222222222222222222222222222222222222222222` |
| contributing fills | `FILL-FIXTURE-E3-000001`, `FILL-FIXTURE-E3-000002` |
| opened quantity | `3 short contracts` |
| assigned quantity | `2 contracts` |
| expired quantity | `1 contract` |
| remaining option quantity | `0 contracts` |
| gross weighted fill price | `USD 1.1666666667 per share` |
| gross premium | `USD 350.00` |
| opening fees | `USD 1.95` |
| lifecycle status | `TERMINAL` |

No quantity comes from the proposal or acknowledgement. The three-contract position exists only
because the two unique fills sum to three.

## 9. Partial assignment

Assignment source evidence:

| Field | Value |
|---|---|
| `lifecycleId` | `LC-FIXTURE-E3-000001` |
| `terminalEventId` | `TERM-FIXTURE-E3-ASSIGN-000001` |
| source event ID | `BROKER-FIXTURE-ASSIGN-800001` |
| source evidence hash | `8888888888888888888888888888888888888888888888888888888888888888` |
| assigned contracts | `2` |
| contract multiplier | `100 shares` |
| shares received | `200` |
| strike | `USD 50.00 per share` |
| strike cash debit | `USD -10000.00` |
| assignment fee | `USD -5.00` |
| effective at | `2026-09-18T01:30:00.000Z` |
| acquired at | `2026-09-18T01:31:10.000Z` |
| settlement version | `OCC_EQUITY_OPTION_100_SHARE_FIXTURE_V1` |

The deterministic FIFO allocation consumes one contract from
`FILL-FIXTURE-E3-000001` and one contract from `FILL-FIXTURE-E3-000002`. One contract from
`FILL-FIXTURE-E3-000002` remains open for expiry.

Assignment arithmetic:

- `2 assigned contracts × 100 shares = 200 shares received`.
- `200 shares × USD 50.00 = USD 10000.00 strike cash debit`.
- The `USD 5.00` assignment fee is a separate cash entry and is allocated equally to the two lots.
- Assignment is invalid unless both the `USD -10000.00` cash debit and `+200` shares exist.

## 10. Cash ledger

| Append | Cash entry ID | Source event | Named line | Signed amount |
|---:|---|---|---|---:|
| 1 | `CASH-FIXTURE-PREMIUM-000002` | `FILL-FIXTURE-E3-000002` | `OPTION_PREMIUM_RECEIPT` | `USD +230.00` |
| 2 | `CASH-FIXTURE-FILL-FEE-000002` | `FILL-FIXTURE-E3-000002` | `OPENING_FILL_FEE` | `USD -1.30` |
| 3 | `CASH-FIXTURE-PREMIUM-000001` | `FILL-FIXTURE-E3-000001` | `OPTION_PREMIUM_RECEIPT` | `USD +120.00` |
| 4 | `CASH-FIXTURE-FILL-FEE-000001` | `FILL-FIXTURE-E3-000001` | `OPENING_FILL_FEE` | `USD -0.65` |
| 5 | `CASH-FIXTURE-ASSIGN-DEBIT-000001` | `TERM-FIXTURE-E3-ASSIGN-000001` | `PUT_ASSIGNMENT_STRIKE_DEBIT` | `USD -10000.00` |
| 6 | `CASH-FIXTURE-ASSIGN-FEE-000001` | `TERM-FIXTURE-E3-ASSIGN-000001` | `PUT_ASSIGNMENT_FEE` | `USD -5.00` |

Net cash movement is:

`USD 230.00 − 1.30 + 120.00 − 0.65 − 10000.00 − 5.00 = USD -9656.95`.

The strike debit remains `USD -10000.00`. The premium is not used to rewrite it as a smaller debit.

## 11. Share lots created by assignment

| Share lot ID | Movement ID | Parent assignment | Quantity | Strike cost | Allocated assignment fee | Total lot cost | State |
|---|---|---|---:|---:|---:|---:|---|
| `LOT-FIXTURE-SPY-000001` | `SHARE-MOVE-FIXTURE-000001` | `TERM-FIXTURE-E3-ASSIGN-000001` | `+100` | `USD 5000.00` | `USD 2.50` | `USD 5002.50` | `AVAILABLE` |
| `LOT-FIXTURE-SPY-000002` | `SHARE-MOVE-FIXTURE-000002` | `TERM-FIXTURE-E3-ASSIGN-000001` | `+100` | `USD 5000.00` | `USD 2.50` | `USD 5002.50` | `AVAILABLE` |

Share reconciliation:

- total shares created: `100 + 100 = 200`;
- total strike cost: `USD 5000.00 + USD 5000.00 = USD 10000.00`;
- total assignment fees allocated: `USD 2.50 + USD 2.50 = USD 5.00`;
- total inventory cost: `USD 10005.00`;
- per-share inventory cost: `USD 50.025`;
- deliverable shares: `200`;
- shares reserved by covered calls: `0`.

Any future covered call in episode `EP-FIXTURE-E3-000001` must reserve these exact `shareLotId`
values. It may not create another 200-share pile.

## 12. Expiry of the remaining contract

| Field | Value |
|---|---|
| `terminalEventId` | `TERM-FIXTURE-E3-EXPIRE-000001` |
| source event ID | `BROKER-FIXTURE-EXPIRE-800001` |
| source evidence hash | `9999999999999999999999999999999999999999999999999999999999999999` |
| expired contracts | `1` |
| allocated source fill | `FILL-FIXTURE-E3-000002` |
| effective at | `2026-09-18T20:00:00.000Z` |
| acquired at | `2026-09-18T20:02:00.000Z` |
| expiry fee entry IDs | explicit empty array `[]` |
| expiry cash entry IDs | explicit empty array `[]` |
| expiry share movement IDs | explicit empty array `[]` |
| option quantity after expiry | `0` |

Expiry creates no strike cash movement and no shares. The allocated one-contract premium from
`FILL-FIXTURE-E3-000002` remains booked.

## 13. Terminal summary

| Field | Value |
|---|---|
| final `terminalEventId` | `TERM-FIXTURE-E3-FINAL-000001` |
| child terminal events | `TERM-FIXTURE-E3-ASSIGN-000001`, `TERM-FIXTURE-E3-EXPIRE-000001` |
| opened contracts | `3` |
| assigned contracts | `2` |
| expired contracts | `1` |
| remaining contracts | `0` |
| shares created | `200` |
| shares remaining | `200` |
| option-unit status | `RESOLVED_ASSIGNMENT_TO_INVENTORY` |
| economic-episode status | `OPEN_SHARES` |

Quantity conservation is `3 opened = 2 assigned + 1 expired + 0 remaining`.

## 14. Named P&L lines

FIFO allocates the option premium and opening fees as follows:

| P&L line ID | Named component | Assigned branch | Expired branch | Total |
|---|---|---:|---:|---:|
| `PNL-LINE-FIXTURE-OPTION-PREMIUM` | `OPTION_PREMIUM_GROSS` | `USD +235.00` | `USD +115.00` | `USD +350.00` |
| `PNL-LINE-FIXTURE-OPENING-FEES` | `OPENING_FILL_FEES` | `USD -1.30` | `USD -0.65` | `USD -1.95` |
| `PNL-LINE-FIXTURE-OPTION-REALIZED` | `OPTION_REALIZED_PNL` | `USD +233.70` | `USD +114.35` | `USD +348.05` |

The assignment fee is capitalized into the share lots and is not counted again in option realized
P&L.

Inventory and marked P&L use this synthetic cited mark:

| Field | Value |
|---|---|
| mark evidence ID | `MARK-FIXTURE-SPY-000001` |
| mark raw hash | `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` |
| mark | `USD 49.00 per share` |
| vendor as of | `2026-09-18T20:01:00.000Z` |
| acquired at | `2026-09-18T20:01:01.000Z` |
| market adapter | `FIXTURE_MARKET_ADAPTER_V1` |

| P&L line ID | Named component | Amount |
|---|---|---:|
| `PNL-LINE-FIXTURE-SHARE-CASH` | `SHARE_ACQUISITION_STRIKE_CASH` | `USD -10000.00` |
| `PNL-LINE-FIXTURE-ASSIGN-FEE` | `ASSIGNMENT_FEE_CAPITALIZED` | `USD -5.00` |
| `PNL-LINE-FIXTURE-INVENTORY-COST` | `REMAINING_SHARE_INVENTORY_COST` | `USD 10005.00` |
| `PNL-LINE-FIXTURE-INVENTORY-MARK` | `REMAINING_SHARE_MARK_VALUE` | `USD 9800.00` |
| `PNL-LINE-FIXTURE-SHARE-UNREALIZED` | `UNREALIZED_SHARE_PNL` | `USD -205.00` |
| `PNL-LINE-FIXTURE-TOTAL-REALIZED` | `TOTAL_REALIZED_PNL` | `USD +348.05` |
| `PNL-LINE-FIXTURE-TOTAL-MARKED` | `TOTAL_MARKED_EPISODE_PNL` | `USD +143.05` |

Reproducible formulas:

- `OPTION_REALIZED_PNL = 350.00 − 1.95 = USD +348.05`.
- `REMAINING_SHARE_INVENTORY_COST = 10000.00 + 5.00 = USD 10005.00`.
- `REMAINING_SHARE_MARK_VALUE = 200 × 49.00 = USD 9800.00`.
- `UNREALIZED_SHARE_PNL = 9800.00 − 10005.00 = USD -205.00`.
- `TOTAL_MARKED_EPISODE_PNL = 348.05 − 205.00 = USD +143.05`.

`TOTAL_REALIZED_PNL` includes only the completed option leg. The share inventory remains open, so
the episode is not labeled economically closed.

## 15. P&L record identity

| Field | Value |
|---|---|
| `pnlRecordId` | `PNL-FIXTURE-E3-000001` |
| `resolvedUnitId` | `RU-FIXTURE-E3-000001` |
| `economicEpisodeId` | `EP-FIXTURE-E3-000001` |
| `pnlFormulaVersion` | `E3_COMPONENT_PNL_V1` |
| cash entry IDs | all six `CASH-FIXTURE-*` entries listed above |
| share lot IDs | `LOT-FIXTURE-SPY-000001`, `LOT-FIXTURE-SPY-000002` |
| terminal event IDs | assignment, expiry, and final-summary identifiers listed above |
| mark evidence ID | `MARK-FIXTURE-SPY-000001` |
| P&L payload hash | `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb` |

## 16. No forecast

This fixture has no forecast by design:

- `forecastPresent: false`
- `forecastHash`: absent under the optional-forecast rule
- `calibrationObservationId`: absent under the optional-forecast rule
- `calibrationEligible: false`
- `calibrationReason: NO_PROSPECTIVELY_SEALED_FORECAST`

No probability is reconstructed from the assignment or expiry. The fixture creates no learning,
calibration, promotion, or Friday matcher claim.

## 17. Replay result

An independent replay must reproduce all of the following:

1. sealed quantity: `3 short put contracts`;
2. fills acquired in order `000002`, then `000001`, with acknowledgement between them;
3. fills applied exactly once for total quantity `3`;
4. gross option premium `USD 350.00` and opening fees `USD 1.95`;
5. partial assignment of `2` contracts into `200` shares;
6. strike cash debit `USD 10000.00` plus separate assignment fee `USD 5.00`;
7. two durable share lots of `100` shares and `USD 5002.50` cost each;
8. expiry of the remaining `1` contract with no cash or share movement;
9. terminal option quantity `0`;
10. net cash movement `USD -9656.95`;
11. option realized P&L `USD +348.05`;
12. remaining share inventory cost `USD 10005.00`;
13. marked episode P&L `USD +143.05` at the cited `USD 49.00` mark;
14. option status `RESOLVED_ASSIGNMENT_TO_INVENTORY` and episode status `OPEN_SHARES`;
15. no forecast and no calibration observation.

If any identifier, fill, fee, cash entry, share lot, terminal branch, or P&L component cannot be
reproduced, the fixture fails the E3 contract.

## 18. Production boundary

This fixture changes no runtime. Worker 126 remains the live dashboard and is untouched. No order
was sent, no broker was called, no Friday tape was restamped, and no forecast was created.
