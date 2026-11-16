-- Up Migration

-- Operator-reviewed requeue history for transfers that previously reached a non-delivered terminal
-- rail status (`failed` or `expired`) and were reopened when new public evidence became available.

CREATE TABLE rail_requeue_audit (
  id                   bigserial PRIMARY KEY,
  transfer_id          bigint NOT NULL REFERENCES outbound_transfer (id) ON DELETE CASCADE,
  route                smallint NOT NULL CHECK (route BETWEEN 0 AND 3),
  origin_chain         text NOT NULL,
  nonce                numeric(20, 0) NOT NULL,
  prior_status         text NOT NULL CHECK (prior_status IN ('failed', 'expired')),
  new_status           text NOT NULL CHECK (new_status = 'pending'),
  prior_rail_status    text,
  prior_rail_reference text,
  prior_check_failures integer NOT NULL CHECK (prior_check_failures >= 0),
  reviewed_by          text NOT NULL CHECK (btrim(reviewed_by) <> ''),
  reviewed_reason      text NOT NULL CHECK (btrim(reviewed_reason) <> ''),
  evidence_reference   text,
  requeued_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rail_requeue_audit_by_transfer
  ON rail_requeue_audit (transfer_id, requeued_at DESC, id DESC);

COMMENT ON TABLE rail_requeue_audit IS
  'Append-only operator review log for terminal failed or expired rail transfers reopened to pending.';
COMMENT ON COLUMN rail_requeue_audit.prior_status IS
  'Terminal status before operator requeue; delivered transfers are never eligible.';

-- Down Migration

DROP TABLE IF EXISTS rail_requeue_audit;
