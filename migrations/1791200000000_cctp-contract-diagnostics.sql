-- Up Migration

CREATE TABLE cctp_contract_baseline (
  chain_key TEXT NOT NULL,
  role TEXT NOT NULL CHECK (
    role IN ('token_messenger_v2', 'message_transmitter_v2', 'token_minter_v2', 'usdc')
  ),
  contract_address TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  implementation_address TEXT,
  implementation_code_hash TEXT,
  first_seen_block BIGINT NOT NULL CHECK (first_seen_block >= 0),
  first_seen_block_hash TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_key, role)
);

CREATE TABLE cctp_contract_diagnostic (
  id BIGSERIAL PRIMARY KEY,
  transfer_id BIGINT NOT NULL REFERENCES outbound_transfer (id) ON DELETE CASCADE,
  destination_chain TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  block_number BIGINT NOT NULL CHECK (block_number >= 0),
  block_hash TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('verified', 'mismatch', 'unexpected_upgrade')),
  issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  observations JSONB NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (transfer_id, destination_chain, block_number, block_hash)
);

CREATE INDEX cctp_contract_diagnostic_chain_block_idx
  ON cctp_contract_diagnostic (destination_chain, block_number DESC);

-- Down Migration

DROP INDEX IF EXISTS cctp_contract_diagnostic_chain_block_idx;
DROP TABLE IF EXISTS cctp_contract_diagnostic;
DROP TABLE IF EXISTS cctp_contract_baseline;
