-- Up Migration

CREATE TABLE evm_block_checkpoint (
  chain_key text NOT NULL,
  contract text NOT NULL,
  block_number numeric(20, 0) NOT NULL CHECK (block_number >= 0),
  block_hash text NOT NULL CHECK (length(block_hash) > 0),
  block_timestamp timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_key, contract, block_number)
);

CREATE INDEX evm_block_checkpoint_recent_idx
  ON evm_block_checkpoint (chain_key, lower(contract), block_number DESC);

-- Down Migration

DROP INDEX IF EXISTS evm_block_checkpoint_recent_idx;
DROP TABLE IF EXISTS evm_block_checkpoint;
