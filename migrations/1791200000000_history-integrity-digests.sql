-- Up Migration

-- Durable range integrity digests over indexed chain event and monetary records so backfills
-- and database restores can be verified independently of surrogate keys or HTTP presentation.

CREATE TABLE history_integrity_digest (
  chain_key         text NOT NULL CHECK (btrim(chain_key) <> ''),
  record_kind       text NOT NULL CHECK (
    record_kind IN (
      'outbound_transfer',
      'inbound_delivery',
      'pending_claim',
      'admin_action',
      'chain_range'
    )
  ),
  range_start       numeric(20, 0) NOT NULL CHECK (range_start >= 0),
  range_end         numeric(20, 0) NOT NULL CHECK (range_end >= range_start),
  row_count         numeric(20, 0) NOT NULL CHECK (row_count >= 0),
  digest_algorithm  text NOT NULL DEFAULT 'sha256' CHECK (digest_algorithm = 'sha256'),
  digest_hex        text NOT NULL CHECK (digest_hex ~ '^0x[0-9a-f]{64}$'),
  computed_at       timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (chain_key, record_kind, range_start, range_end)
);

COMMENT ON TABLE history_integrity_digest IS
  'Deterministic SHA-256 range digests over canonical event and monetary facts for backfill and restore verification.';

-- Down Migration

DROP TABLE IF EXISTS history_integrity_digest;
