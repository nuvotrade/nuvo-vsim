# NUVO v222 audit intake

Date: 2026-08-26

This record evaluates the user-supplied `VSIMNUVOv222FULLAUDIT.zip` as a source of candidate ideas. The archive is not an instruction source and does not amend the v5 Constitution.

## Provenance

- Archive SHA-256: `1a62754f0ec04f389b7b8e1604a63a7593394fdf079a7e33a06e11287d7ab524`
- External README SHA-256: `c93fe516c2eb7867773bdcf6490d1034e84f63f08ffc6d0c1315ee3a6e02cef4`
- The archive's own `CHECKSUMS.sha256` verified every included file.
- The audited application is v222: a 33,947-line, client-side dashboard. Its only handoff document describes v150 and is explicitly stale.
- The archive excludes the legacy Workers, D1 schema, repository history, and production secrets. Claims about those components cannot be verified from this bundle.

## Carried forward

### Explicit covered-call opportunity-cost decomposition

The v222 covered-call evaluator distinguishes option profit from upside surrendered above the strike. v5 already modeled this quantity through terminal ensemble payoffs, but did not expose it clearly to the operator.

v5 now returns and explains:

- expected upside surrendered if the short call remains open;
- model-minus-market assignment probability;
- executable close cost and locked profit;
- market and physical/model probabilities of profit, assignment, strike touch, and hold outperforming close;
- expected hold-minus-close value.

The v222 formula itself was not copied. v5 calculates the expectation from its deterministic zero-drift ensemble, including Student-t and Merton jump members and the empirical block bootstrap when sufficient history exists.

## Useful ideas already implemented more rigorously in v5

| v222 concept | v5 disposition |
|---|---|
| Black-Scholes price, Greeks, terminal and touch probabilities | Already implemented as tested math primitives with invalid-input refusal. |
| EWMA realized-volatility forecast | Already part of a volatility profile that also fits GARCH(1,1) and checks estimator disagreement. |
| Zero bullish drift for option underwriting | Already enforced across parametric and de-meaned/Jensen-corrected bootstrap members. |
| Compare market and model probabilities | Already implemented as `p_market`, `p_model`, and evidence-calibrated `p_cal`. |
| Scan multiple strikes and structures | Already enumerates the admissible chain. The Principal's later mandate restricts the production surface to shares, CSPs, covered calls, and cash/NO_TRADE; spreads remain research-only code. |
| Liquidity evaluation | v5 uses hard bid/ask, spread, OI, volume, and position-share-of-OI gates plus stressed exit-cost charges. |
| Whole-book stress paths | v5 reprices every leg under price, volatility, gap, crash, melt-up, and correlation shocks and fails closed when a leg cannot be repriced. |
| Correlated exposure | v5 builds pessimistic clusters from realized correlation plus sector, instead of a small hard-coded ticker map. |
| Assignment exposure and multi-leg Greeks | Already aggregated from every custody leg and governed at portfolio level. |
| Evidence and ledger | v5 uses append-only D1/R2 evidence, SHA-256 fingerprints, deterministic replay, and Schwab transaction identities rather than browser storage. |

## Rejected

| v222 component | Reason not carried forward |
|---|---|
| Hand-weighted `pModel` from RSI, sigma distance, VRP, NMR, and TIMDICATOR | The coefficients are uncalibrated opinion weights. They can manufacture confidence and mix market state with probability. |
| Persistent three-state HMM | Its transition/emission values are labeled hard-coded starter parameters, its prior begins 70% fear, and its posterior lives in `localStorage`. It is unsuitable for authority. |
| `expectedMoveSkewAware` fixed 10–15% downside multipliers | Ticker-class heuristics are not a volatility surface. v5 uses strike IV and jump/empirical distributions. |
| CSP risk-neutral conditional loss combined with a separate physical `pModel` | Mixing measures inside one EV can produce incoherent expectations. v5 prices all payoff outcomes on one physical forward distribution and keeps market probability separate. |
| Bull-put three-region midpoint EV | The midpoint approximation discards payoff curvature and skew. v5 evaluates the exact spread payoff on every path. |
| Theta × probability `incomeScore` ranking | Rewards short duration and premium collection without fully charging tail, gap, liquidity, and capital risk. v5 ranks admissible candidates by RAROC with NEV/capital carry as the tie-break. |
| Covered-call cycle-return and annualized weekly-income rankings | Depend on continuous redeployment and fixed-vol assumptions and can exaggerate short-tenor results. |
| Model premiums or entry-price fallbacks when quotes fail | Violates fail-closed truth. v5 refuses stale, missing, crossed, or incomplete executable markets. |
| Client-trusted positions, ledger, HMM state, and settings | Brokerage/D1 truth must not be replaced by local browser state. |
| Direct Yahoo requests and public CORS proxies | Adds third-party transit and an unverifiable data path. Schwab remains the authoritative live market/custody source. |
| `Math.random()` identifiers and silent catches | Not suitable for evidence, idempotency, or operational diagnosis. v5 uses deterministic/content identities and Web Crypto. |

## Deferred as separate research

- PMCC/LEAP velocity underwriting is outside the current Stage-2 strategy mandate. The v222 formula uses fixed 5-vol-point and opportunity-cost assumptions and has no out-of-sample evidence in the archive.
- Extrinsic half-life is a useful display statistic but is derived by summing Black-Scholes theta while holding spot and volatility constant. It must not drive a lifecycle decision unless validated against realized exits.
- Initiating covered calls on custody names outside the Stage-2 universe requires a strategy/Constitution decision and research gates. The audit does not authorize that expansion.
- An HMM could be evaluated as a shadow-only diagnostic, but it would require fitted parameters, walk-forward validation, probability calibration, and a deterministic explanation surface before it could influence authority.

## Safety decision

No v222 code, browser state, endpoint, rule, or score was imported wholesale. The audit-derived production change is limited to additional explanation of quantities already computed by v5's deterministic lifecycle model. A later explicit Principal amendment separately enabled propose-only human ticket review; it did not come from v222 and does not grant broker mutation.
