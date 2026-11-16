-- Up Migration

CREATE TABLE stellar_event_identity (
  chain_key text NOT NULL,
  canonical_key text NOT NULL,
  event_kind text NOT NULL,
  contract text NOT NULL,
  event_id text NOT NULL,
  ledger numeric(20, 0) NOT NULL,
  tx_hash text NOT NULL,
  payload_digest text NOT NULL,
  bounded_summary jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_key, canonical_key)
);

CREATE TABLE stellar_event_conflict (
  id bigserial PRIMARY KEY,
  chain_key text NOT NULL,
  canonical_key text NOT NULL,
  event_kind text NOT NULL,
  contract text NOT NULL,
  existing_event_id text NOT NULL,
  existing_ledger numeric(20, 0) NOT NULL,
  existing_tx_hash text NOT NULL,
  existing_payload_digest text NOT NULL,
  existing_summary jsonb NOT NULL,
  conflicting_event_id text NOT NULL,
  conflicting_ledger numeric(20, 0) NOT NULL,
  conflicting_tx_hash text NOT NULL,
  conflicting_payload_digest text NOT NULL,
  conflicting_summary jsonb NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_key, canonical_key, conflicting_payload_digest, conflicting_event_id)
);

CREATE INDEX stellar_event_conflict_chain_idx
  ON stellar_event_conflict (chain_key, detected_at DESC);

-- Down Migration

DROP INDEX IF EXISTS stellar_event_conflict_chain_idx;
DROP TABLE IF EXISTS stellar_event_conflict;
DROP TABLE IF EXISTS stellar_event_identity;
