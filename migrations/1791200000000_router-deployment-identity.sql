-- Up Migration

-- Include router deployment identity in transfer, delivery, claim, and action uniqueness keys so
-- redeployed routers starting at nonce 1 on the same chain retain independent histories.

ALTER TABLE outbound_transfer
  ADD COLUMN origin_router text;

UPDATE outbound_transfer t
   SET origin_router = COALESCE(
     (
       SELECT CASE
                WHEN c.contract ~ '^0x[0-9a-fA-F]+$' THEN lower(c.contract)
                ELSE c.contract
              END
         FROM indexer_cursor c
        WHERE c.chain_key = t.origin_chain
        LIMIT 1
     ),
     'legacy-unspecified-router'
   )
 WHERE t.origin_router IS NULL;

ALTER TABLE outbound_transfer
  ALTER COLUMN origin_router SET DEFAULT 'legacy-unspecified-router',
  ALTER COLUMN origin_router SET NOT NULL,
  ADD CONSTRAINT outbound_transfer_router_normalized CHECK (
    btrim(origin_router) <> ''
    AND (
      origin_router !~ '^0x[0-9a-fA-F]+$'
      OR origin_router = lower(origin_router)
    )
  );

ALTER TABLE outbound_transfer
  DROP CONSTRAINT outbound_transfer_identity,
  ADD CONSTRAINT outbound_transfer_identity UNIQUE (origin_chain, origin_router, nonce);

CREATE INDEX outbound_transfer_by_router_sender
  ON outbound_transfer (origin_chain, origin_router, sender, observed_at DESC);

ALTER TABLE inbound_delivery
  ADD COLUMN destination_router text,
  ADD COLUMN source_router text;

UPDATE inbound_delivery d
   SET destination_router = COALESCE(
         (
           SELECT CASE
                    WHEN c.contract ~ '^0x[0-9a-fA-F]+$' THEN lower(c.contract)
                    ELSE c.contract
                  END
             FROM indexer_cursor c
            WHERE c.chain_key = d.destination_chain
            LIMIT 1
         ),
         'legacy-unspecified-router'
       ),
       source_router = COALESCE(
         (
           SELECT CASE WHEN count(*) = 1 THEN max(t.origin_router) END
             FROM outbound_transfer t
            WHERE t.origin_chain = d.source_chain
              AND t.route = d.route
              AND t.nonce = d.source_nonce
         ),
         (
           SELECT CASE
                    WHEN c.contract ~ '^0x[0-9a-fA-F]+$' THEN lower(c.contract)
                    ELSE c.contract
                  END
             FROM indexer_cursor c
            WHERE c.chain_key = d.source_chain
            LIMIT 1
         ),
         'legacy-unspecified-router'
       )
 WHERE d.destination_router IS NULL OR d.source_router IS NULL;

ALTER TABLE inbound_delivery
  ALTER COLUMN destination_router SET DEFAULT 'legacy-unspecified-router',
  ALTER COLUMN destination_router SET NOT NULL,
  ALTER COLUMN source_router SET DEFAULT 'legacy-unspecified-router',
  ALTER COLUMN source_router SET NOT NULL,
  ADD CONSTRAINT inbound_delivery_routers_normalized CHECK (
    btrim(destination_router) <> ''
    AND btrim(source_router) <> ''
    AND (
      destination_router !~ '^0x[0-9a-fA-F]+$'
      OR destination_router = lower(destination_router)
    )
    AND (
      source_router !~ '^0x[0-9a-fA-F]+$'
      OR source_router = lower(source_router)
    )
  );

ALTER TABLE inbound_delivery
  DROP CONSTRAINT inbound_delivery_hop,
  ADD CONSTRAINT inbound_delivery_hop UNIQUE (
    destination_chain,
    destination_router,
    route,
    source_chain,
    source_router,
    source_nonce
  );

DROP INDEX IF EXISTS inbound_delivery_by_message;
CREATE UNIQUE INDEX inbound_delivery_by_message
  ON inbound_delivery (destination_chain, destination_router, route, rail_message_id)
  WHERE rail_message_id IS NOT NULL;

ALTER TABLE pending_claim
  ADD COLUMN router text,
  ADD COLUMN source_router text;

UPDATE pending_claim p
   SET router = COALESCE(
         (
           SELECT CASE
                    WHEN c.contract ~ '^0x[0-9a-fA-F]+$' THEN lower(c.contract)
                    ELSE c.contract
                  END
             FROM indexer_cursor c
            WHERE c.chain_key = p.chain
            LIMIT 1
         ),
         'legacy-unspecified-router'
       ),
       source_router = COALESCE(
         (
           SELECT CASE WHEN count(*) = 1 THEN max(t.origin_router) END
             FROM outbound_transfer t
            WHERE t.origin_chain = p.source_chain
              AND t.route = p.route
              AND t.nonce = p.source_nonce
         ),
         (
           SELECT CASE
                    WHEN c.contract ~ '^0x[0-9a-fA-F]+$' THEN lower(c.contract)
                    ELSE c.contract
                  END
             FROM indexer_cursor c
            WHERE c.chain_key = p.source_chain
            LIMIT 1
         ),
         'legacy-unspecified-router'
       )
 WHERE p.router IS NULL OR p.source_router IS NULL;

ALTER TABLE pending_claim
  ALTER COLUMN router SET DEFAULT 'legacy-unspecified-router',
  ALTER COLUMN router SET NOT NULL,
  ALTER COLUMN source_router SET DEFAULT 'legacy-unspecified-router',
  ALTER COLUMN source_router SET NOT NULL,
  ADD CONSTRAINT pending_claim_routers_normalized CHECK (
    btrim(router) <> ''
    AND btrim(source_router) <> ''
    AND (router !~ '^0x[0-9a-fA-F]+$' OR router = lower(router))
    AND (source_router !~ '^0x[0-9a-fA-F]+$' OR source_router = lower(source_router))
  );

ALTER TABLE pending_claim
  DROP CONSTRAINT pending_claim_pkey,
  ADD CONSTRAINT pending_claim_pkey PRIMARY KEY (chain, router, claim_id);

DROP INDEX IF EXISTS pending_claim_outstanding;
CREATE INDEX pending_claim_outstanding
  ON pending_claim (chain, router, created_at)
  WHERE NOT settled;

DROP INDEX IF EXISTS pending_claim_by_recipient;
CREATE INDEX pending_claim_by_recipient
  ON pending_claim (chain, router, recipient)
  WHERE NOT settled;

ALTER TABLE admin_action
  ADD COLUMN router text;

UPDATE admin_action a
   SET router = COALESCE(
     (
       SELECT CASE
                WHEN c.contract ~ '^0x[0-9a-fA-F]+$' THEN lower(c.contract)
                ELSE c.contract
              END
         FROM indexer_cursor c
        WHERE c.chain_key = a.chain
        LIMIT 1
     ),
     'legacy-unspecified-router'
   )
 WHERE a.router IS NULL;

ALTER TABLE admin_action
  ALTER COLUMN router SET DEFAULT 'legacy-unspecified-router',
  ALTER COLUMN router SET NOT NULL,
  ADD CONSTRAINT admin_action_router_normalized CHECK (
    btrim(router) <> ''
    AND (router !~ '^0x[0-9a-fA-F]+$' OR router = lower(router))
  );

ALTER TABLE admin_action
  DROP CONSTRAINT admin_action_pkey,
  ADD CONSTRAINT admin_action_pkey PRIMARY KEY (chain, router, action_id);

DROP INDEX IF EXISTS admin_action_pending;
CREATE INDEX admin_action_pending
  ON admin_action (chain, router, eta)
  WHERE state = 'queued';

-- Down Migration

DROP INDEX IF EXISTS admin_action_pending;
ALTER TABLE admin_action
  DROP CONSTRAINT admin_action_pkey,
  DROP CONSTRAINT admin_action_router_normalized,
  DROP COLUMN router,
  ADD CONSTRAINT admin_action_pkey PRIMARY KEY (chain, action_id);
CREATE INDEX admin_action_pending
  ON admin_action (chain, eta)
  WHERE state = 'queued';

DROP INDEX IF EXISTS pending_claim_by_recipient;
DROP INDEX IF EXISTS pending_claim_outstanding;
ALTER TABLE pending_claim
  DROP CONSTRAINT pending_claim_pkey,
  DROP CONSTRAINT pending_claim_routers_normalized,
  DROP COLUMN source_router,
  DROP COLUMN router,
  ADD CONSTRAINT pending_claim_pkey PRIMARY KEY (chain, claim_id);
CREATE INDEX pending_claim_outstanding
  ON pending_claim (chain, created_at)
  WHERE NOT settled;
CREATE INDEX pending_claim_by_recipient
  ON pending_claim (chain, recipient)
  WHERE NOT settled;

DROP INDEX IF EXISTS inbound_delivery_by_message;
ALTER TABLE inbound_delivery
  DROP CONSTRAINT inbound_delivery_hop,
  DROP CONSTRAINT inbound_delivery_routers_normalized,
  DROP COLUMN source_router,
  DROP COLUMN destination_router,
  ADD CONSTRAINT inbound_delivery_hop UNIQUE (
    destination_chain,
    route,
    source_chain,
    source_nonce
  );
CREATE UNIQUE INDEX inbound_delivery_by_message
  ON inbound_delivery (destination_chain, route, rail_message_id)
  WHERE rail_message_id IS NOT NULL;

DROP INDEX IF EXISTS outbound_transfer_by_router_sender;
ALTER TABLE outbound_transfer
  DROP CONSTRAINT outbound_transfer_identity,
  DROP CONSTRAINT outbound_transfer_router_normalized,
  DROP COLUMN origin_router,
  ADD CONSTRAINT outbound_transfer_identity UNIQUE (origin_chain, nonce);
