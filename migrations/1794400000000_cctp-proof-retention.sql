-- Up Migration

ALTER TABLE cctp_delivery_evidence
  ADD COLUMN receipt_log_index integer CHECK (receipt_log_index >= 0),
  ADD COLUMN verification_context jsonb;

ALTER TABLE maintenance_job_lease
  DROP CONSTRAINT maintenance_job_lease_job_name_check,
  ADD CONSTRAINT maintenance_job_lease_job_name_check
    CHECK (job_name IN ('rail_attestation_retention', 'route_health_compaction', 'cctp_proof_retention'));

CREATE INDEX cctp_delivery_evidence_retention_scan
  ON cctp_delivery_evidence (id, (COALESCE(last_revalidated_at, verified_at)))
  WHERE status IN ('orphaned', 'superseded');

COMMENT ON INDEX cctp_delivery_evidence_retention_scan IS
  'Supports bounded pruning after the operator-configured 1 to 36500 day retention window; canonical and payout-linked proofs are excluded.';
COMMENT ON COLUMN cctp_delivery_evidence.receipt_log_index IS
  'Public receipt log index of the exact matching MessageReceived event; nullable only for legacy evidence.';
COMMENT ON COLUMN cctp_delivery_evidence.verification_context IS
  'Versioned public verification assumptions and contract observations captured at proof admission; null only for legacy evidence.';
COMMENT ON TABLE cctp_delivery_evidence IS
  'Canonical CCTP MessageReceived and native-USDC mint provenance. Canonical and payout-linked evidence is never pruned; only aged, unreferenced orphaned or superseded rows are eligible.';

-- Down Migration

ALTER TABLE maintenance_job_lease
  DROP CONSTRAINT maintenance_job_lease_job_name_check,
  ADD CONSTRAINT maintenance_job_lease_job_name_check
    CHECK (job_name IN ('rail_attestation_retention', 'route_health_compaction'));
DROP INDEX IF EXISTS cctp_delivery_evidence_retention_scan;
ALTER TABLE cctp_delivery_evidence
  DROP COLUMN verification_context,
  DROP COLUMN receipt_log_index;
COMMENT ON TABLE cctp_delivery_evidence IS
  'Canonical CCTP MessageReceived and native-USDC mint provenance, retained to revalidate destination proofs after reorgs.';
