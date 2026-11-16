-- Up Migration

-- Provenance for verified Axelar Interchain Token Service (ITS) payouts.
--
-- Axelar GMP status is candidate discovery only. Destination payout is established when canonical
-- receipt logs confirm InterchainTransferReceived, the token-manager mapping at the proof block
-- agrees on the ERC-20 token address, and the recipient receives the exact net integer amount.
-- Storing command identity and block-scoped token-manager observations alongside inbound_delivery
-- makes every payout decision inspectable without relaxing verification, while historical arrivals
-- recorded before this table existed remain distinguishable by the absence of a provenance row.

CREATE TABLE axelar_its_provenance (
  destination_chain        text NOT NULL,
  route                    smallint NOT NULL CHECK (route = 1),
  source_chain             text NOT NULL,
  source_nonce             numeric(20, 0) NOT NULL,
  command_id               text NOT NULL CHECK (command_id ~ '^0x[0-9a-fA-F]{64}$'),
  gmp_message_id           text,
  parent_message_id        text,
  axelar_source_chain      text NOT NULL,
  source_address_hex       text NOT NULL CHECK (source_address_hex ~ '^0x([0-9a-fA-F]{2})+$'),
  data_hash                text NOT NULL CHECK (data_hash ~ '^0x[0-9a-fA-F]{64}$'),
  execution_tx             text NOT NULL CHECK (execution_tx ~ '^0x[0-9a-fA-F]{64}$'),
  its_log_index            integer,
  proof_block              numeric(20, 0) NOT NULL,
  proof_block_hash         text NOT NULL CHECK (proof_block_hash ~ '^0x[0-9a-fA-F]{64}$'),
  interchain_token_service text NOT NULL,
  token_id                 text NOT NULL CHECK (token_id ~ '^0x[0-9a-fA-F]{64}$'),
  token_manager            text NOT NULL,
  token_manager_type       integer,
  registered_token         text NOT NULL,
  payment_from             text NOT NULL,
  payment_log_index        integer,
  verified_at              timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (destination_chain, route, source_chain, source_nonce),
  CONSTRAINT axelar_its_provenance_delivery_fk
    FOREIGN KEY (destination_chain, route, source_chain, source_nonce)
    REFERENCES inbound_delivery (destination_chain, route, source_chain, source_nonce)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX axelar_its_provenance_by_command
  ON axelar_its_provenance (destination_chain, command_id);

CREATE INDEX axelar_its_provenance_by_block
  ON axelar_its_provenance (destination_chain, proof_block DESC);

COMMENT ON TABLE axelar_its_provenance IS
  'Command identity and block-scoped token-manager observations recorded alongside verified Axelar ITS payouts.';

-- Down Migration

DROP TABLE IF EXISTS axelar_its_provenance;
