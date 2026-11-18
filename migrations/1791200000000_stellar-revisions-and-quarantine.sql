-- Up Migration

-- Deployment revision tracking on the cursor, plus a history table for router replacements and
-- a quarantine table for unknown or undecodable Soroban events.

ALTER TABLE indexer_cursor
  ADD COLUMN deployment_revision integer NOT NULL DEFAULT 1 CHECK (deployment_revision >= 1);

COMMENT ON COLUMN indexer_cursor.deployment_revision IS
  'Monotonic watched deployment revision for this chain cursor. Increments when a router contract is replaced so the new deployment starts from its own start ledger instead of reusing the previous router cursor.';

CREATE TABLE stellar_deployment_revision (
  chain_key           text NOT NULL,
  deployment_revision integer NOT NULL CHECK (deployment_revision >= 1),
  contract            text NOT NULL,
  start_ledger        numeric(20, 0) NOT NULL,
  previous_contract   text,
  previous_cursor     numeric(20, 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_key, deployment_revision)
);

COMMENT ON TABLE stellar_deployment_revision IS
  'Audit trail of watched Stellar router deployment revisions and the cursor boundary each replacement superseded.';

CREATE TABLE stellar_event_quarantine (
  id                  bigserial PRIMARY KEY,
  chain_key           text NOT NULL,
  contract            text NOT NULL,
  deployment_revision integer NOT NULL DEFAULT 1 CHECK (deployment_revision >= 1),
  event_id            text NOT NULL,
  ledger              numeric(20, 0) NOT NULL,
  tx_hash             text NOT NULL,
  tx_index            integer NOT NULL,
  op_index            integer NOT NULL,
  ledger_closed_at    timestamptz,
  reason              text NOT NULL CHECK (reason IN ('unknown_tag', 'decode_error')),
  tag                 text,
  decode_error        text,
  raw_event           jsonb NOT NULL,
  replayed_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_key, event_id)
);

CREATE INDEX stellar_event_quarantine_unreplayed_idx
  ON stellar_event_quarantine (chain_key, ledger, event_id)
  WHERE replayed_at IS NULL;

COMMENT ON TABLE stellar_event_quarantine IS
  'Bounded raw Soroban events and decode errors saved with their exact source position for offline decoder replay.';

-- Down Migration

DROP TABLE IF EXISTS stellar_event_quarantine;
DROP TABLE IF EXISTS stellar_deployment_revision;
ALTER TABLE indexer_cursor
  DROP COLUMN IF EXISTS deployment_revision;
