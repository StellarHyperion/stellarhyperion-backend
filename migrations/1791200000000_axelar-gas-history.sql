-- Up Migration

-- Public Axelar gas-service payment, top-up, and refund history.
--
-- Stored strictly separately from `inbound_delivery` and `rail_attestation` so gas top-ups or
-- refunds can never advance payout lifecycle on their own. Amounts use `numeric(78, 0)` for exact
-- uint256/i128 native and token precision, and unresolvable or unsupported link shapes remain
-- queryable as `unresolved` evidence.

CREATE TABLE axelar_gas_event (
  id                   bigserial PRIMARY KEY,
  chain                text NOT NULL,
  gas_service          text NOT NULL,
  tx_hash              text NOT NULL,
  block_number         numeric(20, 0) NOT NULL,
  log_index            integer NOT NULL CHECK (log_index >= 0),
  event_kind           text NOT NULL CHECK (
    event_kind IN ('gas_paid', 'gas_added', 'refunded')
  ),
  is_native            boolean NOT NULL,
  gas_token            text,
  amount               numeric(78, 0) NOT NULL CHECK (amount >= 0),
  sender               text,
  refund_address       text,
  source_tx_ref        text,
  source_log_index_ref numeric(20, 0),
  message_id           text,
  payload_hash         text,
  transfer_id          bigint REFERENCES outbound_transfer (id) ON DELETE SET NULL,
  resolution_status    text NOT NULL CHECK (
    resolution_status IN ('linked', 'unresolved')
  ),
  unresolved_reason    text,
  observed_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT axelar_gas_event_identity UNIQUE (chain, tx_hash, log_index),
  CONSTRAINT axelar_gas_event_resolution CHECK (
    (resolution_status = 'linked' AND transfer_id IS NOT NULL AND unresolved_reason IS NULL)
    OR (resolution_status = 'unresolved' AND transfer_id IS NULL AND unresolved_reason IS NOT NULL)
  )
);

CREATE INDEX axelar_gas_event_by_transfer
  ON axelar_gas_event (transfer_id, block_number ASC, log_index ASC)
  WHERE transfer_id IS NOT NULL;

CREATE INDEX axelar_gas_event_unresolved
  ON axelar_gas_event (chain, id ASC)
  WHERE resolution_status = 'unresolved';

COMMENT ON TABLE axelar_gas_event IS
  'Public Axelar Gas Service payments, top-ups, and refunds. Informational evidence only; never establishes destination delivery.';
COMMENT ON COLUMN axelar_gas_event.refund_address IS
  'Exact refund recipient address or strkey as emitted on chain (checksummed EVM address, Stellar G/C strkey, or M muxed strkey).';

-- Down Migration

DROP TABLE IF EXISTS axelar_gas_event;
