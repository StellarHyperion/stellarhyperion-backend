-- Up Migration

-- --------------------------------------------------------------------------------------------
-- Compare-and-swap cursor revision (#32)
-- --------------------------------------------------------------------------------------------

ALTER TABLE indexer_cursor
  ADD COLUMN revision bigint NOT NULL DEFAULT 1;

COMMENT ON COLUMN indexer_cursor.revision IS
  'Monotonic cursor revision checked inside the event transaction so concurrent stale writes are rejected.';

-- --------------------------------------------------------------------------------------------
-- Expiring database-backed watcher leases (#31)
-- --------------------------------------------------------------------------------------------

CREATE TABLE indexer_lease (
  chain_key    text NOT NULL,
  contract     text NOT NULL,
  owner_id     text NOT NULL,
  lease_until  timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_key, contract)
);

CREATE INDEX idx_indexer_lease_until ON indexer_lease (lease_until);

COMMENT ON TABLE indexer_lease IS
  'Expiring ownership leases per chain and router so continuous and scheduled workers do not overlap.';

-- --------------------------------------------------------------------------------------------
-- Durable Stellar history-gap tracking (#29)
-- --------------------------------------------------------------------------------------------

CREATE TABLE stellar_history_gap (
  id               bigserial PRIMARY KEY,
  chain_key        text NOT NULL,
  contract         text NOT NULL,
  start_ledger     numeric(20, 0) NOT NULL,
  end_ledger       numeric(20, 0) NOT NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reconciling', 'reconciled')),
  replayed_through numeric(20, 0),
  reason           text NOT NULL,
  detected_at      timestamptz NOT NULL DEFAULT now(),
  reconciled_at    timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stellar_history_gap_range_chk CHECK (start_ledger <= end_ledger),
  CONSTRAINT stellar_history_gap_replay_chk CHECK (
    replayed_through IS NULL OR (replayed_through >= start_ledger - 1 AND replayed_through <= end_ledger)
  ),
  UNIQUE (chain_key, contract, start_ledger, end_ledger)
);

CREATE INDEX idx_stellar_history_gap_status ON stellar_history_gap (chain_key, contract, status, start_ledger);

COMMENT ON TABLE stellar_history_gap IS
  'Unavailable Stellar ledger intervals whose history was outside RPC retention and requires historical backfill.';

-- --------------------------------------------------------------------------------------------
-- Separate historical-provider backfill progress (#30)
-- --------------------------------------------------------------------------------------------

CREATE TABLE stellar_backfill_cursor (
  chain_key        text NOT NULL,
  contract         text NOT NULL,
  job_key          text NOT NULL DEFAULT 'default',
  start_ledger     numeric(20, 0) NOT NULL,
  end_ledger       numeric(20, 0) NOT NULL,
  next_ledger      numeric(20, 0) NOT NULL,
  status           text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  revision         bigint NOT NULL DEFAULT 1,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_key, contract, job_key),
  CONSTRAINT stellar_backfill_range_chk CHECK (start_ledger <= end_ledger)
);

COMMENT ON TABLE stellar_backfill_cursor IS
  'Bounded historical-provider replay progress, kept separate from the live indexer_cursor.';

-- Down Migration

DROP TABLE IF EXISTS stellar_backfill_cursor;
DROP TABLE IF EXISTS stellar_history_gap;
DROP TABLE IF EXISTS indexer_lease;
ALTER TABLE indexer_cursor DROP COLUMN IF EXISTS revision;
