-- Up Migration

-- Add monotonic cursor revision to indexer_cursor for compare-and-swap concurrency protection.
ALTER TABLE indexer_cursor
  ADD COLUMN revision bigint NOT NULL DEFAULT 1
    CONSTRAINT indexer_cursor_revision_check CHECK (revision >= 1);

COMMENT ON COLUMN indexer_cursor.revision IS
  'Monotonically incremented version number used for compare-and-swap concurrency protection.';

-- Down Migration

ALTER TABLE indexer_cursor
  DROP COLUMN IF EXISTS revision;
