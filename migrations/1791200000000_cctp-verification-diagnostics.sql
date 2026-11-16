-- Up Migration

CREATE TABLE cctp_verification_diagnostic (
  transfer_id BIGINT PRIMARY KEY REFERENCES outbound_transfer (id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('verified', 'mismatch', 'missing_evidence')),
  category TEXT NOT NULL CHECK (char_length(category) <= 64),
  retryable BOOLEAN NOT NULL,
  field_name TEXT CHECK (field_name IS NULL OR char_length(field_name) <= 64),
  expected_summary TEXT CHECK (expected_summary IS NULL OR char_length(expected_summary) <= 128),
  observed_summary TEXT CHECK (observed_summary IS NULL OR char_length(observed_summary) <= 128),
  detail TEXT NOT NULL CHECK (char_length(detail) <= 240),
  candidate_tx_hash TEXT CHECK (
    candidate_tx_hash IS NULL OR candidate_tx_hash ~ '^0x[0-9a-f]{64}$'
  ),
  candidate_block BIGINT CHECK (candidate_block IS NULL OR candidate_block >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX cctp_verification_diagnostic_category_idx
  ON cctp_verification_diagnostic (outcome, category);

-- Down Migration

DROP INDEX IF EXISTS cctp_verification_diagnostic_category_idx;
DROP TABLE IF EXISTS cctp_verification_diagnostic;
