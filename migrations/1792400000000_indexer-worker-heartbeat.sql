-- Up Migration

-- --------------------------------------------------------------------------------------------
-- Persistent indexer worker heartbeat and progress reporting (#107)
-- --------------------------------------------------------------------------------------------

CREATE TABLE indexer_worker_heartbeat (
  worker_name           text PRIMARY KEY,
  worker_kind           text NOT NULL CHECK (worker_kind IN ('chain', 'rail', 'keeper', 'other')),
  chain_key             text,
  state                 text NOT NULL CHECK (state IN ('ready', 'degraded', 'down')),
  detail                text NOT NULL,
  last_heartbeat_at     timestamptz NOT NULL DEFAULT now(),
  last_completed_at     timestamptz,
  last_cursor_block     numeric(20, 0),
  consecutive_failures  integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_error            text,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_indexer_worker_heartbeat_recent
  ON indexer_worker_heartbeat (last_heartbeat_at DESC);

COMMENT ON TABLE indexer_worker_heartbeat IS
  'Durable worker heartbeat and completed progress for separate-process and serverless API diagnostics.';

-- Down Migration

DROP TABLE IF EXISTS indexer_worker_heartbeat;
