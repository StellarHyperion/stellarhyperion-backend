# Hyperion backend

[App](https://stellarhyperion.vercel.app/) | [Public API health](https://stellarhyperion-backend.vercel.app/health) | [Contracts and deployment evidence](https://github.com/StellarHyperion/stellarhyperion-contracts)

Indexes Hyperion contract events, serves public transfer/claim history, polls rail status and optionally submits Stellar maintenance transactions. The checked-in deployment is the Stellar Testnet router. Active routes deliver Stellar USDC through Axelar ITS to Ethereum Sepolia, or through Circle CCTP to native USDC on Ethereum Sepolia, Base Sepolia and Arc Testnet. The frontend can first convert other liquid classic Stellar assets into USDC. The wallet-owned deployment is active; signed deployment and successful transfer evidence are described in the contracts repository's `docs/TESTNET_ACTIVATION.md`.

## Changes since October 12, 2026

- Corrected transfer, claim, health and metrics queries against the migrated schema, plus Stellar RPC retention/error handling. Regression tests run the actual migrations in embedded PostgreSQL.
- Added independent destination-receipt verification for paid ITS and CCTP, including recipient, token identity, amount, finality and confirmations. API history exposes the actual destination payout and its precision.
- Published the API with persistent managed PostgreSQL and a scheduled catch-up indexer, and added signer-backed Stellar maintenance for optional keeper deployments. Compatible dependency patches resolved the reported HTTP redirect and test-tooling advisories.

## Run

Use Node 22.13 or newer. PostgreSQL is required. Redis is used only when the keeper is enabled.

```bash
npm ci
cp .env.example .env
# Configure DATABASE_URL and the other required values.
npm run migrate:up
npm run build
node --env-file=.env dist/main.js
```

Migration commands use PostgreSQL's session-level advisory lock and wait for another migration
runner to finish before checking and applying pending steps. The lock is released when the runner
finishes or its database connection closes. API instances do not run migrations at startup.

The SDK is installed from the committed protocol tarball. `npm run dev` does not load `.env` automatically; export the variables first or run `node --env-file=.env --watch --experimental-strip-types src/main.ts`.

### Startup schema compatibility check

Before the server accepts requests or the indexer reads a cursor, the process verifies that the database has been migrated to the schema version this build expects (`SCHEMA_VERSION`, defaulting to the newest migration file). The check reads `pgmigrations` and refuses to start unless the complete shipped migration manifest matches the applied schema (including the newest step). It never runs migrations itself: apply them with `npm run migrate:up` first. The failure message names only the variable and the expected shape, never the database connection string.

### Bounded catch-up runtime budget

Enable `CATCH_UP_ENABLED=true` for scheduled runs; continuous containers have no lifetime limit. Apply migrations explicitly before startup. The scheduled process divides its wall-clock budget (`CATCH_UP_BUDGET_MS`, default 120000ms) among migrations, source scans, proof polling and graceful drain. A slow stage cannot consume the entire shutdown safety margin: source scans and proof polling receive bounded stage allocations with a reserved drain window and the run moves on when its slice is spent. Work already committed to the database survives budget expiration, and the shutdown log reports why the run stopped and which stage remains eligible for the next run.

### Continuous-container readiness and graceful rollout

Before indexing shared cursors, a replica acquires an expiring lease per chain/router in the existing cursor lease storage so two active replicas never advance the same cursor. The lease TTL (`INDEXER_LEASE_TTL_MS`, default 30000ms) is renewed while the replica is healthy and released during graceful shutdown. A replica that loses its lease stops indexing until it can re-acquire ownership.

`INDEXER_LEASE_OWNER_ID` names this replica; it defaults to hostname plus process id, with an independently unique worker suffix. Health probes (`GET /ready`) report lease ownership together with Postgres, Redis and watcher state, so a load balancer takes a replica out of rotation when it cannot do its job and puts it back when it recovers. The Dockerfile exposes `/ready` as a HEALTHCHECK endpoint.

Run the watchers and rail pollers in a continuous process or in regular scheduled catch-up windows. Deploying only `api/index.ts` provides reads from an existing database; it does not run indexing in the background. Set the frontend's `NEXT_PUBLIC_HYPERION_API_URL` to this service's origin. Public API reads support cross-origin GET requests.

## Deploy on Vercel

The `hyperion-backend` Vercel project serves [stellarhyperion-backend.vercel.app](https://stellarhyperion-backend.vercel.app). Configure its production `DATABASE_URL` through Vercel environment variables with a managed PostgreSQL connection and TLS. Keep the value server-side. Redis and signing keys are unnecessary while `KEEPER_ENABLED=false`.

`vercel.json` includes the deployment metadata in the API function. Production indexing runs in [the testnet indexer workflow](.github/workflows/indexer.yml), independently of requests to the API. Store the same database connection as the repository Actions secret `HYPERION_DATABASE_URL`. Each run applies pending SQL migrations and runs the real indexer and bridge pollers for 150 seconds, with graceful shutdown and a persisted PostgreSQL cursor. The concurrency group prevents overlapping hosted jobs. No signer is configured.

The workflow is scheduled every five minutes and can be started manually. GitHub may delay scheduled runs; public Activity is eventually updated rather than an instant destination feed. Inspect its latest run and `/v1/metrics` cursor timestamps to check freshness. API `/ready` verifies its database access; the serverless API does not run chain watchers itself. The optional Dockerfile packages the same service for an always-running container host.

Deploy the API with `vercel deploy --prod`. Preview environments require their own database. Database credentials stay in Vercel and GitHub secrets, never in browser configuration, Git or logs. The managed PostgreSQL database is the durable state; restarting a worker must not repeat source transfers.

Set `HYPERION_DATABASE_ENV` to the hosting `VERCEL_ENV` (`preview` or `production`).
Apply migrations explicitly with a migration administrator, then provision the database once:

```sql
INSERT INTO public.hyperion_database_identity(environment) VALUES ('preview');
```

Use `production` for the production database. Startup compares this durable marker with both
configured environment labels; changing a preview label cannot admit production credentials.
The migration deliberately leaves the marker empty until an administrator binds the database.
Local development and tests with `VERCEL_ENV=development` and nonproduction `NODE_ENV` do not
require this hosting marker.

The API requires a dedicated nonprivileged login with `USAGE` on the `public` schema and `SELECT`
on the tables listed by `API_READ_TABLES` in `src/db/policy.ts` (including `pgmigrations` and the
identity marker and `rail_attestation_history` for durable SSE replay). Existing API reader
roles must receive this additional SELECT grant before enabling resumable streams. Grant no
public-table write privileges or privileged role memberships. API
connections also use `default_transaction_read_only`; startup verifies the actual role and grants,
not only the `HYPERION_DATABASE_ROLE=read-only` label. The serverless entrypoint refuses enabled
background writers. Indexer, rail or keeper processes require `HYPERION_DATABASE_ROLE=read-write`
and a separately provisioned worker credential. Keep migration privileges separate from both.

Vercel's installed Git integration publishes `main`. GitHub Actions runs validation and the scheduled indexer; it does not need a Vercel deployment token.

### Serverless deployment (Vercel)

Serverless invocations via `api/index.ts` reuse a cached Fastify application and database connection pool across warm invocations within an execution environment. To avoid exhausting connection limits across concurrent serverless instances, the database pool is restricted to a maximum of 2 connections (`max: 2`).

Each warm invocation pings the database before handing off its HTTP request. Initialization, health checks and teardown share one serialized lifecycle, including direct harness calls, so concurrent invocations cannot create duplicate pools or let an old failure close a replacement. An idle PostgreSQL connection error removes that client from the pool without exposing its raw error; the next query can reconnect. If a health probe fails, that invocation receives the fixed, credential-free 500 response, and the app, owned Redis connection and pool are released before the next call attempts initialization. Startup failures at schema admission, privilege admission, server construction or readiness also release their owned resources.

The cache belongs to one execution environment; separate serverless instances each have their own two-connection budget. `closeApp()` provides an explicit restart boundary for the harness and drains pending initialization before disposal. No platform shutdown callback is assumed. Run `npm run test -- test/unit/serverless-lifecycle.test.ts` for overlap/failure fixtures and, after migrating a dedicated local `TEST_DATABASE_URL`, `npm run test -- test/integration/serverless-lifecycle.test.ts` for repeated restart, pool limits, real read-only grants and terminated-idle-connection recovery.

Background processes must be disabled in serverless functions: `INDEXER_ENABLED=false`, `RAILS_ENABLED=false`, and `KEEPER_ENABLED=false`. Furthermore, database credentials must use `HYPERION_DATABASE_ROLE=read-only`.

## What establishes status

Stellar router events establish source transfers and claim changes. The EVM watcher indexes configured Hyperion routers with confirmation and reorg checks. The default record does not deploy an EVM Hyperion router.

For direct Stellar ITS transfers, Axelar's status API supplies a candidate destination transaction. Delivery is recorded only after the destination RPC confirms a successful receipt, sufficient confirmations, the matching ITS command/token/source/recipient/amount event and a matching token payment. The received asset is the ITS representation of Stellar USDC, with seven decimals. A rail API `executed` status alone is not delivery.

For CCTP, Circle's forwarding hash is a candidate only. The backend binds the attested message to the source transfer, then verifies finalized Circle message execution and the exact native-USDC mint to the recipient in a successful confirmed canonical destination receipt. Activity exposes the actual received amount, token and six-decimal precision, separately from the source amount before forwarding fees. After applying `1792800000000_cctp-verification-failure-reasons`, transfer and backlog responses also expose a nullable `verificationFailure` category. Recipient, domain, token and amount mismatches remain distinct; missing evidence stays pending and retryable without consuming the provider failure budget. A category never proves delivery. Provider text is bounded and redacted, and oversized message/signature payloads are omitted. Real acceptance on all three destinations is recorded in `deployments/evidence/2026-10-29-cctp.json` in the contracts repository.

Unknown or unreachable APIs produce errors; there are no fabricated deliveries or fallback attestations. Claims, route health and metrics query the actual migrated schema. Transfer amounts remain base-unit integer strings, with decimals/symbol supplied from deployment metadata when known.

## Rail retry recovery

Rail lookup failures persist a normalized `retry_class` and `next_attempt_at`. Transient failures use capped exponential backoff; rate limits use the provider's retry delay. Permanent failures and transfers that exhaust the configured evidence-failure count are held for operator recovery and are not retried automatically. After correcting the underlying issue and reviewing the source transfer, an operator may explicitly re-enable one transfer with:

```bash
npm run migrate:up
npm run build
npm run rail:requeue -- --transfer-id 123 --reviewed-by operator-name --reason "Provider evidence is now available"
```

Transfers in `failed` or `expired`, or pending/attested transfers held for `permanent`/`exhausted` evidence failures, can be reopened. Each requeue atomically records the prior state, operator and reason. A matching destination delivery or claim blocks requeue, and the original source transfer is never rewritten. Add `--evaluate-now` to make one immediate rail lookup after requeue; otherwise the regular worker picks it up. Provider error text and credentials are not exposed through the public transfer API or retry logs.

Inspect active rail backlog without starting workers or changing lifecycle state:

```bash
npm run rails:backlog -- [--route 0|1] [--destination <chain>] [--stage <stage>] [--retry-class <class>] [--overdue-only] [--limit <n>] [--cursor <token>] [--sort asc|desc] [--format table|json]
```

The report separates provider discovery from destination receipt verification, includes retry class and due state, and uses stable keyset pagination. It runs its database transaction as read-only.

For a read-only source-to-payout audit of direct Axelar ITS transfers, use the reconciliation
command. It joins the indexed source transfer, provider reference and destination proof inside one
repeatable-read transaction; it never calls Axelar, tops up fees or writes state:

```bash
npm run rails:reconcile -- [--transfer-id <id>] [--limit <1..500>]
```

The report distinguishes a missing provider record, provider-only evidence, a missing destination
proof, an amount mismatch and a fully reconciled payout. A provider status is never treated as a
destination payment.

## Protocol fees and claims

The active Stellar router charges 0.3% on outbound USDC and transfers that fee directly to its configured treasury during the source transaction. The backend indexes the recorded source fee; bridge and network fees are separate. Received amounts reflect actual destination payment after forwarding fees.

A claim number identifies funds parked by a destination router after an unsuccessful recipient payout. Successful transfers do not create claims. The claims API exposes actual indexed claims and settlement status. Stellar settlement always pays the recipient recorded on chain.

## Keeper

`KEEPER_ENABLED=true` enables BullMQ jobs for router `keep_alive` and Stellar `settle_claim`. Supply a funded testnet `KEEPER_STELLAR_SECRET` from your secret store to submit them. With no signer, jobs report zero confirmed changes and dry-run status. Secrets are redacted from structured logs.

### Signed transaction checkpoints

Before a signed keeper transaction is broadcast, its hash, intended operation, chain and contract are durably written to `keeper_checkpoint` with state `submitted`. Only a definitive terminal outcome changes the row to `confirmed` or `failed`; ambiguous responses and timeouts remain `submitted` and block new envelopes, so an unknown broadcast outcome can be reconciled by the saved hash before retrying. Recovery never generates a second claim payment attempt blindly, and no secret key or signed credential material appears in logs.

PostgreSQL serializes submissions across replicas sharing a signer. Keep at least two pool connections available: one holds the signer lock while independent journal writes commit before broadcast. The keeper counts confirmations and leaves database claim/delivery changes to indexed events. It does not perform rail second-step delivery or gas top-ups. TTL maintenance covers configured router tokens/routes and recent indexed transfer/claim entries; it is not a guarantee that every adapter or upstream storage entry remains live.

When simulation reports an archived Soroban footprint, the keeper submits the protocol's
`restoreFootprint` operation for that exact footprint. Its signed public hash is journaled under
the `restore` phase before broadcast. An uncertain restore blocks further signing until that
hash is reconciled. After confirmed restoration, the keeper fetches a fresh signer sequence
and simulates the unchanged `keep_alive` or `settle_claim` call again. Claims remain in the
indexed database with their original recipient and amount; no database `archived` flag or
router-specific restore method is assumed. A footprint still requiring restoration after this
bounded attempt fails explicitly.

### Reconciliation test tooling

`test/tooling/proof-corpus.ts` runs independent mutations through the real CCTP and ITS
receipt verifiers and records each mutation, expected outcome and observed verifier result.
Recipient, amount, token, domain and canonical block hash mutations must be rejected;
unrelated receipt logs must preserve a valid proof. Mock provider exceptions fail the harness.

`docs/api-response-contracts.json` publishes the required transfer and claim response shapes.
`test/tooling/api-contract.ts` validates actual Fastify responses against those shapes and
compares recorded fixtures across versions, including nested field removal, integer-string
coercion, token identity changes and additive metadata.

With a dedicated migrated `TEST_DATABASE_URL`, `test/integration/load-benchmark.test.ts`
creates deterministic 32- and 512-transfer histories through the actual ingestion writers,
including pending/attested proof states, delivered rows and canonical replay. It emits
`HYPERION_DATABASE_BENCHMARK` reports with ingestion/scan timings, query costs, buffer counts
and `EXPLAIN ANALYZE` plan nodes. Bounds are regression limits on these fixtures, not a
production throughput guarantee. The suite refuses to substitute an empty database query
for a seeded history.

## API and checks

- `GET /health`, `GET /ready`
  `GET /health` reports hosting environment, database role, a stable public configuration digest
  (`configDigest`) and effective-setting provenance (`configProvenance`). The report uses selected
  deployment routers and per-chain commits, with safe names for conflicting overrides.
  `DEPLOYMENT_REVISION` is an expected Git commit and never replaces the selected deployment
  record. Endpoints are reported only as omitted values and their source; database credentials,
  signer material, host/path/process identity and arbitrary metadata are excluded. The digest
  covers public effective settings and selected deployment identities, excluding endpoint
  credentials, diagnostic-only overrides and tuning for disabled workers. Equivalent explicit
  defaults and reordered JSON targets therefore share a digest. Provider health does not
  establish destination delivery.
- `GET /v1/transfers`, with sender/recipient/chain/route/search/limit/offset filters. Responses
  also include an opaque `nextCursor`; pass it back with the same filters for stable keyset
  pagination. Cursors are scoped to the descending transfer-id order and reject mismatched filters.
- `GET /v1/transfers/by-tx/:txHash`, `GET /v1/transfers/:originChain/:nonce`
- `GET /v1/claims`, `GET /v1/claims/:chain/:claimId`
- `GET /v1/routes/health`, `GET /v1/metrics`

Public reads have a ten-second request budget. A client disconnect cancels the in-flight
PostgreSQL query through its `AbortSignal`. The database adapter uses a separate connection with
the same role to cancel the exact active backend, and holds its borrowed connection until cancellation
finishes so a delayed cancellation cannot affect a later request. The statement timeout remains the
server-side safeguard. SSE uses opaque, transfer-scoped full-width history cursors. Reconnection with
`Last-Event-ID` replays committed `rail_transition` events from PostgreSQL, including changes made while
the client was disconnected, then emits the current `transfer_update` snapshot. Replay is bounded to
100 transitions and cursors expire after 15 minutes. Invalid, expired or oversized replay windows return
`409 cursor_expired` with `resync=true`; reconnect without the cursor. Slow clients wait for socket drain
within a bounded budget, and disconnected clients stop polling.

`npm run check` runs formatting, lint, type checking and tests. Schema/API regressions execute repository migrations in embedded PostgreSQL (PGlite). The full PostgreSQL integration suite requires `TEST_DATABASE_URL`; it is skipped when unset. Use `npm run build` for emitted production code.

RPC event retention is finite. A fresh deployment record may predate the public RPC's retained history; initialize `STELLAR_START_LEDGER` within retained history only if you accept that older events are unavailable, or use a historical provider. Check readiness and logs rather than treating an empty database as complete history.

## Verified testnet status

As of October 29, 2026, the public API and scheduled indexer use persistent Neon PostgreSQL. The verified database retained 10 delivered testnet transfers. The [successful indexer run](https://github.com/StellarHyperion/stellarhyperion-backend/actions/runs/40882312116) advanced its stored Stellar cursor and preserved transfer history after shutdown. These are recorded verification results; current freshness is available through `/v1/metrics`.

Signed source transactions and independently checked destination payments are published in the contracts repository's [paid ITS evidence](https://github.com/StellarHyperion/stellarhyperion-contracts/blob/main/deployments/evidence/2026-10-28-paid-its.json), [XLM conversion evidence](https://github.com/StellarHyperion/stellarhyperion-contracts/blob/main/deployments/evidence/2026-10-29-conversion.json) and [CCTP evidence for all three destinations](https://github.com/StellarHyperion/stellarhyperion-contracts/blob/main/deployments/evidence/2026-10-29-cctp.json).

The [October 29 CI run](https://github.com/StellarHyperion/stellarhyperion-backend/actions/runs/40881373948) passed formatting, lint, types, the production build and all 220 tests. `npm audit` reported zero known vulnerabilities after compatible locked HTTP redirect and test-tooling patches. These results cover dependency and regression checks; they are not a formal security audit.

MIT.

Rail workers claim one transfer inside a PostgreSQL transaction using `FOR UPDATE SKIP LOCKED`, so another replica skips active polling. Source identity, verified delivery and the retry schedule commit together. Aborted polling rolls back. Transient and rate-limit attempts have a separate durable counter and do not exhaust the permanent/evidence failure budget; explicit Retry-After delays are respected.

### Router-scoped source identity

Outbound nonces are unique within an emitting router. Numeric transfer IDs remain stable;
responses include `origin.router` (null for legacy rows whose deployment is not yet proved).
A chain/nonce detail lookup returns 409 when more than one deployment used the nonce.
Use the source transaction or numeric ID to disambiguate. Receipt verifiers bind destination
evidence to the exact source row. Unbound legacy evidence is joined only for an unambiguous
source nonce; provider status cannot select a deployment or establish delivery. Historical
rows acquire their router during exact source-event replay without changing their IDs.

### EVM historical jobs

Use `npm run evm:backfill -- start <operator> <chain> <from> <to>` on a trusted
local machine with database access. The returned job ID supports `resume` and
`cancel` commands with the same operator. Owner is audit metadata, not HTTP
authentication. The public API exposes only bounded job status reads.

Jobs commit range progress in the same PostgreSQL transaction as their events.
Stopping the process rolls back its unfinished range; resume uses the saved
next block without moving the live cursor. Ranges stay below the configured
confirmation line, at most 100000 blocks per job and one configured log page
per transaction. Active jobs are limited to 100 and terminal history to 1000.
Live and historical ingestion share durable event identity and serialized
materialization, including route-health observations. Provider errors are
reported with fixed public messages; inspect secure local provider logs when
reviewing a failed job.

## EVM scan finality and historical audits

EVM watcher ownership is scoped to the chain and router. An expired owner may be replaced after a crash, and each cursor commit verifies ownership and its previous revision in the same transaction as event writes. Concurrent replay keeps the existing canonical event serialization and quarantine checks.

Unsupported EVM signatures and malformed payloads retain canonical block hashes, signature,
router and up to 64 KiB of raw data in the existing quarantine (at most 1000 records per chain).
Oversized bodies retain metadata and topics without a raw body. After deploying a decoder that
supports the event, use `npm run evm:quarantine -- replay <configured-chain> [limit 1..100]`
with a configured router and database writer credential. Legacy diagnostics without raw data
are preserved but cannot be replayed. Replay verifies the chain, deployment start, confirmed
boundary and retained block hash, and uses the normal idempotent writers without advancing
the live cursor. A replayed BridgeIn reconstructs its canonical transaction's ClaimParked
context within a total 1000-log budget; missing or unsupported context requires operator review.
No Hyperion EVM router is configured in the active deployment; the command does not infer one.

`EVM_FINALITY_MODE=confirmations` preserves the chain registry's confirmation depth. Set `EVM_FINALITY_MODE=finalized` to require the RPC's finalized-block number and hash as additional evidence; scans never exceed either that block or the configured confirmation boundary. Unsupported tags fail the pass unless `EVM_FINALITY_ALLOW_FALLBACK=true` explicitly permits depth fallback. Invalid finalized evidence fails even with fallback enabled. `evm_scan_provenance` retains the configured policy, actual evidence, hashes and policy transitions for each committed range; weaker policies never rewrite earlier evidence.

Scheduled route-health compaction removes bounded batches of old interior duplicates and skips rows locked by ingestion. It retains the first and last samples of each configuration run, every transition, and all samples in the recent retention window. Historical `route_health` queries therefore represent state transitions after compaction; they must not treat old row counts as raw sampling frequency or uptime percentages. Recent raw samples remain available within the configured retention window.

`Database.auditTransferAndClaimInvariants()` reads source amount equations, claim liabilities and actual destination-delivery evidence. Its monetary values remain integer strings, and violations identify source row IDs and routers. Delivery joins use the bound source transfer or an unambiguous legacy hop; a reused deployment nonce cannot prove delivery for another source row.

## Metadata versions, request budgets and durable freshness

Public transfer, claim and route responses default to schema `1.0` and retain their legacy shape.
Request `X-API-Schema-Version: 1.1` (or `schemaVersion=1.1` for EventSource) to receive the
`schemaVersion` and `metadata.source=indexed_postgres` envelope. Monetary and token identity
fields are identical in both versions. Unsupported versions return 400 with the supported list.
Versioned responses carry distinct ETags and vary on `X-API-Schema-Version`.

Production API requests default to 120 requests per client per minute, with 20 SSE connections
per minute. `/health` and `/ready` probes, including query-bearing probes, are exempt;
operational metrics and backfill inspection use the ordinary budget. `buildServer` accepts a
bounded `rateLimit` policy and explicit `trustProxy` configuration. Forwarded client headers
are ignored by default; production proxy trust should name the validated proxy addresses.
When `REDIS_URL` is configured, both continuous and serverless API entry points connect
with bounded command/connect timeouts; an injected ioredis client shares counters across replicas using the same key prefix; without
one the bounded cache is local to that process. Redis errors fail requests closed and expose
only the generic internal error. 429 responses include `Retry-After` and `retryAfterMs`.

Background chain and rail workers persist heartbeats after every completed or failed poll,
including the actual cursor and consecutive failures. Worker IDs are limited to 128 safe
characters; diagnostic text and nested metadata are bounded and redact credentials. Older
writes cannot overwrite newer activity. `/ready` degrades missing configured chain-worker
heartbeats and timestamps older than 120 seconds, invalid timestamps, or timestamps over 30 seconds
in the future. A healthy database or a local ready report cannot mask stale persisted activity.
API replicas with indexing disabled still report the durable heartbeats present in PostgreSQL.

`Database.computeHistoryDigest`/`recordHistoryDigest`/`verifyHistoryDigest` cover indexed
outbound transfers, inbound deliveries and claims linked to a delivery within the requested
inclusive block range. Exact integer strings and deployment/source identities contribute to
the SHA-256 digest; surrogate row IDs, observation times and API presentation do not.
Rows are read in deterministic pages of 1,000 under a repeatable-read snapshot. A plain
`Queryable` must already provide snapshot isolation when used concurrently with ingestion.
Unlinked claims are outside a block-range digest because they have no delivery block evidence.

## Freshness targets and deployment readiness

`/v1/metrics` now reports `freshnessSlo` using persisted source cursors/history gaps and
source-bound destination delivery or settled-claim evidence. A parked delivery or provider
status alone cannot settle a backlog entry. Ambiguous legacy hops remain pending.
Every report identifies the source-scan or destination-proof stage, its chain/lane and target.
Missing or invalid/future cursor timestamps produce `unknown` with `met=false`; open and
reconciling history gaps breach source progress. API-only processes evaluate remote durable
history. Other deployment modes with indexing explicitly disabled label source monitoring
`disabled` rather than presenting an absent watcher as healthy.

Defaults are 120 seconds for source scan lag, 100 pending proofs per lane and 15 minutes for
oldest proof age. Set `FRESHNESS_MAX_SCAN_LAG_MS`, `FRESHNESS_MAX_PROOF_BACKLOG_COUNT`,
`FRESHNESS_MAX_PROOF_BACKLOG_AGE_MS` and optional JSON `FRESHNESS_LANE_TARGETS` to override them.
Lane keys use `origin->destination`, with `maxSourceScanLagMs`, `maxProofBacklogCount` and
`maxProofBacklogAgeMs`. The strictest configured lane scan target applies to its origin.

`DEPLOYMENT_MODE` accepts `all-in-one`, `api-only`, `indexer-only`, `keeper-only` or `custom`;
component flags determine the default mode. `READINESS_DB_POLICY`, `READINESS_INDEXER_POLICY`,
`READINESS_RAILS_POLICY` and `READINESS_KEEPER_POLICY` accept `required`, `optional` or
`disabled`. Required dependencies without readiness evidence are down. Required down
returns 503; stale/degraded evidence remains visible as degraded. Optional down degrades
without returning 503. Disabled checks explicitly carry `effectiveState=disabled` and do not
certify absent workers. `/ready` includes the resolved mode and dependency policy.

## Database telemetry and diagnostics

`/v1/metrics.database` reports pool active/idle/queued connections, saturation and latency/error
counts by a fixed set of workload labels. Ingestion writes and API reads have separate labels.
Each workload retains at most 256 recent latency samples by default (configurable 1–4096 via
`Database.open`); SQL text, parameters and wallet identifiers are never retained in telemetry
or slow-query messages. Saturation is visible while requests queue, before a timeout.

Run `npm run diagnostics -- --output diagnostics.json` to collect configuration presence,
migrations/table counts, persisted worker freshness, source revisions, proof backlog and local
pool telemetry. `--compact` emits compact JSON; without `--output`, the bundle goes to stdout.
Every database connection enforces read-only statements. Failed probes retain normalized
codes and actionable descriptions, so unavailable data is distinguishable from empty history.
The bundle records its generation time and the code revision (`HYPERION_REVISION`, `GITHUB_SHA`
or the local Git HEAD when available). URLs, nested authorization/signers and other sensitive
values are redacted. Output files are created exclusively with mode 0600; choose a new filename
for each capture. No RPC polling, transactions or wallet operations are performed.

### Backup and restore rehearsals

`npm run rehearsal -- rehearse --output snapshot.json` exports the indexed history tables from
`DATABASE_URL` (read-only), restores them into the dedicated database named by
`HYPERION_REHEARSAL_DATABASE_URL`, and validates the result. `export`, `restore` and `validate`
run the steps separately. Every value travels as PostgreSQL text, so full-width identifiers and
integer-string amounts round-trip exactly. Validation recomputes row counts, the per-chain
monetary history digests and a cursor/provenance join fingerprint, and fails on any difference,
including a change in the number of dangling provenance links. The target must be migrated to the same schema version, must be empty, and
must not be the source. A target provisioned as `production` or `preview` is refused unless both
`--allow-protected-target` and `HYPERION_REHEARSAL_ALLOW_PROTECTED=true` are set. Snapshots
hold rows and digests only, never connection strings, are capped at 100,000 rows per table, and
carry a SHA-256 so a modified file is refused.

### Rail transition history and transfer cursors

`rail_attestation_history` records actual committed lifecycle changes bound to the source transfer
id, including changes made by reviewed requeue and destination-proof reorg reconciliation. Identical
polls create no duplicate entry. Blind backward writes are rejected; repeated real requeue cycles
retain every transition. History records normalized reasons and bounded public hashes/references,
without provider response bodies or error credentials.

`GET /v1/transfers` returns `nextCursor` for descending transfer-id pagination. Pass it as `cursor`
with the same origin/destination/route/sender/recipient/search filters; changing filters or combining
a cursor with a nonzero offset returns HTTP400 `invalid_cursor`. New inserts sort before the cursor
and cannot duplicate an already read transfer. Existing offset reads remain available and keep
their response offset field. A full page can return a cursor whose next page is empty.

### Keeper outcomes and signer rotation

Keeper maintenance records separate simulated, submitted, pending, confirmed and failed outcomes
in `keeper_submission`. `/v1/metrics` returns aggregate counts without transaction-hash labels;
public hashes are retained for recovery. API readers require SELECT on `keeper_submission`
and `keeper_checkpoint` after migration179310. Dry runs never count as confirmed maintenance.

Configure `KEEPER_STELLAR_SECRETS` as the comma-separated local signer secret sources and
`KEEPER_STELLAR_ACTIVE_SIGNER` as one configured public key. Startup verifies the account's
Stellar network and positive balance, then reconciles up to100 old pending public hashes before
changing persistent signer ownership. Unknown outcomes block rotation. The same chain ownership
lock protects submission, and old replicas refuse preparation after ownership changes. Every
maintenance signing attempt rechecks funding/network and current ownership. Signer rotation
changes the fee payer; router claim payout recipients remain fixed by the contract. Public
readiness exposes the funded public key and integer-string balance in logs; private provider
errors are replaced by bounded readiness reasons.

### Read-only ITS source-to-payment audit

`npm run rails:reconcile -- --transfer-id <id> --limit <1..500> --format json` reads one
repeatable, read-only database snapshot and never contacts providers or performs top-ups.
The report joins the exact source transfer, provider discovery reference and persisted canonical
ITS command/token-manager/payment proof. Reconciled rows require the verified public source
snapshot and matching destination chain, command, transaction, recipient, token and integer
amount. Migration179320 adds nullable source bindings; legacy proofs without that snapshot are
reported as `missing_source_binding`. Missing backend history and missing canonical proof are
reported explicitly. Source changes during verification are rejected before proof admission.
Recoverable provider gas errors remain retryable and cannot by themselves establish payment.

### Public API error compatibility

JSON errors retain their existing `error`, status code and route-specific fields. The additive `code` is one stable category: `bad_request`, `not_found`, `timeout`, `unavailable`, `internal_error` or `too_many_requests`. Clients can migrate to `code` while existing clients continue reading `error`. Errors include a safe message and request ID; empty indexed history remains HTTP 200 with an empty page. SSE resync frames retain their existing event contract.

ITS verification stores at most six bounded public mismatch categories and an independent `its_verification_state`: `receipt_unavailable` leaves verification retryable, `payout_unverified` records invalid receipt/payment evidence, and `verified` requires the exact canonical ITS event and matching ERC-20 payment. Unrelated events in the same transaction do not invalidate an exact pair. Diagnostics never establish delivery.

The PostgreSQL upgrade fixture starts with representative full-width transfer and claim records in the initial schema, then checks identity, monetary constraints and exact source joins after every supported migration. Upgrades run in one transaction with recorded migration history. A simulated failing monetary step verifies both data and the history boundary roll back; after repairing that step, retry applies it once and repeated migration runs preserve the same rows. Inspect the migration history and failed step before retrying an interrupted production upgrade.

Transfer responses expose typed source and destination provenance with chain, transaction, canonical indexed block height and log index. Destination provenance is `unverified` until independent delivery is recorded. Rail references are explicitly labeled `candidate` and remain sanitized. Claim source provenance uses the exact source-transfer foreign key; ambiguous legacy deployment nonces return no source provenance. Combined transfer filters validate canonical account/address formats, the selected network, configured source asset/adapter support and direct destination rail support before issuing parameterized SQL. EVM recipients accept canonical20-byte or zero-padded32-byte addresses; direct CCTP/ITS destinations do not require a Hyperion EVM router.

### Historical coverage metrics (#112)

`GET /v1/metrics` retains `historyGaps` and adds version 1 `historicalCoverage`, separate from
current cursor lag. One PostgreSQL statement reads unresolved counts, remaining ranges, and
source observation status, so a concurrent backfill cannot mix an old count with a new range.
Each `sources` entry reports its chain and family, unresolved range records, exact integer-string
`oldestMissingStart`/`oldestMissingEnd`, and `unknown` status. A recent cursor cannot hide an older
retention gap. Partial Stellar replay advances the first missing ledger; reconciliation removes
the record. EVM queued/running/failed/cancelled declared backfill intervals remain missing from
`next_block` through `to_block` until their range is fully scanned. Overlapping gap/job records
are counted as records, not as a union of unique missing blocks.

The retained `oldestMissingStartLedger` and `oldestMissingEndLedger` fields summarize Stellar
ranges; EVM block ranges use the per-source fields. Global `unresolved` includes both families.
`scope: recorded_ranges` means recorded watcher/backfill history, not universal blockchain
coverage. No cursor, no committed scan provenance, an incomplete deployment replacement, or
missing schema keeps historical coverage explicitly unknown. Schema-unavailable unresolved
counts are null. Zero recorded gaps alone does not establish known history. These diagnostics
are read-only and do not establish transfer delivery or activate an EVM router.

### Proof rejection metrics (#109)

`GET /v1/metrics` exposes the fixed categories `recipient`, `token`, `amount`, `finality`, and
`provider_inconsistency`. `proofRejections` sums current unresolved CCTP/ITS verification reasons
and durable unreconciled ingestion records. `proofRejectionsByRail` uses the same vocabulary for
both rails; `proofRejectionIngestion` separates structural decoder/ordering failures. These are
current reason gauges, not successful delivery counts or monotonic attempt counters. One ITS
transfer can contribute to several distinct mismatch categories, once per category. Rechecking
an unchanged failure does not increment the gauge; canonical verified proof clears its reasons.

CCTP recipient/destination-domain mismatches map to recipient, token/messenger/source-adapter
mismatches to token, amount/fee mismatches to amount, and finality/receipt/confirmation failures
to finality. Other identity/message/provider failures map to provider inconsistency. ITS retains
recipient/token/amount diagnostics, maps unavailable receipts to finality, and maps missing
payment/source/command evidence to provider inconsistency. Source decode/ordering rejections
are provider inconsistency. Prunable raw quarantine rows are not counted again alongside their
durable ingestion rejection. Provider success alone never establishes destination delivery.

`proofRejectionCoverage` is version 1 and reports availability of each source. A missing table or
column on an older deployment sets `known: false`, while retaining counts from available sources;
zero counts with unknown coverage are not evidence of zero failures. Other database errors fail
the request. SQL returns only bounded categories and exact safe counts; raw hashes, addresses,
provider messages, expected/observed diagnostics, endpoints, and credentials never become labels.

### Durable worker run correlation

Each indexer build has a generated execution UUID shared by its source and rail workers; each worker also has a distinct run UUID. Before a poll begins, `indexer_worker_run` records a running, partial job. Successful polls that still made progress remain partial; only a poll returning no eligible work records `caught_up`. Failure or interruption records `failed` or `stopped`. A killed process leaves its last running record visible, and a replacement process creates new identities without overwriting that history. A caught-up poll describes that worker's eligible queue at that time and cannot establish destination delivery.

Migration `1793700000000_worker-run-correlation` adds the history table and nullable run references to Stellar scan journals, EVM scan provenance and rail transition history. `Database.transaction` binds the internal worker context with a parameterized, transaction-local setting; insert triggers record the reference in the same commit as the evidence. Rollback removes both evidence and links, and pooled connections clear the setting at transaction end. Existing records remain uncorrelated. Apply migrations and grant the API reader SELECT on `indexer_worker_run` before restarting a reader; no monetary precision, replay identity, delivery predicate or claim ownership changes.

`/ready` and `/v1/metrics` expose at most 100 durable recent worker runs, safe UUIDs, partial/completed status, integer-string counters and correlated scan/verification-transition counts. Legacy heartbeats without a valid run UUID or an explicit caught-up observation remain unverified/partial. No provider URLs, raw metadata or credential-bearing IDs are included in this projection. Scheduled catch-up and process startup logs carry the execution UUID. Run the focused unit and dedicated PostgreSQL `worker-run-correlation.test.ts` suites plus the full check/build before deployment.
