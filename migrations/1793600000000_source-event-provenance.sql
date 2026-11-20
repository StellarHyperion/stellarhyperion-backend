-- Up Migration

-- --------------------------------------------------------------------------------------------
-- Source event identity and payload digest, kept apart from mutable materialized rows (#54)
-- --------------------------------------------------------------------------------------------
--
-- outbound_transfer, inbound_delivery, pending_claim and admin_action are materialized views of
-- chain history: upserts, reorg corrections and lifecycle events rewrite them. The raw event that
-- produced each fact is recorded here once, with a digest of its payload, and never rewritten.
--
-- Retention and access bounds:
--   * source_event rows are retained for as long as any source_event_link or
--     source_event_conflict references them (enforced by ON DELETE RESTRICT). Only unlinked,
--     conflict-free rows older than an operator cutoff may be pruned, in batches of at most
--     10,000 (pruneUnlinkedSourceEvents).
--   * No raw payload is stored: only a SHA-256 digest, a bounded event kind and the source
--     position, so nothing a provider sent (and no credential) can be read back from these tables.
--   * Readers return at most 100 links per materialized record (readSourceProvenance).

CREATE TABLE source_event (
  id                   bigserial PRIMARY KEY,
  chain_key            text NOT NULL CHECK (length(chain_key) BETWEEN 1 AND 64),
  family               text NOT NULL CHECK (family IN ('stellar', 'evm')),
  contract             text NOT NULL CHECK (length(contract) BETWEEN 1 AND 128),
  deployment_revision  integer NOT NULL DEFAULT 1 CHECK (deployment_revision >= 1),
  block_number         numeric(20, 0) NOT NULL CHECK (block_number >= 0),
  tx_hash              text NOT NULL CHECK (length(tx_hash) BETWEEN 1 AND 128),
  -- Stellar event id, or the EVM log index, at full width.
  event_position       text NOT NULL CHECK (event_position ~ '^[0-9A-Za-z_-]{1,64}$'),
  event_kind           text NOT NULL CHECK (event_kind ~ '^[A-Za-z0-9_]{1,64}$'),
  payload_digest       text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  replays              integer NOT NULL DEFAULT 0 CHECK (replays BETWEEN 0 AND 1000000),
  CONSTRAINT source_event_identity
    UNIQUE (chain_key, contract, deployment_revision, block_number, tx_hash, event_position),
  CONSTRAINT source_event_seen_order CHECK (last_seen_at >= first_seen_at)
);

CREATE INDEX source_event_by_position ON source_event (chain_key, block_number, id);

-- Identity and digest are provenance: once written they cannot be replaced, only observed again.
CREATE FUNCTION source_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.chain_key, NEW.family, NEW.contract, NEW.deployment_revision, NEW.block_number,
      NEW.tx_hash, NEW.event_position, NEW.event_kind, NEW.payload_digest, NEW.first_seen_at)
     IS DISTINCT FROM
     (OLD.chain_key, OLD.family, OLD.contract, OLD.deployment_revision, OLD.block_number,
      OLD.tx_hash, OLD.event_position, OLD.event_kind, OLD.payload_digest, OLD.first_seen_at) THEN
    RAISE EXCEPTION 'source_event provenance is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER source_event_immutable BEFORE UPDATE ON source_event
  FOR EACH ROW EXECUTE FUNCTION source_event_immutable();

CREATE TABLE source_event_conflict (
  id                bigserial PRIMARY KEY,
  source_event_id   bigint NOT NULL REFERENCES source_event (id) ON DELETE RESTRICT,
  incoming_digest   text NOT NULL CHECK (incoming_digest ~ '^[0-9a-f]{64}$'),
  incoming_kind     text NOT NULL CHECK (incoming_kind ~ '^[A-Za-z0-9_]{1,64}$'),
  occurrences       integer NOT NULL DEFAULT 1 CHECK (occurrences BETWEEN 1 AND 1000000),
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_event_id, incoming_digest)
);

CREATE TABLE source_event_link (
  source_event_id   bigint NOT NULL REFERENCES source_event (id) ON DELETE RESTRICT,
  record_kind       text NOT NULL CHECK (
    record_kind IN ('outbound_transfer', 'inbound_delivery', 'pending_claim', 'admin_action')
  ),
  -- outbound_transfer and inbound_delivery: the row id. pending_claim and admin_action: chain:id.
  record_key        text NOT NULL CHECK (length(record_key) BETWEEN 1 AND 160),
  role              text NOT NULL CHECK (role IN ('created', 'settled')),
  linked_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (record_kind, record_key, source_event_id, role)
);

CREATE INDEX source_event_link_by_source ON source_event_link (source_event_id);

COMMENT ON TABLE source_event IS
  'Immutable raw event identity and payload digest. Retained while linked or conflicted; unlinked rows prunable after an operator cutoff. Stores no raw payload.';
COMMENT ON TABLE source_event_conflict IS
  'A later observation of the same source identity with a different payload digest. The original source_event is never replaced.';
COMMENT ON TABLE source_event_link IS
  'Which raw source events produced or settled a mutable materialized record. Replays reuse the existing link.';

-- Down Migration

DROP TABLE source_event_link;
DROP TABLE source_event_conflict;
DROP TRIGGER source_event_immutable ON source_event;
DROP FUNCTION source_event_immutable();
DROP TABLE source_event;
