-- Up Migration

CREATE TABLE cctp_delivery_evidence (
  id                 bigserial PRIMARY KEY,
  transfer_id        bigint NOT NULL REFERENCES outbound_transfer (id) ON DELETE CASCADE,
  destination_chain  text NOT NULL,
  status             text NOT NULL CHECK (status IN ('canonical', 'orphaned', 'superseded')),
  tx_hash            text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  block_number       numeric(20, 0) NOT NULL,
  block_hash         text NOT NULL CHECK (block_hash ~ '^0x[0-9a-fA-F]{64}$'),
  mint_log_index     integer NOT NULL CHECK (mint_log_index >= 0),
  message_nonce      text NOT NULL CHECK (message_nonce ~ '^0x[0-9a-fA-F]{64}$'),
  message_digest     text NOT NULL CHECK (message_digest ~ '^0x[0-9a-fA-F]{64}$'),
  message_bytes      text NOT NULL CHECK (length(message_bytes) <= 16386),
  token              text NOT NULL,
  recipient          text NOT NULL,
  amount             numeric(78, 0) NOT NULL CHECK (amount > 0),
  source_binding     jsonb NOT NULL,
  verified_at        timestamptz NOT NULL DEFAULT now(),
  last_revalidated_at timestamptz
);

CREATE UNIQUE INDEX cctp_delivery_evidence_identity
  ON cctp_delivery_evidence (transfer_id, tx_hash, mint_log_index);
CREATE UNIQUE INDEX cctp_delivery_evidence_canonical
  ON cctp_delivery_evidence (transfer_id)
  WHERE status = 'canonical';
CREATE INDEX cctp_delivery_evidence_revalidation
  ON cctp_delivery_evidence (destination_chain, block_number)
  WHERE status = 'canonical';

ALTER TABLE inbound_delivery
  ADD COLUMN cctp_evidence_id bigint
    REFERENCES cctp_delivery_evidence (id) ON DELETE SET NULL;

COMMENT ON TABLE cctp_delivery_evidence IS
  'Canonical CCTP MessageReceived and native-USDC mint provenance, retained to revalidate destination proofs after reorgs.';
COMMENT ON COLUMN cctp_delivery_evidence.message_bytes IS
  'Exact bounded public CCTP message bytes used to recheck the full message identity and mint payment; contains no provider credentials.';

-- Down Migration
ALTER TABLE inbound_delivery DROP COLUMN cctp_evidence_id;
DROP TABLE cctp_delivery_evidence;
