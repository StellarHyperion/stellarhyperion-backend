-- Up Migration

-- Distributed watcher ownership leases and monotonic fence tokens for container rollouts.
--
-- Prevents overlapping instances during rolling restarts from racing on shared indexer
-- cursors or writing stale pages after lease expiration or graceful drain handoff.
CREATE TABLE indexer_rollout_lease (
  lease_key text PRIMARY KEY,
  holder_id text NOT NULL,
  fence_token numeric(20,0) NOT NULL CHECK (fence_token >= 1),
  draining boolean NOT NULL DEFAULT false,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX indexer_rollout_lease_expires_idx
  ON indexer_rollout_lease (expires_at);

COMMENT ON TABLE indexer_rollout_lease IS
  'Distributed rollout lease coordinating shared chain watcher and rail poller cursor ownership across container restarts.';

-- Down Migration

DROP TABLE IF EXISTS indexer_rollout_lease;
