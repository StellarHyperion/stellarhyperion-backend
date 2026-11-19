-- Up Migration

-- Supporting index for bounded route_health sample compaction (#61).
-- Partitioned by (origin_chain, destination_chain, route, token) and ordered by (sampled_at, id)
-- so old redundant samples can be identified and deleted in bounded batches while preserving
-- change boundaries and recent diagnostic detail.
CREATE INDEX IF NOT EXISTS route_health_compaction_idx
  ON route_health (origin_chain, destination_chain, route, token, sampled_at ASC, id ASC);

-- Down Migration

DROP INDEX IF EXISTS route_health_compaction_idx;
