-- Up Migration

-- What a cursor needs to notice a reorg, which the first schema had no way to see.
--
-- A Stellar cursor does not need this and never will: a closed ledger is closed, so the ledger
-- number is the whole position. An EVM cursor is a position on a chain that can change its mind
-- about which block had that number, and a watcher holding only the number cannot tell the
-- difference between advancing and being handed a different history.
--
-- Nullable, because the Stellar rows legitimately have nothing to put here and a NOT NULL column
-- with a placeholder for half the rows is a column that means two things.
ALTER TABLE indexer_cursor
  ADD COLUMN last_processed_hash text;

COMMENT ON COLUMN indexer_cursor.last_processed_hash IS
  'Block hash at the cursor, EVM only. Re-read on every pass: a hash that no longer matches means the chain reorganised past a block this indexer had already believed, which is reported rather than quietly re-indexed. Null for Stellar, where a closed ledger cannot change.';

-- Down Migration

ALTER TABLE indexer_cursor
  DROP COLUMN last_processed_hash;
