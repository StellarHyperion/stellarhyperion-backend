-- Up Migration

-- Durable per-transfer retry classification and next-attempt timestamps so process restarts
-- preserve backoff windows without retry storms and terminal evidence requires explicit recovery.

ALTER TABLE rail_attestation
  ADD COLUMN retry_class text CHECK (
    retry_class IN (
      'awaiting_index',
      'awaiting_delivery_proof',
      'transient_provider',
      'rate_limited',
      'terminal_evidence',
      'settled'
    )
  ),
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN recovery_note text,
  ADD COLUMN recovered_at timestamptz;

CREATE INDEX rail_attestation_retry_schedule
  ON rail_attestation (route, next_attempt_at ASC NULLS FIRST)
  WHERE status IN ('pending', 'attested')
    AND (retry_class IS NULL OR retry_class <> 'terminal_evidence');

COMMENT ON COLUMN rail_attestation.retry_class IS
  'Normalized retry schedule category persisted across worker restarts.';
COMMENT ON COLUMN rail_attestation.next_attempt_at IS
  'Earliest wall-clock timestamp at which automatic polling may re-attempt this transfer; null when settled or halted on terminal evidence.';

-- Down Migration

DROP INDEX IF EXISTS rail_attestation_retry_schedule;

ALTER TABLE rail_attestation
  DROP COLUMN IF EXISTS recovered_at,
  DROP COLUMN IF EXISTS recovery_note,
  DROP COLUMN IF EXISTS next_attempt_at,
  DROP COLUMN IF EXISTS retry_class;
