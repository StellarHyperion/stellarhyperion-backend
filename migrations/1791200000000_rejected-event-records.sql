-- Up Migration

-- Durable ingestion failure records so a malformed or constraint-violating chain event never
-- advances its cursor silently and leaves an auditable, replayable trail.
--
-- Block positions are NUMERIC(20,0) for u64 parity with indexer_cursor and transfer tables.
-- Error diagnostics and raw event previews are bounded in length at the schema boundary so a
-- pathological event or repeated retry loop cannot cause unbounded row growth.

CREATE TABLE rejected_event (
  id                 bigserial PRIMARY KEY,
  chain_key          text NOT NULL,
  family             text NOT NULL CHECK (family IN ('stellar', 'evm')),
  contract           text NOT NULL,
  block_number       numeric(20, 0) NOT NULL CHECK (block_number >= 0),
  tx_hash            text NOT NULL,
  event_ref          text NOT NULL CHECK (char_length(event_ref) BETWEEN 1 AND 256),
  log_index          integer CHECK (log_index IS NULL OR log_index >= 0),
  event_tag          text CHECK (event_tag IS NULL OR char_length(event_tag) <= 256),
  error_class        text NOT NULL CHECK (
    error_class IN (
      'decode_error',
      'shape_error',
      'constraint_violation',
      'state_mismatch',
      'transient_db_error',
      'unknown_error'
    )
  ),
  error_code         text CHECK (error_code IS NULL OR char_length(error_code) <= 64),
  error_message      text NOT NULL CHECK (char_length(error_message) <= 1024),
  replay_eligible    boolean NOT NULL,
  status             text NOT NULL DEFAULT 'rejected' CHECK (status IN ('rejected', 'reconciled')),
  payload_preview    text CHECK (payload_preview IS NULL OR char_length(payload_preview) <= 4096),
  payload_truncated  boolean NOT NULL DEFAULT false,
  failure_count      integer NOT NULL DEFAULT 1 CHECK (failure_count BETWEEN 1 AND 1000000),
  first_failed_at    timestamptz NOT NULL DEFAULT now(),
  last_failed_at     timestamptz NOT NULL DEFAULT now(),
  last_replay_at     timestamptz,
  reconciled_at      timestamptz,
  reconciled_tx      text,

  CONSTRAINT rejected_event_source UNIQUE (chain_key, contract, event_ref),
  CONSTRAINT rejected_event_reconciliation CHECK (
    (status = 'rejected' AND reconciled_at IS NULL AND reconciled_tx IS NULL)
    OR (status = 'reconciled' AND reconciled_at IS NOT NULL)
  )
);

CREATE INDEX rejected_event_unresolved
  ON rejected_event (chain_key, block_number ASC, id ASC)
  WHERE status = 'rejected';

CREATE INDEX rejected_event_replayable
  ON rejected_event (chain_key, block_number ASC, id ASC)
  WHERE status = 'rejected' AND replay_eligible;

COMMENT ON TABLE rejected_event IS
  'Durable ingestion failures recorded outside rolled-back watcher commits, keyed by source event identity.';
COMMENT ON COLUMN rejected_event.event_ref IS
  'Chain-native event identifier: Soroban event id on Stellar, or lowercase txHash:logIndex on EVM.';
COMMENT ON COLUMN rejected_event.error_class IS
  'Normalized ingestion failure class used to distinguish decoder bugs, schema violations, and transient database errors.';
COMMENT ON COLUMN rejected_event.replay_eligible IS
  'True when deterministic replay after a code fix or transient recovery can reconcile this event.';
COMMENT ON COLUMN rejected_event.payload_preview IS
  'Credential-scrubbed and length-bounded JSON preview of the source event for offline triage and replay.';

-- Down Migration

DROP TABLE IF EXISTS rejected_event;
