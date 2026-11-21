-- Up Migration

CREATE TABLE axelar_gas_evidence (
  id                 bigserial PRIMARY KEY,
  transfer_id        bigint REFERENCES outbound_transfer (id) ON DELETE CASCADE,
  origin_chain       text NOT NULL,
  source_tx_hash     text NOT NULL,
  source_log_index   integer NOT NULL,
  source_event       text NOT NULL,
  event_signature    text NOT NULL CHECK (event_signature ~ '^0x[0-9a-fA-F]{64}$'),
  event_kind         text NOT NULL CHECK (event_kind IN ('payment', 'topup', 'refund', 'unsupported')),
  status             text NOT NULL CHECK (status IN ('linked', 'unresolved')),
  link_basis         text NOT NULL CHECK (link_basis IN ('origin_log', 'source_identity', 'unresolved')),
  gas_token          text,
  native             boolean NOT NULL,
  amount             numeric(78, 0) NOT NULL CHECK (amount >= 0),
  refund_address     text,
  reference_tx_hash  text NOT NULL,
  reference_log_index integer,
  candidate_count    integer NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  payload            jsonb NOT NULL,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  replay_count       integer NOT NULL DEFAULT 0 CHECK (replay_count >= 0)
);

CREATE UNIQUE INDEX axelar_gas_evidence_identity
  ON axelar_gas_evidence (origin_chain, source_tx_hash, source_log_index, source_event);

CREATE INDEX axelar_gas_evidence_transfer
  ON axelar_gas_evidence (transfer_id, last_seen_at DESC)
  WHERE transfer_id IS NOT NULL;

CREATE TABLE axelar_gas_scan (
  origin_chain     text NOT NULL,
  origin_tx        text NOT NULL,
  event_count      integer NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  unresolved_count integer NOT NULL DEFAULT 0 CHECK (unresolved_count >= 0),
  first_scanned_at timestamptz NOT NULL DEFAULT now(),
  last_scanned_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (origin_chain, origin_tx)
);

COMMENT ON TABLE axelar_gas_evidence IS
  'Public Axelar gas-service payments, top-ups and refunds linked to source transfers as evidence only; these rows never establish destination delivery.';
COMMENT ON TABLE axelar_gas_scan IS
  'Source transactions whose gas-service receipt history has been read, so replayable evidence ingestion does not refetch unchanged receipts.';
COMMENT ON COLUMN axelar_gas_evidence.amount IS
  'The exact on-chain integer amount, including native currency amounts, stored as an unbounded decimal string.';
COMMENT ON COLUMN axelar_gas_evidence.refund_address IS
  'The exact refund receiver or recipient address from the public event.';

-- Down Migration

DROP TABLE axelar_gas_scan;
DROP TABLE axelar_gas_evidence;
