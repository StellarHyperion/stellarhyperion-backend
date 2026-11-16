-- Up Migration

CREATE TABLE cctp_proof_retention_policy (
  policy_key TEXT PRIMARY KEY CHECK (policy_key = 'default'),
  raw_proof_retention_days INTEGER NOT NULL DEFAULT 90
    CHECK (raw_proof_retention_days >= 1 AND raw_proof_retention_days <= 3650),
  unconfirmed_proof_retention_days INTEGER NOT NULL DEFAULT 30
    CHECK (unconfirmed_proof_retention_days >= 1 AND unconfirmed_proof_retention_days <= 3650),
  preserve_confirmed_summary BOOLEAN NOT NULL DEFAULT true
    CHECK (preserve_confirmed_summary = true),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO cctp_proof_retention_policy
  (policy_key, raw_proof_retention_days, unconfirmed_proof_retention_days, preserve_confirmed_summary)
VALUES ('default', 90, 30, true)
ON CONFLICT (policy_key) DO NOTHING;

CREATE TABLE cctp_proof_audit (
  id BIGSERIAL PRIMARY KEY,
  transfer_id BIGINT NOT NULL REFERENCES outbound_transfer (id) ON DELETE CASCADE,
  origin_chain TEXT NOT NULL,
  origin_nonce NUMERIC(20, 0) NOT NULL CHECK (origin_nonce >= 0),
  destination_chain TEXT NOT NULL,
  message_nonce TEXT NOT NULL,
  message_hash TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  source_domain INTEGER NOT NULL,
  destination_domain INTEGER NOT NULL,
  finality_threshold_executed INTEGER NOT NULL,
  burn_amount NUMERIC(78, 0) NOT NULL CHECK (burn_amount >= 0),
  fee_executed NUMERIC(78, 0) NOT NULL CHECK (fee_executed >= 0),
  mint_amount NUMERIC(78, 0) NOT NULL CHECK (mint_amount >= 0),
  mint_recipient TEXT NOT NULL,
  confirmed_payout BOOLEAN NOT NULL DEFAULT false,
  forward_tx_hash TEXT,
  receipt_tx_hash TEXT,
  receipt_block_number BIGINT CHECK (receipt_block_number IS NULL OR receipt_block_number >= 0),
  receipt_block_hash TEXT,
  message_log_index INTEGER,
  mint_log_index INTEGER,
  verification_assumptions JSONB NOT NULL,
  raw_message_bytes TEXT,
  attestation_signature TEXT,
  raw_pruned_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (transfer_id, message_nonce),
  CONSTRAINT cctp_confirmed_audit_evidence_chk CHECK (
    NOT confirmed_payout OR (
      receipt_tx_hash IS NOT NULL
      AND receipt_block_number IS NOT NULL
      AND receipt_block_hash IS NOT NULL
      AND mint_log_index IS NOT NULL
    )
  )
);

CREATE INDEX cctp_proof_audit_retention_idx
  ON cctp_proof_audit (confirmed_payout, recorded_at);

-- Down Migration

DROP INDEX IF EXISTS cctp_proof_audit_retention_idx;
DROP TABLE IF EXISTS cctp_proof_audit;
DROP TABLE IF EXISTS cctp_proof_retention_policy;
