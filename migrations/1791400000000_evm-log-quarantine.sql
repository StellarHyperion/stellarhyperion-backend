-- Up Migration
-- Unknown router logs are evidence, not transfers. Keep the raw payload so a later decoder can
-- replay it without asking the RPC node for a history it may no longer retain.
CREATE TABLE evm_log_quarantine (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chain_key           text NOT NULL,
  contract            text NOT NULL,
  block_number        numeric(20, 0) NOT NULL,
  transaction_hash    text NOT NULL,
  log_index           integer NOT NULL,
  signature           text NOT NULL,
  data                text NOT NULL,
  topics              jsonb NOT NULL,
  reason              text NOT NULL,
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evm_log_quarantine_identity UNIQUE
    (chain_key, block_number, transaction_hash, log_index)
);

CREATE INDEX evm_log_quarantine_replay
  ON evm_log_quarantine (chain_key, block_number, log_index);

COMMENT ON TABLE evm_log_quarantine IS
  'Bounded evidence for EVM logs this decoder cannot safely materialize. Replay after a decoder upgrade.';

-- Down Migration
DROP TABLE evm_log_quarantine;
