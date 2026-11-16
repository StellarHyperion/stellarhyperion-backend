-- Up Migration

-- Distributed ownership and monotonic fencing leases for a shared Stellar keeper signer.
--
-- Coordinates sequence reservation across keeper replicas so only one active lease holder
-- can build, sign and broadcast the next operation for a given signer public key, while
-- allowing bounded takeover after lease expiration when a holder crashes.
CREATE TABLE keeper_signer_lease (
  signer_public_key text PRIMARY KEY,
  chain text NOT NULL,
  holder_id text NOT NULL,
  fence_token numeric(20,0) NOT NULL CHECK (fence_token >= 1),
  last_reserved_sequence numeric(20,0),
  last_confirmed_sequence numeric(20,0),
  in_flight_tx_hash text,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT keeper_signer_lease_sequence_order_chk CHECK (
    last_confirmed_sequence IS NULL
    OR last_reserved_sequence IS NULL
    OR last_confirmed_sequence <= last_reserved_sequence
  )
);

CREATE INDEX keeper_signer_lease_chain_expires_idx
  ON keeper_signer_lease (chain, expires_at);

COMMENT ON TABLE keeper_signer_lease IS
  'Distributed lease and monotonic fence token coordinating shared Stellar keeper signer ownership and sequence numbers across replicas.';

-- Down Migration

DROP TABLE IF EXISTS keeper_signer_lease;
