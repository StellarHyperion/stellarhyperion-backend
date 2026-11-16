-- Up Migration

ALTER TABLE indexer_cursor
  ADD COLUMN deployment_revision integer NOT NULL DEFAULT 1 CHECK (deployment_revision >= 1),
  ADD COLUMN start_ledger numeric(20, 0) CHECK (start_ledger IS NULL OR start_ledger >= 0);

CREATE TABLE stellar_deployment_cursor (
  chain_key text NOT NULL,
  deployment_revision integer NOT NULL CHECK (deployment_revision >= 1),
  contract text NOT NULL,
  start_ledger numeric(20, 0) NOT NULL CHECK (start_ledger >= 0),
  last_processed numeric(20, 0) NOT NULL CHECK (last_processed >= 0),
  last_processed_at timestamptz,
  status text NOT NULL CHECK (status IN ('active', 'superseded')),
  activated_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_key, deployment_revision),
  UNIQUE (chain_key, contract)
);

CREATE INDEX stellar_deployment_cursor_status_idx
  ON stellar_deployment_cursor (chain_key, status, deployment_revision DESC);

-- Down Migration

DROP INDEX IF EXISTS stellar_deployment_cursor_status_idx;
DROP TABLE IF EXISTS stellar_deployment_cursor;
ALTER TABLE indexer_cursor
  DROP COLUMN IF EXISTS start_ledger,
  DROP COLUMN IF EXISTS deployment_revision;
