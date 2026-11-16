-- Up Migration

-- Durable recovery records for Soroban RestoreFootprintOp transactions submitted before
-- keeper TTL bumps or claim settlements.
--
-- An archived Soroban entry requires an explicit restore transaction before the contract
-- invocation that touches it can succeed. Saving the public restore transaction hash before
-- network broadcast ensures an uncertain submission is reconciled via getTransaction before
-- retrying, preventing duplicate fee spend or mistaken absent-claim classification while
-- preserving the recorded recipient and integer-string amount in pending_claim.

CREATE TABLE keeper_restore_checkpoint (
  scope_key          text PRIMARY KEY,
  chain              text NOT NULL,
  job_kind           text NOT NULL CHECK (job_kind IN ('ttl-bump', 'claim-settlement')),
  claim_id           numeric(20, 0),
  restore_tx_hash    text NOT NULL,
  footprint_keys     jsonb NOT NULL,
  min_resource_fee   numeric(78, 0) NOT NULL CHECK (min_resource_fee >= 0),
  status             text NOT NULL CHECK (
    status IN ('pending_broadcast', 'uncertain', 'confirmed', 'failed')
  ),
  recipient_snapshot text,
  amount_snapshot    numeric(78, 0) CHECK (amount_snapshot IS NULL OR amount_snapshot > 0),
  last_error         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT keeper_restore_checkpoint_claim_scope CHECK (
    (job_kind = 'ttl-bump' AND claim_id IS NULL)
    OR (job_kind = 'claim-settlement' AND claim_id IS NOT NULL)
  )
);

CREATE INDEX keeper_restore_checkpoint_unresolved
  ON keeper_restore_checkpoint (chain, status, updated_at)
  WHERE status IN ('pending_broadcast', 'uncertain');

COMMENT ON TABLE keeper_restore_checkpoint IS
  'Public transaction hashes and footprint metadata for keeper Soroban RestoreFootprintOp submissions.';

-- Down Migration

DROP TABLE IF EXISTS keeper_restore_checkpoint;
