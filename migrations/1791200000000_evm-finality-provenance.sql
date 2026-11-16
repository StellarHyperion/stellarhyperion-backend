-- Up Migration

-- Finality policy provenance for EVM scans and materialized transfer rows.
--
-- An EVM block number alone says where an event appeared, not why this indexer believed that
-- block had settled. One deployment may wait twelve blocks behind head, another may follow the
-- chain's `safe` or `finalized` tag, and an operator may change that setting between restarts.
-- Recording both the configured policy and the actual boundary evidence on every committed scan
-- and row keeps weaker policy changes from rewriting how earlier deliveries were established.

ALTER TABLE indexer_cursor
  ADD COLUMN finality_mode text CHECK (finality_mode IN ('confirmations', 'safe', 'finalized')),
  ADD COLUMN finality_confirmations integer CHECK (finality_confirmations >= 0),
  ADD COLUMN finality_allow_fallback boolean,
  ADD COLUMN finality_evidence text CHECK (
    finality_evidence IN ('confirmation_depth', 'safe_block', 'finalized_block')
  ),
  ADD COLUMN finality_tag text CHECK (finality_tag IN ('safe', 'finalized')),
  ADD COLUMN finality_used_fallback boolean;

COMMENT ON COLUMN indexer_cursor.finality_mode IS
  'Configured EVM settlement boundary mode for the most recent committed pass. Null for Stellar.';
COMMENT ON COLUMN indexer_cursor.finality_confirmations IS
  'Configured EVM confirmation depth for the most recent committed pass. Null for Stellar.';
COMMENT ON COLUMN indexer_cursor.finality_allow_fallback IS
  'Whether the configured EVM finality tag was allowed to fall back to confirmation depth.';
COMMENT ON COLUMN indexer_cursor.finality_evidence IS
  'Actual evidence kind that established the cursor boundary on the most recent committed pass.';
COMMENT ON COLUMN indexer_cursor.finality_tag IS
  'RPC block tag that established the cursor boundary when tag-based finality succeeded.';
COMMENT ON COLUMN indexer_cursor.finality_used_fallback IS
  'True when an unsupported EVM finality tag fell back to confirmation depth under explicit configuration.';

ALTER TABLE outbound_transfer
  ADD COLUMN finality_evidence text CHECK (
    finality_evidence IN ('confirmation_depth', 'safe_block', 'finalized_block')
  ),
  ADD COLUMN finality_confirmations integer CHECK (finality_confirmations >= 0),
  ADD COLUMN finality_tag text CHECK (finality_tag IN ('safe', 'finalized')),
  ADD COLUMN finality_boundary_block numeric(20, 0),
  ADD COLUMN finality_boundary_hash text,
  ADD COLUMN finality_used_fallback boolean;

COMMENT ON COLUMN outbound_transfer.finality_evidence IS
  'Strongest verified EVM settlement evidence recorded for this departure. Null for Stellar.';

ALTER TABLE inbound_delivery
  ADD COLUMN finality_evidence text CHECK (
    finality_evidence IN ('confirmation_depth', 'safe_block', 'finalized_block')
  ),
  ADD COLUMN finality_confirmations integer CHECK (finality_confirmations >= 0),
  ADD COLUMN finality_tag text CHECK (finality_tag IN ('safe', 'finalized')),
  ADD COLUMN finality_boundary_block numeric(20, 0),
  ADD COLUMN finality_boundary_hash text,
  ADD COLUMN finality_used_fallback boolean;

COMMENT ON COLUMN inbound_delivery.finality_evidence IS
  'Strongest verified EVM settlement evidence recorded for this arrival. Null for Stellar.';

ALTER TABLE pending_claim
  ADD COLUMN finality_evidence text CHECK (
    finality_evidence IN ('confirmation_depth', 'safe_block', 'finalized_block')
  ),
  ADD COLUMN finality_confirmations integer CHECK (finality_confirmations >= 0),
  ADD COLUMN finality_tag text CHECK (finality_tag IN ('safe', 'finalized')),
  ADD COLUMN finality_boundary_block numeric(20, 0),
  ADD COLUMN finality_boundary_hash text,
  ADD COLUMN finality_used_fallback boolean;

COMMENT ON COLUMN pending_claim.finality_evidence IS
  'Strongest verified EVM settlement evidence recorded when this claim was parked. Null for Stellar.';

CREATE TABLE evm_scan_provenance (
  id                       bigserial PRIMARY KEY,
  chain_key                text NOT NULL,
  contract                 text NOT NULL,
  from_block               numeric(20, 0) NOT NULL,
  to_block                 numeric(20, 0) NOT NULL,
  to_block_hash            text NOT NULL,
  head_block               numeric(20, 0) NOT NULL,
  configured_mode          text NOT NULL CHECK (
    configured_mode IN ('confirmations', 'safe', 'finalized')
  ),
  configured_confirmations integer NOT NULL CHECK (configured_confirmations >= 0),
  allow_fallback           boolean NOT NULL,
  finality_evidence        text NOT NULL CHECK (
    finality_evidence IN ('confirmation_depth', 'safe_block', 'finalized_block')
  ),
  finality_tag             text CHECK (finality_tag IN ('safe', 'finalized')),
  confirmation_depth       integer CHECK (confirmation_depth >= 0),
  finality_boundary_block  numeric(20, 0) NOT NULL,
  finality_boundary_hash   text,
  used_fallback            boolean NOT NULL DEFAULT false,
  policy_changed           boolean NOT NULL DEFAULT false,
  policy_change_kind       text CHECK (policy_change_kind IN ('stronger', 'weaker')),
  previous_mode            text CHECK (previous_mode IN ('confirmations', 'safe', 'finalized')),
  previous_confirmations   integer CHECK (previous_confirmations >= 0),
  previous_allow_fallback  boolean,
  committed_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT evm_scan_provenance_range CHECK (from_block <= to_block),
  CONSTRAINT evm_scan_provenance_evidence CHECK (
    (
      finality_evidence = 'confirmation_depth'
      AND finality_tag IS NULL
      AND confirmation_depth IS NOT NULL
    )
    OR (
      finality_evidence = 'safe_block'
      AND finality_tag = 'safe'
      AND confirmation_depth IS NULL
      AND NOT used_fallback
    )
    OR (
      finality_evidence = 'finalized_block'
      AND finality_tag = 'finalized'
      AND confirmation_depth IS NULL
      AND NOT used_fallback
    )
  ),
  CONSTRAINT evm_scan_provenance_policy_change CHECK (
    (
      NOT policy_changed
      AND policy_change_kind IS NULL
      AND previous_mode IS NULL
      AND previous_confirmations IS NULL
      AND previous_allow_fallback IS NULL
    )
    OR (
      policy_changed
      AND policy_change_kind IS NOT NULL
      AND previous_mode IS NOT NULL
      AND previous_confirmations IS NOT NULL
      AND previous_allow_fallback IS NOT NULL
    )
  )
);

CREATE INDEX evm_scan_provenance_by_chain_block
  ON evm_scan_provenance (chain_key, to_block DESC, id DESC);

CREATE INDEX evm_scan_provenance_policy_changes
  ON evm_scan_provenance (chain_key, id DESC)
  WHERE policy_changed;

COMMENT ON TABLE evm_scan_provenance IS
  'Append-only provenance log of each committed EVM scan range, recording configured finality policy, actual settlement evidence, and detected policy transitions.';
COMMENT ON COLUMN evm_scan_provenance.finality_evidence IS
  'Whether the scan boundary came from confirmation depth behind head or from an explicit safe or finalized block tag.';
COMMENT ON COLUMN evm_scan_provenance.policy_change_kind IS
  'Direction of policy transition relative to the prior committed cursor policy (stronger or weaker).';

-- Down Migration

DROP TABLE IF EXISTS evm_scan_provenance;

ALTER TABLE pending_claim
  DROP COLUMN IF EXISTS finality_used_fallback,
  DROP COLUMN IF EXISTS finality_boundary_hash,
  DROP COLUMN IF EXISTS finality_boundary_block,
  DROP COLUMN IF EXISTS finality_tag,
  DROP COLUMN IF EXISTS finality_confirmations,
  DROP COLUMN IF EXISTS finality_evidence;

ALTER TABLE inbound_delivery
  DROP COLUMN IF EXISTS finality_used_fallback,
  DROP COLUMN IF EXISTS finality_boundary_hash,
  DROP COLUMN IF EXISTS finality_boundary_block,
  DROP COLUMN IF EXISTS finality_tag,
  DROP COLUMN IF EXISTS finality_confirmations,
  DROP COLUMN IF EXISTS finality_evidence;

ALTER TABLE outbound_transfer
  DROP COLUMN IF EXISTS finality_used_fallback,
  DROP COLUMN IF EXISTS finality_boundary_hash,
  DROP COLUMN IF EXISTS finality_boundary_block,
  DROP COLUMN IF EXISTS finality_tag,
  DROP COLUMN IF EXISTS finality_confirmations,
  DROP COLUMN IF EXISTS finality_evidence;

ALTER TABLE indexer_cursor
  DROP COLUMN IF EXISTS finality_used_fallback,
  DROP COLUMN IF EXISTS finality_tag,
  DROP COLUMN IF EXISTS finality_evidence,
  DROP COLUMN IF EXISTS finality_allow_fallback,
  DROP COLUMN IF EXISTS finality_confirmations,
  DROP COLUMN IF EXISTS finality_mode;
