-- Up Migration

-- Canonical block tracking and reorg revalidation state for Axelar ITS payouts.
--
-- Destination payout is established by confirmed EVM receipt logs on a specific canonical block
-- hash. If a deeper destination chain reorganization orphans that block, the stored proof must be
-- revalidated against the canonical chain and either reconciled to a replacement proof matching
-- the original outbound transfer intent or invalidated so an orphaned payment never remains
-- permanently confirmed.

CREATE TABLE its_payment_proof (
  transfer_id          bigint PRIMARY KEY REFERENCES outbound_transfer (id) ON DELETE CASCADE,
  destination_chain    text NOT NULL,
  route                smallint NOT NULL CHECK (route = 1),
  source_chain         text NOT NULL,
  source_nonce         numeric(20, 0) NOT NULL,
  command_id           text NOT NULL CHECK (command_id ~ '^0x[0-9a-fA-F]{64}$'),
  token_id             text NOT NULL CHECK (token_id ~ '^0x[0-9a-fA-F]{64}$'),
  token                text NOT NULL,
  recipient            text NOT NULL,
  amount               numeric(78, 0) NOT NULL CHECK (amount > 0),
  proof_block          numeric(20, 0) NOT NULL,
  proof_block_hash     text NOT NULL CHECK (proof_block_hash ~ '^0x[0-9a-fA-F]{64}$'),
  proof_tx             text NOT NULL CHECK (proof_tx ~ '^0x[0-9a-fA-F]{64}$'),
  proof_log_index      integer,
  proof_state          text NOT NULL CHECK (proof_state IN ('canonical', 'orphaned')),
  orphaned_block_hash  text CHECK (
    orphaned_block_hash IS NULL OR orphaned_block_hash ~ '^0x[0-9a-fA-F]{64}$'
  ),
  orphaned_tx          text CHECK (orphaned_tx IS NULL OR orphaned_tx ~ '^0x[0-9a-fA-F]{64}$'),
  revalidation_count   integer NOT NULL DEFAULT 0 CHECK (revalidation_count >= 0),
  reconciled_count     integer NOT NULL DEFAULT 0 CHECK (reconciled_count >= 0),
  verified_at          timestamptz NOT NULL DEFAULT now(),
  revalidated_at       timestamptz,

  CONSTRAINT its_payment_proof_hop UNIQUE (destination_chain, route, source_chain, source_nonce),
  CONSTRAINT its_payment_proof_orphan_audit CHECK (
    proof_state = 'canonical'
    OR (orphaned_block_hash IS NOT NULL AND orphaned_tx IS NOT NULL)
  )
);

CREATE INDEX its_payment_proof_revalidation_queue
  ON its_payment_proof (destination_chain, revalidated_at NULLS FIRST, transfer_id)
  WHERE proof_state = 'canonical';

COMMENT ON TABLE its_payment_proof IS
  'Tracks canonical block hashes for verified Axelar ITS payouts so destination reorgs invalidate or reconcile orphaned proofs.';

-- Down Migration

DROP TABLE IF EXISTS its_payment_proof;
