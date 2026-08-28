# FR-006B Submission Diff Scope

**Base:** `058a2a839836279e5636b39f4024f7affc0b775c`  
**Branch:** `codex/fr-006-clock-domains`  
**State:** uncommitted review submission; no deploy

This inventory separates the approved scope expansion rather than presenting one aggregate diff.
No dashboard markup, schema, configuration, scheduler, order route, mandate, authority, threshold,
universe, or model coefficient changes.

## 1. Canonical clock evaluator

| File | Diff | Role |
|---|---:|---|
| `src/truth/providers/clock_contract.js` | new, 88 lines | validates mandatory decision time; evaluates vendor freshness against response acquisition; owns `PRODUCTION_CLOCK_DOMAINS_V1` |

## 2. Three production operation owners and supporting call sites

| File | Diff | Role |
|---|---:|---|
| `cloudflare/worker.js` | +20 / -10 | fixes one instant in live-market verifier, decision cycle, and covered-call calculator; threads the same instant through owned-lot probes |
| `src/pipeline/cycle.js` | +15 / -2 | threads one engine instant through chain/events and seals top-level plus per-symbol clock fields |
| `cloudflare/custody-risk.js` | +1 / -1 | exact-strike custody chain read receives the already-fixed mapping instant |
| `src/truth/providers/provider.js` | +1 / -1 | base event method exposes the options boundary |

## 3. Production adapters

| File | Diff | Role |
|---|---:|---|
| `src/truth/providers/schwab.js` | +92 / -20 | current live path; chain and underlying keep independent acquisitions; missing decision time refuses before request |
| `src/truth/providers/massive.js` | +92 / -22 | event membership uses explicit operation instant; dormant option path keeps per-response acquisitions; cached underlying retains acquisition |

The live verdict-flip evidence is the Schwab two-response topology. Massive's multi-response option
batch is dormant under the current configuration and is not used as a claim about live incidence.

## 4. Evidence and replay plumbing

| File | Diff | Role |
|---|---:|---|
| `src/evidence/replay.js` | +25 / -3 | returns stored clock fields without reading or recomputing a live clock |
| `src/pipeline/cycle.js` | counted in §2 | seals decision, acquisition, age, and contract-identity fields |

## 5. Tests

| File | Diff | Role |
|---|---:|---|
| `test/production_adapters.test.js` | +184 / -13 | seven new tests plus explicit decision-time updates to existing production-provider calls |
| `test/integration.test.js` | +50 / -0 | one new end-to-end cycle threading/sealing test |

Count reconciliation: parent 391 → packet 399, exactly eight added tests; 22/22 files loaded.

## 6. Replay and audit artifacts

| File group | Role |
|---|---|
| `tools/replay-fr006b.mjs` | deterministic old/new event-window and Schwab verdict-flip replay with sensitivity boundary |
| `docs/change-packets/FR-006B_PRODUCTION_CLOCK_CONTRACT.md` | ten-section review packet |
| `docs/evidence/fr-006b/*` | caller trace, exact replay output, test ledgers, dry-run evidence, register dependency, manifest |

`SHA256SUMS` is generated last and covers every submitted file except itself.
