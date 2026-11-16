-- Up Migration

-- Persisted run correlation for hosted catch-up jobs and background worker passes.
--
-- Links a safe public run identifier to every chain scan window and rail verification transition
-- recorded during that execution so separate API-only replicas and restarts can distinguish
-- partial progress from a completed catch-up without conflating distinct jobs.

CREATE TABLE worker_run (
  run_id text PRIMARY KEY,
  network text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'partial', 'completed', 'failed')),
  expected_chains text[] NOT NULL DEFAULT '{}',
  expected_rails text[] NOT NULL DEFAULT '{}',
  caught_up_chains text[] NOT NULL DEFAULT '{}',
  caught_up_rails text[] NOT NULL DEFAULT '{}',
  scan_windows integer NOT NULL DEFAULT 0 CHECK (scan_windows >= 0),
  verification_transitions integer NOT NULL DEFAULT 0 CHECK (verification_transitions >= 0),
  verified_deliveries integer NOT NULL DEFAULT 0 CHECK (verified_deliveries >= 0),
  ended_reason text,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);

CREATE INDEX worker_run_started_at_idx ON worker_run (started_at DESC);

CREATE TABLE worker_scan_journal (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL REFERENCES worker_run(run_id) ON DELETE CASCADE,
  chain_key text NOT NULL,
  family text NOT NULL CHECK (family IN ('stellar', 'evm')),
  from_position bigint NOT NULL,
  to_position bigint NOT NULL,
  decoded_count integer NOT NULL CHECK (decoded_count >= 0),
  skipped_count integer NOT NULL CHECK (skipped_count >= 0),
  behind_count bigint NOT NULL CHECK (behind_count >= 0),
  caught_up boolean NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX worker_scan_journal_run_idx ON worker_scan_journal (run_id, id ASC);

CREATE TABLE worker_verification_journal (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL REFERENCES worker_run(run_id) ON DELETE CASCADE,
  transfer_id bigint NOT NULL REFERENCES outbound_transfer(id) ON DELETE CASCADE,
  route smallint NOT NULL,
  previous_status text,
  next_status text NOT NULL,
  verified_delivery boolean NOT NULL DEFAULT false,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX worker_verification_journal_run_idx ON worker_verification_journal (run_id, id ASC);

-- Down Migration

DROP TABLE IF EXISTS worker_verification_journal;
DROP TABLE IF EXISTS worker_scan_journal;
DROP TABLE IF EXISTS worker_run;
