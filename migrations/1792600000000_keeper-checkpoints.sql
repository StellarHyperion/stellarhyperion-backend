-- Up Migration
CREATE TABLE keeper_checkpoint (
  hash text PRIMARY KEY CHECK (hash ~ '^[0-9a-f]{64}$'),
  operation text NOT NULL CHECK (operation IN ('keep_alive','settle_claim')),
  chain_key text NOT NULL,
  contract text NOT NULL,
  signer text NOT NULL,
  intent_key text NOT NULL CHECK (intent_key ~ '^[0-9a-f]{64}$'),
  phase text NOT NULL CHECK (phase IN ('restore','invoke')),
  state text NOT NULL CHECK (state IN ('submitted','confirmed','failed')),
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  CHECK ((state = 'confirmed') = (confirmed_at IS NOT NULL))
);
CREATE UNIQUE INDEX keeper_checkpoint_unresolved_signer ON keeper_checkpoint (chain_key,signer) WHERE state='submitted';
CREATE INDEX keeper_checkpoint_intent ON keeper_checkpoint (chain_key,signer,intent_key,phase,created_at DESC);
COMMENT ON TABLE keeper_checkpoint IS 'Committed public hashes and source maintenance intent before broadcast; unknown outcomes block new signer envelopes until reconciled. No signed envelopes, private keys or credentials are stored.';
-- Down Migration
DROP TABLE keeper_checkpoint;
