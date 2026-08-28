# FR-005 Schwab History Caller Trace

## Governing request

`SchwabMarketProvider.history()` is the single production normalization boundary for Schwab price
history. Before FR-005 it requested two years explicitly. FR-005 changes that explicit request to
three years and gives the response contract a version identity. The lower-level client default is
left unchanged because the production provider never relies on it.

## Production consumers

| Consumer | Call site | Lookback | Minimum | Effect of FR-005 |
|---|---|---:|---:|---|
| Quote / ADV | `src/truth/providers/schwab.js` | 120 | provider default 120 | Same normalized 120-bar suffix |
| Market state | `src/truth/providers/schwab.js` | 252 | provider default 120 | Same normalized 252-bar suffix |
| Custody risk | `cloudflare/custody-risk.js` | 400 | 30 | Same normalized 400-bar suffix |
| Covered-call entry | `cloudflare/worker.js` | 400 | 121 | Same normalized 400-bar suffix |
| Covered-call lifecycle | `cloudflare/worker.js` | 400 | 20 | Same normalized 400-bar suffix |
| Cycle | `src/pipeline/cycle.js` | 400 | provider default 120 | Same normalized 400-bar suffix |
| Three-sleeve scanner | external caller contract | 504 | 504 | Changes from 502-bar refusal to 504 normalized bars when available |

Every in-repository production caller passes a lookback explicitly. Normalization sorts and
deduplicates first, then takes `.slice(-lookback)`. The preserved replay proves that 120, 252, and
400 return the exact same bar objects and SHA-256 before and after the request expansion. Only the
504-bar consumer sees a different decision input.

## Boundary disposition

- Change the shared provider's explicit request because 502 bars cannot satisfy its documented
  504-bar consumer contract.
- Do not change `cloudflare/schwab-client.js`'s two-year transport default; the production provider
  supplies an explicit period and the default is not the governing contract.
- Do not change any sufficiency threshold. Exactly 503 normalized bars still fail closed as
  `SCHWAB_HISTORY_SHORT:503`.
- Seal the source identity, request period, raw count, normalized count, and contract version in
  decision inputs. Replay revalidates stored values through the same replay boundary.

## Corroborating production audit

The prior live universe audit returned exactly 504 bars for 194 of 198 symbols, including SPY,
AAPL, TLT, SLV, and GDX. Three symbols were unavailable and one newly listed symbol returned 14
bars. The breadth of the boundary result supports an upstream request-window defect rather than a
market-wide absence of history.

This is the third observed instance in the audit where a gate rejected 100% of a diverse
population because of an upstream boundary: Nasdaq `1002` parsing, the delta-band input, and the
two-year history request. The gate remains closed while the boundary is corrected.
