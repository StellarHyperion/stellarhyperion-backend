-- Up Migration
-- Existing rows retain their IDs and an explicit unknown deployment until exact source replay.
ALTER TABLE outbound_transfer ADD COLUMN origin_router text NOT NULL DEFAULT '';
ALTER TABLE outbound_transfer DROP CONSTRAINT outbound_transfer_identity;
ALTER TABLE outbound_transfer ADD CONSTRAINT outbound_transfer_identity
  UNIQUE (origin_chain, origin_router, nonce);

-- Receipt verifiers can bind evidence to the precise source row. Legacy joins are allowed only
-- while their source nonce is unambiguous; repeated deployment nonces must never imply delivery.
ALTER TABLE inbound_delivery ADD COLUMN source_transfer_id bigint
  REFERENCES outbound_transfer(id) ON DELETE CASCADE;
ALTER TABLE pending_claim ADD COLUMN source_transfer_id bigint
  REFERENCES outbound_transfer(id) ON DELETE SET NULL;
UPDATE inbound_delivery d SET source_transfer_id = t.id
  FROM outbound_transfer t
 WHERE t.origin_chain = d.source_chain AND t.nonce = d.source_nonce
   AND t.route = d.route AND t.destination_chain = d.destination_chain;
UPDATE pending_claim c SET source_transfer_id = t.id
  FROM outbound_transfer t
 WHERE t.origin_chain = c.source_chain AND t.nonce = c.source_nonce
   AND t.route = c.route AND t.destination_chain = c.chain;
ALTER TABLE inbound_delivery DROP CONSTRAINT inbound_delivery_hop;
ALTER TABLE inbound_delivery ADD CONSTRAINT inbound_delivery_hop
  UNIQUE NULLS NOT DISTINCT
  (destination_chain, route, source_chain, source_nonce, source_transfer_id);

-- Outbound nonces are now scoped by their emitting router. Preserve existing evidence and
-- conflict protection for other lifecycle rows, whose schema identity has not changed.
DROP INDEX stellar_event_identity_shared_semantic_idx;
CREATE UNIQUE INDEX stellar_event_identity_shared_semantic_idx
  ON stellar_event_identity (chain_key, identity)
  WHERE identity NOT LIKE 'event:%' AND identity NOT LIKE 'bridgeOut:%';

-- Down Migration
-- Restoring the original unique keys deliberately refuses colliding deployment histories.
ALTER TABLE inbound_delivery DROP CONSTRAINT inbound_delivery_hop;
ALTER TABLE inbound_delivery ADD CONSTRAINT inbound_delivery_hop
  UNIQUE (destination_chain, route, source_chain, source_nonce);
ALTER TABLE pending_claim DROP COLUMN source_transfer_id;
ALTER TABLE inbound_delivery DROP COLUMN source_transfer_id;
ALTER TABLE outbound_transfer DROP CONSTRAINT outbound_transfer_identity;
ALTER TABLE outbound_transfer ADD CONSTRAINT outbound_transfer_identity UNIQUE (origin_chain, nonce);
ALTER TABLE outbound_transfer DROP COLUMN origin_router;
DROP INDEX stellar_event_identity_shared_semantic_idx;
CREATE UNIQUE INDEX stellar_event_identity_shared_semantic_idx
  ON stellar_event_identity (chain_key, identity) WHERE identity NOT LIKE 'event:%';
