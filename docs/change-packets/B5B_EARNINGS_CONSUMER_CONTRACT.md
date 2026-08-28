# Change Packet — B5B Earnings Consumer Contract

**Status:** BUILT FOR PRINCIPAL AUDIT — NOT DEPLOYED  
**Objective:** Prevent VSIM from inventing an earnings time and preserve the signed event-source
contract through sealed evidence and replay  
**Authority:** 2 / PROPOSE ONLY — unchanged  
**Deployment:** Not authorized and not performed

## 1. Branch, base and predecessor

- Repository: `https://github.com/nuvotrade/nuvo-vsim`
- Branch: `codex/b5b-earnings-consumer-contract`
- Base: `d600c0b8e00936d31d550eff1d75cc4d4af6ca03` — approved FR-006B
- Worktree: isolated from dashboard A1/A2, B5A, the unaccepted fault-classification draft and
  production
- Signed authority: Amendment 3 Revision 1,
  SHA-256 `a39b9a261aa20254999f9bbfca39a93abfaeac7174ceeb6bc048eae350785148`

The identity consumed by this packet is exactly:

```text
sourceId        MASSIVE_BENZINGA_EARNINGS
upstreamOrigin  BENZINGA
schemaVersion   BENZINGA_COMPENSATING_ADAPTER_CONTRACT_V1
```

## 2. Complete diff and isolation answer

Runtime changes are limited to three files:

```text
src/truth/providers/massive.js   strict earnings consumer boundary
src/pipeline/cycle.js            sealed fault and source-envelope fields
src/evidence/replay.js           exact success/refusal replay
```

Tests are limited to:

```text
test/production_adapters.test.js
test/integration.test.js
```

Submission support is `tools/replay-b5b.mjs`, this packet and `docs/evidence/b5b/*`.

### Earnings can be isolated cleanly

The existing provider has separate earnings and corporate-split array branches. B5B replaces only
the earnings result with a strict consumer. The split branch remains the same expression and output;
no new type discriminator is needed. The fixed pre-change split bytes and SHA-256 are asserted in
the test suite and replay.

No producer, dashboard, config, schema, schedule, mandate, limit, model, universe, authority,
storage binding, order route or broker mutation changes.

## 3. Consumer contract and production flow

Production flow:

```text
nuvo-command/master `/v1/earnings-events`
  -> private Cloudflare MARKET service binding
  -> MassiveProvider event consumer
  -> SchwabMarketProvider pass-through in the live configuration
  -> decision/calculator/verifier operation
  -> sealed raw inputs
  -> ReplayProvider
```

B5B does not duplicate the eight-clause canonical producer adapter. B5A owns request validation,
exact echo, verified-empty freshness, IANA conversion and provider normalization. B5B independently
enforces the source identity and Amendment 3 clause 3.7:

- `timeEst` must be present;
- `eventTimeUtc` must be an explicit parseable string;
- `lastUpdated` must be a parseable instant;
- `dateStatus` must be `projected` or `confirmed`;
- no date-only fallback may create an earnings instant.

An old or unnamed producer now fails `EARNINGS_SOURCE_CONTRACT_UNVERIFIED`. This creates a safe,
fail-closed intermediate state when B5B deploys before B5A.

Every result preserves the signed envelope fields:

```text
status · faultCode · faultStage · sourceId · upstreamOrigin
vendorAsOf · fetchedAt · requestedRange · echoedRange
coverageThrough · schemaVersion · events · rawPayloadHash
```

## 4. Old-versus-new deterministic replay

The replay fixture supplies an event with a date but no vendor time or UTC instant.

| Path | Result | Verdict |
|---|---|---|
| old consumer | `2026-10-29T16:00:00Z` / `1793289600000` | accepted fabricated time |
| B5B | `EARNINGS_EVENT_TIME_MISSING` | refused |

The B5B failure serializes with `containsInvented1600Z=false`.

A corrected AAPL input, `2026-10-29T20:00:00.000Z`, maps to exactly `1793304000000` and is not
recomputed by VSIM. B5A remains responsible for deriving that value through
`America/New_York`; B5B only consumes and verifies it.

Machine-readable evidence: `docs/evidence/b5b/OLD_VS_NEW_REPLAY.json`.

## 5. State discrimination and fail-closed behavior

| Input condition | B5B result | Clears event fact? |
|---|---|---:|
| wrong/missing source identity | `EARNINGS_SOURCE_CONTRACT_UNVERIFIED` | no |
| producer HTTP/fault envelope | producer `faultCode` preserved | no |
| events field absent | `EARNINGS_EVENTS_MISSING` | no |
| status/event-count contradiction | `EARNINGS_RESULT_SEMANTICS_INVALID` | no |
| missing `timeEst` | `EARNINGS_EVENT_TIME_MISSING` | no |
| missing/invalid/numeric `eventTimeUtc` | `EARNINGS_EVENT_TIME_INVALID` | no |
| missing/invalid `lastUpdated` | `EARNINGS_LAST_UPDATED_MISSING_OR_INVALID` | no |
| unknown `dateStatus` | `EARNINGS_DATE_STATUS_UNKNOWN` | no |
| signed verified-empty envelope | empty event list | yes, subject to later gates |
| signed blocked envelope with valid event | exact supplied UTC instant | no tenor spanning event |

Producer faults retain their own stage inside `eventsSourceEnvelope.faultStage`; the consumer boundary
is separately named `EARNINGS_CONSUMER`. A persistence or replay reader can therefore distinguish
where the failure originated.

## 6. Split isolation and remaining FR-026 limitation

The fixed pre-B5B corporate-split result is:

```json
{"type":"CORPORATE_SPLIT","at":1788278400000,"source":"MASSIVE_ACTIONS"}
```

SHA-256 before and after:

```text
8e8893d716f8326b93c573a9c9827c115e69a3ee6680cbb99007c2d92c2e0aed
```

The test compares the current output to a fixed serialized literal and fixed digest. It does not
compute both sides from the current code.

This is an intentional limitation, not approval of the existing behavior. Date-only corporate
splits still receive `16:00Z`. The split half of FR-026 remains `OPEN_GOVERNANCE`; B5B closes only
the earnings half after deployment verification.

## 7. Sealed evidence and replay

New raw-input fields per symbol:

```text
eventsError · eventsFaultCode · eventsFaultStage
eventsContractVersion · eventsSourceEnvelope
```

Existing event acquisition, decision and clock fields remain unchanged. A successful event result
replays with its exact source envelope and contract version. A refused result replays the stored
error, fault stage and envelope rather than returning a generic “no captured events” response.

This is decision evidence, not additional runtime state. No D1 or R2 schema changes are required;
the fields live inside the already versioned raw evidence payload.

No canonical Governance Register exists. The contract identity is named and sealed here, while
`docs/evidence/b5b/REGISTER_DEPENDENCY.md` records the unresolved register dependency instead of
creating another local list.

## 8. Verification and test-count reconciliation

Focused production-adapter and integration run:

```text
total 112 · passed 112 · failed 0 · unloaded 0
```

Full packet branch:

```text
total 405 · passed 405 · failed 0 · unloaded 0
files 22 · each file executed independently · every file exit 0
```

Approved FR-006B parent:

```text
total 399 · passed 399 · failed 0 · unloaded 0
files 22
```

The exact delta is six tests, all in `production_adapters.test.js`. The integration test adds exact
sealed-envelope assertions inside an existing test. No test was removed, renamed, absorbed or
unloaded.

The per-file ledger is `docs/evidence/b5b/FILE_TEST_COUNTS.txt`; its totals sum to 405. Full and
focused raw outputs are preserved separately.

### B5A freshness tests still required

B5B does not implement Amendment 3 clause 3.4. B5A must prove exact producer boundaries:

```text
ageMs <= 900000  accepted
ageMs  = 900001  EARNINGS_EMPTY_STALE
timestamp absent EARNINGS_EMPTY_UNVERIFIABLE
vendor timestamp ahead of acquisition by more than allowed skew -> named refusal
```

## 9. Cloudflare dry run and boundary review

Wrangler `4.125.0` completed a Worker dry run with exit 0 and did not deploy. Entry bundle SHA-256:

```text
4bf92c31e31c29efacf335ddddd7379bd71eb7e9abc56406b83a40dca8b9efb7
```

The review used the current Cloudflare Workers best-practices documentation and
`@cloudflare/workers-types@5.20260827.1`. B5B adds no global mutable request state, floating promise,
secret, route, binding or storage mutation. Worker-to-Worker communication remains on the existing
private `MARKET` service binding.

No dashboard markup or screenshot applies to this packet.

## 10. Submission, deployment gate and rollback

The final manifest is `docs/evidence/b5b/SHA256SUMS`. It covers every changed runtime file, test,
tool, packet and evidence artifact, excluding the manifest itself.

**Nothing in this packet authorizes deployment.** Required order after Principal approval:

1. commit and push B5B;
2. byte-compare the tested bundle;
3. deploy B5B alone;
4. verify old producer responses fail closed by contract identity and no date-only earnings time is
   created;
5. build, review and deploy B5A separately;
6. capture live ADBE `20:05Z` and AAPL `20:00Z` parity through the complete path;
7. only then assess H-09 closure.

B5B rollback is one VSIM Worker version revert. It does not roll back `master`, B5A, a schema, or a
governance artifact. Reverting would restore the known fail-open earnings fallback, so rollback is
operational recovery only and immediately reopens the earnings half of FR-026.
