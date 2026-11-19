-- Up Migration

ALTER TABLE rail_attestation
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN retry_attempts integer NOT NULL DEFAULT 0 CHECK (retry_attempts >= 0),
  ADD COLUMN retry_class text CHECK (
    retry_class IN ('transient', 'rate_limited', 'permanent', 'exhausted')
  );

DROP INDEX rail_attestation_outstanding;
CREATE INDEX rail_attestation_outstanding
  ON rail_attestation (route, next_attempt_at NULLS FIRST, last_checked_at NULLS FIRST)
  WHERE status IN ('pending', 'attested');

COMMENT ON COLUMN rail_attestation.next_attempt_at IS
  'Persisted time when the worker may next poll this transfer. Null means use the legacy check interval, or the failure is held for operator recovery.';
COMMENT ON COLUMN rail_attestation.retry_class IS
  'Normalized lookup failure class. permanent and exhausted require operator recovery; null means the previous check did not fail.';

-- Down Migration

DROP INDEX rail_attestation_outstanding;
CREATE INDEX rail_attestation_outstanding
  ON rail_attestation (route, last_checked_at NULLS FIRST)
  WHERE status IN ('pending', 'attested');

ALTER TABLE rail_attestation
  DROP COLUMN retry_attempts,
  DROP COLUMN retry_class,
  DROP COLUMN next_attempt_at;
