# NUVO VSIM V5 authority-storage recovery — 2026-08-27

## Release identity

- Worker: `nuvo-vsim-v5-shadow`
- Worker version: `c909de83-308c-4a56-9336-5db2edf0b463` (version 126)
- Version creation: `2026-08-27T07:13:19.688632Z`
- Code commit that produced the Worker artifact: `b9474f218042497331e530424babcb1f23d7d3ab`
- Worker entry size: `1,771,781` bytes
- Worker entry SHA-256: `7e9b775c59d7c84cf34e673162284fe1e702ae38445809b1c5a92bf13315067e`
- Cloudflare script ETag: `6333858ec976fac4f6c9651e2a57cee42830aadf2b98061236b7cadf241a9208`

The downloaded live Worker entry and the tested local dry-run entry match byte for byte.

## Incident corrected

Authority 2 became active while `evidence_index.authority_level` still accepted only Authority 1. The last successful pre-recovery seal was sequence 61 at `2026-08-26T16:15:49.084Z`. Persistence failures were presented as plausible `NO DATA` refusals, and the System surface showed a valid but stalled 62-record chain without an expected-cadence alarm.

This release corrects the first part of the incident:

1. authority configuration is required and validated at the runtime boundary;
2. opaque validated-authority tokens are required by guards, promotion, and demotion paths;
3. missing, malformed, out-of-range, and unvalidated values produce `SYSTEM_FAULT` rather than a denial or degraded Shadow state;
4. stored authority values are revalidated on replay;
5. `evidence_index` and `cycle_context_index` accept the full constitutional storage ladder, Authority 0 through 5;
6. runtime capability gates remain the enforcement boundary.

Stream-cadence monitoring and full persistence-fault classification remain separate follow-up work. Until those land, a visible refusal must still be checked against Worker logs and evidence advancement.

## Database preservation and migration

Checkpoint directory:

`/Users/nuvo/Documents/Codex/2026-08-23/vsim-v5-checkpoints/2026-08-27-authority-storage-release`

Fresh pre-migration export:

- File: `d1-pre-authority-storage-migration.sql`
- SHA-256: `54f20ff527ef9bde144b6d97e5c5a6fd8837947cdf297437f8cb8f00fd7f1d95`
- Size: `16,209,012` bytes

The exact pre-migration export restored locally and accepted the rehearsed migration. Verification passed with integrity `ok`, zero foreign-key errors, unchanged row counts, both owner-created indexes present, sequences 0–61 contiguous, zero predecessor-link errors, and the expected head `163fd237cbcf143cb1311a353bbfb69370726b552ec60825f8115372b3563e8f`. Both migrated tables accepted Authority 0 and 5 and rejected -1 and 6.

The validated-authority Worker was deployed before the database constraint was widened. This avoided an interval where Authority-2 sealing could resume under the former fail-open guards.

Post-migration export, captured before the proof calculation:

- File: `d1-post-authority-storage-migration.sql`
- SHA-256: `e2fd8ae7ab2a2d40104cd92cd821686458103ffe611c7ac2b5b015e080a27ae0`

That export restores with integrity `ok`, zero foreign-key errors, 62 evidence records, 64 cycle contexts, sequences 0–61, and the original sequence-61 head. It is the rollback baseline for the schema migration.

## Live proof

A proxied `POST /api/cash-secured-put/calculate` was issued through `https://vsim.nuvotrade.co/` after migration. The Worker log showed HTTP 200, no exception, and no constraint error. The closed market session produced a real `NO DATA` refusal and sealed sequence 62:

- Cycle: `CY-ba629ba31c-SESSION-20260827`
- Authority: 2
- Decision: `REFUSED`
- Model stamp: `nuvo-model-5.0.1-execution-cost-v2`
- Evidence hash: `64cf62dea58b29466455853f356c31a75b3c224bd469e49b662db5827827efdb`
- Prior head: `163fd237cbcf143cb1311a353bbfb69370726b552ec60825f8115372b3563e8f`
- New head: `d116cf612234caac69736f0c8fe03ce9f8377f6212b9be83d979989217d43fc7`
- Created: `2026-08-27T07:17:42.515Z`
- R2 object SHA-256: `e0bd3803e83d03648ccd86ce8b85964f57f5767f52c22d6f26d07ec4a7c93346`

The downloaded package passes its full evidence hash, decision fingerprint, and chain-hash checks. Its raw inputs are captured. D1 contains 63 indexed evidence records, sequences 0–62, with zero predecessor-link errors.

## Verification performed

- Full test suite: 387 tests passed across 66 suites; 0 failures.
- Storage migration tests accept every Authority level 0–5 and reject values outside that range on both tables.
- Invalid authority cannot suppress demotion; a valid Authority-5 integrity failure demotes to Authority 0.
- Missing and malformed configuration stop scheduled work before D1 access.
- Plain numbers and deserialized lookalikes cannot satisfy the validated-authority boundary.
- Local dry-run and downloaded live artifact match byte for byte.
- Fresh pre-migration backup restored and migration rehearsal passed.
- Live schema contains `CHECK(authority_level BETWEEN 0 AND 5)` on both tables.
- Post-migration export restored with integrity and foreign-key checks passing.
- Sequence 62 sealed at Authority 2 and carries `execution-cost-v2`.

## Rollback

Rollback Worker code without rebuilding:

```bash
cd /Users/nuvo/Documents/Codex/2026-08-23/referenced-chatgpt-conversation-this-is-an-2/work/claude-review.8xjXJ5
npx wrangler rollback 4ae60e00-cc0b-46cc-aaa9-e93353599d32 \
  --name nuvo-vsim-v5-shadow \
  --config cloudflare/wrangler.jsonc \
  --message "Rollback authority-storage recovery Worker" \
  --yes
```

Do not roll back the Worker alone while leaving `NUVO_AUTHORITY_LEVEL=2`: the predecessor cannot seal Authority-2 evidence under the old schema semantics and retains the authority-validation defects corrected here.

Restore the pre-migration database only if the schema migration itself must be reversed, and only after stopping Authority-2 writers. Restoring it discards sequence 62 and any later valid history. The source backup and its checksum are in the checkpoint directory above.

No DNS, Pages binding, Access policy, Schwab OAuth registration, scheduler, storage binding, Guardian cadence, Discord behavior, Telegram behavior, order route, or broker mutation authority changed in this release.
