# Change Packet — FR-005 Schwab History Request Contract

**Status:** BUILT FOR PRINCIPAL AUDIT — NOT DEPLOYED
**Objective:** Make the shared Schwab history request capable of satisfying the existing 504-bar
constitutional requirement without changing that requirement or any lower-lookback input
**Authority:** 2 / PROPOSE ONLY — unchanged
**Deployment:** Not authorized and not performed

## 1. Branch and base

- Repository: `https://github.com/nuvotrade/nuvo-vsim`
- Branch: `codex/fr-005-history-window`
- Governing freeze/base: `55052d32ab03c3eb46b8c8a8af52770b479428a5`
- Worktree: isolated from A1, A2, FR-003, and the unaccepted 1a draft
- Production change: none

The packet changes one provider contract: the explicit Schwab history request expands from two to
three years. It does not change the 504-bar gate, universe, ranker, thresholds, dashboard,
authority, database, order route, or low-level client default.

## 2. Complete isolated diff and diff-stat

Functional source and tests:

```text
src/truth/providers/schwab.js       canonical request, normalizer, contract identity
src/pipeline/cycle.js               sealed-input provenance
src/evidence/replay.js              provenance-preserving replay re-entry
test/production_adapters.test.js    exact request, suffix, and boundary tests
test/integration.test.js            sealed-input identity test
```

Submission support:

```text
tools/replay-fr005.mjs
docs/evidence/fr-005/*
docs/change-packets/FR-005_HISTORY_REQUEST.md
```

No UI, portfolio, mandate, broker, order, D1, R2, scheduler, messaging, or configuration file is
changed. Final submission: **18 files, 2,050 insertions, 14 deletions**, including the 17-line
SHA-256 manifest.

## 3. Contract source, callers, and provenance

Canonical implementation:

- `src/truth/providers/schwab.js:5-6` — three-year request and
  `SCHWAB_PRICE_HISTORY_3Y_V2` identity
- `src/truth/providers/schwab.js:35-59` — normalization, sort/dedup/suffix, exact short-history
  refusal, and response provenance
- `src/truth/providers/schwab.js:158-170` — production request uses the canonical period
- `src/pipeline/cycle.js:213-227` — history source, contract identity, request period, raw count,
  and returned count enter the raw decision inputs
- `src/evidence/replay.js:47-58` — stored identities re-enter through the replay provider

The full caller inventory is in `docs/evidence/fr-005/CALLER_TRACE.md`. Every production consumer
passes a lookback explicitly. Six in-repository consumers request 120, 252, or 400 bars. The
three-sleeve scanner requires 504. Since normalization takes the suffix after sorting and
deduplication, the first six receive identical arrays under the longer raw response. Only the
504-bar consumer changes from refusal to usable history.

The low-level `cloudflare/schwab-client.js` two-year default is deliberately unchanged. The shared
provider always supplies an explicit period, so changing the unreachable transport default would
expand scope without changing the governing request.

## 4. Exact-value tests and old-versus-new replay

`test/production_adapters.test.js` proves:

1. The production provider requests exactly `{period: 3}`.
2. A 756-record packet normalized at 504 returns exactly source records 253 through 756.
3. The first returned close is `253.25`; the last is `756.25`.
4. Contract identity is exactly `SCHWAB_PRICE_HISTORY_3Y_V2`; source is exactly
   `SCHWAB_MARKET_DATA_PRICE_HISTORY_3Y`.
5. Request, raw, and returned counts are exactly `3`, `756`, and `504`.
6. Exactly 503 normalized records fail closed as `SCHWAB_HISTORY_SHORT:503`.
7. The 120-, 252-, and 400-bar outputs are deep-equal before and after and retain pinned SHA-256
   values.

`test/integration.test.js` proves those identities and counts survive into the cycle's sealed raw
inputs. The deterministic replay in `docs/evidence/fr-005/OLD_VS_NEW_REPLAY.json` records actual
boundary bar objects and hashes:

| Lookback | Before SHA-256 | After SHA-256 | Result |
|---:|---|---|---|
| 120 | `7fe334790bea1669bfa457b4cb65dcc1c2f81661bf19ec0ec1305a62434e4394` | same | byte-identical |
| 252 | `fa01df992d815626b9319909a9e8539a6a4f0cbde1f87cd0366d0975d57fcf65` | same | byte-identical |
| 400 | `3a4cce5a127d1b9f565d82355200884f0b4edcc30e70762870507c8d1eed2c4f` | same | byte-identical |
| 504 | old refusal | `7d0f987f917697306aacda7c41dc0c37b08727e79144d55d44473c11dcba978b` | 504 exact bars |

The preserved pre-change replay hashes to
`3f6660730366e55da170009c1bd838dfd77634b79c29aa39a6e7463035ae5701`.
Running `tools/replay-fr005.mjs` reproduces the submitted comparison.

## 5. State-discrimination and fail-closed behavior

| Normalized result | State | Gate effect |
|---|---|---|
| 504 or more available, lookback 504 | history verified | Consumer may continue to later gates |
| Exactly 503 | `SCHWAB_HISTORY_SHORT:503` | Refused |
| Invalid or duplicate bars reduce normalized count below minimum | `SCHWAB_HISTORY_SHORT:N` | Refused |
| Provider marks response empty | `SCHWAB_HISTORY_SHORT:N` | Refused |
| Transport or adapter throws | named error | Refused |

No threshold is reduced and no malformed record is counted. The packet changes a number and a
verdict only for a consumer that previously received 502 valid bars despite requiring 504. It
does not change numerical inputs for 120-, 252-, or 400-bar consumers.

This is the third observed case in the audit where a gate rejected 100% of a diverse population
because of an upstream boundary: Nasdaq `1002` parsing, the delta-band input, and the two-year
history request. The diagnostic rule remains: investigate the shared boundary while the gate
stays closed; never loosen the gate because the rejection rate is high.

## 6. Forbidden-directive and authority guard

Not applicable as a rendered-copy guard: FR-005 has no UI or lifecycle language. It cannot propose,
approve, submit, replace, cancel, or route an order. Authority remains 2 and the read-only broker
boundary is untouched.

The relevant structural guard is the exact 504 minimum. The new 503 test proves the request
expansion cannot be mistaken for permission to soften the gate.

## 7. Test execution and count reconciliation

Full packet branch:

```text
total 391 · passed 391 · failed 0 · unloaded 0
declared files 22 · loaded files 22
```

Each file's total, passed, failed, unloaded, and exit status is recorded in
`docs/evidence/fr-005/FILE_TEST_COUNTS.txt`. The per-file totals sum to 391.

Untouched freeze `55052d32` under the same locked dependencies:

```text
total 387 · passed 387 · failed 0
```

FR-005 adds four tests, accounting exactly for `387 → 391`. A2's 392 is a sibling branch based on
the same freeze and includes five Mandate State panel tests; A2 is not FR-005's parent. Therefore
`391` is not a one-test loss from A2. The branch-forward integration gate must later run the
combined suite and account for its new total.

Targeted source and integration run:

```text
total 98 · passed 98 · failed 0 · unloaded 0
```

## 8. Worker dry-run and artifact identity

Command:

```text
npx wrangler deploy --dry-run --config cloudflare/wrangler.jsonc --outdir <temporary-directory>
```

Wrangler `4.125.0` result:

```text
exit 0
Total Upload: 1731.53 KiB / gzip: 360.02 KiB
--dry-run: exiting now
```

Dry-run entry bundle SHA-256:
`041f45c207408c6c68ee960e8f0448e0f17396cbae911dac4ccbb829e0788643`.
The map and README hashes are recorded in
`docs/evidence/fr-005/DRY_RUN_ARTIFACT_SHA256.txt`. No deployment occurred.

## 9. Rendered markup or screenshot

Not applicable. FR-005 changes a read-only market-history boundary and sealed evidence inputs. It
has no rendered surface. The exact serialized old/new contract appears in
`docs/evidence/fr-005/OLD_VS_NEW_REPLAY.json`.

## 10. Submission SHA-256 manifest

The final manifest is `docs/evidence/fr-005/SHA256SUMS`. It covers every changed source, test,
replay tool, packet, and evidence artifact except itself. It is regenerated after the final diff is
staged and then verified. Its own digest and final staged diff-stat are reported with the audit
submission.

## Corroborating production evidence

The prior live audit found 194 of 198 symbols returned exactly 504 bars, including SPY, AAPL, TLT,
SLV, and GDX. Three were unavailable; one newly listed symbol returned 14. That breadth supports a
shared request-window defect rather than a market-wide absence of history. This packet does not
convert those observations into fixtures or claim live parity; it preserves them as corroboration.

## Deployment and rollback

No deployment is authorized. If later approved, FR-005 must deploy alone from the verified
branch-forward successor, be byte-compared to the tested bundle, and be verified before the next
packet. Rollback is the immutable Worker version immediately preceding that deployment. No schema
or stored-data rollback is required. Older sealed decisions retain their old history identity;
new decisions carry `SCHWAB_PRICE_HISTORY_3Y_V2`, so replay does not infer the governing contract.
