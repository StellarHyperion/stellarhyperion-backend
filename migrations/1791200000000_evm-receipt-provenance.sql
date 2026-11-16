-- Up Migration

-- Canonical block hash provenance on EVM transfers and deliveries, bound from verified receipts.
--
-- Recording the canonical block hash alongside block number and transaction hash ties each indexed
-- transfer row to the exact block header and successful transaction receipt verified before commit.

ALTER TABLE outbound_transfer
  ADD COLUMN origin_block_hash text;

COMMENT ON COLUMN outbound_transfer.origin_block_hash IS
  'Canonical origin block hash verified across log, receipt, and block header on EVM chains. Null for Stellar.';

ALTER TABLE inbound_delivery
  ADD COLUMN destination_block_hash text;

COMMENT ON COLUMN inbound_delivery.destination_block_hash IS
  'Canonical destination block hash verified across log, receipt, and block header on EVM chains. Null for Stellar.';

-- Down Migration

ALTER TABLE inbound_delivery
  DROP COLUMN IF EXISTS destination_block_hash;

ALTER TABLE outbound_transfer
  DROP COLUMN IF EXISTS origin_block_hash;
