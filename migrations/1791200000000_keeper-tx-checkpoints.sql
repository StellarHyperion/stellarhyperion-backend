-- Up Migration

-- Durable pre-broadcast checkpoints for signed Stellar keeper transactions.
--
-- Persists only the public transaction hash, signer public key, intended contract operation,
-- sequence number, fee bound and confirmation state BEFORE any network submission occurs.
-- No secret key, signature bytes or signed XDR credential material is ever stored.
CREATE TABLE keeper_tx_checkpoint (
  operation_key text PRIMARY KEY,
  tx_hash text NOT NULL,
  chain text NOT NULL,
  job_kind text NOT NULL CHECK (job_kind IN ('ttl-bump', 'claim-settlement')),
  claim_id numeric(20,0),
  contract text NOT NULL,
  method text NOT NULL,
  signer_public_key text NOT NULL,
  sequence_number numeric(20,0) NOT NULL,
  fee_stroops numeric(78,0) NOT NULL,
  state text NOT NULL CHECK (
    state IN ('signed_pending_broadcast', 'broadcast_unknown', 'confirmed', 'failed')
  ),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT keeper_tx_checkpoint_claim_shape_chk CHECK (
    (job_kind = 'claim-settlement' AND claim_id IS NOT NULL)
    OR (job_kind = 'ttl-bump' AND claim_id IS NULL)
  )
);

CREATE INDEX keeper_tx_checkpoint_unresolved_idx
  ON keeper_tx_checkpoint (chain, state)
  WHERE state IN ('signed_pending_broadcast', 'broadcast_unknown');

COMMENT ON TABLE keeper_tx_checkpoint IS
  'Durable pre-broadcast checkpoint storing public transaction hash, intended keeper operation and confirmation state so unknown broadcast outcomes are reconciled by hash before any retry.';

-- Down Migration

DROP TABLE IF EXISTS keeper_tx_checkpoint;
