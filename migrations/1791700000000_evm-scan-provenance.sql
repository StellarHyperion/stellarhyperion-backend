-- Up Migration

-- Per-scan finality-policy provenance for EVM watchers (#47).
-- Records the configured confirmation and reorg-depth policy alongside each committed block
-- range so operators and audits can verify under what finality assumptions rows were indexed
-- and detect policy changes across scans.
CREATE TABLE evm_scan_provenance (
  id                     bigserial PRIMARY KEY,
  chain_key              text NOT NULL,
  contract               text NOT NULL,
  chain_id               integer NOT NULL,
  from_block             numeric(20, 0) NOT NULL,
  to_block               numeric(20, 0) NOT NULL,
  end_block_hash         text NOT NULL,
  head_block             numeric(20, 0) NOT NULL,
  confirmations          integer NOT NULL CHECK (confirmations >= 0),
  reorg_depth            integer NOT NULL CHECK (reorg_depth >= 1),
  logs_written           integer NOT NULL DEFAULT 0 CHECK (logs_written >= 0),
  logs_ignored           integer NOT NULL DEFAULT 0 CHECK (logs_ignored >= 0),
  reorg_detected         boolean NOT NULL DEFAULT false,
  policy_changed         boolean NOT NULL DEFAULT false,
  previous_confirmations integer,
  previous_reorg_depth   integer,
  owner_id               text,
  committed_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT evm_scan_provenance_range_chk CHECK (from_block <= to_block),
  CONSTRAINT evm_scan_provenance_policy_change_chk CHECK (
    (NOT policy_changed AND previous_confirmations IS NULL AND previous_reorg_depth IS NULL)
    OR (policy_changed AND previous_confirmations IS NOT NULL AND previous_reorg_depth IS NOT NULL)
  )
);

CREATE INDEX evm_scan_provenance_chain_idx
  ON evm_scan_provenance (chain_key, contract, id DESC);

CREATE INDEX evm_scan_provenance_policy_changes_idx
  ON evm_scan_provenance (chain_key, contract, id DESC)
  WHERE policy_changed;

COMMENT ON TABLE evm_scan_provenance IS
  'Durable provenance of committed EVM watcher scans, including configured finality policy and policy transitions.';

-- Down Migration

DROP TABLE IF EXISTS evm_scan_provenance;
