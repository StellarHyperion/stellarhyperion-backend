-- Up Migration

-- One durable, deduplicated record for every observable rail lifecycle change. The transfer id
-- keeps the history joined to the exact source transfer even when a nonce is reused on another
-- origin chain.
CREATE TABLE rail_attestation_history (
  id                 bigserial PRIMARY KEY,
  transfer_id        bigint NOT NULL REFERENCES outbound_transfer (id) ON DELETE CASCADE,
  route              smallint NOT NULL CHECK (route BETWEEN 0 AND 3),
  old_status         text NOT NULL,
  new_status         text NOT NULL CHECK (
    new_status IN ('pending', 'attested', 'delivered', 'failed', 'expired')
  ),
  reason             text NOT NULL DEFAULT '',
  rail_status        text NOT NULL DEFAULT '',
  evidence_reference text NOT NULL DEFAULT '',
  observed_at        timestamptz NOT NULL,
  CONSTRAINT rail_attestation_history_once UNIQUE
    (transfer_id, old_status, new_status, reason, rail_status, evidence_reference)
);

CREATE INDEX rail_attestation_history_by_transfer
  ON rail_attestation_history (transfer_id, id);

COMMENT ON TABLE rail_attestation_history IS
  'Deduplicated lifecycle transitions observed while a transfer was being polled on its rail.';
COMMENT ON COLUMN rail_attestation_history.evidence_reference IS
  'The public rail reference, such as a message id, never a credential or private response body.';

-- Down Migration
DROP TABLE IF EXISTS rail_attestation_history;
