-- Up Migration

CREATE TABLE axelar_status_quarantine (
  id                 bigserial PRIMARY KEY,
  transfer_id        bigint NOT NULL REFERENCES outbound_transfer (id) ON DELETE CASCADE,
  source_tx_hash     text NOT NULL,
  provider_reference text,
  provider_reference_key text NOT NULL DEFAULT '',
  schema             text NOT NULL,
  payload            jsonb NOT NULL,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  replay_count       integer NOT NULL DEFAULT 0 CHECK (replay_count >= 0)
);

CREATE UNIQUE INDEX axelar_status_quarantine_identity
  ON axelar_status_quarantine
     (transfer_id, source_tx_hash, provider_reference_key);

CREATE INDEX axelar_status_quarantine_recent
  ON axelar_status_quarantine (transfer_id, last_seen_at DESC);

CREATE TABLE axelar_delivery_evidence (
  id                        bigserial PRIMARY KEY,
  transfer_id               bigint NOT NULL REFERENCES outbound_transfer (id) ON DELETE CASCADE,
  destination_chain         text NOT NULL,
  status                    text NOT NULL CHECK (status IN ('canonical', 'orphaned', 'superseded')),
  command_id                text NOT NULL CHECK (command_id ~ '^0x[0-9a-fA-F]{64}$'),
  execution_tx_hash         text NOT NULL CHECK (execution_tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  receipt_status            text NOT NULL CHECK (receipt_status = 'success'),
  receipt_block             numeric(20, 0) NOT NULL,
  receipt_block_hash        text NOT NULL CHECK (receipt_block_hash ~ '^0x[0-9a-fA-F]{64}$'),
  its_address               text NOT NULL,
  token_id                  text NOT NULL CHECK (token_id ~ '^0x[0-9a-fA-F]{64}$'),
  registered_token          text NOT NULL,
  token_manager             text NOT NULL,
  token_manager_block       numeric(20, 0) NOT NULL,
  token_manager_block_hash  text NOT NULL CHECK (token_manager_block_hash ~ '^0x[0-9a-fA-F]{64}$'),
  payment_log_index         integer NOT NULL CHECK (payment_log_index >= 0),
  payment_recipient         text NOT NULL,
  payment_amount            numeric(78, 0) NOT NULL CHECK (payment_amount > 0),
  verified_at               timestamptz NOT NULL DEFAULT now(),
  last_revalidated_at       timestamptz
);

CREATE UNIQUE INDEX axelar_delivery_evidence_identity
  ON axelar_delivery_evidence
     (transfer_id, command_id, execution_tx_hash, payment_log_index);

CREATE UNIQUE INDEX axelar_delivery_evidence_canonical
  ON axelar_delivery_evidence (transfer_id)
  WHERE status = 'canonical';

CREATE INDEX axelar_delivery_evidence_revalidation
  ON axelar_delivery_evidence (destination_chain, receipt_block)
  WHERE status = 'canonical';

ALTER TABLE inbound_delivery
  ADD COLUMN axelar_evidence_id bigint
    REFERENCES axelar_delivery_evidence (id) ON DELETE SET NULL;

COMMENT ON TABLE axelar_status_quarantine IS
  'Bounded, credential-redacted Axelar response shapes that this build cannot parse yet. The transfer and provider reference make each record replayable.';
COMMENT ON TABLE axelar_delivery_evidence IS
  'Canonical ITS command, receipt, token-manager mapping and exact ERC-20 payment proof, tied to the originating transfer.';
COMMENT ON COLUMN axelar_delivery_evidence.token_manager_block IS
  'The destination-chain block at which the ITS token-manager mapping was observed.';
COMMENT ON COLUMN inbound_delivery.axelar_evidence_id IS
  'Identifies arrivals established by an Axelar ITS receipt rather than by a Hyperion EVM router event.';

-- Down Migration
ALTER TABLE inbound_delivery DROP COLUMN axelar_evidence_id;
DROP TABLE axelar_delivery_evidence;
DROP TABLE axelar_status_quarantine;
