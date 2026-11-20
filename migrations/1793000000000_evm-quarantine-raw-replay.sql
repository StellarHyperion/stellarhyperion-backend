-- Up Migration
ALTER TABLE evm_log_quarantine
  ADD COLUMN contract text CHECK (contract IS NULL OR contract ~ '^0x[0-9a-fA-F]{40}$'),
  ADD COLUMN block_hash text CHECK (block_hash IS NULL OR block_hash ~ '^0x[0-9a-fA-F]{64}$'),
  ADD COLUMN signature text CHECK (signature IS NULL OR signature ~ '^0x[0-9a-fA-F]{64}$'),
  ADD COLUMN data text CHECK (data IS NULL OR (length(data) <= 131074 AND data ~ '^0x([0-9a-fA-F]{2})*$')),
  ADD COLUMN topics jsonb CHECK (topics IS NULL OR (jsonb_typeof(topics) = 'array' AND jsonb_array_length(topics) <= 4));
CREATE INDEX evm_quarantine_raw_replay ON evm_log_quarantine(chain_key,contract,block_number,transaction_hash,log_index)
  WHERE data IS NOT NULL AND block_hash IS NOT NULL;
COMMENT ON COLUMN evm_log_quarantine.data IS 'Bounded raw event evidence; absent for legacy or oversized diagnostics. Replay must verify the retained canonical block hash.';

-- Down Migration
DROP INDEX evm_quarantine_raw_replay;
ALTER TABLE evm_log_quarantine DROP COLUMN topics,DROP COLUMN data,DROP COLUMN signature,DROP COLUMN block_hash,DROP COLUMN contract;
