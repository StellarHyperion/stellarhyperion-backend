-- Up Migration
CREATE TABLE evm_log_quarantine (
  chain_key        text NOT NULL,
  block_number     numeric(20, 0) NOT NULL,
  transaction_hash text NOT NULL,
  log_index        integer NOT NULL,
  event_name       text NOT NULL,
  reason           text NOT NULL,
  observed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_key, block_number, transaction_hash, log_index, reason)
);

CREATE INDEX evm_log_quarantine_chain ON evm_log_quarantine (chain_key, observed_at DESC);

COMMENT ON TABLE evm_log_quarantine IS
  'Bounded evidence for EVM logs whose ordering would make paired lifecycle state ambiguous.';

-- Down Migration
DROP TABLE evm_log_quarantine;
