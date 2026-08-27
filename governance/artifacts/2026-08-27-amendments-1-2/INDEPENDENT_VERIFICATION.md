# Independent Verification — Amendment 1 and Amendment 2 Originals

**Date:** 2026-08-27
**Classification:** Preservation only
**Base:** `55052d32ab03c3eb46b8c8a8af52770b479428a5`
**Governance effect:** None

## Result

The original Amendment-1 and Amendment-2 `.docx` binaries were transferred into this environment, extracted through an exact filename allowlist, and hashed without opening or resaving them. Both independently recomputed SHA-256 digests match the previously reported values exactly.

| Artifact | Bytes | SHA-256 | Result |
|---|---:|---|---|
| `AMENDMENT_1_LIVE_UNIVERSE_SCAN_2026-08-27.docx` | 13,889 | `bff748201613d6a1cf1e57d3645324a6807f57541b577925ca7eb63b1024738f` | VERIFIED |
| `AMENDMENT_2_MIN_MARKET_CAP_4B_2026-08-27.docx` | 13,086 | `2615a55b559d759a0ed053b775943eb95c137af9f2a2f2aaeb5775b4ecbf580b` | VERIFIED |

Transfer container: `AMENDMENT_1_AND_2_ORIGINALS_2026-08-27.zip`
Transfer container SHA-256: `babd0998882c8670c34eb323f34c64b7f5146c39e5bbe00b882ed602cc78f4fe`
Transfer container size: 22,220 bytes

The transfer ZIP and both DOCX ZIP containers passed CRC validation. The transfer ZIP is recorded as provenance but is not committed because it duplicates the two preserved canonical binaries.

## Finding disposition

`AMENDMENT_ARTIFACTS_NOT_INDEPENDENTLY_VERIFIABLE` is **RESOLVED**.

Resolution required manual transfer between isolated environments. The recurrence risk is therefore retained: canonical governance artifacts had existed outside version control and could not be independently verified until transferred.

## Chain consequence

The predecessor artifacts for Amendment-1 and Amendment-2 are now independently reproducible from version control. This closes their binary-provenance gap. It does not sign or activate Amendment-4, does not make draft Amendment-3 a predecessor, and does not change any runtime, policy value, Worker artifact, database, or authority level.

## Amendment-4 audit update

Any Amendment-4 audit statement that these two originals are `unavailable` is superseded by this verification. The audit source itself was not present in the canonical checkout at the time of this preservation change, so it was not silently reconstructed or edited here. It should cite this record and the transfer-container digest when next revised.
