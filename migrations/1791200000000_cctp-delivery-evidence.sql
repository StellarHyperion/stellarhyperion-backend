-- Up Migration

CREATE TABLE cctp_delivery_evidence (
  transfer_id BIGINT PRIMARY KEY REFERENCES outbound_transfer (id) ON DELETE CASCADE,
  message_nonce TEXT,
  message_hash TEXT,
  body_hash TEXT,
  source_domain INTEGER,
  destination_domain INTEGER,
  finality_threshold_executed INTEGER,
  forward_tx_hash TEXT,
  canonical_tx_hash TEXT,
  canonical_block_number BIGINT CHECK (
    canonical_block_number IS NULL OR canonical_block_number >= 0
  ),
  canonical_block_hash TEXT,
  message_log_index INTEGER,
  mint_log_index INTEGER,
  burned_amount NUMERIC(78, 0) CHECK (burned_amount IS NULL OR burned_amount >= 0),
  minted_amount NUMERIC(78, 0) CHECK (minted_amount IS NULL OR minted_amount >= 0),
  fee_executed NUMERIC(78, 0) CHECK (fee_executed IS NULL OR fee_executed >= 0),
  attestation_present BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE IF EXISTS cctp_delivery_evidence;
