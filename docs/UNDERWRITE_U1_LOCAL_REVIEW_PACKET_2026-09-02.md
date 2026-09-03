# UNDERWRITE U1 local review packet — 2026-09-02

Status: **LOCAL ONLY · NOT UPLOADED · `mutation_eligible: false`**

Scope: preserve the seven sealed single-ticker CSP locks, share that model engine
with the covered-call write-versus-hold calculation, and add only the separately
clocked cash-rate contract. Portfolio-review economics (U2) were not opened.

## Sealed identities

- Manifest SHA-256: `977198bb10b5554af5a71c048ce1971cac29078d041e42496d89e55e9e2c0040`
- Predicted Worker bundle SHA-256: `7e430e77394240a61f104e53cccf7c1fe25de0439102da6ebe0d09b7ac58d05e`
- Predicted Worker bundle bytes: `2,179,606`
- Dry-build config: `cloudflare/wrangler.jsonc`
- Dry-build result: **PASS**
- Test result: **765 / 765 PASS**
- Deployment: **NONE**

## File list

| File | SHA-256 |
| --- | --- |
| `cloudflare/underwrite-model-engine.js` | `3e5e720b9e39339023b9290576dce515bb8f05fc8967f41e4bd45522663ed9e0` |
| `cloudflare/cash-secured-put-calculator.js` | `746b5413460a621679383adf36981966ab14a9558cba79a83fa99c867e05f895` |
| `cloudflare/covered-call-calculator.js` | `8568c7a9d620314160e12c67e40cbe451b87bd50eb723f14aa734e5ab23224e4` |
| `cloudflare/worker.js` | `fa265bb1b27c713522f59dce98259ff7dbf053fcaf0388dac81220bb175cdcd4` |
| `test/cash_secured_put_calculator.test.js` | `9305ad92cae274caa7d72e69c31f91df75f511eeade8d05a3f6fbf3ac3ebcc46` |
| `test/covered_call_calculator.test.js` | `3154bdff3a601bf3aec2cf259d8d917559eff88a745eb4ecebe982ee6846bc74` |
| `test/production_adapters.test.js` | `de3683e9bba136f5b5950c3d4f4e13c0ec9fa75f0a3a71dea070ecfc9e8ff517` |
| `test/lane-1-event-ledger.test.js` | `e1836e405c8bc2aeb17104881c732047c293b471908cfa8cee2fccf74f2d2eda` |

The Lane 1 test-only change replaces a hard-coded September 2 timestamp with the
test execution time. It removes a midnight-New-York test failure and changes no
Lane 1 production code, control, or state.

## Seven preserved CSP locks

The calculator file changed as expected for U1. Its U0 sealed SHA-256 was
`e16e4e02e4ca2a34cb26fcaaff4fc4aab27575ee966d21a42e6fe1f15ae571da`;
its U1 SHA-256 is
`746b5413460a621679383adf36981966ab14a9558cba79a83fa99c867e05f895`.
The change adds the rate contract while the seven model locks below remain
asserted by the full regression suite.

1. PRIMARY remains the centered five-session block bootstrap over at most 400
   sessions, with zero arithmetic drift and no global jump law.
2. Each model receives the caller's actual path count; production remains 8,000.
   Every modeled NEV is printed with `SE = SD(P&L) / sqrt(n)`.
3. Drift is explicit and zero in every member. Bootstrap blocks are centered and
   carry no sample drift.
4. `RAW_NEV_0 = C_net - exp(-rT) E_P[(K-S_T)+] × 100` for the put. Premium and
   liability are both expressed in today dollars.
5. There is no mixture and no MAX-of-models decision. PRIMARY alone supplies the
   headline; challengers remain separate. Stress is display-only and has no veto.
6. Lognormal, variance-normalized Student-t(5), jump, and 1.25× stress use the
   GARCH DTE forecast or are unavailable. Bootstrap uses centered empirical
   blocks and no parametric sigma.
7. Jump remains an uncalibrated additive diagnostic and is visibly labeled as
   potentially double-counting jump variance already present in GARCH.

Other locked boundaries remain: executable bid credit, one-contract calculation
unit, PRIMARY provisional and uncalibrated, no `probTouch`, no ranking, no
Governor, no portfolio gate, no recommendation, and no order route.

## U1 rate contract

The registered risk-free rate `r` remains inside RAW discounting and the
risk-neutral `N(d2)` calculation. The two cash yields never enter either.

```text
RAW_NEV_0 = C_net - exp(-rT) E_P[(K-S_T)+] × 100

CASH_CARRY_COST_0 = exp(-rT) C_tied
                    × [exp(y_alt T) - exp(y_coll T)]

CASH_ADJ_NEV_0 = RAW_NEV_0 - CASH_CARRY_COST_0
```

`C_tied` defaults to `K × 100 - C_net`. A fetched and verified broker cash
requirement overrides that modeled amount. The response and glass print gross
obligation and net tied cash separately.

Covered-call incremental value remains RAW only:

```text
RAW_CC_NEV_0 = call net credit
               - exp(-rT) E_P[(S_T-K)+] × 100
```

No CSP cash carry is attached to a covered-call row.

## Required rate fixtures

All three are exercised in `test/cash_secured_put_calculator.test.js`:

- `(y,0)`: `exp(-rT) C_tied [exp(yT)-1]` is charged and cash-adjusted NEV equals
  RAW minus that exact present-value amount.
- `(y,y)`: cash carry is exactly zero and cash-adjusted NEV equals RAW; it is not
  marked unavailable.
- unverified pair: cash carry and cash-adjusted NEV are `null` / `UNAVAILABLE`;
  RAW still calculates.

A computed `$0.00` carry therefore means two verified, equal yields. It is not
the same state as a printed `0%` assumption: when either yield is unverified,
the Worker passes `null` with both verification flags false and the glass prints
`UNAVAILABLE`, never zero.

The fixture also changes both cash yields while holding all market inputs fixed
and proves that the risk-neutral finish-ITM probability and `RAW_NEV_0` remain
bit-for-bit unchanged. A verified broker requirement fixture proves the override
and source label.

## Glass contract

The one-ticker CSP page still asks only for a ticker. It now shows:

- gross obligation and net tied cash as different values;
- every separate RAW model output with Monte Carlo SE;
- present-value cash carry and PRIMARY cash-adjusted NEV;
- `UNAVAILABLE` for cash-adjusted value until both yields are verified;
- the equations and the rule that cash yields never enter `N(d2)`.

No missing rate hides a row or blocks RAW math.

## Boundary statement

- `mutation_eligible: false` remains explicit after the change.
- U2 Portfolio review, its policies, ranking, and economics were not modified.
- No live Worker version, lane, alert, broker, coordinator, or account state was
  changed while producing this packet.
- This packet is review evidence, not deployment authority.
