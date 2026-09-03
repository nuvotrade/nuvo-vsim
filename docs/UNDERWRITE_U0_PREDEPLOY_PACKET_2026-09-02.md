# UNDERWRITE U0 — pre-deployment review packet

**Prepared:** 2026-09-02 20:53 PDT  
**Status:** REVIEW CANDIDATE · NOT DEPLOYED · NOT LIVE  
**Baseline commit:** `9944a4bdeaeb848913c5b38c1915e5c9724b72f9`  
**Branch:** `codex/post-fill-reconciliation`  
**mutation_eligible:** `false`  
**Manifest SHA-256:** `54c87f1256e6de2282dd9c490302df58c6e43341d47837739745f0c8a2a61f56`

No Worker version was uploaded or switched. No lane, coordinator, alert, broker,
credential, Cloudflare configuration, or production-data state was changed.
U1 valuation math is not part of this packet.

## Touched-file identities

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `cloudflare/worker.js` | 325,579 | `ff03e0bf65507a6e0c8af6b00f2cb2e373ff3eed984d3277a49675b75cea4cf0` |
| `cloudflare/migrations/0016_underwrite_forecasts.sql` | 712 | `5351f6b6fcac98a1036e05991015649c45863c9a622dbe1f1a112153c67d3966` |
| `src/pipeline/cycle.js` | 30,198 | `934708a2b7ff07bb1fc5c540588d5432b5667372e1bb7833a8dbb94d76720983` |
| `src/lifecycle/covered_call_analysis.js` | 17,634 | `c6d95c6b12ebe992a4cb2f32be6cbf8cf4090d8097fd505e6cf8a0a5fd10a0fc` |
| `test/integration.test.js` | 25,824 | `c240d235c463a881d55932f415723b228bbd99eff5beb58017184af41493fc7a` |
| `test/covered_call_analysis.test.js` | 9,210 | `589ed62da7106b0683d50bb78522eaf3c4053d31a0810999afe1bb072bc521bf` |
| `test/underwrite_u0.test.js` | 2,923 | `03e2ff70a5dc4f4aed2c0214951a9bcce5fb49470eaaa6c2dc7a2553ad311546` |

The machine-readable file list is
`docs/UNDERWRITE_U0_PREDEPLOY_PACKET_2026-09-02.manifest.json`.

## Predicted Worker bundle

Wrangler 4.125.0 produced `entry.js` twice from the exact working tree. Both
independent dry builds produced the same bytes:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Predicted Worker `entry.js` | 2,173,197 | `53779147009d9ba61b9999727101ef1288c6732a2b017768ab5e0bd7a92e9a09` |

This is a prediction for a later upload only if the exact hashed sources and
toolchain remain unchanged. Any source change requires a new bundle and packet.

## Verification reprint

```text
tests 764
suites 66
pass 764
fail 0
cancelled 0
skipped 0
todo 0
```

```text
Wrangler 4.125.0
Total Upload: 2122.26 KiB / gzip: 442.28 KiB
--dry-run: exiting now.
entry.js: 2,173,197 bytes
entry.js SHA-256: 53779147009d9ba61b9999727101ef1288c6732a2b017768ab5e0bd7a92e9a09
DRY BUILD: PASS
```

## Mutation boundary

`mutation_eligible: false` remains true after U0:

- scan summaries still emit `mutationEligible: false`;
- covered-call calculation responses emit `mutation_eligible: false` and
  `READ_ONLY_CALCULATION_NO_ORDER_ROUTE`;
- cash-secured-put results emit `mutation_eligible: false` and
  `READ_ONLY_MATH_NO_ORDER_ROUTE`;
- the new forecast writer performs append-only D1 inserts and has no order,
  approval, sizing, lane, coordinator, or broker-mutation path.

The fixture in `test/underwrite_u0.test.js` asserts these four boundaries.

## Required fixtures

### 1. Closed session is not a failed candidate search

Fixture input:

```json
{"ok":false,"reason_code":"TRUTH/SESSION_NOT_RTH","outcome":"NOT_EVALUATED","symbol":"SOFI"}
```

Observed display state:

```json
{"ready":false,"state":"NOT_EVALUATED","outcome":"NOT_EVALUATED"}
```

The fixture asserts that the result contains no `NO_ELIGIBLE` state.

### 2. `HISTORY_SHORT` is isolated to its symbol

Fixture universe: `SPY`, `AAPL`, `XOM`. The provider returns
`SCHWAB_HISTORY_SHORT:76` for XOM and verified history for its peers.

Observed and asserted:

```text
cycle outcome != REFUSED
XOM state = REFUSED
XOM stage = HISTORY
XOM reason_codes = [SCHWAB_HISTORY_SHORT]
at least one verified peer state = CALCULATED
```

This proves symbol A's short history does not discard symbol B's completed
calculation. The same integration fixture also proves an unverified event
calendar is isolated per symbol.

### 3. Stale option quote cannot emit current lifecycle flags

Fixture input uses the locked SPCX lifecycle values with
`quoteFreshness = LAST_MARKET_QUOTE`.

Observed and asserted:

```text
classification.current = false
classification.status = UNAVAILABLE_STALE_QUOTE
classification.flags = [QUOTE_STALE]
historical_flags retains the calculated conditions only as historical context
do_nothing = NOT_RECOMMENDED_BY_FLAGS
```

The displayed economics remain inspectable, but no stale economic condition is
represented as current.

## Sealed CSP calculator continuity

The sealed CSP review packet recorded:

```text
cloudflare/cash-secured-put-calculator.js
SHA-256 e16e4e02e4ca2a34cb26fcaaff4fc4aab27575ee966d21a42e6fe1f15ae571da
```

Current working-tree result:

```text
SHA-256 e16e4e02e4ca2a34cb26fcaaff4fc4aab27575ee966d21a42e6fe1f15ae571da
```

**Result: byte-for-byte unchanged from the sealed CSP packet.** U0 changes CSP
labels and persistence wiring in `cloudflare/worker.js`; it does not reopen or
alter the sealed CSP calculator mathematics.

## Release boundary

This packet is evidence for review, not deployment authority. The D1 migration
must accompany any later authorized Worker switch. No production action has
occurred.
