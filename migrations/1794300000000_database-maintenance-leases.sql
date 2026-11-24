-- Up Migration

-- One fenced owner and a durable primary-key boundary for each bounded retention sweep.
-- Attestation rows are eligible only after destination evidence exists and no claim remains open;
-- route-health compaction preserves status boundaries and the latest sample in each series.
CREATE TABLE maintenance_job_lease (
  job_name          text PRIMARY KEY CHECK (
    job_name IN ('rail_attestation_retention', 'route_health_compaction')
  ),
  owner_id          text CHECK (owner_id IS NULL OR btrim(owner_id) <> ''),
  fence_token       bigint NOT NULL DEFAULT 0 CHECK (fence_token >= 0),
  lease_expires_at  timestamptz,
  resume_cursor     bigint NOT NULL DEFAULT 0 CHECK (resume_cursor >= 0),
  batches_completed bigint NOT NULL DEFAULT 0 CHECK (batches_completed >= 0),
  rows_pruned       bigint NOT NULL DEFAULT 0 CHECK (rows_pruned >= 0),
  last_batch_at     timestamptz,
  last_completed_at timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT maintenance_job_lease_owner_expiry CHECK (
    (owner_id IS NULL AND lease_expires_at IS NULL)
    OR (owner_id IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);

CREATE INDEX rail_attestation_retention_scan
  ON rail_attestation (transfer_id, updated_at)
  WHERE status = 'delivered';

COMMENT ON TABLE maintenance_job_lease IS
  'Fenced ownership lease and committed resume boundary for each bounded database maintenance job.';

-- Down Migration

DROP INDEX IF EXISTS rail_attestation_retention_scan;
DROP TABLE IF EXISTS maintenance_job_lease;
