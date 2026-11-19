-- Up Migration

-- --------------------------------------------------------------------------------------------
-- Keeper submission evidence (#115, #136)
-- --------------------------------------------------------------------------------------------

CREATE TABLE keeper_submission (
  id                 bigserial PRIMARY KEY,
  job_name           text NOT NULL CHECK (job_name IN ('ttl-bump', 'claim-settlement')),
  signer_public_key  text NOT NULL,
  transaction_hash   text CHECK (transaction_hash IS NULL OR transaction_hash ~ '^[0-9a-f]{64}$'),
  stage              text NOT NULL CHECK (stage IN ('simulated', 'submitted', 'pending', 'confirmed', 'failed')),
  error_detail       text CHECK (error_detail IS NULL OR length(error_detail) <= 200),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX keeper_submission_hash ON keeper_submission(transaction_hash) WHERE transaction_hash IS NOT NULL;
CREATE TABLE keeper_signer_state (
  chain_key text PRIMARY KEY,
  network_passphrase text NOT NULL,
  active_signer text NOT NULL CHECK(active_signer ~ '^G[A-Z2-7]{55}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX keeper_submission_stage_updated
  ON keeper_submission (stage, updated_at DESC);

COMMENT ON TABLE keeper_submission IS
  'Durable keeper transaction lifecycle evidence. Hashes are public chain references; signer secrets are never stored.';

-- Down Migration

DROP TABLE keeper_signer_state;
DROP TABLE keeper_submission;
