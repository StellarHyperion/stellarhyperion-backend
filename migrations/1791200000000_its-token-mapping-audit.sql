-- Up Migration

-- Archived per-proof ITS token mapping assumptions and operator drift diagnostics.
--
-- Preserves the exact token id, destination token manager, ERC-20 token contract, and decimals
-- observed at each destination block when evaluating a proof so historical payout assumptions
-- remain immutable and auditable even if a lane mapping later changes.

CREATE TABLE its_token_mapping_audit (
  id                         bigserial PRIMARY KEY,
  transfer_id                bigint NOT NULL REFERENCES outbound_transfer (id) ON DELETE CASCADE,
  origin_chain               text NOT NULL,
  source_token               text NOT NULL,
  destination_chain          text NOT NULL,
  destination_block          numeric(20, 0) NOT NULL,
  destination_tx             text NOT NULL,
  expected_token_id          text NOT NULL,
  observed_token_id          text NOT NULL,
  expected_token_manager     text,
  observed_token_manager     text NOT NULL,
  expected_destination_token text,
  observed_destination_token text NOT NULL,
  manager_reported_token     text NOT NULL,
  expected_decimals          integer,
  observed_decimals          integer NOT NULL CHECK (observed_decimals BETWEEN 0 AND 255),
  observed_symbol            text,
  registry_symbol            text,
  status                     text NOT NULL CHECK (status IN ('verified', 'drift_detected')),
  drift_reasons              jsonb NOT NULL DEFAULT '[]'::jsonb,
  diagnostic_detail          text,
  observed_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT its_token_mapping_audit_unique_observation UNIQUE (
    transfer_id,
    destination_chain,
    destination_tx,
    destination_block,
    status
  )
);

CREATE INDEX its_token_mapping_audit_lane_baseline
  ON its_token_mapping_audit (origin_chain, source_token, destination_chain, id ASC)
  WHERE status = 'verified';

CREATE INDEX its_token_mapping_audit_by_transfer
  ON its_token_mapping_audit (transfer_id, id ASC);

COMMENT ON TABLE its_token_mapping_audit IS
  'Immutable audit log of ITS token mapping assumptions and drift diagnostics captured per destination proof.';
COMMENT ON COLUMN its_token_mapping_audit.status IS
  'verified when destination manager and token state match expected lane assumptions; drift_detected when token identity or precision changed.';

-- Down Migration

DROP TABLE IF EXISTS its_token_mapping_audit;
