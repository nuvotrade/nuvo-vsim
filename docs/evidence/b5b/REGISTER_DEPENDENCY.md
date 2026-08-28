# Governance Register dependency

B5B names `BENZINGA_COMPENSATING_ADAPTER_CONTRACT_V1` and seals it as event-source identity.

No canonical Governance Register exists. B5B does not create another local list. The future register
must include this identity alongside:

- `PRODUCTION_CLOCK_DOMAINS_V1`
- `SCHWAB_PRICE_HISTORY_3Y_V2`
- `execution-cost-v2`
- `QVU_CLOCK_DOMAINS_V2`
- the eventual B5A producer implementation identity

Until that packet lands, the contract is discoverable from signed Amendment 3, code constants,
sealed evidence and this dependency record, but not from a canonical register surface.

