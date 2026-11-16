-- Up Migration

ALTER TABLE indexer_cursor
  ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1);

CREATE TABLE stellar_cursor_repair_audit (
  id bigserial PRIMARY KEY,
  proposal_id text NOT NULL UNIQUE,
  chain_key text NOT NULL,
  contract text NOT NULL,
  action text NOT NULL CHECK (action IN ('initialize', 'advance', 'rewind')),
  expected_revision bigint NOT NULL CHECK (expected_revision >= 0),
  applied_revision bigint NOT NULL CHECK (applied_revision >= 1),
  before_contract text,
  before_position numeric(20, 0),
  before_observed_at timestamptz,
  proposed_position numeric(20, 0) NOT NULL CHECK (proposed_position >= 0),
  proposed_observed_at timestamptz,
  verified_from_ledger numeric(20, 0) NOT NULL,
  verified_through_ledger numeric(20, 0) NOT NULL,
  rpc_oldest_ledger numeric(20, 0) NOT NULL,
  rpc_latest_ledger numeric(20, 0) NOT NULL,
  terminal_cursor text NOT NULL,
  justification text NOT NULL,
  reviewed_by text NOT NULL CHECK (length(trim(reviewed_by)) > 0),
  review_note text NOT NULL CHECK (length(trim(review_note)) > 0),
  proposal_payload jsonb NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX stellar_cursor_repair_audit_chain_idx
  ON stellar_cursor_repair_audit (chain_key, applied_at DESC);

-- Down Migration

DROP INDEX IF EXISTS stellar_cursor_repair_audit_chain_idx;
DROP TABLE IF EXISTS stellar_cursor_repair_audit;
ALTER TABLE indexer_cursor
  DROP COLUMN IF EXISTS revision;
