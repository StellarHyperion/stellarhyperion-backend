-- Up Migration

ALTER TABLE rail_attestation
  ADD COLUMN cctp_message_versions jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(cctp_message_versions) = 'array');

COMMENT ON COLUMN rail_attestation.cctp_message_versions IS
  'Credential-free CCTP message and attestation fingerprints observed from Iris, retained across polls so expired originals and replacements remain auditable.';

-- Down Migration

ALTER TABLE rail_attestation DROP COLUMN cctp_message_versions;
