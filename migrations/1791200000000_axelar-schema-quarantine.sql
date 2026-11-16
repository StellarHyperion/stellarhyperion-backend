-- Up Migration

-- Bounded quarantine store for unsupported or drifted Axelar GMP status shapes.
--
-- Retains transfer identity, provider message reference, and a credential-scrubbed bounded JSON
-- payload for offline inspection and idempotent replay once a supported parser is registered.

CREATE TABLE axelar_schema_quarantine (
  id                  bigserial PRIMARY KEY,
  transfer_id         bigint NOT NULL REFERENCES outbound_transfer (id) ON DELETE CASCADE,
  route               smallint NOT NULL CHECK (route BETWEEN 0 AND 3),
  origin_chain        text NOT NULL,
  nonce               numeric(20, 0) NOT NULL,
  origin_tx           text NOT NULL,
  provider_reference  text,
  drift_kind          text NOT NULL CHECK (
    drift_kind IN (
      'unknown_status',
      'invalid_status_type',
      'unsupported_execution_shape',
      'unsupported_envelope'
    )
  ),
  observed_status     text,
  payload_fingerprint text NOT NULL,
  bounded_payload     jsonb NOT NULL,
  payload_truncated   boolean NOT NULL DEFAULT false,
  quarantine_status   text NOT NULL DEFAULT 'quarantined' CHECK (
    quarantine_status IN ('quarantined', 'replayed')
  ),
  replayed_parser     text,
  replayed_at         timestamptz,
  occurrences         integer NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT axelar_schema_quarantine_dedup UNIQUE (transfer_id, payload_fingerprint)
);

CREATE INDEX axelar_schema_quarantine_pending
  ON axelar_schema_quarantine (quarantine_status, id ASC)
  WHERE quarantine_status = 'quarantined';

CREATE INDEX axelar_schema_quarantine_by_transfer
  ON axelar_schema_quarantine (transfer_id, id ASC);

COMMENT ON TABLE axelar_schema_quarantine IS
  'Bounded offline inspection and replay queue for unsupported Axelar provider response shapes.';
COMMENT ON COLUMN axelar_schema_quarantine.provider_reference IS
  'Extracted Axelar message or command identifier retained alongside source transfer identity.';

-- Down Migration

DROP TABLE IF EXISTS axelar_schema_quarantine;
