# Change Packet — FR-006B Production Clock Contract

**Status:** BUILT FOR PRINCIPAL AUDIT — NOT DEPLOYED  
**Objective:** Separate decision membership time from response-acquisition freshness time in every
production operation that compares option chains with events  
**Authority:** 2 / PROPOSE ONLY — unchanged  
**Deployment:** Not authorized and not performed

## 1. Branch and base

- Repository: `https://github.com/nuvotrade/nuvo-vsim`
- Branch: `codex/fr-006-clock-domains`
- Base: `058a2a839836279e5636b39f4024f7affc0b775c` — approved FR-005
- Worktree: isolated from dashboard A1/A2, FR-006A, and the unaccepted fault-classification draft
- Production change: none

The identity introduced by this packet is exactly `PRODUCTION_CLOCK_DOMAINS_V1`.

## 2. Complete isolated diff and approved scope expansion

Functional source and tests:

```text
src/truth/providers/clock_contract.js   canonical clock evaluator and identity
src/truth/providers/massive.js          per-response acquisition; fixed event membership
src/truth/providers/schwab.js           per-response acquisition; fixed event delegation
src/pipeline/cycle.js                    one cycle instant; sealed clock provenance
src/evidence/replay.js                   clock-preserving replay
src/truth/providers/provider.js          event option contract
cloudflare/worker.js                     three production operation owners
cloudflare/custody-risk.js               exact-strike reads use the operation instant
test/production_adapters.test.js         exact boundaries, caller guards, replay
test/integration.test.js                 one-cycle threading and sealing
```

Submission support:

```text
tools/replay-fr006b.mjs
docs/evidence/fr-006b/*
docs/change-packets/FR-006B_PRODUCTION_CLOCK_CONTRACT.md
```

The original FR-006B description named `runCycle()` only. Trace work found two other production
operations that compare a chain with events: the covered-call calculator and the live-market
verifier. The approved scope therefore expands to those operations so all three use the same
threading pattern. It also threads the same instant through custody exact-strike reads and owned-lot
optionability probes inside the cycle operation. It does not change a threshold, universe, ranker,
model coefficient, dashboard, mandate, schema, order route, authority, or scheduler.

## 3. Canonical contract and data flow

`src/truth/providers/clock_contract.js` defines one contract:

```text
event membership = fixed decisionTime
quote age         = acquiredAt - vendorAsOf
identity          = PRODUCTION_CLOCK_DOMAINS_V1
```

A vendor timestamp is mandatory. `acquiredAt` proves when VSIM possessed the response and may never
stand in for `vendorAsOf`.

`decisionTime` has no production default. A caller that omits it receives
`DECISION_TIME_MISSING` before any provider request. This makes the clock boundary enforceable when
a fourth caller is added; it is not a convention maintained by the three callers listed here.

The same option shape crosses every provider boundary:

```js
provider.optionChain(symbol, { expirations, decisionTime })
provider.events(symbol, { decisionTime })
```

The three chain-versus-event operations are inventoried in
`docs/evidence/fr-006b/CALLER_TRACE.md`:

1. scheduled/manual decision cycle
2. covered-call calculator
3. live-market verifier

Massive records a distinct acquisition time for every expiration/right response. Schwab records the
option-chain response acquisition time. Cached quote objects retain their original acquisition time
instead of minting a later one when read.

New sealed raw inputs include:

```text
decisionTime · clockContractVersion
quoteAcquiredAt · quoteAgeMs · quoteClockContractVersion
chainAcquiredAt · chainAcquisitionTimes · chainDecisionTime · chainClockContractVersion
eventsAcquiredAt · eventsDecisionTime · eventsClockContractVersion
```

Replay returns those stored values and never recomputes them from a live clock.

### Governance Register disposition

No canonical Governance Register exists in this repository or any available branch. FR-006B names
and seals `PRODUCTION_CLOCK_DOMAINS_V1` but records `REGISTER_DEPENDENCY_UNBUILT`; it does not create
a fourth local register. Register construction remains its own packet. The required reconciliation
set is in `docs/evidence/fr-006b/REGISTER_DEPENDENCY.md`.

## 4. Exact-value tests and old-versus-new replay

The deterministic replay uses 198 symbols and a decision instant near a UTC date boundary.

### Event membership

| Measurement | Old dynamic provider clock | New fixed decision clock |
|---|---:|---:|
| Symbols | 198 | 198 |
| Unique requested windows | 2 | 1 |
| First window | 2026-08-25 → 2026-10-26 | 2026-08-25 → 2026-10-26 |
| Last window | 2026-08-26 → 2026-10-27 | 2026-08-25 → 2026-10-26 |

The old last-symbol clock is exactly 197 seconds later than the first. Crossing the UTC date
boundary changes event membership inside one cycle. The new contract keeps all 198 windows equal to
the cycle decision instant.

### Quote freshness

The deployed configuration is `SCHWAB_MARKET_DATA` with a 120,000 ms option-chain threshold and a
60,000 ms underlying-quote threshold. The old Schwab adapter awaited the chain and underlying
responses together, then aged the chain against one post-batch clock. The deterministic stress
replay makes the chain response arrive first and the concurrent underlying response arrive 130
seconds later. Both vendor timestamps are exactly one second old at their own acquisitions.

| Response | Acquisition | Old post-batch age | Old result | New age | New result |
|---|---:|---:|---|---:|---|
| option chain | T+0 s | 131,000 ms | refused at 120 s | 1,000 ms | accepted |
| underlying quote | T+130 s | 1,000 ms | accepted | 1,000 ms | accepted |

The old adapter therefore refuses a fresh chain; the new production adapter returns both required
contracts with the exact T+0 acquisition. The replay names them: `TEST_put` and `TEST_call` both
move from `SCHWAB_EXECUTABLE_CHAIN_UNAVAILABLE` to accepted. This proves the production code can
change a verdict, not only provenance.

The sensitivity boundary is exact for this one-second-old chain: the old path remains accepted
through a 119,000 ms sibling delay (120,000 ms computed age) and falsely refuses above it. At
120,000 ms of sibling delay, the old computed age is 121,000 ms and the verdict flips; the new age
remains 1,000 ms. The replay records 0, 30, 60, 90, 119, 120, and 130-second cases.

This replay is a **stress case, not an observed incidence estimate**. Historical evidence did not
seal per-response acquisition times, so the number of live false refusals is not recoverable. A
claim such as “141 of 198” would be invented. After deployment, the new fields make incidence
measurable. The current live topology is one Schwab chain response concurrent with one Schwab
underlying response. The dormant Massive option-chain path can exhibit the same defect across its
multi-response expiration/right batch, but it is not the current live option source.

Replay artifact SHA-256:
`bfa1cd7497f6f1b5fea9e215f46794a2afdf3d8afdf57a8d3b75fcb0e2ece43a`.

## 5. State discrimination and fail-closed behavior

| Condition | Result | Gate effect |
|---|---|---|
| explicit valid decision time | one event window for the operation | continue |
| missing decision time at production adapter boundary | `DECISION_TIME_MISSING` before provider read | refuse |
| invalid decision time at production adapter boundary | `DECISION_TIME_INVALID` before provider read | refuse |
| vendor quote timestamp absent | `VENDOR_QUOTE_TIMESTAMP_MISSING` | refuse by name |
| vendor quote timestamp invalid | evaluator names it; adapter retains existing generic refusal | refuse |
| response acquisition absent/invalid | evaluator names it; adapter retains existing generic refusal | refuse |
| quote materially future-dated | adapter retains existing generic refusal | refuse |
| quote older than existing configured maximum | adapter retains existing generic refusal | refuse |
| valid vendor and acquisition times | exact `ageMs` sealed | continue to later gates |

The adapters preserve their existing generic chain-unavailable state for structural, liquidity,
Greek, and stale-slice failures. A missing vendor timestamp receives the new precise cause. The
packet never converts absence into a timestamp and never relaxes `NUVO_MAX_CHAIN_AGE_MS` or
`NUVO_MAX_QUOTE_AGE_MS`.

### Which findings change what

- fixed event membership changes requested date-window values and can change event-clearance verdicts
  only where a dynamic scan crosses a date boundary
- per-response freshness changes age values and can change a complete-chain verdict where a slow
  concurrent response previously aged an early chain against a later response's clock
- missing timestamp classification changes the cause, not the refusal verdict
- sealing and replay fields change provenance only

## 6. Authority and forbidden-action guard

FR-006B has no order, sizing, approval, dashboard directive, lifecycle recommendation, or broker
mutation path. Authority remains 2. Broker mode remains read-only.

No new action can follow from a fresh quote alone: the same Truth Contract, event clearance,
liquidity, expectancy, Governor, capital, and authority gates still run. The corrected clock may let
a fact reach those later gates; it cannot clear them itself.

The Worker source guard verifies all three production operations thread `decisionTime` explicitly.

## 7. Test execution and count reconciliation

Full packet branch:

```text
total 399 · passed 399 · failed 0 · unloaded 0
files 22 · every file exit 0
```

Approved FR-005 parent:

```text
total 391 · passed 391 · failed 0 · unloaded 0
files 22
```

The exact delta is eight added tests: seven in `production_adapters.test.js` and one in
`integration.test.js`. No test was removed, renamed, absorbed, or unloaded.

Targeted production-adapter and integration run:

```text
total 106 · passed 106 · failed 0 · unloaded 0
```

Per-file totals are recorded in `docs/evidence/fr-006b/FILE_TEST_COUNTS.txt` and sum to 399.

The exact tests prove:

1. acquisition never substitutes for a missing vendor timestamp
2. Massive keeps distinct response acquisitions under one decision instant
3. Massive and Schwab both return the named missing-vendor refusal
4. every symbol event request uses the same exact date window
5. omission of `decisionTime` refuses before the request counter advances from zero
6. a fresh Schwab chain survives a 130-second concurrent underlying delay because each response
   uses its own acquisition instant
7. replay returns stored clocks without recomputation
8. cycle calls every symbol with one instant and seals all provenance
9. Worker source retains the same threading pattern in all three operations

## 8. Worker dry-run and Cloudflare boundary review

Command:

```text
npx wrangler deploy --dry-run --config cloudflare/wrangler.jsonc --outdir <temporary-directory>
```

Wrangler `4.125.0` completed with exit 0 and did not deploy. Entry bundle SHA-256:
`fdf0cd3d0c78c8924ee01a866362e2c048e60b2f2dbf5ae924cd3df95bb6dfd7`.

The implementation was checked against the current Cloudflare Workers best-practices page and
`@cloudflare/workers-types@5.20260827.1`. It adds no global mutable request state, floating promise,
secret, public route, binding, or storage mutation. Provider instances remain operation-scoped and
every response promise is awaited.

## 9. Rendered markup or screenshot

Not applicable. FR-006B changes provider clocks and sealed evidence only. No dashboard markup, copy,
style, or route changes. The user-visible calculator may receive a different truthful refusal cause,
but this packet adds no rendering logic.

The machine-readable old/new behavior is the review surface:
`docs/evidence/fr-006b/OLD_VS_NEW_REPLAY.json`.

## 10. Submission manifest, deployment, and rollback

The final manifest is `docs/evidence/fr-006b/SHA256SUMS`. It covers every changed source, test,
replay tool, packet, and evidence artifact except itself. The manifest is generated only after the
final diff and then verified before packaging.

No deployment is authorized. If later approved, FR-006B must be integrated onto the verified
branch-forward successor, its full suite rerun with counts reconciled, and its Worker deployed alone.
The live artifact must byte-match the tested bundle before any later packet deploys.

Rollback is the immutable Worker version immediately preceding FR-006B. No D1, R2, schema,
configuration, or stored-data rollback is required. Evidence sealed under
`PRODUCTION_CLOCK_DOMAINS_V1` retains that identity; older records with no clock identity remain
legacy unsealed-clock evidence and must be replayed with their historical code artifact.
