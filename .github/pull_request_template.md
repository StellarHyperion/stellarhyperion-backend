<!--
Every question below is here because getting it wrong once is expensive, and most of them are
cheap to answer while the change is fresh in your head and nearly impossible to reconstruct three
weeks later.

Do not delete sections. If one does not apply, write "not applicable" and one line saying why.
That is a real answer and a reviewer can check it. A deleted section just looks like an oversight.
-->

## What changed

<!--
Plain prose. What is different in the code after this change than before it, at the level a
reviewer who has not read the diff can follow. File names are not an answer; "the CCTP poller now
backs off for five minutes upon receiving a 429 rather than spinning in the generic retry loop" is.
-->

## Why

<!--
What was wrong, or what became possible. If this fixes something, say how it was found: a failing
test, a reproduced reorg, an unexpected RPC status code, or something observed on testnet.
If it is new behaviour, say who asked for it and what they could not do before.

If the honest answer is "cleanup", that is fine. Say so and keep the diff to cleanup.
-->

## Chains, watchers, and rails

<!--
Tick what this change can affect, not what it was aimed at. A change to shared writers affects
every chain watcher, and a change to the database schema affects every component.
-->

Watchers and indexers:

- [ ] Stellar event watcher (`src/chains/stellar/`)
- [ ] EVM event watcher (`src/chains/evm/`)
- [ ] Shared writer layer (`src/chains/writers.ts`)
- [ ] Runner and lifecycle (`src/chains/runner.ts`)
- [ ] None. This touches no watcher logic.

Rails and pollers:

- [ ] Circle CCTP Iris poller (`src/rails/cctp/`)
- [ ] Axelar GMP poller (`src/rails/axelar/`)
- [ ] BullMQ keeper upkeep jobs (`src/keeper/`)
- [ ] None. This touches no rail or keeper logic.

API and runtime:

- [ ] Fastify REST endpoints (`src/http/`)
- [ ] Configuration and environment (`src/config/`)
- [ ] Database schema and migrations (`migrations/`, `src/db/`)
- [ ] Runtime health, readiness, and shutdown (`src/runtime/`)
- [ ] None.

## Database and schema invariants

<!--
Does this change alter tables, indexes, or constraints?
If yes:
1. Is it backwards compatible with running indexer replicas?
2. Does it touch NUMERIC column precision?
3. Did you verify that conflict clauses (ON CONFLICT DO UPDATE) preserve observed_at?
If not applicable, state "not applicable".
-->

## State machine and idempotency

<!--
Explain how this change preserves idempotency during restarts, re-reads, and chain reorgs:
- Are event cursors safely monotone?
- Can this pass run twice over the same block or ledger window without duplicating records?
- Does it handle transient RPC 4xx/5xx errors without burning permanent failure counters?
-->

## Verification

<!--
Which suites were executed?
- [ ] npm run fmt:check
- [ ] npm run lint
- [ ] npm run typecheck
- [ ] npm run build
- [ ] npm test (unit suite)
- [ ] npm test (with TEST_DATABASE_URL and real Postgres)
- [ ] Live chain or RPC verification (detail below)
-->
