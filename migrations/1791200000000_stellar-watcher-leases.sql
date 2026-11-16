-- Up Migration

-- Expiring database-backed leases coordinating concurrent continuous and scheduled Stellar
-- watchers per `(chain_key, contract)`.
--
-- Ownership changes monotonically increment `fence_token`. Every event-and-cursor commit verifies
-- `(holder_id, fence_token)` and `expires_at > now` inside the same database transaction before
-- advancing `indexer_cursor`, ensuring crashed holders lose ownership after bounded expiry and
-- stale holders abort before any unauthorized cursor write.
CREATE TABLE stellar_watcher_lease (
  chain_key    text NOT NULL,
  contract     text NOT NULL,
  holder_id    text NOT NULL,
  fence_token  bigint NOT NULL DEFAULT 1
                 CONSTRAINT stellar_watcher_lease_fence_check
                 CHECK (fence_token >= 1),
  acquired_at  timestamptz NOT NULL,
  renewed_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  PRIMARY KEY (chain_key, contract),
  CONSTRAINT stellar_watcher_lease_expiry_check
    CHECK (expires_at > renewed_at)
);

CREATE INDEX stellar_watcher_lease_expires_idx
  ON stellar_watcher_lease (expires_at);

ALTER TABLE stellar_watcher_lease
  SET (
    autovacuum_vacuum_scale_factor = 0.05,
    autovacuum_vacuum_cost_limit = 500
  );

COMMENT ON TABLE stellar_watcher_lease IS
  'Fenced expiring ownership leases per Stellar chain and router contract for coordinating concurrent continuous and scheduled watchers.';

-- Down Migration

DROP INDEX IF EXISTS stellar_watcher_lease_expires_idx;
DROP TABLE IF EXISTS stellar_watcher_lease;
