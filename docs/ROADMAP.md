# Implementation status

Implemented: schema migrations, Stellar/EVM event watchers, rail pollers, public REST reads, source-scoped Axelar lookup, confirmed direct ITS payment verification, and optional signed Stellar TTL/claim jobs. The checked-in record names the real Stellar router and no EVM Hyperion deployment.

Removed: mocked gas top-ups, synthetic second-step attestations and receipt-only fabricated inbound deliveries. They must not reappear as advertised capabilities without a verified contract integration.

Network acceptance passed: the current testnet lane was deployed and activated, a real wallet transfer confirmed on Stellar, and matching ITS/token payment events established its Sepolia delivery in the indexer. The API server alone cannot establish background worker availability.

Axelar GMP status is only a candidate signal: a transfer becomes delivered after the configured deployment, source event fields, destination receipt and payment event all match. Axelar ITS admission requires valid deployed service receiver metadata on the selected network. Direct ITS payouts do not require a Hyperion EVM router. Configuration admission is metadata validation; only independently verified matching chain events establish delivery. Generic GMP adapter extensions still require their implemented contracts and signed acceptance before runtime enablement. Signer ownership now uses PostgreSQL advisory locks and committed public submission checkpoints; archived Soroban footprints are restored with the native protocol operation before unchanged maintenance calls. Additional rails/networks still require their own implementation and validation. The complete PostgreSQL-backed suite passes, and the live acceptance proof is preserved in the contracts deployment evidence.

New-lane acceptance is explicit: source indexing, provider discovery, a finalized destination receipt, canonical payment, token, amount and network identity must all be evidenced. Provider status alone never activates a lane; missing prerequisites stay visible for operator review.
