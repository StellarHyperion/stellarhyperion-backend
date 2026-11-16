-- Up Migration

ALTER TABLE outbound_transfer
  ADD COLUMN origin_block_hash text;

ALTER TABLE inbound_delivery
  ADD COLUMN destination_block_hash text;

ALTER TABLE pending_claim
  ADD COLUMN parked_block numeric(20, 0),
  ADD COLUMN parked_tx text,
  ADD COLUMN parked_log_index integer,
  ADD COLUMN parked_block_hash text,
  ADD COLUMN settled_block numeric(20, 0),
  ADD COLUMN settled_log_index integer,
  ADD COLUMN settled_block_hash text;

CREATE INDEX pending_claim_by_parked_block_idx
  ON pending_claim (chain, parked_block DESC)
  WHERE parked_block IS NOT NULL;

CREATE INDEX pending_claim_by_settled_block_idx
  ON pending_claim (chain, settled_block DESC)
  WHERE settled_block IS NOT NULL;

ALTER TABLE admin_action
  ADD COLUMN queued_block numeric(20, 0),
  ADD COLUMN queued_tx text,
  ADD COLUMN queued_log_index integer,
  ADD COLUMN queued_block_hash text,
  ADD COLUMN settled_block numeric(20, 0),
  ADD COLUMN settled_tx text,
  ADD COLUMN settled_log_index integer,
  ADD COLUMN settled_block_hash text;

CREATE INDEX admin_action_by_queued_block_idx
  ON admin_action (chain, queued_block DESC)
  WHERE queued_block IS NOT NULL;

CREATE INDEX admin_action_by_settled_block_idx
  ON admin_action (chain, settled_block DESC)
  WHERE settled_block IS NOT NULL;

ALTER TABLE route_health
  ADD COLUMN sample_block numeric(20, 0),
  ADD COLUMN sample_tx text,
  ADD COLUMN sample_log_index integer,
  ADD COLUMN sample_block_hash text;

CREATE INDEX route_health_by_sample_block_idx
  ON route_health (origin_chain, sample_block DESC)
  WHERE sample_block IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS route_health_by_sample_block_idx;
ALTER TABLE route_health
  DROP COLUMN IF EXISTS sample_block_hash,
  DROP COLUMN IF EXISTS sample_log_index,
  DROP COLUMN IF EXISTS sample_tx,
  DROP COLUMN IF EXISTS sample_block;

DROP INDEX IF EXISTS admin_action_by_settled_block_idx;
DROP INDEX IF EXISTS admin_action_by_queued_block_idx;
ALTER TABLE admin_action
  DROP COLUMN IF EXISTS settled_block_hash,
  DROP COLUMN IF EXISTS settled_log_index,
  DROP COLUMN IF EXISTS settled_tx,
  DROP COLUMN IF EXISTS settled_block,
  DROP COLUMN IF EXISTS queued_block_hash,
  DROP COLUMN IF EXISTS queued_log_index,
  DROP COLUMN IF EXISTS queued_tx,
  DROP COLUMN IF EXISTS queued_block;

DROP INDEX IF EXISTS pending_claim_by_settled_block_idx;
DROP INDEX IF EXISTS pending_claim_by_parked_block_idx;
ALTER TABLE pending_claim
  DROP COLUMN IF EXISTS settled_block_hash,
  DROP COLUMN IF EXISTS settled_log_index,
  DROP COLUMN IF EXISTS settled_block,
  DROP COLUMN IF EXISTS parked_block_hash,
  DROP COLUMN IF EXISTS parked_log_index,
  DROP COLUMN IF EXISTS parked_tx,
  DROP COLUMN IF EXISTS parked_block;

ALTER TABLE inbound_delivery
  DROP COLUMN IF EXISTS destination_block_hash;

ALTER TABLE outbound_transfer
  DROP COLUMN IF EXISTS origin_block_hash;
