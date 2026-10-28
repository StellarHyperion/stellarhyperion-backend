# Hyperion backend

Indexes Hyperion contract events, serves public transfer/claim history, polls rail status and optionally submits Stellar maintenance transactions. The checked-in deployment is the Stellar Testnet router. The supported app lane is Stellar USDC to Ethereum Sepolia through Axelar ITS, pending contract activation described in the contracts repository's `docs/TESTNET_ACTIVATION.md`.

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

The SDK is installed from the committed protocol tarball. `npm run dev` does not load `.env` automatically; export the variables first or run `node --env-file=.env --watch --experimental-strip-types src/main.ts`.

A continuously running process must run the watchers and rail pollers. Deploying only `api/index.ts` provides reads from an existing database; it does not run indexing in the background. Set the frontend's `NEXT_PUBLIC_HYPERION_API_URL` to this service's origin. Public API reads support cross-origin GET requests.

## What establishes status

Stellar router events establish source transfers and claim changes. The EVM watcher indexes configured Hyperion routers with confirmation and reorg checks. The default record does not deploy an EVM Hyperion router.

For direct Stellar ITS transfers, Axelar's status API supplies a candidate destination transaction. Delivery is recorded only after the destination RPC confirms a successful receipt, sufficient confirmations, the matching ITS command/token/source/recipient/amount event and a matching token payment. The received asset is the ITS representation of Stellar USDC, with seven decimals. A rail API `executed` status alone is not delivery.

Unknown or unreachable APIs produce errors; there are no fabricated deliveries or fallback attestations. Claims, route health and metrics query the actual migrated schema. Transfer amounts remain base-unit integer strings, with decimals/symbol supplied from deployment metadata when known.

## Keeper

`KEEPER_ENABLED=true` enables BullMQ jobs for router `keep_alive` and Stellar `settle_claim`. Supply a funded testnet `KEEPER_STELLAR_SECRET` from your secret store to submit them. With no signer, jobs report zero confirmed changes and dry-run status. Secrets are redacted from structured logs.

One process serializes its Stellar submissions to avoid sequence conflicts. Run only one active keeper signer process, or give replicas separate accounts. The keeper counts confirmations and leaves database claim/delivery changes to indexed events. It does not perform rail second-step delivery or gas top-ups. TTL maintenance covers configured router tokens/routes and recent indexed transfer/claim entries; it is not a guarantee that every adapter or upstream storage entry remains live.

## API and checks

- `GET /health`, `GET /ready`
- `GET /v1/transfers`, with sender/recipient/chain/route/search/limit/offset filters
- `GET /v1/transfers/by-tx/:txHash`, `GET /v1/transfers/:originChain/:nonce`
- `GET /v1/claims`, `GET /v1/claims/:chain/:claimId`
- `GET /v1/routes/health`, `GET /v1/metrics`

`npm run check` runs formatting, lint, type checking and tests. Schema/API regressions execute repository migrations in embedded PostgreSQL (PGlite). The full PostgreSQL integration suite requires `TEST_DATABASE_URL`; it is skipped when unset. Use `npm run build` for emitted production code.

RPC event retention is finite. A fresh deployment record may predate the public RPC's retained history; initialize `STELLAR_START_LEDGER` within retained history only if you accept that older events are unavailable, or use a historical provider. Check readiness and logs rather than treating an empty database as complete history.

MIT.
