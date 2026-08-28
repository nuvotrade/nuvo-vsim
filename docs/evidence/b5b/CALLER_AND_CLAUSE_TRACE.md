# B5B caller and clause trace

## Production flow

```text
nuvo-command `master` Worker `/v1/earnings-events`
  -> Cloudflare `MARKET` private service binding
  -> VSIM `MassiveProvider.events()`
  -> `SchwabMarketProvider.events()` pass-through in the live configuration
  -> decision cycle / covered-call calculator / live-market verifier
  -> sealed raw inputs and deterministic replay
```

Cloudflare production uses `NUVO_MARKET_SOURCE=SCHWAB_MARKET_DATA`; Schwab supplies price, chain,
history, ADV and session facts. The injected `MassiveProvider` remains the forward-event provider.
No public route, credential, storage binding, or broker mutation is added by B5B.

## Clause ownership

| Amendment 3 clause | Canonical owner | B5B consumer enforcement |
|---|---|---|
| 3.1 request validation | `nuvo-command/master` B5A | trusts versioned producer contract |
| 3.2 exact echo | `nuvo-command/master` B5A | preserves requested and echoed ranges |
| 3.3 known-empty semantics | `nuvo-command/master` B5A | accepts only coherent `VERIFIED` empty / `BLOCKED` nonempty envelopes |
| 3.4 empty freshness | `nuvo-command/master` B5A | preserves `vendorAsOf` and `fetchedAt` |
| 3.5 IANA time conversion | `nuvo-command/master` B5A | consumes the resulting UTC instant only |
| 3.6 provider-time diagnostic | `nuvo-command/master` B5A | preserves the normalized source event in the envelope |
| 3.7 required event fields | both | independently refuses missing/invalid time, vintage, or date status |
| 3.8 error isolation | `nuvo-command/master` B5A | preserves producer fault and never converts it to empty |

The source identity is exactly `MASSIVE_BENZINGA_EARNINGS` / `BENZINGA` /
`BENZINGA_COMPENSATING_ADAPTER_CONTRACT_V1`. An old or unnamed producer therefore fails closed after
B5B deploys. This is the intended safe intermediate state before B5A.

## Isolation answer

Earnings and corporate splits are separate array branches in `MassiveProvider.events()`. B5B
replaces only the earnings branch with the strict consumer result. The corporate-split expression
is unchanged and requires no new discriminator. Its exact old output is pinned by a fixed SHA-256
literal in tests and the deterministic replay.

