# Lane-1 failed-preview receipt — 2026-08-31

## Scope and authority

Principal authorized an evidence-only patch, deployment, and one VALIDATE of
ingress `327c1bcb-e57c-4f9e-9611-5f94a3ef076f`. No new TradingView alert, ARM,
broker order, relaxed validation, or cleanup is authorized by this change.

Base source: `762769cd2f5d9e4d8812663b947191fa49c67eb9`.
Prior deployment: `aef94f8c-d869-4ad2-a308-27f89d730551` at 100%.
Prior bundle SHA-256: `fd4f4ebf50dba33fea86561b428c1fa1abf011561b82e4b13085b750344ae890`.

## Behavioral difference

Only the non-CLEAR branch of `previewStoredLane1Ingress` changes. Before its
HTTP 422 response it now awaits an append-only `LANE_1_ORDER_PREVIEW_REFUSED`
record in the existing `operational_audit` table. The receipt binds to the
original ingress ID, source timestamp, SPY/1 replay body and TV binding hash.
It records the original fault, request hash, recomputed raw-response hash,
Schwab rejects/reviews/warns/alerts, and whether those fields were missing,
null, arrays, or another type. The authenticated refusal response includes
the new receipt ID. Failure to write the receipt is explicitly named and
retains the original preview fault separately; it never claims saved evidence.

No raw broker body, account/token fields, webhook secret, or authorization
headers are stored by this patch. The selected validation fields retain the
broker's contents. Historical ingress and preview rows are not edited.

The Schwab client, clear criteria, order builder, preview-only destination
guard, coordinator, ARM controls, TV ingress, retired routes, dashboard,
Wrangler configuration, secrets, bindings, crons, and master remain unchanged.
No migration is required. A refusal receipt is NOT a successful preview proof.

## Verification

Baseline: 467 passing tests. Candidate: 476 passing tests, nine added.
Added coverage: actual rejects, reviews, missing arrays, null/malformed arrays,
missing validation, malformed JSON, non-2xx rejection, receipt storage failure,
and warnings-only success. Tests assert one mocked preview, no `/orders`
network call, no coordinator claim or mutation, unchanged ingress, exact
raw hash, no credentials/full payload persisted, and unchanged clear criteria.

## Rollback

From this repository, restore the prior version without touching D1 or ARM:

```sh
node node_modules/wrangler/bin/wrangler.js rollback aef94f8c-d869-4ad2-a308-27f89d730551 --config cloudflare/wrangler.jsonc --message "Rollback preview refusal receipt patch" --yes
```

Verify 100% on that version and OFF/DISARMED after rollback. Existing refusal
receipts remain append-only evidence; do not delete them. Never deactivate or
rotate the shared Schwab OAuth application as part of this operation.
