-- Up Migration

CREATE TABLE cctp_provider_message (
  id BIGSERIAL PRIMARY KEY,
  origin_tx TEXT NOT NULL,
  source_domain INTEGER NOT NULL,
  destination_domain INTEGER NOT NULL,
  full_nonce TEXT NOT NULL CHECK (full_nonce ~ '^0x[0-9a-f]{64}$'),
  message_digest TEXT NOT NULL CHECK (message_digest ~ '^0x[0-9a-f]{64}$'),
  body_digest TEXT NOT NULL CHECK (body_digest ~ '^0x[0-9a-f]{64}$'),
  displayed_nonce NUMERIC(20, 0) NOT NULL CHECK (displayed_nonce >= 0),
  provider_event_nonce TEXT,
  forward_tx_hash TEXT,
  status TEXT NOT NULL,
  transfer_id BIGINT REFERENCES outbound_transfer (id) ON DELETE SET NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_domain, destination_domain, full_nonce, message_digest)
);

CREATE INDEX cctp_provider_message_origin_tx_idx
  ON cctp_provider_message (origin_tx);

CREATE INDEX cctp_provider_message_displayed_nonce_idx
  ON cctp_provider_message (displayed_nonce);

-- Down Migration

DROP INDEX IF EXISTS cctp_provider_message_displayed_nonce_idx;
DROP INDEX IF EXISTS cctp_provider_message_origin_tx_idx;
DROP TABLE IF EXISTS cctp_provider_message;
