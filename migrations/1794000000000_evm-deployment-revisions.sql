-- Up Migration

-- One immutable activation row per watched EVM router. The retirement boundary is filled when a
-- later router becomes active, so old router rows remain queryable and their end is explicit.
CREATE TABLE evm_deployment_revision (
  chain_key            text NOT NULL,
  chain_id             integer NOT NULL CHECK (chain_id > 0),
  deployment_revision  integer NOT NULL CHECK (deployment_revision >= 1),
  contract             text NOT NULL,
  start_block          numeric(20, 0) NOT NULL CHECK (start_block >= 0),
  previous_revision    integer,
  previous_contract    text,
  previous_cursor      numeric(20, 0),
  previous_cursor_hash text,
  retired_block        numeric(20, 0),
  retired_block_hash   text,
  activated_at         timestamptz NOT NULL DEFAULT now(),
  retired_at           timestamptz,
  PRIMARY KEY (chain_key, deployment_revision),
  CHECK (retired_at IS NULL OR retired_block IS NOT NULL)
);

CREATE INDEX evm_deployment_revision_history
  ON evm_deployment_revision (chain_key, start_block, deployment_revision);

COMMENT ON TABLE evm_deployment_revision IS
  'Activation and retirement boundaries for each EVM router deployment; historical routers remain addressable.';

-- Down Migration
DROP TABLE evm_deployment_revision;
