-- Up Migration

-- One durable row per source record the indexer could not apply. It is written in the same
-- transaction that advances the committed event boundary, so the cursor can never pass a failed
-- record without leaving this evidence behind. Quarantine tables keep bulky raw diagnostics and
-- may be pruned; this table only ever loses rows that a successful replay has reconciled.
CREATE TABLE ingestion_rejection (
  id                   bigserial PRIMARY KEY,
  chain_key            text NOT NULL CHECK (length(chain_key) BETWEEN 1 AND 64),
  family               text NOT NULL CHECK (family IN ('stellar', 'evm')),
  contract             text NOT NULL CHECK (length(contract) BETWEEN 1 AND 128),
  deployment_revision  integer NOT NULL DEFAULT 1 CHECK (deployment_revision >= 1),
  block_number         numeric(20, 0) NOT NULL CHECK (block_number >= 0),
  tx_hash              text NOT NULL CHECK (length(tx_hash) BETWEEN 1 AND 128),
  -- Stellar event id, or the EVM log index, at full width.
  source_position      text NOT NULL CHECK (source_position ~ '^[0-9A-Za-z_-]{1,64}$'),
  error_class          text NOT NULL CHECK (
    error_class IN ('decode_error', 'unknown_event', 'unsupported_payload', 'ordering_conflict')
  ),
  replay_eligible      boolean NOT NULL,
  detail               text CHECK (
    detail IS NULL OR (
      length(detail) <= 256
      AND detail !~* '(postgres(ql)?|https?|rediss?)://'
      AND detail !~* '(password|secret|api[_-]?key|authorization|bearer|token)\s*[:=]'
    )
  ),
  payload              jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 4096
  ),
  attempts             integer NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 1000000),
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  reconciled_at        timestamptz,
  CONSTRAINT ingestion_rejection_source
    UNIQUE (chain_key, contract, deployment_revision, block_number, tx_hash, source_position),
  CONSTRAINT ingestion_rejection_order CHECK (
    last_seen_at >= first_seen_at AND (reconciled_at IS NULL OR reconciled_at >= first_seen_at)
  )
);

CREATE INDEX ingestion_rejection_open
  ON ingestion_rejection (chain_key, block_number, id)
  WHERE reconciled_at IS NULL;

CREATE INDEX ingestion_rejection_reconciled
  ON ingestion_rejection (reconciled_at)
  WHERE reconciled_at IS NOT NULL;

COMMENT ON TABLE ingestion_rejection IS
  'Source records the indexer could not apply, written with the cursor advance that passed them. Reconciled only by a successful replay of the same source position.';
COMMENT ON COLUMN ingestion_rejection.detail IS
  'Bounded, credential-free diagnostic category. Never a raw provider response or connection string.';

-- Down Migration

DROP TABLE ingestion_rejection;
