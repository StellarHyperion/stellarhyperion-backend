-- Up Migration

CREATE TABLE cctp_delivery_proof (
  transfer_id BIGINT PRIMARY KEY REFERENCES outbound_transfer (id) ON DELETE CASCADE,
  origin_chain TEXT NOT NULL,
  source_nonce NUMERIC(20, 0) NOT NULL CHECK (source_nonce >= 0),
  destination_chain TEXT NOT NULL,
  rail_message_id TEXT NOT NULL CHECK (rail_message_id ~ '^0x[0-9a-f]{64}$'),
  raw_message_bytes TEXT NOT NULL,
  recipient TEXT NOT NULL,
  token_address TEXT NOT NULL,
  minted_amount NUMERIC(78, 0) NOT NULL CHECK (minted_amount >= 0),
  tx_hash TEXT NOT NULL,
  block_number BIGINT NOT NULL CHECK (block_number >= 0),
  block_hash TEXT NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  message_log_index INTEGER NOT NULL CHECK (message_log_index >= 0),
  mint_log_index INTEGER NOT NULL CHECK (mint_log_index >= 0),
  revalidation_state TEXT NOT NULL CHECK (
    revalidation_state IN ('canonical', 'orphaned', 'reconciled')
  ),
  orphan_reason TEXT,
  last_checked_head BIGINT CHECK (last_checked_head IS NULL OR last_checked_head >= 0),
  revalidated_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX cctp_delivery_proof_revalidation_idx
  ON cctp_delivery_proof (revalidation_state, destination_chain, block_number ASC);

-- Down Migration

DROP INDEX IF EXISTS cctp_delivery_proof_revalidation_idx;
DROP TABLE IF EXISTS cctp_delivery_proof;
