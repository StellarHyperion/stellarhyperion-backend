-- Up Migration

-- Committed journal of detected EVM reorganizations, rollback ranges, affected canonical proof
-- counts, and reconciliation status so separate API-only processes and operators can distinguish
-- shallow automatic recovery from deep operator intervention or failed rollbacks.

CREATE TABLE reorg_recovery_journal (
  id bigserial PRIMARY KEY,
  chain_key text NOT NULL,
  cursor_block numeric(20, 0) NOT NULL,
  rewind_to_block numeric(20, 0) NOT NULL,
  reindexed_through_block numeric(20, 0),
  detected_depth integer NOT NULL CHECK (detected_depth >= 1),
  rollback_blocks integer NOT NULL CHECK (rollback_blocks >= 0),
  expected_hash text NOT NULL,
  observed_hash text,
  classification text NOT NULL CHECK (
    classification IN ('shallow_automatic', 'deep_operator_required')
  ),
  reconciliation_status text NOT NULL CHECK (
    reconciliation_status IN (
      'winding_back',
      'reconciled',
      'rollback_failed',
      'operator_intervention_required'
    )
  ),
  affected_outbound_transfers integer NOT NULL DEFAULT 0 CHECK (affected_outbound_transfers >= 0),
  affected_inbound_deliveries integer NOT NULL DEFAULT 0 CHECK (affected_inbound_deliveries >= 0),
  affected_pending_claims integer NOT NULL DEFAULT 0 CHECK (affected_pending_claims >= 0),
  affected_rail_attestations integer NOT NULL DEFAULT 0 CHECK (affected_rail_attestations >= 0),
  rewritten_canonical_proofs integer NOT NULL DEFAULT 0 CHECK (rewritten_canonical_proofs >= 0),
  last_error text,
  detected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  reconciled_at timestamptz
);

CREATE INDEX reorg_recovery_journal_chain_idx
  ON reorg_recovery_journal (chain_key, detected_at DESC, id DESC);

CREATE INDEX reorg_recovery_journal_status_idx
  ON reorg_recovery_journal (reconciliation_status, detected_at DESC);

-- Down Migration

DROP TABLE IF EXISTS reorg_recovery_journal;
