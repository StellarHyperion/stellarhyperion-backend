-- Up Migration

CREATE TABLE keeper_tx_outcome_counter (
  job_kind    TEXT        NOT NULL CHECK (job_kind IN ('ttl-bump', 'claim-settlement')),
  outcome     TEXT        NOT NULL CHECK (outcome IN ('simulated', 'submitted', 'confirmed', 'failed')),
  total_count BIGINT      NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job_kind, outcome)
);

CREATE TABLE keeper_tx_submission (
  tx_hash      TEXT        PRIMARY KEY,
  chain_key    TEXT        NOT NULL,
  job_kind     TEXT        NOT NULL CHECK (job_kind IN ('ttl-bump', 'claim-settlement')),
  contract_id  TEXT        NOT NULL,
  method       TEXT        NOT NULL,
  status       TEXT        NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed')),
  last_error   TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX keeper_tx_submission_status_idx
  ON keeper_tx_submission (status, submitted_at ASC);

-- Down Migration

DROP INDEX IF EXISTS keeper_tx_submission_status_idx;
DROP TABLE IF EXISTS keeper_tx_submission;
DROP TABLE IF EXISTS keeper_tx_outcome_counter;
