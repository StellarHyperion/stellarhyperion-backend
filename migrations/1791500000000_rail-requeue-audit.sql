-- Up Migration

-- Keep operator-reviewed requeues separate from mutable polling state. The source identity is
-- copied here so the audit remains meaningful if a source-chain reorg removes the transfer row.
CREATE TABLE rail_requeue_audit (
  id              bigserial PRIMARY KEY,
  transfer_id     bigint NOT NULL,
  route           smallint NOT NULL CHECK (route BETWEEN 0 AND 3),
  origin_chain    text NOT NULL,
  nonce           numeric(20, 0) NOT NULL,
  prior_status    text NOT NULL CHECK (prior_status IN ('failed', 'expired')),
  new_status      text NOT NULL CHECK (new_status = 'pending'),
  reviewed_by     text NOT NULL CHECK (btrim(reviewed_by) <> ''),
  reviewed_reason text NOT NULL CHECK (btrim(reviewed_reason) <> ''),
  requeued_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rail_requeue_audit_by_transfer
  ON rail_requeue_audit (transfer_id, requeued_at DESC, id DESC);

COMMENT ON TABLE rail_requeue_audit IS
  'Append-only operator review history for failed or expired rail transfers reopened for polling.';

-- Down Migration

DROP TABLE IF EXISTS rail_requeue_audit;
