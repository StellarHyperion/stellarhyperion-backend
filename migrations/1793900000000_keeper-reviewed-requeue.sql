-- Up Migration
CREATE TABLE keeper_requeue_audit (
  id bigserial PRIMARY KEY,
  queue_job_id text NOT NULL CHECK (length(queue_job_id) BETWEEN 1 AND 200),
  job_name text NOT NULL CHECK (job_name IN ('ttl-bump','claim-settlement')),
  reviewed_by text NOT NULL CHECK (length(reviewed_by) BETWEEN 1 AND 200),
  reviewed_reason text NOT NULL CHECK (length(reviewed_reason) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX keeper_requeue_audit_job_created
  ON keeper_requeue_audit(queue_job_id,created_at DESC);
COMMENT ON TABLE keeper_requeue_audit IS
  'Operator-reviewed retries of failed keeper maintenance jobs. Submission checkpoints remain the durable evidence for uncertain public transaction outcomes.';

-- Down Migration
DROP TABLE keeper_requeue_audit;
