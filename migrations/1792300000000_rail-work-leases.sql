-- Up Migration

CREATE TABLE rail_work_lease (
  transfer_id  bigint PRIMARY KEY REFERENCES outbound_transfer (id) ON DELETE CASCADE,
  owner_id     uuid NOT NULL,
  lease_token  uuid NOT NULL,
  lease_until  timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rail_work_lease_until ON rail_work_lease (lease_until);

COMMENT ON TABLE rail_work_lease IS
  'Expiring, fenced ownership of rail verification work, so crashed replicas become eligible again without stale decisions committing.';

-- Down Migration

DROP TABLE IF EXISTS rail_work_lease;
