# What is not built yet

Written down because a repository that implies more than it does costs somebody an afternoon.

## Landed

- **B1** Fastify scaffold, config, logging, graceful shutdown, health and readiness.
- **Runtime** The poller every watcher will run in, the readiness registry, shutdown ordering.
- **Database** Connection pool and row mappers.
- **Compose** Postgres and Redis, on non default ports.

## Next, in this order

**B2, the schema and its migrations.** The shape is decided and recorded in the README: amounts as
`NUMERIC(78,0)`, u64 values as `NUMERIC(20,0)` because they do not fit `int8`, deliveries keyed on
the rail's full width message id, and a nullable `rail_message_id` on the Stellar side with its own
partial unique index because the Soroban `BridgeIn` event does not carry one. Migrations with
node-pg-migrate, hand written SQL, `COMMENT ON` for every table and column.

**B3, the Stellar watcher.** Polls `getEvents` and filters on `contractIds` only. Never on topics:
the RPC topic filter matches on exact segment count and the router's events have two, three and
four topics, so a topic filter needs one entry per shape and silently drops anything that does not
match. Soroban event data is an `ScMap` keyed by snake case field names sorted by name, with void
fields omitted, which is what `#[contractevent]` produces by default in soroban-sdk 28.

**B4, the EVM watcher.** viem, per chain, confirmation aware using the registry's own
`confirmations` value, and reorg safe by re-scanning a window and reconciling rather than trusting
a single read.

**B5, the rail status pollers.** Circle's Iris for CCTP attestations, Axelar's GMP status API. This
is the part of a transfer's life neither chain can tell you about.

**B6, the keeper.** BullMQ. Four jobs, all of them permissionless on chain: bump a Soroban TTL
before an entry is archived, settle a parked claim, submit a rail's second leg where the rail needs
somebody to, and top up Axelar gas for a delivery that ran short. Nothing it does requires a key
that can move user funds, which is the constraint that makes it safe to run unattended.

**B7, the REST API.** Transfer status, claims, route health, metrics. Rate limited, because a
status endpoint is the one thing an app will poll in a loop.

## Deliberately out of scope

**Quoting.** The protocol package already mirrors the router's quote ladder locally and the app
prices against it directly. A second implementation here would be a third place for the arithmetic
to drift.

**Holding any key that can move user funds.** Everything this process calls is a read or a call
anybody could make. That is a limit on what a compromise of this box can cost, and it should stay
that way.
