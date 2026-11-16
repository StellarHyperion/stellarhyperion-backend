-- Up Migration

-- Durable, bounded counters for rejected destination delivery proof candidates across rails.
-- Labels are constrained to fixed rail and normalized reason identifiers so arbitrary hashes,
-- wallet addresses, and endpoint credentials can never enter metric dimensions.

CREATE TABLE proof_rejection_counter (
  rail text NOT NULL CHECK (rail IN ('cctp', 'axelar-its')),
  reason text NOT NULL CHECK (
    reason IN (
      'recipient_mismatch',
      'token_mismatch',
      'amount_mismatch',
      'insufficient_finality',
      'provider_inconsistency'
    )
  ),
  rejected_count bigint NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rail, reason)
);

-- Down Migration

DROP TABLE IF EXISTS proof_rejection_counter;
