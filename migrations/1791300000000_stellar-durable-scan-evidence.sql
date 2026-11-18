-- Up Migration
CREATE TABLE stellar_event_identity (
  chain_key text NOT NULL, contract text NOT NULL, identity text NOT NULL,
  evidence jsonb NOT NULL, PRIMARY KEY (chain_key, contract, identity)
);
CREATE TABLE stellar_event_conflict (
  chain_key text NOT NULL, contract text NOT NULL, identity text NOT NULL,
  incoming_digest text NOT NULL, evidence jsonb NOT NULL,
  PRIMARY KEY (chain_key, contract, identity, incoming_digest)
);
CREATE TABLE stellar_scan_journal (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chain_key text NOT NULL, contract text NOT NULL, journal jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stellar_scan_journal_chain ON stellar_scan_journal (chain_key, contract, id);
-- Down Migration
DROP TABLE stellar_scan_journal;
DROP TABLE stellar_event_conflict;
DROP TABLE stellar_event_identity;
