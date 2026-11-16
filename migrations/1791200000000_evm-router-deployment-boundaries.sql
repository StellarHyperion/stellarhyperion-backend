-- Up Migration

CREATE TABLE router_deployment (
  chain_key text NOT NULL,
  contract text NOT NULL,
  family text NOT NULL,
  start_block numeric(20, 0) NOT NULL,
  retired_at_block numeric(20, 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_key, contract)
);

ALTER TABLE outbound_transfer
  ADD COLUMN router_address text NOT NULL DEFAULT '';

ALTER TABLE outbound_transfer
  DROP CONSTRAINT IF EXISTS outbound_transfer_identity;

ALTER TABLE outbound_transfer
  ADD CONSTRAINT outbound_transfer_identity UNIQUE (origin_chain, router_address, nonce);

COMMENT ON TABLE router_deployment IS
  'Deployment revisions with verified starting blocks and retirement metadata for routers.';

-- Down Migration

ALTER TABLE outbound_transfer
  DROP CONSTRAINT IF EXISTS outbound_transfer_identity;

ALTER TABLE outbound_transfer
  DROP COLUMN IF EXISTS router_address;

ALTER TABLE outbound_transfer
  ADD CONSTRAINT outbound_transfer_identity UNIQUE (origin_chain, nonce);

DROP TABLE IF EXISTS router_deployment;
