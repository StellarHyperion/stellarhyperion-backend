-- Up Migration
ALTER TABLE rail_attestation
  ADD COLUMN its_verification_state text CHECK (its_verification_state IN ('receipt_unavailable','payout_unverified','verified')),
  ADD COLUMN diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(diagnostics) = 'array' AND jsonb_array_length(diagnostics) <= 6 AND octet_length(diagnostics::text) <= 4096);

COMMENT ON COLUMN rail_attestation.diagnostics IS
  'Bounded public verification mismatch categories and values; never credentials or raw provider responses.';

-- Down Migration
ALTER TABLE rail_attestation DROP COLUMN diagnostics, DROP COLUMN its_verification_state;
