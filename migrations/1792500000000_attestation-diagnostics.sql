-- Up Migration
ALTER TABLE rail_attestation
  ADD COLUMN diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN rail_attestation.diagnostics IS
  'Bounded public verification mismatch categories and values; never credentials or raw provider responses.';

-- Down Migration
ALTER TABLE rail_attestation DROP COLUMN diagnostics;
