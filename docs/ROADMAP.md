# Implementation status

Implemented: schema migrations, Stellar/EVM event watchers, rail pollers, public REST reads, source-scoped Axelar lookup, confirmed direct ITS payment verification, and optional signed Stellar TTL/claim jobs. The checked-in record names the real Stellar router and no EVM Hyperion deployment.

Removed: mocked gas top-ups, synthetic second-step attestations and receipt-only fabricated inbound deliveries. They must not reappear as advertised capabilities without a verified contract integration.

Pending network acceptance: upgrade/map/link the testnet lane, run one real wallet transfer, verify the destination receipt and confirm that the continuously running indexer records it. The API server alone cannot establish background worker availability.

Additional rails/networks and distributed keeper signing need their own implementation and validation. Existing unit and embedded SQL tests do not replace a live cross-chain acceptance transfer.
