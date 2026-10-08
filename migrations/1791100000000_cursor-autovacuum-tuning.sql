-- Up Migration

-- In production, indexer_cursor accumulates high-frequency updates from chain watchers advancing
-- their cursor position. Small tables subject to frequent updates accumulate dead tuples quickly.
-- Tuning the autovacuum scale factor and cost limit ensures Postgres vacuums this table aggressively
-- to prevent index and table bloat without starving the worker.
ALTER TABLE indexer_cursor
  SET (
    autovacuum_vacuum_scale_factor = 0.05,
    autovacuum_vacuum_cost_limit = 500
  );

-- Down Migration

ALTER TABLE indexer_cursor
  RESET (
    autovacuum_vacuum_scale_factor,
    autovacuum_vacuum_cost_limit
  );
