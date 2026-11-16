-- Up Migration

-- Database-backed work leases with monotonic fencing tokens so multiple rail-poller replicas
-- coordinate candidate processing safely and stale workers cannot commit conflicting decisions.

CREATE TABLE rail_work_lease (
  transfer_id   bigint PRIMARY KEY REFERENCES outbound_transfer (id) ON DELETE CASCADE,
  route         smallint NOT NULL CHECK (route BETWEEN 0 AND 3),
  lease_owner   text NOT NULL CHECK (btrim(lease_owner) <> ''),
  fencing_token bigint NOT NULL CHECK (fencing_token >= 1),
  acquired_at   timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL CHECK (expires_at >= acquired_at)
);

CREATE INDEX rail_work_lease_by_expiry
  ON rail_work_lease (route, expires_at);

COMMENT ON TABLE rail_work_lease IS
  'Bounded per-transfer ownership leases and monotonic fencing tokens for multi-replica rail passes.';
COMMENT ON COLUMN rail_work_lease.fencing_token IS
  'Monotonic counter incremented on every lease acquisition; stale workers with older tokens cannot commit.';

-- Down Migration

DROP TABLE IF EXISTS rail_work_lease;
