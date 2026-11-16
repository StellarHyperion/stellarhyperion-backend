-- Up Migration

-- Bounded compaction metadata for route_health so steady-state configuration samples older than
-- the raw diagnostic window fold into their initial transition row without losing audit boundaries.

ALTER TABLE route_health
  ADD COLUMN compacted_count integer NOT NULL DEFAULT 1,
  ADD COLUMN window_ended_at timestamptz,
  ADD CONSTRAINT route_health_compaction_window CHECK (
    (compacted_count = 1 AND window_ended_at IS NULL)
    OR (compacted_count > 1 AND window_ended_at IS NOT NULL AND window_ended_at >= sampled_at)
  );

CREATE INDEX route_health_compaction_scan
  ON route_health (origin_chain, destination_chain, route, token, sampled_at ASC, id ASC);

COMMENT ON COLUMN route_health.compacted_count IS
  'Number of identical consecutive samples folded into this transition row. One for raw uncompacted rows.';
COMMENT ON COLUMN route_health.window_ended_at IS
  'Timestamp of the final identical sample folded into this boundary row; null when compacted_count is 1.';

CREATE TABLE health_sample_compaction (
  id                  smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  raw_window_seconds  integer NOT NULL CHECK (raw_window_seconds > 0),
  compacted_before    timestamptz NOT NULL,
  last_compacted_at   timestamptz NOT NULL DEFAULT now(),
  total_rows_deleted  numeric(20, 0) NOT NULL DEFAULT 0 CHECK (total_rows_deleted >= 0),
  total_runs          numeric(20, 0) NOT NULL DEFAULT 0 CHECK (total_runs >= 0)
);

COMMENT ON TABLE health_sample_compaction IS
  'Singleton watermark recording the boundary between compacted transition history and raw diagnostic samples.';
COMMENT ON COLUMN health_sample_compaction.compacted_before IS
  'Cutoff timestamp below which steady-state route_health samples have been compacted into transition boundaries.';

-- Down Migration

DROP TABLE IF EXISTS health_sample_compaction;
DROP INDEX IF EXISTS route_health_compaction_scan;
ALTER TABLE route_health
  DROP CONSTRAINT IF EXISTS route_health_compaction_window,
  DROP COLUMN IF EXISTS window_ended_at,
  DROP COLUMN IF EXISTS compacted_count;
