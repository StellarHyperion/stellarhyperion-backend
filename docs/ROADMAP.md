# What is not built yet

Written down because a repository that implies more than it does costs somebody an afternoon.

## Landed

- **B1** Fastify scaffold, config, logging, graceful shutdown, health and readiness.
- **B2** The schema and its migrations, with every constraint proven against a real Postgres.
- **B3** The Stellar watcher. Verified against the deployed router on testnet: started 28400
  ledgers behind, backfilled through the empty windows, reached the head, and the rows matched the
  deployment record's own account of what had been queued, executed and cancelled.
- **B4** The EVM watcher. One per chain from the deployment record, confirmation aware from the
  registry, reorg detecting through the cursor's block hash. Verified against a router deployed on
  a local node answering as the chain its record names.
- **Runtime** The poller every watcher runs in, the readiness registry, shutdown ordering.
- **Database** Connection pool, row mappers, and one shared writer layer for both chain families.
- **Compose** Postgres and Redis, on non default ports.

## Next, in this order

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

## Two things found while building the watchers, that belong in the contracts repo

Recorded here because they are not backend bugs and they are easy to lose.

**The phase 1 Stellar testnet deployment record is wrong about the start ledger.**
`deployedAt.ledger` is 4966617, which is when the deploy script finished. The router emitted its
initialisation at 4965951 and seven queued actions before that point, so a watcher that trusts the
record misses eight events. The backend works around it with `STELLAR_START_LEDGER`; the fix is for
the deploy script to record the ledger the router instance was created in.

**A local anvil deployment cannot be indexed as itself.** The EVM watcher refuses an endpoint whose
chain id disagrees with the deployment record, which is the counterpart of the Stellar watcher
refusing a network passphrase that disagrees with the registry. But the local deploy scripts refuse
to run on anything except chain 31337 or 1337, and no chain in the registry has either id. So there
is no chain a local end to end run and the indexer can both accept. Closing it means a `local`
entry in the chain registry; the alternative, an opt out on the chain id check, is a safety guard
with an off switch, which is a guard people turn off.
