-- Up Migration
CREATE TABLE IF NOT EXISTS migration_backup_boundary (
  backup_id       text PRIMARY KEY,
  migration_name  text NOT NULL,
  verified_at     timestamptz NOT NULL,
  verified_by     text NOT NULL,
  verification    text NOT NULL
);

COMMENT ON TABLE migration_backup_boundary IS
  'Operator-recorded backup boundary verified before a migration that may require restore.';

-- Down Migration
DROP TABLE IF EXISTS migration_backup_boundary;
