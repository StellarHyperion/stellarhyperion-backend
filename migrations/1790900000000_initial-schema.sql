-- Up Migration

-- The schema an indexer needs rather than the one a transfer looks like.
--
-- Three rules shape all of it.
--
-- Amounts are NUMERIC(78,0). A uint256 does not fit in anything narrower and a float in a column
-- holding somebody's money is a rounding error waiting for a large transfer.
--
-- Anything that is a u64 on chain is NUMERIC(20,0), not bigint. Postgres int8 stops at 2^63-1 and
-- u64 goes to 2^64-1, so a nonce near the top of the range would fail to insert. That only bites
-- at values a fixture will never produce and a long lived router eventually will.
--
-- Addresses and identifiers are text. A Stellar contract id is 56 characters, an EVM address is
-- 42, and a 32 byte rail message id is 66. Storing all three as text in a shared column means one
-- query shape across both families instead of two tables that differ only in a width.

-- --------------------------------------------------------------------------------------------
-- Where each watcher has read up to
-- --------------------------------------------------------------------------------------------

CREATE TABLE indexer_cursor (
  chain_key        text PRIMARY KEY,
  family           text NOT NULL CHECK (family IN ('stellar', 'evm')),
  -- The router this cursor describes. Checked on every pass, because a redeployed router at a new
  -- address shares nothing with the old one and a cursor carried over would skip its entire
  -- history silently.
  contract         text NOT NULL,
  -- Ledger sequence on Stellar, block number on an EVM chain. Both monotonic, both u64 shaped.
  last_processed   numeric(20, 0) NOT NULL,
  -- The chain's own timestamp for that position, not ours. Lag is the difference between this and
  -- now, and measuring it against our clock would hide a watcher that has stopped advancing.
  last_processed_at timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE indexer_cursor IS
  'One row per watched chain. The only mutable state an indexer restart depends on.';
COMMENT ON COLUMN indexer_cursor.contract IS
  'Router address this cursor belongs to. A mismatch means a redeployment and the cursor has to be reset rather than reused.';
COMMENT ON COLUMN indexer_cursor.last_processed_at IS
  'The chain timestamp at the cursor, used to compute lag. Null until the first pass lands.';

-- --------------------------------------------------------------------------------------------
-- Departures
-- --------------------------------------------------------------------------------------------

CREATE TABLE outbound_transfer (
  id                 bigserial PRIMARY KEY,
  origin_chain       text NOT NULL,
  -- RouteKind as the integer both chains encode. 0 cctp, 1 axelar its, 2 axelar gmp, 3 allbridge.
  route              smallint NOT NULL CHECK (route BETWEEN 0 AND 3),
  -- The router's own counter, monotonic per router and therefore unique per origin chain. Not
  -- unique per route: one counter serves all four rails.
  nonce              numeric(20, 0) NOT NULL,
  sender             text NOT NULL,
  token              text NOT NULL,
  -- What the sender handed over, what the protocol kept, and what went onto the rail. All three
  -- are stored rather than derived, because the fee rate can change between transfers and a
  -- historical row recomputed against today's rate would be wrong.
  gross_amount       numeric(78, 0) NOT NULL,
  fee                numeric(78, 0) NOT NULL,
  net_amount         numeric(78, 0) NOT NULL,
  destination_chain  text NOT NULL,
  -- The recipient as the origin chain put it on the wire. A strkey when leaving an EVM chain, a
  -- 32 byte hex word when leaving Stellar. Normalising the two here would mean re-deriving one
  -- form from the other, and a bridge should record what was actually signed.
  destination        text NOT NULL,
  -- Whatever the rail calls this transfer, when it names it at all. Several do not.
  rail_ref           text,
  origin_block       numeric(20, 0) NOT NULL,
  origin_tx          text NOT NULL,
  -- EVM only. Null on Stellar, where a contract event has no log index within its transaction.
  origin_log_index   integer,
  observed_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT outbound_transfer_identity UNIQUE (origin_chain, nonce),
  CONSTRAINT outbound_transfer_amounts CHECK (gross_amount = fee + net_amount)
);

COMMENT ON TABLE outbound_transfer IS
  'One row per departure, from either family. The chain is the source of truth; this is the copy that outlives a seven day RPC history window.';
COMMENT ON CONSTRAINT outbound_transfer_amounts ON outbound_transfer IS
  'The router guarantees gross equals fee plus net. Asserting it here turns a decoder that reads a field off the wrong offset into a failed insert rather than a plausible row.';

-- Answers "where is my transfer" for a person who has a sending address and nothing else, which
-- is the most common way this question arrives.
CREATE INDEX outbound_transfer_by_sender
  ON outbound_transfer (origin_chain, sender, observed_at DESC);

-- The reorg purge, and the catch up query. Both scan by position.
CREATE INDEX outbound_transfer_by_position
  ON outbound_transfer (origin_chain, origin_block DESC);

-- --------------------------------------------------------------------------------------------
-- Arrivals
-- --------------------------------------------------------------------------------------------

CREATE TABLE inbound_delivery (
  id                 bigserial PRIMARY KEY,
  destination_chain  text NOT NULL,
  route              smallint NOT NULL CHECK (route BETWEEN 0 AND 3),
  source_chain       text NOT NULL,
  -- The far side router's own counter, for pairing the two halves of a hop.
  source_nonce       numeric(20, 0) NOT NULL,
  -- The rail's own identifier at full width, which is what both routers key replay protection on.
  --
  -- Nullable, and that is not an oversight on this side. The EVM BridgeIn event carries messageId;
  -- the Soroban BridgeIn event carries an InboundRecord which does not include it, even though the
  -- Soroban router guards replay on exactly that value. So an arrival on Stellar can only be
  -- identified by chain, route, source chain and source nonce. That is a gap in the event rather
  -- than in this table, and it is worth closing in the contract.
  rail_message_id    text,
  recipient          text NOT NULL,
  token              text NOT NULL,
  amount             numeric(78, 0) NOT NULL CHECK (amount > 0),
  -- False when the recipient could not take it and the funds parked as a claim instead.
  delivered          boolean NOT NULL,
  claim_id           numeric(20, 0),
  destination_block  numeric(20, 0) NOT NULL,
  destination_tx     text NOT NULL,
  destination_log_index integer,
  observed_at        timestamptz NOT NULL DEFAULT now(),

  -- Either the delivery arrived or it parked. A row claiming both, or neither, is a decoder bug.
  CONSTRAINT inbound_delivery_claim CHECK (
    (delivered AND claim_id IS NULL) OR (NOT delivered AND claim_id IS NOT NULL)
  ),
  CONSTRAINT inbound_delivery_hop UNIQUE (destination_chain, route, source_chain, source_nonce)
);

-- The strong key, where the chain gives us one. Partial so the Stellar rows, which have no message
-- id to offer, are not all competing for a single null.
CREATE UNIQUE INDEX inbound_delivery_by_message
  ON inbound_delivery (destination_chain, route, rail_message_id)
  WHERE rail_message_id IS NOT NULL;

CREATE INDEX inbound_delivery_by_recipient
  ON inbound_delivery (destination_chain, recipient, observed_at DESC);

CREATE INDEX inbound_delivery_by_position
  ON inbound_delivery (destination_chain, destination_block DESC);

COMMENT ON TABLE inbound_delivery IS
  'One row per arrival. Paired with an outbound_transfer by source chain and source nonce, which is the only pairing both families can offer.';
COMMENT ON COLUMN inbound_delivery.rail_message_id IS
  'The rail identifier at full width. Present on EVM arrivals, absent on Stellar ones because the Soroban BridgeIn event does not emit it.';

-- --------------------------------------------------------------------------------------------
-- Funds that arrived and could not be handed over
-- --------------------------------------------------------------------------------------------

CREATE TABLE pending_claim (
  chain          text NOT NULL,
  claim_id       numeric(20, 0) NOT NULL,
  recipient      text NOT NULL,
  token          text NOT NULL,
  amount         numeric(78, 0) NOT NULL CHECK (amount > 0),
  route          smallint NOT NULL CHECK (route BETWEEN 0 AND 3),
  source_chain   text NOT NULL,
  source_nonce   numeric(20, 0) NOT NULL,
  -- The chain's timestamp when the claim was parked.
  created_at     timestamptz NOT NULL,
  settled        boolean NOT NULL DEFAULT false,
  settled_at     timestamptz,
  -- Whoever paid to settle it. Settlement is permissionless, so this is frequently not the
  -- recipient and frequently not us.
  settled_by     text,
  settled_tx     text,
  observed_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (chain, claim_id),
  CONSTRAINT pending_claim_settlement CHECK (
    (NOT settled AND settled_at IS NULL AND settled_by IS NULL)
    OR (settled AND settled_at IS NOT NULL AND settled_by IS NOT NULL)
  )
);

-- The keeper's work queue. Partial, because a settled claim is history and the index exists to
-- find the handful that are not.
CREATE INDEX pending_claim_outstanding
  ON pending_claim (chain, created_at)
  WHERE NOT settled;

CREATE INDEX pending_claim_by_recipient
  ON pending_claim (chain, recipient)
  WHERE NOT settled;

COMMENT ON TABLE pending_claim IS
  'A delivery the recipient could not accept, usually a missing trustline or a frozen account. Anybody may settle one, which is why settled_by is recorded.';

-- --------------------------------------------------------------------------------------------
-- The part of a transfer neither chain can tell you about
-- --------------------------------------------------------------------------------------------

CREATE TABLE rail_attestation (
  transfer_id       bigint PRIMARY KEY REFERENCES outbound_transfer (id) ON DELETE CASCADE,
  route             smallint NOT NULL CHECK (route BETWEEN 0 AND 3),
  -- Hyperion's own vocabulary, not the rail's. Each rail names these differently and an operator
  -- should not have to learn four sets of words to read one table.
  status            text NOT NULL CHECK (
    status IN ('pending', 'attested', 'delivered', 'failed', 'expired')
  ),
  -- Whatever the rail's own API calls this, kept verbatim so a support question can be taken
  -- straight to them.
  rail_status       text,
  rail_reference    text,
  attested_at       timestamptz,
  last_checked_at   timestamptz,
  -- Consecutive failures, so the poller can back off per transfer rather than per rail.
  check_failures    integer NOT NULL DEFAULT 0,
  last_error        text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- What to poll next. Partial for the same reason as the claim index: the terminal states are the
-- overwhelming majority and none of them need looking at again.
CREATE INDEX rail_attestation_outstanding
  ON rail_attestation (route, last_checked_at NULLS FIRST)
  WHERE status IN ('pending', 'attested');

COMMENT ON TABLE rail_attestation IS
  'Where a transfer is while it exists only as an attestation in a rail API. The one piece of a transfer that is not on either chain.';
COMMENT ON COLUMN rail_attestation.status IS
  'Hyperion vocabulary. attested means the rail will deliver it; delivered means an inbound_delivery row exists for it.';

-- --------------------------------------------------------------------------------------------
-- Governance, watched so a parameter change outside a maintenance window gets attention
-- --------------------------------------------------------------------------------------------

CREATE TABLE admin_action (
  chain       text NOT NULL,
  action_id   numeric(20, 0) NOT NULL,
  -- ActionKind as the integer the chain emits. Not a text enum: the two chains order their kinds
  -- identically on purpose and a name mapped at write time would hide a drift the parity test
  -- exists to catch.
  kind        smallint NOT NULL,
  state       text NOT NULL CHECK (state IN ('queued', 'executed', 'cancelled', 'expired')),
  -- The whole action as the chain described it, so a reviewer reads what was queued rather than
  -- what an indexer understood of it.
  payload     jsonb NOT NULL,
  eta         timestamptz,
  expires_at  timestamptz,
  queued_at   timestamptz NOT NULL,
  settled_at  timestamptz,
  actor       text,
  observed_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (chain, action_id)
);

-- Anything still waiting, soonest first. This is the list a human should be looking at.
CREATE INDEX admin_action_pending
  ON admin_action (chain, eta)
  WHERE state = 'queued';

COMMENT ON TABLE admin_action IS
  'Privileged changes and where they are in the timelock. A timelock only does its job if somebody is reading the pending list.';

-- --------------------------------------------------------------------------------------------
-- Whether a route is worth offering right now
-- --------------------------------------------------------------------------------------------

CREATE TABLE route_health (
  id                 bigserial PRIMARY KEY,
  sampled_at         timestamptz NOT NULL DEFAULT now(),
  origin_chain       text NOT NULL,
  destination_chain  text NOT NULL,
  route              smallint NOT NULL CHECK (route BETWEEN 0 AND 3),
  token              text NOT NULL,
  available          boolean NOT NULL,
  -- QuoteBlocker as the integer the router returns. Zero when available.
  blocker            smallint NOT NULL DEFAULT 0,
  flow_available     numeric(78, 0),
  -- Observed end to end time for transfers that completed in this sample window, in seconds.
  -- Null when nothing completed, which is different from zero.
  median_seconds     integer
);

CREATE INDEX route_health_recent
  ON route_health (origin_chain, destination_chain, route, sampled_at DESC);

COMMENT ON TABLE route_health IS
  'Periodic samples of what each route would do. Append only, because the useful question is how a route behaved over the last hour rather than what it says this second.';
COMMENT ON COLUMN route_health.median_seconds IS
  'Observed, not predicted. Null when nothing completed in the window, which an app should render as unknown rather than as fast.';

-- Down Migration

DROP TABLE IF EXISTS route_health;
DROP TABLE IF EXISTS admin_action;
DROP TABLE IF EXISTS rail_attestation;
DROP TABLE IF EXISTS pending_claim;
DROP TABLE IF EXISTS inbound_delivery;
DROP TABLE IF EXISTS outbound_transfer;
DROP TABLE IF EXISTS indexer_cursor;
