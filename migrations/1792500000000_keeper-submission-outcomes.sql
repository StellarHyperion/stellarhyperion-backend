-- Up Migration

-- --------------------------------------------------------------------------------------------
-- Keeper submission evidence (#115, #136)
-- --------------------------------------------------------------------------------------------

CREATE TABLE keeper_submission (
  id                 bigserial PRIMARY KEY,
  job_name           text NOT NULL CHECK (job_name IN ('ttl-bump', 'claim-settlement')),
  signer_public_key  text NOT NULL,
  transaction_hash   text,
  stage              text NOT NULL CHECK (stage IN ('simulated', 'submitted', 'pending', 'confirmed', 'failed')),
  error_detail       text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX keeper_submission_stage_updated
  ON keeper_submission (stage, updated_at DESC);

COMMENT ON TABLE keeper_submission IS
  'Durable keeper transaction lifecycle evidence. Hashes are public chain references; signer secrets are never stored.';

-- Down Migration

DROP TABLE IF EXISTS keeper_submission;
