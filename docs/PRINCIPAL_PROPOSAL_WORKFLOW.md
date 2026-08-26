# Principal deterministic proposal workflow

## Permitted actions

The production advice and ticket-review surface permits only:

- buy fully paid shares;
- sell currently owned shares;
- sell fully cash-secured puts;
- sell covered calls against verified unencumbered shares;
- buy to close an existing short option as a risk-reducing lifecycle action;
- hold cash or return `NO_TRADE`.

Bull-put spreads, bear-put spreads, and every other spread are outside this
mandate. Their historical math modules may remain for regression and research,
but they are filtered before the production candidate field and rejected by
both the bot and the proposal service.

## Deterministic calculation path

For each admissible expiry and strike, VSIM builds a seeded terminal-price
ensemble from zero-drift lognormal, Student-t, Merton jump-diffusion, and
block-bootstrap members. It then applies the exact structure payoff to every
terminal path.

The engine, never the language model, calculates:

```text
P(profit) = count(payoff(S_T) > 0) / number of paths
EV         = mean(payoff(S_T)) - round-trip execution costs
CVaR       = mean loss in the worst configured tail
GapRisk    = CVaR(jump ensemble) - CVaR(diffusion counterfactual)
LiqRisk    = stressed exit spread cost × probability an early exit is needed
NEV        = EV - λc·CVaR - λg·GapRisk - λl·LiqRisk
EconCap    = max(deep-tail loss, stress loss, structural capital floor)
RAROC      = (NEV / EconCap) × 365 / DTE
```

The market-implied probability and physical/model probability remain separate.
`p_market`, `p_model`, and `p_cal` describe the calibrated terminal event used
by the underwriting hypothesis. `probability_of_profit_model` separately
answers the Principal's direct question: the fraction of ensemble paths whose
exact payoff is positive. The bot must never substitute delta or a slogan for
that value.

Sizing is calculated by the Portfolio Governor. It may reduce or reject the
engine size and can never increase it. Cash, concentration, correlations,
Greeks, stress, CVaR, drawdown, margin, open orders, and the existing custody
book are rechecked before a proposal can be frozen.

## Approval sequence

1. Run Guardian state. New exposure requires exactly `OPEN`.
2. Read current Schwab account truth. Connection and reconciliation must pass;
   cash must be non-negative and margin debit must be zero.
3. Read current market truth. Session must be RTH and quotes must be fresh.
4. Run the deterministic cycle. An empty result is a valid `NO_TRADE`.
5. Freeze one sealed candidate with `create_trade_proposal`.
6. The Principal submits quantity and DAY limit with `review_order_ticket`.
7. Guardian approves only if quantity is no larger than the frozen size and
   the limit is no worse than the deterministic template. CSP collateral and
   covered-share capacity are rechecked from current Schwab truth.
8. Approval expires after 60 seconds. The Principal manually enters the exact
   ticket at Schwab.
9. The broker ledger detects and audits the resulting order/fill. A different
   broker order is a bypass, not an approved variation.

The proposal Worker contains no Schwab execution secret and no route capable of
placing, replacing, or cancelling an order.
