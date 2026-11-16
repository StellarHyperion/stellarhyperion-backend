-- Up Migration

-- Ownership leases and durable resume checkpoints for bounded database maintenance jobs.
--
-- Retention sweeps acquire a named lease with a monotonic fence token before scanning a bounded
-- primary-key window, re-verify lease ownership inside every batch transaction, and persist the
-- last processed key so interrupted jobs resume from a durable batch boundary.

CREATE TABLE maintenance_job_lease (
  job_name           text PRIMARY KEY CHECK (btrim(job_name) <> ''),
  owner_id           text CHECK (owner_id IS NULL OR btrim(owner_id) <> ''),
  fence_token        numeric(20, 0) NOT NULL DEFAULT 0 CHECK (fence_token >= 0),
  lease_expires_at   timestamptz,
  resume_cursor      numeric(20, 0) NOT NULL DEFAULT 0 CHECK (resume_cursor >= 0),
  batches_completed  numeric(20, 0) NOT NULL DEFAULT 0 CHECK (batches_completed >= 0),
  rows_pruned        numeric(20, 0) NOT NULL DEFAULT 0 CHECK (rows_pruned >= 0),
  last_batch_at      timestamptz,
  last_completed_at  timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT maintenance_job_lease_owner_expiry CHECK (
    (owner_id IS NULL AND lease_expires_at IS NULL)
    OR (owner_id IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);

CREATE INDEX rail_attestation_retention_scan
  ON rail_attestation (transfer_id ASC, updated_at)
  WHERE status = 'delivered';

CREATE INDEX route_health_retention_scan
  ON route_health (id ASC, sampled_at);

COMMENT ON TABLE maintenance_job_lease IS
  'Single-owner lease, monotonic fence token, and durable batch cursor per maintenance retention job.';

-- Down Migration

DROP INDEX IF EXISTS route_health_retention_scan;
DROP INDEX IF EXISTS rail_attestation_retention_scan;
DROP TABLE IF EXISTS maintenance_job_lease;
