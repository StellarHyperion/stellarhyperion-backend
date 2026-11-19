-- Up Migration
CREATE TABLE evm_backfill_job (
  id text PRIMARY KEY, owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 200),
  chain_key text NOT NULL, contract text NOT NULL,
  from_block numeric(20,0) NOT NULL CHECK (from_block >= 0),
  to_block numeric(20,0) NOT NULL, next_block numeric(20,0) NOT NULL,
  written bigint NOT NULL DEFAULT 0, ignored bigint NOT NULL DEFAULT 0,
  state text NOT NULL CHECK (state IN ('queued','running','cancelled','completed','failed')),
  error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (to_block >= from_block AND to_block - from_block < 100000),
  CHECK (next_block BETWEEN from_block AND to_block + 1)
);
CREATE INDEX evm_backfill_job_progress ON evm_backfill_job (created_at DESC, id);
CREATE TABLE evm_applied_event (
  chain_key text NOT NULL, contract text NOT NULL,
  block_number numeric(20,0) NOT NULL, tx_hash text NOT NULL, log_index integer NOT NULL,
  digest text NOT NULL, PRIMARY KEY(chain_key, contract, block_number, tx_hash, log_index)
);
-- Down Migration
DROP TABLE evm_applied_event;
DROP TABLE evm_backfill_job;
