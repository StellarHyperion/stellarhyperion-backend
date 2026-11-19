-- Up Migration

-- --------------------------------------------------------------------------------------------
-- Stable range digests for indexed event and monetary records (#63)
-- --------------------------------------------------------------------------------------------

CREATE TABLE indexed_history_digest (
  id                bigserial PRIMARY KEY,
  chain_key         text NOT NULL,
  record_kind       text NOT NULL CHECK (
    record_kind IN ('outbound_transfer', 'inbound_delivery', 'pending_claim', 'all')
  ),
  start_block       numeric(20, 0) NOT NULL,
  end_block         numeric(20, 0) NOT NULL,
  row_count         integer NOT NULL CHECK (row_count >= 0),
  digest            text NOT NULL,
  monetary_summary  jsonb NOT NULL DEFAULT '{}'::jsonb,
  computed_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT indexed_history_digest_range_chk CHECK (start_block <= end_block),
  UNIQUE (chain_key, record_kind, start_block, end_block)
);

CREATE INDEX idx_indexed_history_digest_lookup
  ON indexed_history_digest (chain_key, record_kind, start_block DESC, end_block DESC);

COMMENT ON TABLE indexed_history_digest IS
  'Deterministic SHA-256 range digests and integer-string monetary summaries for verifying backfills and restores.';

-- Down Migration

DROP TABLE IF EXISTS indexed_history_digest;
