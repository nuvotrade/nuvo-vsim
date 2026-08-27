# Preservation Record — Signed Amendment 3 Revision 1 and Amendment 4

**Date:** 2026-08-27
**Classification:** Preservation only
**Runtime effect:** None
**Authority effect:** None

## Verified signed identities

| Artifact | Bytes | SHA-256 | Document state |
|---|---:|---|---|
| `AMENDMENT_3_REV1_FORWARD_EVENT_SOURCE_SIGNED.md` | 9,191 | `a39b9a261aa20254999f9bbfca39a93abfaeac7174ceeb6bc048eae350785148` | SIGNED — PENDING IMPLEMENTATION GATES |
| `AMENDMENT_4_NO_TENOR_FLOOR_SIGNED.md` | 11,049 | `741735baeab2eea567a1c91dc894be42c5fea62b99496fdfca792a745cfaee07` | SIGNED — PENDING IMPLEMENTATION GATES |

## Byte provenance

Amendment-4 was available as a downloaded signed original and matched its declared size and digest directly. Its separately transported attachment text was one byte shorter because the text transport omitted the terminal line feed; restoring that single byte independently reproduced the same signed digest.

Amendment-3 Revision 1 was available through the attachment text transport. The transported payload was 9,190 bytes and did not end in a line feed. Appending exactly one terminal LF produced a 9,191-byte stream whose SHA-256 exactly matches the declared signed digest. No other byte was added, removed, reordered, or normalized.

The expected digest is the acceptance boundary: this record does not claim that arbitrary reconstructed text is an original. It records a uniquely bounded one-byte transport normalization that reproduced the signed identity exactly.

## Governance state

Both amendments are signed and neither is active. This commit does not evaluate, waive, or complete any implementation gate. It does not deploy code, change configuration, change authority, admit a universe member, remove `minDte`, or activate the compensating earnings adapter.

No predecessor relation between Amendment-3 Revision 1 and Amendment-4 is invented here. Each document's own chain and supersession statements remain controlling.
