-- Up Migration

-- Persistent worker heartbeats for split API and indexer deployments.
--
-- A serverless or read-only API replica cannot inspect in-memory poller loops in another process,
-- and a healthy SELECT 1 on Postgres says nothing about whether any watcher is still advancing.
-- Recording one bounded row per (worker_name, replica_id) lets API probes and metrics distinguish
-- fresh progress from stalled, missing, or gapped background workers.
CREATE TABLE worker_heartbeat (
  worker_name          text NOT NULL,
  replica_id           text NOT NULL,
  worker_kind          text NOT NULL CHECK (worker_kind IN ('chain', 'rail', 'keeper')),
  state                text NOT NULL CHECK (state IN ('ready', 'degraded', 'down')),
  detail               text NOT NULL,
  heartbeat_at         timestamptz NOT NULL,
  last_progress_at     timestamptz,
  completed_position   numeric(20, 0),
  lag_units            integer CHECK (lag_units IS NULL OR lag_units >= 0),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  expected_interval_ms integer NOT NULL CHECK (expected_interval_ms > 0),
  evidence_gap         boolean NOT NULL DEFAULT false,
  workload_pending     integer CHECK (workload_pending IS NULL OR workload_pending >= 0),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (worker_name, replica_id),
  CONSTRAINT worker_heartbeat_name_len CHECK (char_length(worker_name) BETWEEN 1 AND 64),
  CONSTRAINT worker_heartbeat_replica_len CHECK (char_length(replica_id) BETWEEN 1 AND 64),
  CONSTRAINT worker_heartbeat_detail_len CHECK (char_length(detail) <= 512)
);

CREATE INDEX worker_heartbeat_by_worker_recent
  ON worker_heartbeat (worker_name, heartbeat_at DESC);

ALTER TABLE worker_heartbeat
  SET (
    autovacuum_vacuum_scale_factor = 0.05,
    autovacuum_vacuum_cost_limit = 500
  );

COMMENT ON TABLE worker_heartbeat IS
  'Durable liveness, progress, lag, evidence-gap, and workload snapshots written by background workers so separate API replicas can report real indexer freshness.';
COMMENT ON COLUMN worker_heartbeat.replica_id IS
  'Bounded, credential-free identifier of the worker process that emitted this heartbeat.';
COMMENT ON COLUMN worker_heartbeat.completed_position IS
  'Last durably committed ledger sequence or block number for chain watchers; null for non-positional workers.';
COMMENT ON COLUMN worker_heartbeat.evidence_gap IS
  'True when the worker detected an unindexed retention gap or history discontinuity requiring operator attention.';
COMMENT ON COLUMN worker_heartbeat.workload_pending IS
  'Outstanding backlog items observed by the worker on its latest pass, such as pending rail transfers.';

-- Down Migration

DROP TABLE IF EXISTS worker_heartbeat;
