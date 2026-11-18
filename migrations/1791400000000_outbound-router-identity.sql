-- Up Migration

-- The initial schema now creates origin_router directly. This migration upgrades databases that
-- already ran the initial schema without discarding their indexed history.
ALTER TABLE outbound_transfer
  ADD COLUMN IF NOT EXISTS origin_router text NOT NULL DEFAULT '';

ALTER TABLE outbound_transfer
  DROP CONSTRAINT IF EXISTS outbound_transfer_identity;

ALTER TABLE outbound_transfer
  ADD CONSTRAINT outbound_transfer_identity UNIQUE (origin_chain, origin_router, nonce);

-- Down Migration

ALTER TABLE outbound_transfer
  DROP CONSTRAINT IF EXISTS outbound_transfer_identity;

ALTER TABLE outbound_transfer
  ADD CONSTRAINT outbound_transfer_identity UNIQUE (origin_chain, nonce);

ALTER TABLE outbound_transfer
  DROP COLUMN IF EXISTS origin_router;
