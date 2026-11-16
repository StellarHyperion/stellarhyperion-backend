-- Up Migration

-- Per-deployment expiring ownership leases for EVM watchers.
--
-- Two replicas watching the same `(chain_key, contract)` deployment at once would duplicate RPC
-- load and race overlapping range transactions against `indexer_cursor`. Keying the lease on both
-- `chain_key` and lowercased `contract` scopes ownership to the exact router deployment while
-- expiring automatically if the active replica crashes without releasing its lease.

CREATE TABLE evm_watcher_lease (
  chain_key    text NOT NULL,
  contract     text NOT NULL,
  owner_id     text NOT NULL,
  lease_epoch  numeric(20, 0) NOT NULL DEFAULT 1 CHECK (lease_epoch >= 1),
  acquired_at  timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,

  PRIMARY KEY (chain_key, contract),
  CONSTRAINT evm_watcher_lease_contract_lowercase CHECK (contract = lower(contract)),
  CONSTRAINT evm_watcher_lease_expiry CHECK (expires_at > heartbeat_at)
);

CREATE INDEX evm_watcher_lease_by_expiry
  ON evm_watcher_lease (expires_at);

COMMENT ON TABLE evm_watcher_lease IS
  'Expiring per-deployment ownership lease coordinating multiple EVM watchers on one chain and router.';
COMMENT ON COLUMN evm_watcher_lease.owner_id IS
  'Unique runtime identifier of the watcher instance currently holding ownership.';
COMMENT ON COLUMN evm_watcher_lease.lease_epoch IS
  'Monotonic fencing token incremented whenever a lease changes hands or recovers after expiry.';
COMMENT ON COLUMN evm_watcher_lease.expires_at IS
  'Timestamp after which another watcher may take over ownership if the holder stops heartbeating.';

CREATE OR REPLACE FUNCTION acquire_evm_watcher_lease(
  p_chain_key text,
  p_contract text,
  p_owner_id text,
  p_now timestamptz,
  p_expires_at timestamptz
)
RETURNS TABLE (
  owner_id text,
  lease_epoch numeric(20, 0),
  acquired_at timestamptz,
  heartbeat_at timestamptz,
  expires_at timestamptz,
  acquired boolean
)
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO evm_watcher_lease AS l
    (chain_key, contract, owner_id, lease_epoch, acquired_at, heartbeat_at, expires_at)
  VALUES
    (p_chain_key, lower(p_contract), p_owner_id, 1, p_now, p_now, p_expires_at)
  ON CONFLICT ON CONSTRAINT evm_watcher_lease_pkey DO UPDATE
    SET owner_id = EXCLUDED.owner_id,
        lease_epoch = CASE
          WHEN l.owner_id = EXCLUDED.owner_id AND l.expires_at > p_now THEN l.lease_epoch
          ELSE l.lease_epoch + 1
        END,
        acquired_at = CASE
          WHEN l.owner_id = EXCLUDED.owner_id AND l.expires_at > p_now THEN l.acquired_at
          ELSE EXCLUDED.acquired_at
        END,
        heartbeat_at = EXCLUDED.heartbeat_at,
        expires_at = EXCLUDED.expires_at
    WHERE l.owner_id = EXCLUDED.owner_id
       OR l.expires_at <= p_now;

  RETURN QUERY
    SELECT cur.owner_id,
           cur.lease_epoch,
           cur.acquired_at,
           cur.heartbeat_at,
           cur.expires_at,
           (cur.owner_id = p_owner_id) AS acquired
      FROM evm_watcher_lease AS cur
     WHERE cur.chain_key = p_chain_key
       AND cur.contract = lower(p_contract);
END;
$$;

-- Down Migration

DROP FUNCTION IF EXISTS acquire_evm_watcher_lease(text, text, text, timestamptz, timestamptz);
DROP TABLE IF EXISTS evm_watcher_lease;
