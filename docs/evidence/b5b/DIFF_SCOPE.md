# B5B diff scope

## Runtime source

- `src/truth/providers/massive.js`
  - strict source identity and clause-3.7 consumer
  - named producer-fault preservation
  - event source-envelope return
  - earnings-only removal of the date-at-16:00 fallback
- `src/pipeline/cycle.js`
  - seals event error, fault, contract identity and complete source envelope
- `src/evidence/replay.js`
  - replays successful and refused event results without recomputation

## Tests

- `test/production_adapters.test.js`
  - source identity, required fields, named faults, split hash, envelope and refusal replay
- `test/integration.test.js`
  - event contract identity and source envelope survive into sealed cycle evidence

## Submission support

- `tools/replay-b5b.mjs`
- `docs/evidence/b5b/*`
- `docs/change-packets/B5B_EARNINGS_CONSUMER_CONTRACT.md`

## Explicit exclusions

No producer adapter, timezone conversion, empty-result freshness comparison, cycle cadence,
corporate-split policy, schema, config, dashboard, scheduler, universe, threshold, model coefficient,
authority, order route, broker call, D1 write, or R2 write is changed.

B5A remains a separate `nuvo-command` packet and deploy. B5B cannot close H-09 alone.

