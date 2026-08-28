# FR-006B Production Clock Caller Trace

## Finding

Production had one fixed cycle clock in `NuvoEngine.cycle()`, but did not thread it through the
provider boundary. `runCycle()` called `provider.events(symbol)` without an instant, so Massive
computed each symbol's event window from a later call to its live clock. Both market adapters also
evaluated an early chain against a clock read only after concurrent responses completed; Massive
adds multiple expiration/right responses while Schwab waits for its separate underlying quote.

## Canonical contract

`src/truth/providers/clock_contract.js` is the one evaluator and identity source.

- decision membership: `requireDecisionTime(decisionTime)`
- quote freshness: `acquiredAt - vendorAsOf`
- contract identity: `PRODUCTION_CLOCK_DOMAINS_V1`
- missing vendor time: `VENDOR_QUOTE_TIMESTAMP_MISSING`
- acquisition time never substitutes for vendor time
- there is no live-clock default: missing `decisionTime` fails before a provider request

The provider option shape is the same everywhere: `{ ..., decisionTime }`.

## Three chain-versus-event operations

| Operation | Fixed instant owner | Chain threading | Event threading | Downstream clock |
|---|---|---|---|---|
| Decision cycle | `runShadowCycle` / `NuvoEngine.cycle` | `{ expirations, decisionTime }` | `{ decisionTime }` | engine clock and sealed `rawInputs.decisionTime` |
| Covered-call calculator | `coveredCallDashboard` | `{ expirations, decisionTime }` | `{ decisionTime }` | calculator `now: decisionTime` |
| Live-market verifier | `verifyLiveMarket` | `{ expirations, decisionTime }` | `{ decisionTime }` | one verification operation |

This is an approved scope expansion from the original `runCycle()`-only description. Fixing only
`runCycle()` would have left the human-facing calculator and the production verifier on drifting
membership windows.

## Supporting production consumers

- `mapCustodyRisk(..., now)` passes the same `now` as `decisionTime` to exact-strike chain reads.
- owned-lot optionability probes inside `runShadowCycle` use the cycle's `decisionTime`.
- Schwab delegates event reads to Massive with the same explicit `decisionTime`.
- replay returns the sealed decision and acquisition fields; it does not call a live clock.

## Quote acquisition boundaries

- Current live option source: Schwab. Its production exposure is one option-chain response waiting
  concurrently on one underlying response; an early chain could be aged against the later sibling.
- Massive records one `acquiredAt` after each private-service response is parsed. Different
  expiration/right responses may therefore carry different acquisition instants. This multi-response
  option-chain topology is dormant under the current live configuration.
- Schwab records one `acquiredAt` after the option-chain response resolves, independently of the
  concurrent underlying response.
- cached Schwab and underlying quotes store the response and its acquisition instant together;
  reading the cache later cannot mint a later acquisition time.
- every accepted option row carries `quoteAsOf`, `acquiredAt`, `quoteAgeMs`, and
  `clockContractVersion`.

## Sealed inputs

Cycle evidence records the top-level decision time and contract identity, plus per-symbol quote,
chain, and event acquisition provenance. Replay preserves those fields exactly.

## Register dependency

No canonical Governance Register exists in this repository or any available branch. FR-006B names
`PRODUCTION_CLOCK_DOMAINS_V1` but does not create a fourth local register. Canonical register
creation remains its own packet and must reconcile identities and parameters across both projects.
