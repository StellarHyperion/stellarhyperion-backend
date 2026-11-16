-- Up Migration

CREATE TABLE stellar_quarantined_event (
  id text PRIMARY KEY,
  chain_key text NOT NULL,
  contract text NOT NULL,
  ledger numeric(20, 0) NOT NULL,
  tx_hash text NOT NULL,
  operation_index integer,
  transaction_index integer,
  error_message text NOT NULL,
  payload jsonb NOT NULL,
  replayed boolean NOT NULL DEFAULT false,
  replayed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX stellar_quarantined_event_pending_idx
  ON stellar_quarantined_event (chain_key, contract, ledger)
  WHERE replayed = false;

COMMENT ON TABLE stellar_quarantined_event IS
  'Quarantine store for unknown Stellar event schemas and decode failures awaiting offline replay.';

-- Down Migration

DROP INDEX IF EXISTS stellar_quarantined_event_pending_idx;
DROP TABLE IF EXISTS stellar_quarantined_event;
