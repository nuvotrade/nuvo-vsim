# Lane-1 preview — test-proof correction, no production code change

2026-08-31. Corrects the accepted audit blocker in candidate `522d863a7060811044a1cba30c49bed3c2cb56fc`. This document and its containing commit do not authorize upload, traffic switch, VALIDATE, ARM, webhook traffic, or broker orders.

## Scope and identity

Only these files change relative to the accepted mapping candidate:

- `test/lane-1-ingress-preview.test.js` — real-field OPTION refusal assertions, required-field assertion helper, one live-fixture path test.
- `scripts/check-preview-mutations.mjs` — retain the original twelve cases and add the corrected OPTION refusal as mutation 13.
- This audit document.

No file under `cloudflare/` changes. No runtime source, config, dependency, fixture bytes, routing, ARM or evidence schema changes.

First corrected working-tree dry build: SHA-256 `8ff5da076e633838ab4828ae8e0a09e491ea7c3723a45481c96d611dbd542a65`, 1,971,149 bytes. This is the **same** bundle SHA as the accepted mapping candidate, not an invented “new hash.” A clean export of the new commit must reproduce it; the external execution packet records that final check and the full new Git SHA.

Live predecessor / rollback remains `c567783f-0d50-40fa-b7c5-68e3a2cecd2e` (capture-only). No upload or deployment is part of this correction. Previously uploaded `42a4f738-5e2e-4e69-8c91-c451a609b3a7` remains annotated to the earlier candidate, not falsely relabeled as this test-fix commit.

## Corrected OPTION test

Test: `omitted lists cannot bypass echoed contract: option asset; mismatch is retained`.

Previously it compared `expected.assetType` (removed from the receipt) to `OPTION`, making that additional inequality vacuous. The parser's refusal remained intact, but this was not sufficient proof.

Now:

1. Start from the live-derived order. Set **both** `orderLegs[0].assetType` and `orderLegs[0].instrument.assetType` to `OPTION`. Setting both makes the values agree, so the agreement guard cannot conceal a broken allowlist.
2. Require HTTP **422**, fault code **SCHWAB_LANE_MARKET_PREVIEW_LONG_CONTRACT_UNVERIFIED**, and the **LANE_1_ORDER_PREVIEW_REFUSED** event.
3. Require both input paths to exist with value `OPTION`. Require receipt `actual.assetType` and `actual.instrumentAssetType` to exist and reflect `OPTION`.
4. Require exact mapped paths and exact policy `['EQUITY', 'COLLECTIVE_INVESTMENT']`, `bothPathsMustAgree:true`; require that policy to exclude OPTION.
5. Do not read `expected.assetType` at all. Other cases require their expected field to exist before inequality comparisons. Existing actual value, raw-response hash and redaction checks remain.

The test-only `ownValue` helper checks every traversed object and own field and rejects an undefined value before returning it. Missing or undefined fields cannot satisfy comparisons through this helper. Null is permitted only where a test deliberately expects the receipt's explicit null for an absent/invalid original value.

## Sweep: six assertion-changed and eight path-only cases

The unmodified captured inspection fixture is still parented to original `73646c14e46642dee8d9dd752cc11efb561d70501eb34c13b611439697ccd3a4`, canonical inspection `ee10f96829bee206f98ed6013b0bd6b8ab143a49078d71da157412b05d02131f`.

All paths below are under `orderStrategy`. The new test walks each path with own-field checks and asserts its exact value and type:

| Path | Own path exists | Value / type |
|---|---|---|
| quantity | YES | 1 / number |
| orderLegs[0].instrument.symbol | YES | SPY / string |
| orderLegs[0].assetType | YES | COLLECTIVE_INVESTMENT / string |
| orderLegs[0].instrument.assetType | YES | COLLECTIVE_INVESTMENT / string |
| orderLegs[0].instruction | YES | BUY / string |
| orderType | YES | MARKET / string |
| orderStrategyType | YES | SINGLE / string |
| session | YES | NORMAL / string |
| duration | YES | DAY / string |
| orderLegs | YES | array, length 1 |

Individual case accounting:

| Existing test | Path(s) checked in the unmodified live fixture | Deliberate change / interpretation |
|---|---|---|
| warnings alone still clear an exact preview; success does not write a refusal receipt | All nine scalar paths above; orderLegs array | All source order fields present; receipt actual/expected order fields also require own, defined values. |
| exact preview clears with both rejects and reviews omitted; receipt retains omission, warning, and raw hash | All nine scalar paths above; orderLegs array | All source order fields present; receipt actual/expected order fields also require own, defined values. |
| exact preview clears with only rejects omitted; receipt retains omission, warning, and raw hash | All nine scalar paths above; orderLegs array | All source order fields present; receipt actual/expected order fields also require own, defined values. |
| exact preview clears with only reviews omitted; receipt retains omission, warning, and raw hash | All nine scalar paths above; orderLegs array | All source order fields present; receipt actual/expected order fields also require own, defined values. |
| exact preview clears with all optional lists omitted; receipt retains omission, warning, and raw hash | All nine scalar paths above; orderLegs array | All source order fields present; receipt actual/expected order fields also require own, defined values. |
| production-byte mapping: unchanged redacted live BUY SPY one-share body with warns only clears | All nine scalar paths above; orderLegs array | All source order fields present; receipt actual/expected order fields also require own, defined values. |
| omitted lists cannot bypass echoed contract: quantity two; mismatch is retained | quantity | Present numeric 1 before mutation; then numeric 2; refusal and exact reason required. |
| omitted lists cannot bypass echoed contract: wrong symbol; mismatch is retained | orderLegs[0].instrument.symbol | Present SPY before mutation; then WRONG; refusal and exact reason required. |
| omitted lists cannot bypass echoed contract: missing symbol; mismatch is retained | orderLegs[0].instrument.symbol | Present SPY before mutation; then deliberately deleted. Receipt must contain its own symbol:null, never silently read undefined. |
| live-derived response mapping fails closed on quantity true | quantity | Present numeric 1 before mutation; replaced with the named invalid value; refusal and exact reason required. |
| live-derived response mapping fails closed on quantity "1" | quantity | Present numeric 1 before mutation; replaced with the named invalid value; refusal and exact reason required. |
| live-derived response mapping fails closed on quantity 0 | quantity | Present numeric 1 before mutation; replaced with the named invalid value; refusal and exact reason required. |
| live-derived response mapping fails closed on quantity 1.1 | quantity | Present numeric 1 before mutation; replaced with the named invalid value; refusal and exact reason required. |
| live-derived response mapping fails closed on quantity null | quantity | Present numeric 1 before mutation; replaced with the named invalid value; refusal and exact reason required. |

Leg count is derived from an existing array. Child count is a derived receipt value: the live body intentionally lacks `childOrderStrategies`, and the fixture test asserts that absence rather than pretending a child-count field exists at Schwab. The positive receipt helper requires the derived actual/expected fields to exist. Missing validation lists are separately typed as missing and represented as explicit null in the receipt; those tests assert that distinction.

The sweep found no remaining compatibility assertion consuming absent `finalSymbol`, leg-level quantity, or `expected.assetType`. Remaining legacy names are explicitly justified:

- The compatibility fixture identity test asserts that leg-level quantity and finalSymbol are **absent**, using `Object.hasOwn(...)=false`.
- Negative fallback tests deliberately inject legacy leg quantity/finalSymbol while deleting the true field; they must still refuse.
- `test/preview-evidence-codec.test.js` includes a **synthetic redaction/type-preservation input** with leg quantity string `"1"` and finalSymbol. It is not a broker compatibility fixture or release gate for parser acceptance. Those fields are explicitly present in its constructed input, and strict equality/type assertions fail if redaction loses them. It is unchanged.
- Other non-preview inequality tests found by the repository sweep concern unrelated hashes, RNG, authority or lifecycle decisions; no mapping-projection field changes reach them.

## Test delta, named

Accepted mapping candidate: **572 tests**. Corrected candidate: **573 tests**, all passing, 66 suites, no failures/skips. Relative to capture-only: **549 → 573**, cumulative +24, no removals.

One added test, no renames or removals in this correction:

- `live fixture owns every order field used by the six positive and eight path-only mapping cases`

Eighteen existing tests have stronger assertions through edited shared blocks (not eighteen newly added tests):

1. `warnings alone still clear an exact preview; success does not write a refusal receipt`
2. `exact preview clears with both rejects and reviews omitted; receipt retains omission, warning, and raw hash`
3. `exact preview clears with only rejects omitted; receipt retains omission, warning, and raw hash`
4. `exact preview clears with only reviews omitted; receipt retains omission, warning, and raw hash`
5. `exact preview clears with all optional lists omitted; receipt retains omission, warning, and raw hash`
6. `production-byte mapping: unchanged redacted live BUY SPY one-share body with warns only clears`
7. `explicit EQUITY on both live-derived asset paths also clears`
8. `omitted lists cannot bypass echoed contract: LIMIT order; mismatch is retained`
9. `omitted lists cannot bypass echoed contract: TRIGGER strategy; mismatch is retained`
10. `omitted lists cannot bypass echoed contract: extended session; mismatch is retained`
11. `omitted lists cannot bypass echoed contract: GTC duration; mismatch is retained`
12. `omitted lists cannot bypass echoed contract: second leg; mismatch is retained`
13. `omitted lists cannot bypass echoed contract: child order; mismatch is retained`
14. `omitted lists cannot bypass echoed contract: SELL instruction; mismatch is retained`
15. `omitted lists cannot bypass echoed contract: quantity two; mismatch is retained`
16. `omitted lists cannot bypass echoed contract: wrong symbol; mismatch is retained`
17. `omitted lists cannot bypass echoed contract: option asset; mismatch is retained`
18. `omitted lists cannot bypass echoed contract: missing symbol; mismatch is retained`

The first seven inherit explicit own-field/defined-value checks for actual/expected receipt fields. The final eleven gain an explicit refused-event assertion plus required actual fields; ten require their expected comparison field to exist, while the OPTION case compares its two real asset paths and the asset policy.

The previous release's textual classification remains on record: **50 fixture-only / 8 path-only / 6 assertion-changed**. Its fourteen title changes mean **13 negative-title renames, with their assertion statements unchanged, plus 1 replaced positive with added assertions**; five of the renamed negative cases also have mutation-path changes already counted in the eight path-only cases. The semantic weakness in one nominal fixture-only case is this correction's finding; it was not hidden by that text-based classification.

## Mutation proof

The original **12/12** cases pass their healthy controls and fail under their intended in-memory faults, unchanged. New case **13/13**:

- Name: `OPTION refusal guard removed`.
- Target test: the **corrected existing OPTION test**, not only the separate newer unknown-asset test.
- Fault injection: remove both asset allowlist clauses from the loaded Schwab client source in a child process.
- Both input asset fields remain OPTION, so agreement is true; without the allowlists the preview erroneously clears.
- Result: healthy test PASS; mutated test FAIL_EXPECTED at the required refusal assertion. Exactly one selected test executes; an ERR_ASSERTION failure is required, not setup/import/anchor failure.
- Application files are never rewritten by the mutation runner. These are offline test responses; no live network or broker call occurs.

The full suite includes unchanged /orders zero-network, DISARMED gating, coordinator-no-claim and retired-route controls. No claim is made of a live SHORT preview.

## Unattributed local doc change remains preserved

The separate working-copy edit to `docs/LANE_1_PREVIEW_LIVE_MAPPING_RELEASE.md` remains uncommitted, unattributed and excluded. It is not silently repaired by this correction. Its observed 643-byte SHA is `240b05d299e88a8087388a8555ae4ddd8234cd910d5bb51d2349abe332c0c551`; cause UNKNOWN. Full committed source documentation remains recoverable. This is finding F-RELEASE-DOC-01 and remains separate from the now-corrected assertion defect.

## Stop line

After committing only these test/documentation changes: rebuild from the clean commit, verify the bundle against `8ff5da07…`, record the Git SHA and exact hashes, and hand back the packet. **No traffic switch. No VALIDATE. ARM remains OFF.**

