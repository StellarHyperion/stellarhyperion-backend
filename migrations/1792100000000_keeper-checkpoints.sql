-- Up Migration

CREATE TABLE keeper_checkpoint (
  hash        text NOT NULL,
  operation   text NOT NULL CHECK (operation IN ('keep_alive', 'settle_claim')),
  chain_key   text NOT NULL,
  contract    text NOT NULL,
  state       text NOT NULL CHECK (state IN ('submitted', 'confirmed', 'failed')),
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  PRIMARY KEY (hash)
);

CREATE INDEX idx_keeper_checkpoint_state ON keeper_checkpoint (state);
CREATE INDEX idx_keeper_checkpoint_contract ON keeper_checkpoint (chain_key, contract);

COMMENT ON TABLE keeper_checkpoint IS
  'Durable checkpoint of every signed keeper transaction before network submission, so unknown broadcast outcomes can be reconciled by the saved hash before retry.';

-- Down Migration

DROP INDEX IF EXISTS idx_keeper_checkpoint_contract;
DROP INDEX IF EXISTS idx_keeper_checkpoint_state;
DROP TABLE IF EXISTS keeper_checkpoint;
