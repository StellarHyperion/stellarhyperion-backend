-- Up Migration

ALTER TABLE outbound_transfer
  ADD COLUMN canonical boolean NOT NULL DEFAULT true;

ALTER TABLE inbound_delivery
  ADD COLUMN canonical boolean NOT NULL DEFAULT true;

CREATE INDEX inbound_delivery_canonical_hop_idx
  ON inbound_delivery (destination_chain, route, source_chain, source_nonce)
  WHERE canonical = true;

CREATE TABLE evm_block_anchor (
  chain_key text NOT NULL,
  contract text NOT NULL,
  block_number numeric(20, 0) NOT NULL CHECK (block_number >= 0),
  block_hash text NOT NULL CHECK (length(block_hash) > 0),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_key, contract, block_number)
);

CREATE INDEX evm_block_anchor_recent_idx
  ON evm_block_anchor (chain_key, lower(contract), block_number DESC);

CREATE TABLE evm_reorg_recovery (
  id bigserial PRIMARY KEY,
  chain_key text NOT NULL,
  contract text NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'resolved')),
  detected_at_block numeric(20, 0) NOT NULL CHECK (detected_at_block >= 0),
  configured_reorg_depth integer NOT NULL CHECK (configured_reorg_depth >= 0),
  recovery_from_block numeric(20, 0) NOT NULL CHECK (recovery_from_block >= 0),
  recovery_to_block numeric(20, 0) NOT NULL CHECK (recovery_to_block >= recovery_from_block),
  safe_anchor_block numeric(20, 0),
  safe_anchor_hash text,
  mismatched_block numeric(20, 0) NOT NULL CHECK (mismatched_block >= 0),
  expected_hash text NOT NULL,
  actual_hash text,
  affected_deliveries integer NOT NULL DEFAULT 0 CHECK (affected_deliveries >= 0),
  affected_transfers integer NOT NULL DEFAULT 0 CHECK (affected_transfers >= 0),
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution_note text
);

CREATE UNIQUE INDEX evm_reorg_recovery_open_idx
  ON evm_reorg_recovery (chain_key, lower(contract))
  WHERE status = 'open';

-- Down Migration

DROP INDEX IF EXISTS evm_reorg_recovery_open_idx;
DROP TABLE IF EXISTS evm_reorg_recovery;
DROP INDEX IF EXISTS evm_block_anchor_recent_idx;
DROP TABLE IF EXISTS evm_block_anchor;
DROP INDEX IF EXISTS inbound_delivery_canonical_hop_idx;
ALTER TABLE inbound_delivery DROP COLUMN IF EXISTS canonical;
ALTER TABLE outbound_transfer DROP COLUMN IF EXISTS canonical;
