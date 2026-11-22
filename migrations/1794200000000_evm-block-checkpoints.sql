-- Up Migration
CREATE TABLE evm_block_checkpoint (
  chain_key TEXT NOT NULL,
  contract TEXT NOT NULL CHECK (contract ~ '^0x[0-9a-f]{40}$'),
  deployment_revision INTEGER NOT NULL CHECK (deployment_revision > 0),
  block_number NUMERIC(20,0) NOT NULL CHECK (block_number >= 0),
  block_hash TEXT NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (chain_key, contract, deployment_revision, block_number)
);
COMMENT ON TABLE evm_block_checkpoint IS
  'Bounded canonical scan-end anchors independent of router events. Cursor and checkpoint commit together. Verified reorgs replace orphaned anchors; cleanup preserves the newest 256 per deployment. Append-only evm_scan_provenance remains the full audit history. No checkpoint implies a delivery.';

-- Down Migration
DROP TABLE evm_block_checkpoint;
