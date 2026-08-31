# LANE_1 four-action deployment record — 2026-08-31

Status: **DEPLOYED DISARMED. No webhook, preview, alert, ARM action, or order in this deployment.**

## Identity

| Item | Identity |
| --- | --- |
| Runtime source Git | `ffe157a0c0e23fbd43078a64d613e4fd82e445e8` |
| Evidence packet Git | `0984db06d940cff76b514089a38318e5582c98d9` |
| Candidate bundle | `b5dce61b1a129a8843f1b5392036e8cd241602b56cd9661830b3494bc9090e86` · 1,984,156 bytes |
| Previous version / rollback | `42a4f738-5e2e-4e69-8c91-c451a609b3a7` |
| New version | `2376a4a9-6ca4-4943-8e28-a15294bf68e3` · version 161 |
| New deployment | `7c0cb12a-db26-4953-961b-2daf2ef37d46` |
| Traffic switched | `2026-08-31T21:14:55.052811Z` |
| Worker | `nuvo-vsim-v5-shadow` · **100% new version** |

The uploaded version was tagged `lane1-four-action-ffe157a0`. Traffic changed in
one switch from 100% `42a4f738…` to 100% `2376a4a9…`. No split remains.

## D1 retired-alias inventory — exact stored message word

Read-only query against remote D1 `nuvo-vsim-v5-shadow` at
`2026-08-31T21:11:40.555Z`:

```sql
WITH ingress AS (
  SELECT id, created_at, json_valid(detail_json) AS valid_json,
    json_extract(CASE WHEN json_valid(detail_json) THEN detail_json ELSE '{}' END,
      '$.replayBody.side') AS stored_message_side
  FROM operational_audit
  WHERE event_type = 'LANE_1_TV_INGRESS'
), affected AS (
  SELECT id, created_at, stored_message_side
  FROM ingress
  WHERE stored_message_side COLLATE BINARY IN ('LONG','SHORT','EXIT')
  ORDER BY created_at, id
)
SELECT COUNT(*) AS total_count, MIN(created_at), MAX(created_at),
  json_group_array(json_object('id',id,'created_at',created_at,
    'replayBody.side',stored_message_side)) AS rows_json
FROM affected;
```

Result: **0 rows**; IDs `[]`; first date `null`; last date `null`.
The table held three total ingress rows and zero malformed ingress JSON rows.
Cloudflare reported `rows_written: 0`, `changed_db: false`. This query ignores
cleaned display fields and all preview receipts, including receipt `eba4d1ac…`
whose historical internal `signal: LONG` is not a stored message word.

The selected dashboard row was separately read by ID after deployment:
`de0d86ad-68a2-4263-96e8-2d5e4473dda5`, created
`2026-08-31T19:55:03.005Z`, event `LANE_1_TV_INGRESS`, SPY / BUY / numeric 1,
binding `21baaecb3006248b6bf21c186684c855d55e5255b5c004970033221762a2188c`.
It is not a retired alias. The SELECT read one row and wrote zero.

## Live preconditions

- Predecessor: `42a4f738…` measured at **100%** before upload.
- Bindings: predecessor and candidate each had **49**; all 49 serialized binding
  records were byte-for-byte equal after sorting by name. Runtime settings were
  also equal. Secret **names only** were accounted for; values were neither read
  nor recorded. Environment `NUVO_LANE_1_SPY_ARMED` was `OFF` in both versions.
- Runtime: compatibility date `2026-08-26`, flag `nodejs_compat`, migration `v1`.
- Dashboard: `DISARMED` at `2026-08-31T21:14:38.183Z` immediately before switch.
- Broker position: authenticated Schwab Positions UI, account …315 selected,
  reported updated `2026-08-31 5:11:47 PM ET`. The complete positions table and
  Positions Total were visible; SPY was absent. Deployment precondition recorded
  as **SPY long quantity 0, short quantity 0, FLAT — BROKER_UI_OBSERVED**. The
  Principal independently asserted SPY quantity zero. The earlier unavailable
  Schwab screen was not treated as an empty position list.

The broker observation is a signed-in UI observation, not an API receipt and not
coordinator state. Unrelated holdings are intentionally omitted from this record.

## Post-switch proof

- Cloudflare: deployment `7c0cb12a…`, version `2376a4a9…`, **100%**.
- Custom-domain dashboard reload: footer showed `Dashboard 2376a4a9-6ca`.
- Dashboard coordinator: **DISARMED** at `2026-08-31T21:15:29.807Z`.
- Environment on deployed version: **ARM OFF**.
- Selected row remained `de0d86ad…`; VALIDATE was not pressed.
- No TradingView alert was edited/authored/fired. No `/lane/tv` request, Schwab
  preview, `/orders` call, real order, or ARM/DISARM action was performed.

## Rollback and remaining sequence

Named rollback, **not executed**:

```sh
WRANGLER_SEND_METRICS=false node_modules/.bin/wrangler rollback 42a4f738-5e2e-4e69-8c91-c451a609b3a7 --config cloudflare/wrangler.jsonc
```

Next work remains separately controlled: Principal authors the two 5-minute short
alerts using exact `SELL_SHORT` and `BUY_TO_COVER` tokens; then each unproven
direction receives its own DISARMED preview/capture/decrypt/map cycle. No position
may be fabricated and ARM may not be used to manufacture preview proof.

Local proofs and this deployment do not prove Schwab accepts SELL, SELL_SHORT, or
BUY_TO_COVER; do not prove any fill; and do not prove the short alerts work—they
did not exist at deployment. **Stage 0 completes at four real fills ending flat.**

