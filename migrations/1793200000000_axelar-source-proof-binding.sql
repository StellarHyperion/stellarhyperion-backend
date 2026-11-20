-- Up Migration
ALTER TABLE axelar_delivery_evidence ADD COLUMN source_binding jsonb
  CHECK(source_binding IS NULL OR (jsonb_typeof(source_binding)='object' AND octet_length(source_binding::text)<=4096));
COMMENT ON COLUMN axelar_delivery_evidence.source_binding IS 'Public source snapshot verified with the ITS command and token mapping; legacy missing bindings remain explicitly unaudited.';
-- Down Migration
ALTER TABLE axelar_delivery_evidence DROP COLUMN source_binding;
