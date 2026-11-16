-- Up Migration

-- Immutable source-event provenance, stored separately from mutable materialized state.
--
-- Materialized rows (pending_claim, admin_action, outbound_transfer, inbound_delivery) evolve as
-- settlements, rail references, or reorg corrections arrive. This table records the exact source
-- event identity and canonical SHA-256 payload digest observed on chain and refuses in-place
-- mutation so replay audits always have the original wire evidence.

CREATE TABLE raw_event_provenance (
  id                 bigserial PRIMARY KEY,
  chain_key          text NOT NULL,
  family             text NOT NULL CHECK (family IN ('stellar', 'evm')),
  contract           text NOT NULL,
  -- Deterministic per-family event key within (chain_key, contract): Soroban RPC event id on
  -- Stellar, and blockNumber:txHash:logIndex on EVM chains.
  event_key          text NOT NULL,
  block_number       numeric(20, 0) NOT NULL,
  block_hash         text,
  tx_hash            text NOT NULL,
  log_index          integer,
  event_tag          text NOT NULL,
  -- monetary rows back transfers, deliveries, claims, and timelock governance and are retained
  -- permanently; telemetry rows back operational health events and can be pruned after windowing.
  retention_class    text NOT NULL CHECK (retention_class IN ('monetary', 'telemetry')),
  payload_sha256     text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  canonical_envelope jsonb NOT NULL,
  chain_timestamp    timestamptz NOT NULL,
  first_observed_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT raw_event_provenance_identity UNIQUE (chain_key, contract, event_key),
  CONSTRAINT raw_event_provenance_envelope_bounds CHECK (
    octet_length(canonical_envelope::text) <= 65536
  )
);

CREATE INDEX raw_event_provenance_by_tx
  ON raw_event_provenance (chain_key, tx_hash);

CREATE INDEX raw_event_provenance_by_position
  ON raw_event_provenance (chain_key, block_number DESC, id DESC);

CREATE INDEX raw_event_provenance_telemetry_retention
  ON raw_event_provenance (first_observed_at ASC)
  WHERE retention_class = 'telemetry';

COMMENT ON TABLE raw_event_provenance IS
  'Append-only source event identity and canonical payload digest. Monetary rows are retained permanently; telemetry rows expire via bounded maintenance pruning.';
COMMENT ON COLUMN raw_event_provenance.canonical_envelope IS
  'Canonicalized source payload bounded to 64 KiB. Oversized payloads store a truncated preview while payload_sha256 hashes the full canonical source event.';

CREATE OR REPLACE FUNCTION prevent_raw_event_provenance_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'raw_event_provenance rows are immutable once recorded (id=%)', OLD.id
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER raw_event_provenance_immutable
  BEFORE UPDATE ON raw_event_provenance
  FOR EACH ROW
  EXECUTE FUNCTION prevent_raw_event_provenance_mutation();

CREATE TABLE raw_event_provenance_conflict (
  id                      bigserial PRIMARY KEY,
  provenance_id           bigint NOT NULL REFERENCES raw_event_provenance (id) ON DELETE CASCADE,
  chain_key               text NOT NULL,
  contract                text NOT NULL,
  event_key               text NOT NULL,
  expected_payload_sha256 text NOT NULL CHECK (expected_payload_sha256 ~ '^[0-9a-f]{64}$'),
  observed_payload_sha256 text NOT NULL CHECK (observed_payload_sha256 ~ '^[0-9a-f]{64}$'),
  observed_envelope       jsonb NOT NULL,
  detected_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT raw_event_provenance_conflict_distinct CHECK (
    expected_payload_sha256 <> observed_payload_sha256
  ),
  CONSTRAINT raw_event_provenance_conflict_envelope_bounds CHECK (
    octet_length(observed_envelope::text) <= 65536
  ),
  CONSTRAINT raw_event_provenance_conflict_unique UNIQUE (
    provenance_id,
    observed_payload_sha256
  )
);

CREATE INDEX raw_event_provenance_conflict_by_chain
  ON raw_event_provenance_conflict (chain_key, detected_at DESC);

CREATE TRIGGER raw_event_provenance_conflict_immutable
  BEFORE UPDATE ON raw_event_provenance_conflict
  FOR EACH ROW
  EXECUTE FUNCTION prevent_raw_event_provenance_mutation();

COMMENT ON TABLE raw_event_provenance_conflict IS
  'Immutable audit record written when a replayed or provider-supplied event presents a different payload digest for an existing source event identity.';

ALTER TABLE outbound_transfer
  ADD COLUMN provenance_id bigint REFERENCES raw_event_provenance (id) ON DELETE RESTRICT;

ALTER TABLE inbound_delivery
  ADD COLUMN provenance_id bigint REFERENCES raw_event_provenance (id) ON DELETE RESTRICT;

ALTER TABLE pending_claim
  ADD COLUMN provenance_id bigint REFERENCES raw_event_provenance (id) ON DELETE RESTRICT;

ALTER TABLE admin_action
  ADD COLUMN provenance_id bigint REFERENCES raw_event_provenance (id) ON DELETE RESTRICT;

-- Down Migration

ALTER TABLE admin_action DROP COLUMN IF EXISTS provenance_id;
ALTER TABLE pending_claim DROP COLUMN IF EXISTS provenance_id;
ALTER TABLE inbound_delivery DROP COLUMN IF EXISTS provenance_id;
ALTER TABLE outbound_transfer DROP COLUMN IF EXISTS provenance_id;

DROP TRIGGER IF EXISTS raw_event_provenance_conflict_immutable ON raw_event_provenance_conflict;
DROP TABLE IF EXISTS raw_event_provenance_conflict;
DROP TRIGGER IF EXISTS raw_event_provenance_immutable ON raw_event_provenance;
DROP FUNCTION IF EXISTS prevent_raw_event_provenance_mutation();
DROP TABLE IF EXISTS raw_event_provenance;
