# Preview response capture — local draft, production HOLD

Historical draft note: retention choice was subsequently approved. See
`LANE_1_PREVIEW_CAPTURE_RELEASE.md` for the encrypted two-artifact release.

2026-08-31. Base Git: `aab2f6e8f677fbc41f5435268218880c5870081e`.
Live version checked: `98f7b19a-7874-49e9-b3a3-7f1a697acaa4`, 100%.
No upload, deployment, new ingress, preview click, or ARM in this work.

## Narrow change

The stored-ingress preview now requires an EVIDENCE capture callback. The callback
receives the complete Schwab response before JSON parsing or semantic checks.
The outgoing request, parser acceptance checks, broker transport allowlist,
coordinator behavior and all authority settings remain unchanged.

The draft stores a unique `response.body` plus `manifest.json` in the existing
EVIDENCE bucket. It stores the full response entity, not HTTP framing. The manifest
binds the bytes to source ingress ID/time, TV body hash, request hash, Worker
version, response status/content type, acquisition time, size and SHA-256.
R2 writes are conditional (no replacement); the complete body is read back and
its SHA/size verified. D1 stores the reference and summary, not the full body.
No raw body, request headers, bearer token or account-path URL is logged or
returned to the dashboard. The response itself may contain sensitive identifiers.

Memory is bounded to an 8 MiB capture limit. A larger or broken stream refuses
without saving a truncated receipt. The existing 1 MiB JSON parsing limit remains:
a complete 1–8 MiB body is saved, but not parsed. Invalid UTF8 is retained exactly
and refused. Failed R2 capture cannot clear; failed D1 receipt writing does not
erase an already saved R2 response. No automatic broker retry is added.

## Production-data handling decision is unresolved

The Principal's later audit suggests redacting identifiers **before** storage,
while the earlier request requires the exact original bytes and matching SHA.
Those are different artifacts. The current local draft is exact-byte capture;
it is NOT approved for production under the new redaction requirement.

Read-only Cloudflare checks confirm the evidence bucket's r2.dev public access
is disabled and it has no custom domains. Private storage is not the same thing
as redaction. Do not deploy this draft until the owner resolves retention:

- Original exact bytes retained privately (or encrypted), plus a separately
  redacted inspection copy; each artifact has its own hash.
- Redacted-only retained payload, with separately named original-response and
  stored-redacted-payload hashes. Original bytes cannot then be recovered.

Never claim that a raw-response hash authenticates redacted bytes.

## Test rule

Synthetic/document-derived fixtures test failure handling and mechanics only.
They are NOT evidence of live Schwab response compatibility or a release gate
for the semantic response mapping. Mapping requires a captured production
response (sanitized fixture preserving field paths and types), with wrong-value,
wrong-type, missing-field and conflicting-field negative tests.

The Worker-runtime test caught unknown-length stream rejection by R2 which the
memory mock did not catch. The draft now uploads bounded, complete byte arrays;
the actual local workerd/R2 test passes and verifies no-overwrite behavior.

## Next receipt inspection — no mapping guesses

Only after the retention choice and a separately resumed approved capture run:
use existing morning ingress `327c1bcb-e57c-4f9e-9611-5f94a3ef076f` once while both
ARM keys are off. Save the receipt even if current parsing returns 422. Report:

- First actual response line (redacted display if needed), with HTTP status.
- Root keys, actual first-leg location and keys, and redacted first-leg object.
- Every observed value's type, distinguishing absent, null, arrays, numbers,
  numeric strings, and nested objects.
- Exact symbol and quantity paths/types/values, without substituting request data.
- Presence/type/value of rejection and review fields, including alternative names
  actually present (do not invent empty arrays).
- Current parser result, one preview, zero order dispatches, ARM still off.

Do not change the mapping or widen the asset allowlist in this capture-only patch.
No additional live check or ARM until explicitly resumed.
