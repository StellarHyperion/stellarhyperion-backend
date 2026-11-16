-- Up Migration

CREATE TABLE cctp_message_version (
  id BIGSERIAL PRIMARY KEY,
  transfer_id BIGINT NOT NULL REFERENCES outbound_transfer (id) ON DELETE CASCADE,
  version_ordinal INTEGER NOT NULL CHECK (version_ordinal >= 1),
  full_nonce TEXT NOT NULL CHECK (full_nonce ~ '^0x[0-9a-f]{64}$'),
  message_digest TEXT NOT NULL CHECK (message_digest ~ '^0x[0-9a-f]{64}$'),
  body_digest TEXT NOT NULL CHECK (body_digest ~ '^0x[0-9a-f]{64}$'),
  provider_reference TEXT,
  provider_status TEXT NOT NULL,
  attestation_tier TEXT NOT NULL CHECK (
    attestation_tier IN ('fast', 'finalized', 'unattested', 'unsupported')
  ),
  expiration_block NUMERIC(78, 0) CHECK (expiration_block IS NULL OR expiration_block >= 0),
  max_fee NUMERIC(78, 0) CHECK (max_fee IS NULL OR max_fee >= 0),
  fee_executed NUMERIC(78, 0) CHECK (fee_executed IS NULL OR fee_executed >= 0),
  raw_message_bytes TEXT NOT NULL,
  attestation_signature TEXT,
  forward_tx_hash TEXT,
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN ('active', 'expired', 'superseded', 'rejected', 'settled')
  ),
  replaces_digest TEXT CHECK (replaces_digest IS NULL OR replaces_digest ~ '^0x[0-9a-f]{64}$'),
  superseded_by_digest TEXT CHECK (
    superseded_by_digest IS NULL OR superseded_by_digest ~ '^0x[0-9a-f]{64}$'
  ),
  equivalence_status TEXT NOT NULL CHECK (
    equivalence_status IN (
      'original',
      'equivalent_replacement',
      'intent_mismatch',
      'unsupported_semantics'
    )
  ),
  equivalence_reason TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (transfer_id, message_digest),
  UNIQUE (transfer_id, version_ordinal)
);

CREATE INDEX cctp_message_version_transfer_idx
  ON cctp_message_version (transfer_id, version_ordinal ASC);

CREATE INDEX cctp_message_version_nonce_idx
  ON cctp_message_version (full_nonce);

-- Down Migration

DROP INDEX IF EXISTS cctp_message_version_nonce_idx;
DROP INDEX IF EXISTS cctp_message_version_transfer_idx;
DROP TABLE IF EXISTS cctp_message_version;
