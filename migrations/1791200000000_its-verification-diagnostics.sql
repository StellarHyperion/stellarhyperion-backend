-- Up Migration

-- Structured verification diagnostics for Axelar Interchain Token Service (ITS) candidates.
--
-- Distinguishes retryable unavailable evidence (missing receipt, insufficient confirmations,
-- non-canonical block, missing execution candidate) from invalid evidence across stable mismatch
-- categories (source identity, command, token, recipient, amount, payment evidence, reverted
-- execution). Identifier columns are length-bounded so raw payloads and credentials cannot land.

CREATE TABLE its_verification_diagnostic (
  transfer_id          bigint PRIMARY KEY REFERENCES outbound_transfer (id) ON DELETE CASCADE,
  destination_chain    text NOT NULL,
  route                smallint NOT NULL CHECK (route = 1),
  source_chain         text NOT NULL,
  source_nonce         numeric(20, 0) NOT NULL,
  disposition          text NOT NULL CHECK (disposition IN ('unavailable', 'mismatch')),
  category             text NOT NULL CHECK (
    category IN (
      'execution_candidate_missing',
      'receipt_unavailable',
      'insufficient_confirmations',
      'non_canonical_receipt_block',
      'reverted_execution_receipt',
      'source_identity_mismatch',
      'command_mismatch',
      'token_mismatch',
      'recipient_mismatch',
      'amount_mismatch',
      'payment_evidence_missing'
    )
  ),
  candidate_tx         text CHECK (candidate_tx IS NULL OR char_length(candidate_tx) <= 160),
  candidate_command_id text CHECK (
    candidate_command_id IS NULL OR char_length(candidate_command_id) <= 160
  ),
  candidate_block      numeric(20, 0),
  expected_value       text CHECK (expected_value IS NULL OR char_length(expected_value) <= 160),
  observed_value       text CHECK (observed_value IS NULL OR char_length(observed_value) <= 160),
  occurrences          integer NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  first_observed_at    timestamptz NOT NULL DEFAULT now(),
  last_observed_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT its_verification_diagnostic_disposition_category CHECK (
    (
      disposition = 'unavailable'
      AND category IN (
        'execution_candidate_missing',
        'receipt_unavailable',
        'insufficient_confirmations',
        'non_canonical_receipt_block'
      )
    )
    OR (
      disposition = 'mismatch'
      AND category IN (
        'reverted_execution_receipt',
        'source_identity_mismatch',
        'command_mismatch',
        'token_mismatch',
        'recipient_mismatch',
        'amount_mismatch',
        'payment_evidence_missing'
      )
    )
  )
);

CREATE INDEX its_verification_diagnostic_by_category
  ON its_verification_diagnostic (disposition, category, last_observed_at DESC);

COMMENT ON TABLE its_verification_diagnostic IS
  'Bounded public mismatch and unavailability diagnostics for unverified Axelar ITS payout candidates.';

-- Down Migration

DROP TABLE IF EXISTS its_verification_diagnostic;
