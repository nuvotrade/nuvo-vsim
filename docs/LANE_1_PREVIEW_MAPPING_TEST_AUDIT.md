# Mapping packet — test substitution and negative-control audit

2026-08-31. Baseline Git `86df03d8eb86ed7cbbeab84296cc14c31ba16819`. Baseline was rerun from its own exported source; the candidate ran from the reviewed working tree.

## Accounting

- Full suite: **549 → 572**, 66 suites, zero failures/skips on both runs.
- **23 added; 0 removed.** Thirteen negative titles renamed from `documented` to `live-derived`; one synthetic positive case replaced in place with the unchanged captured-body compatibility case. Those 14 are not counted as new tests.
- **64 existing tests changed** through direct test edits and/or the shared fixture. All 64 are named below. The other 485 baseline tests remain unchanged.
- Two touched test modules: 86 baseline tests → 109 candidate tests; 22 of the original tests in these modules unchanged.
- Additional negative controls: **12/12 deliberate implementation defects detected** by selected tests. These are separate mutation runs, not inflated into the 572 suite count.

## Exact bulk-substitution scope

Only `test/lane-1-ingress-preview.test.js` and `test/lane-1-production-adapters.test.js` were passed to the mechanical substitution. No production source, fixture file, or other test file was passed.

Both files contain expected-refusal assertions. Both contain `assert.rejects`; the adapters file also contains `assert.throws`. Neither contains `doesNotMatch`. No expected HTTP 422, fault-code literal, throws/rejects assertion, or zero-network assertion was mechanically changed.

The adapters substitutions renamed only the imported fixture helper and two calls. The ingress substitutions renamed fixture calls, moved quantity/symbol mutations to their observed response paths, and replaced successful-contract deep equality with a stricter dedicated assertion that separately validates both asset values against the explicit allowlist and their equality. Subsequent additions were explicit patches.

## Did a previously passing test pass for a different reason?

**Yes, deliberately and named—not hidden.** The successful-preview cases now accept the captured response shape: order-level numeric quantity, instrument symbol, and matching ETF asset types. The old synthetic shape is not the compatibility authority. The captured unchanged BUY case would fail the previous parser; restoring that parser in memory makes the positive test fail.

Existing wrong/missing symbol negatives now corrupt/remove `instrument.symbol`; quantity negatives now corrupt order-level `quantity`. Their meaning remains wrong/missing symbol and non-one/nonnumeric size. Since missing `finalSymbol` and leg quantity are VALID in the real response, their absence must not itself be rejected. New explicit legacy-fallback tests prove those old fields cannot substitute for a missing required live path.

The existing OPTION-leg mutation now violates both the asset allowlist and agreement with the unchanged ETF instrument. To avoid relying on that double fault, a new mutation sets BOTH asset fields to OPTION; another sets both to the same unknown value. Both refuse, and removing the allowlists makes the unknown-assets test fail.

All pre-existing absent/null validation cases, nonempty reject/review cases, zero-/multi-leg cases, and string-quantity refusal retain their refusal expectations. The mutation checks below distinguish real guard coverage from a test that happens to pass because some other part of its input is invalid.

## Existing changed tests — every name

- capture failure never clears a preview and never retries Schwab
- failed preview saves reject and exact raw hash without relaxing the gate
- failed preview saves review and exact raw hash without relaxing the gate
- failed preview saves null and malformed arrays and exact raw hash without relaxing the gate
- failed preview saves missing validation and exact raw hash without relaxing the gate
- warnings alone still clear an exact preview; success does not write a refusal receipt
- exact preview clears with both rejects and reviews omitted; receipt retains omission, warning, and raw hash
- exact preview clears with only rejects omitted; receipt retains omission, warning, and raw hash
- exact preview clears with only reviews omitted; receipt retains omission, warning, and raw hash
- exact preview clears with all optional lists omitted; receipt retains omission, warning, and raw hash
- preview refuses explicit rejects=null instead of treating it as omitted
- preview refuses explicit rejects="not an array" instead of treating it as omitted
- preview refuses explicit rejects={} instead of treating it as omitted
- preview refuses explicit rejects=0 instead of treating it as omitted
- preview refuses explicit rejects=false instead of treating it as omitted
- preview refuses explicit reviews=null instead of treating it as omitted
- preview refuses explicit reviews="not an array" instead of treating it as omitted
- preview refuses explicit reviews={} instead of treating it as omitted
- preview refuses explicit reviews=0 instead of treating it as omitted
- preview refuses explicit reviews=false instead of treating it as omitted
- preview refuses explicit warns=null instead of treating it as omitted
- preview refuses explicit warns="not an array" instead of treating it as omitted
- preview refuses explicit warns={} instead of treating it as omitted
- preview refuses explicit warns=0 instead of treating it as omitted
- preview refuses explicit warns=false instead of treating it as omitted
- preview refuses explicit alerts=null instead of treating it as omitted
- preview refuses explicit alerts="not an array" instead of treating it as omitted
- preview refuses explicit alerts={} instead of treating it as omitted
- preview refuses explicit alerts=0 instead of treating it as omitted
- preview refuses explicit alerts=false instead of treating it as omitted
- preview refuses a non-object validation result null
- preview refuses a non-object validation result []
- preview refuses a non-object validation result "malformed validation"
- preview refuses a non-object validation result true
- preview refuses a non-object validation result 42
- a nonempty rejects list blocks even when the other list is omitted and severity says WARN
- a nonempty reviews list blocks even when the other list is omitted and severity says WARN
- omitted lists cannot bypass echoed contract: LIMIT order; mismatch is retained
- omitted lists cannot bypass echoed contract: TRIGGER strategy; mismatch is retained
- omitted lists cannot bypass echoed contract: extended session; mismatch is retained
- omitted lists cannot bypass echoed contract: GTC duration; mismatch is retained
- omitted lists cannot bypass echoed contract: second leg; mismatch is retained
- omitted lists cannot bypass echoed contract: child order; mismatch is retained
- omitted lists cannot bypass echoed contract: SELL instruction; mismatch is retained
- omitted lists cannot bypass echoed contract: quantity two; mismatch is retained
- omitted lists cannot bypass echoed contract: wrong symbol; mismatch is retained
- omitted lists cannot bypass echoed contract: option asset; mismatch is retained
- omitted lists cannot bypass echoed contract: missing symbol; mismatch is retained
- schema mapping: documented Schwab orderLegs response clears only the exact stored BUY SPY one-share ticket → production-byte mapping: unchanged redacted live BUY SPY one-share body with warns only clears
- documented response mapping fails closed on quantity true → live-derived response mapping fails closed on quantity true
- documented response mapping fails closed on quantity "1" → live-derived response mapping fails closed on quantity "1"
- documented response mapping fails closed on quantity 0 → live-derived response mapping fails closed on quantity 0
- documented response mapping fails closed on quantity 1.1 → live-derived response mapping fails closed on quantity 1.1
- documented response mapping fails closed on quantity null → live-derived response mapping fails closed on quantity null
- documented response mapping fails closed on legs null → live-derived response mapping fails closed on legs null
- documented response mapping fails closed on legs {} → live-derived response mapping fails closed on legs {}
- documented response mapping fails closed on legs [] → live-derived response mapping fails closed on legs []
- documented response mapping fails closed on malformed children null → live-derived response mapping fails closed on malformed children null
- documented response mapping fails closed on malformed children {} → live-derived response mapping fails closed on malformed children {}
- documented response mapping fails closed on malformed children false → live-derived response mapping fails closed on malformed children false
- documented response mapping fails closed on legacy-only request-shaped echo → live-derived response mapping fails closed on legacy-only request-shaped echo
- documented response mapping fails closed on mixed response and request leg shapes → live-derived response mapping fails closed on mixed response and request leg shapes
- market preview clears BUY and disables only SHORT on a SELL_SHORT failure while OFF
- market preview retains SHORT only when BUY and SELL_SHORT both clear exactly

## Added tests — every name

- live inspection fixture reproduces its canonical hash and names the encrypted original parent
- two live-derived legs with order-level quantity exactly one refuse
- nonempty rejects added to the live warns-only body refuses
- nonempty reviews added to the live warns-only body refuses
- explicit EQUITY on both live-derived asset paths also clears
- live-body negative mutation refuses: missing order quantity
- live-body negative mutation refuses: legacy leg quantity cannot replace missing order quantity
- live-body negative mutation refuses: legacy finalSymbol cannot replace missing instrument symbol
- live-body negative mutation refuses: symbol number
- live-body negative mutation refuses: symbol lowercase
- live-body negative mutation refuses: symbol array
- live-body negative mutation refuses: quantity object
- live-body negative mutation refuses: empty legs
- live-body negative mutation refuses: missing instrument
- live-body negative mutation refuses: null instrument
- live-body negative mutation refuses: missing leg asset
- live-body negative mutation refuses: missing instrument asset
- live-body negative mutation refuses: unknown assets agree
- live-body negative mutation refuses: OPTION assets agree
- live-body negative mutation refuses: leg asset null
- live-body negative mutation refuses: instrument asset array
- live-body negative mutation refuses: allowed assets disagree leg EQUITY
- live-body negative mutation refuses: allowed assets disagree instrument EQUITY

## Negative controls: healthy PASS, defective implementation FAIL

The runner `scripts/check-preview-mutations.mjs` applies one targeted source mutation in memory inside a child process. It asserts the selected test passes normally and fails with an assertion under the mutation. No application source is rewritten; no live request or deployment occurs.

| Deliberately introduced defect | Test that detects it |
|---|---|
| Remove numeric quantity guard | missing order quantity |
| Coerce quantity with Number() | quantity `"1"` |
| Accept old leg quantity as fallback | legacy leg quantity cannot replace missing order quantity |
| Remove symbol guard | missing symbol |
| Accept finalSymbol fallback | legacy finalSymbol cannot replace missing instrument symbol |
| Remove exactly-one-leg check | two live-derived legs with order-level quantity exactly one refuse |
| Ignore nonempty rejects | nonempty rejects added to live warns-only body |
| Ignore nonempty reviews | nonempty reviews added to live warns-only body |
| Remove both asset allowlists | unknown assets agree |
| Remove asset agreement | allowed assets disagree leg EQUITY |
| Restore old wrong parser mapping | unchanged captured-body positive case |
| Restore old wrong receipt quantity projection | unchanged captured-body positive case |

Every row detected its defect: 12 of 12. This supports the specified guard claims, not a claim of exhaustive mutation coverage.

## Fixture identity

`test/fixtures/schwab-preview-20260831.inspection.json` contains the saved live inspection object, with a text-file trailing newline. Canonical serialization exactly reproduces SHA `ee10f96829bee206f98ed6013b0bd6b8ab143a49078d71da157412b05d02131f`. Its parent original SHA is `73646c14e46642dee8d9dd752cc11efb561d70501eb34c13b611439697ccd3a4`. The test checks both identities and the versioned removed paths.

Only the unchanged BUY projection is a production fixture. Alternate instructions, EQUITY classification, and malformed responses are explicitly synthetic mutations of it. No claim is made that a live SHORT preview has been captured or approved.

