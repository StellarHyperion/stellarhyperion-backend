# Hyperion backend

The off-chain half. It answers one question and performs one job.

The question is "where is my transfer". A cross-chain transfer is two transactions on two chains
with a rail in between, and for some of its life it exists only as an attestation sitting in
somebody else's API. Nothing on either chain can tell you about that middle part, so something has
to watch both ends and the rail, and keep a record that outlives the seven days of history a
Soroban RPC node retains.

The job is moving a stuck one along. Rails get stuck for boring reasons: a destination gas market
moved between the quote and the execution, a recipient was frozen when the delivery arrived, a
second leg needs somebody to submit it and nobody did. Every one of those has a permissionless fix
on chain, and a keeper that notices and pays is worth more than a support inbox.

This process holds no keys that can move user funds. Everything it calls is either a read or a
permissionless call that anybody could make, which is a deliberate limit on how much damage it can
do if it is compromised.

## State of play

Built and verified:

| Subsystem | Scope |
|---|---|
| Config | Declarative spec table, accumulating reader, strict validation |
| HTTP | Fastify 5, `/health` and `/ready` probes, REST API endpoints |
| Runtime | Poller loop, backoff, readiness registry, graceful shutdown |
| Database | Schema, SQL migrations, connection pool, row mappers |
| Stellar | Soroban event watcher, cursor safe across bounded ledger windows |
| EVM | Per-chain viem log watcher, confirmation-aware, reorg-detecting |
| Rail Pollers | Circle Iris attestation poller, Axelar GMP status poller |
| Keeper | BullMQ workers for TTL bumps, claim settlement, second-step calls |
| REST API | Transfer status, parked claims, route health, prometheus metrics |
| CI/CD | GitHub Actions workflow, PR template, CODEOWNERS, security docs |

158 tests passing across unit and integration suites against real PostgreSQL 16 and Redis 7. Both watchers are verified against live chains and testnet router contracts.

### Organization links

This service connects on-chain contracts with the web interface across the StellarHyperion organization:

- Contracts: [stellarhyperion-contracts](https://github.com/StellarHyperion/stellarhyperion-contracts)
- Frontend: [stellarhyperion-frontend](https://github.com/StellarHyperion/stellarhyperion-frontend)

## Why the config layer is the longest file here

Because a process that boots with half a configuration and discovers the rest on the first inbound
transfer discovers it at the worst possible moment.

Every variable goes through a spec that says what it is, whether it is required, what it is for,
and whether its value may ever appear in an error message. The reader accumulates faults instead of
throwing on the first one, so a bad deploy names every variable that needs attention in a single
message rather than one per restart. Nothing logs a value: `DATABASE_URL` and `REDIS_URL` carry
passwords, and a configuration dump at info level is the most common way a credential reaches a log
aggregator.

Three bugs in that layer were found by making its own tests pass, and all three are worth knowing
about because they are not specific to this project.

**`new URL` is far more permissive than anybody expects.** `new URL("sepolia-node:8545")` succeeds.
It parses as the scheme `sepolia-node` with an opaque body and no host at all, so a check that was
meant to catch a malformed RPC endpoint passed it through to viem, where it fails on the first
request as a fetch error naming nothing an operator can act on. Every URL variable now declares
which schemes it accepts and the parse requires a host, so a redis url in `DATABASE_URL` is refused
by name at startup.

**One mistake produced several faults pointing at the wrong variable.** A missing `HYPERION_NETWORK`
made the enum reader fall back to the first mode, which made every chain in a testnet deployment
record look like it belonged to the wrong network, and the result was two faults blaming
`HYPERION_DEPLOYMENTS_FILE` for a file that was fine. A cascading fault is worse than a silent one:
it sends somebody to edit the wrong thing, confidently. Derived checks now stand down when their own
inputs have already failed, and a variable is named at most once.

**The wrong network check reported one fault per offending chain.** There is one thing to fix, the
record or the variable, so it is now one fault naming all of them.

## The poller

Every watcher runs in the same loop, and it does three things `setInterval` does not.

One tick at a time, because `setInterval` will start a second tick while the first is still reading
a page, and two ticks sharing one cursor race each other into writing the same page twice or
skipping one.

Catch up without waiting. A watcher starting from a deployment block months behind the head has
thousands of pages to read, and sleeping four seconds between them would take a week. A tick that
reports progress is followed immediately; only a tick that found nothing new waits out the interval.

Back off on consecutive failures, with a ceiling. A rate limited RPC endpoint answers a retry storm
with more rate limiting. Doubling the wait and capping it means a flapping endpoint costs one
request a minute instead of one a second, and a recovered one is picked up on the next tick rather
than after a long sulk.

It also reads its own abort flag through a method call rather than a field access, which looks like
noise and is not. The loop tests the flag, awaits, then tests it again, and `abort` is called from
another turn of the event loop. TypeScript cannot see that, so it narrows the flag to false at the
top of the loop and keeps that narrowing across every await inside, which makes the later checks
look like dead code to the compiler and the linter. Reading it through a call defeats the narrowing.

## Health and readiness mean different things

`/health` says the process is alive and answering. A load balancer uses it to decide whether to
restart.

`/ready` says the process can do its job, which means the database answers and every watcher has
either caught up or is failing in a way worth reporting. A process whose Stellar watcher has been
unable to reach an RPC node for ten minutes is alive and is not ready, and conflating those two is
how a deployment rolls forward into a cluster that cannot index anything.

## Schema notes

Amounts are `NUMERIC(78,0)`. A `uint256` does not fit in anything else, and a float would be a
rounding error in a column that holds somebody's money.

Nonces and claim ids are `NUMERIC(20,0)` rather than `bigint`, because `u64` maximum is larger than
Postgres `int8` can hold. That is a narrow trap: it only bites at values a test fixture will not
produce and a real chain eventually will.

Inbound deliveries are keyed on the rail's own message id at full width, never on a nonce alone,
because squeezing a 32 byte CCTP nonce into a `uint64` lets two different messages collide on one
key.

One asymmetry worth recording, found while reading both routers. The Soroban `BridgeIn` event
carries an `InboundRecord` with no `message_id`, while the EVM `BridgeIn` event does carry
`messageId`. Both routers guard replay on the message id; only one emits it. So on the Stellar side
an inbound delivery can only be keyed on the chain, the route, the source chain and the source
nonce, and `rail_message_id` is nullable with its own partial unique index. That is a gap in the
Soroban event rather than in this schema, and it is worth closing there.

## Two chains, two watchers, and why they are not one file with a flag

Stellar has deterministic finality. A closed ledger is closed, so a ledger number is a complete
description of a position and there is nothing to re-read. An EVM block number is not a complete
description, because the chain can later disagree about which block had that number. Sharing one
watcher between them would mean a flag selecting which half of its own correctness argument
applied, which is how the half that is off by default stops being tested.

What they do share is the writers. `src/chains/writers.ts` holds every statement that writes an
indexed row, and the per-family files map events onto it. The tables are shared and so are the
constraints: `inbound_delivery_claim` says a row claims either a delivery or a claim id and never
both, and two files writing that table would be two chances to violate it on one side only.

### What the Stellar watcher had to be told about `getEvents`

That it does not scan to the head. It scans a bounded window and returns a cursor saying where it
stopped: ten thousand ledgers for a request starting at a ledger, 9999 for one resuming from a
cursor. So an empty page means "nothing in this window", never "nothing left to read", and a
watcher that treats the two as the same re-reads one window forever and never arrives. That is
invisible on a busy chain and permanent on a quiet one. The measurements behind this, and the
cursor arithmetic they imply, are written out in `src/chains/stellar/cursor.ts`.

### What the EVM watcher does about reorgs

Two mechanisms doing two different jobs. Confirmations draw the line it will not read past, per
chain from the registry, which is the honest way to treat one block on Arc and twelve on Ethereum
as the same kind of fact. Indexing only up to `head - confirmations` means the ordinary pass needs
no re-reading at all.

The cursor's block hash catches what confirmations were supposed to prevent. Every pass re-reads
the hash of the block the cursor sits on, and a hash that no longer matches means the chain
reorganised past a depth its own registry entry claims is enough. That is reported at error level
and the cursor winds back by the reorg depth, so the corrected blocks are read again and the
writers overwrite what the orphaned ones said.

What it will not do is delete. A transfer orphaned out of existence rather than changed leaves a
row nothing overwrites, and the only honest fix is a person deciding. Silently deleting money
records to tidy up after a reorg deeper than the chain's stated finality would be a worse failure
than the one being cleaned up.

Both watchers report `degraded` at worst and never `down`. `/ready` takes the worst report in the
process, and a 503 because one chain is unreachable would stop this replica answering about the
chains that are fine. Moving an outage is not fixing one.

## Running it

```bash
docker compose up -d        # postgres on 5433, redis on 6380

# The shared SDK is a file dependency on the contracts repo and has to be built first.
cd ../contracts/packages/protocol && npm install && npm run build && cd -

npm install
cp .env.example .env        # then fill it in
npm run check               # format, lint, typecheck, test
npm run dev
```

Compose publishes on 5433 and 6380 rather than the defaults so it does not fight whatever is
already running on a development machine.

### The shared SDK

`@hyperion/protocol` comes from the contracts repository as a `file:` dependency, which means the
two repositories have to sit side by side and the package has to be built before an install here
will resolve. CI checks out the contracts repo as a sibling for exactly that reason.

That is a real tradeoff rather than an oversight. The alternative is publishing to a registry, which
is the right answer eventually and is overhead nobody needs while both halves are moving daily.
What is not an option is vendoring a copy or redefining its types locally: one copy of the shared
facts is the entire point of that package, and two copies that agree today are two copies that
disagree the first time somebody adds an error variant.

### Secrets

Only `.env.example` is committed and every value in it is a placeholder. `.env` and anything
matching it is gitignored. No value is ever logged, including on error paths, and the config layer
reports a bad credential by naming the variable and the shape it failed rather than the string.

## Tests

```bash
npm test                                            # unit, no network
TEST_DATABASE_URL=postgres://... npm test           # adds the integration suite
```

Unit tests never touch the network or the filesystem or `process.env`. The deployment record under
`test/fixtures` is a real record: every strkey in it carries a valid CRC16 and
`parseDeploymentSet` accepts it for the same reasons it would accept a live one, because a fixture
the validator would reject tests the validator and nothing else.

## License

MIT.
