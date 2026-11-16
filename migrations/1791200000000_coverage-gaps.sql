-- Up Migration

-- Historical ledger/block coverage state and unresolved gap ranges.
--
-- Stored separately from indexer_cursor so a cursor advancing at the current chain head never
-- masks an earlier RPC retention hole or unverified pre-start history.

CREATE TABLE indexer_coverage_state (
  chain_key text PRIMARY KEY,
  family text NOT NULL CHECK (family IN ('stellar', 'evm')),
  deployed_start bigint NOT NULL,
  verified_from bigint,
  verified_through bigint,
  coverage_known boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE indexer_coverage_gap (
  id bigserial PRIMARY KEY,
  chain_key text NOT NULL,
  family text NOT NULL CHECK (family IN ('stellar', 'evm')),
  from_height bigint NOT NULL,
  to_height bigint NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT indexer_coverage_gap_range_chk CHECK (to_height >= from_height)
);

CREATE INDEX indexer_coverage_gap_open_idx
  ON indexer_coverage_gap (chain_key, status, from_height ASC);

-- Down Migration

DROP TABLE IF EXISTS indexer_coverage_gap;
DROP TABLE IF EXISTS indexer_coverage_state;
