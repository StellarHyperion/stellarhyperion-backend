-- Up Migration

-- Audited lifecycle transition log for off-chain rail polling and destination proof verification.
--
-- `rail_attestation` holds the latest state per transfer; `rail_lifecycle_transition` records each
-- committed state or public-evidence change so operators can see when and why a transfer moved
-- without unbounded duplicate rows on repeated identical polls.
CREATE TABLE rail_lifecycle_transition (
  id                 bigserial PRIMARY KEY,
  transfer_id        bigint NOT NULL REFERENCES outbound_transfer (id) ON DELETE CASCADE,
  route              smallint NOT NULL CHECK (route BETWEEN 0 AND 3),
  previous_status    text CHECK (
    previous_status IS NULL
    OR previous_status IN ('pending', 'attested', 'delivered', 'failed', 'expired')
  ),
  next_status        text NOT NULL CHECK (
    next_status IN ('pending', 'attested', 'delivered', 'failed', 'expired')
  ),
  reason             text NOT NULL,
  rail_status        text,
  rail_reference     text,
  destination_tx     text,
  command_id         text,
  rail_message_id    text,
  reconciled         boolean NOT NULL DEFAULT false,
  recorded_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rail_lifecycle_transition_by_transfer
  ON rail_lifecycle_transition (transfer_id, id ASC);

COMMENT ON TABLE rail_lifecycle_transition IS
  'Committed rail status and public-evidence transitions joined to outbound_transfer.';

-- Down Migration

DROP TABLE IF EXISTS rail_lifecycle_transition;
