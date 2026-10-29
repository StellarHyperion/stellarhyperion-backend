# Hyperion backend

[App](https://stellarhyperion.vercel.app/) | [Public API health](https://stellarhyperion-backend.vercel.app/health) | [Contracts and deployment evidence](https://github.com/StellarHyperion/stellarhyperion-contracts)

Indexes Hyperion contract events, serves public transfer/claim history, polls rail status and optionally submits Stellar maintenance transactions. The checked-in deployment is the Stellar Testnet router. Active routes deliver Stellar USDC through Axelar ITS to Ethereum Sepolia, or through Circle CCTP to native USDC on Ethereum Sepolia, Base Sepolia and Arc Testnet. The frontend can first convert other liquid classic Stellar assets into USDC. The wallet-owned deployment is active; signed deployment and successful transfer evidence are described in the contracts repository's `docs/TESTNET_ACTIVATION.md`.

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

Run the watchers and rail pollers in a continuous process or in regular scheduled catch-up windows. Deploying only `api/index.ts` provides reads from an existing database; it does not run indexing in the background. Set the frontend's `NEXT_PUBLIC_HYPERION_API_URL` to this service's origin. Public API reads support cross-origin GET requests.

## Deploy on Vercel

The `hyperion-backend` Vercel project serves [stellarhyperion-backend.vercel.app](https://stellarhyperion-backend.vercel.app). Configure its production `DATABASE_URL` through Vercel environment variables with a managed PostgreSQL connection and TLS. Keep the value server-side. Redis and signing keys are unnecessary while `KEEPER_ENABLED=false`.

`vercel.json` includes the deployment metadata in the API function. Production indexing runs in [the testnet indexer workflow](.github/workflows/indexer.yml), independently of requests to the API. Store the same database connection as the repository Actions secret `HYPERION_DATABASE_URL`. Each run applies pending SQL migrations and runs the real indexer and bridge pollers for 150 seconds, with graceful shutdown and a persisted PostgreSQL cursor. The concurrency group prevents overlapping hosted jobs. No signer is configured.

The workflow is scheduled every five minutes and can be started manually. GitHub may delay scheduled runs; public Activity is eventually updated rather than an instant destination feed. Inspect its latest run and `/v1/metrics` cursor timestamps to check freshness. API `/ready` verifies its database access; the serverless API does not run chain watchers itself. The optional Dockerfile packages the same service for an always-running container host.

Deploy the API with `vercel deploy --prod`. Preview environments require their own database. Database credentials stay in Vercel and GitHub secrets, never in browser configuration, Git or logs. The managed PostgreSQL database is the durable state; restarting a worker must not repeat source transfers.

Vercel's installed Git integration publishes `main`. GitHub Actions runs validation and the scheduled indexer; it does not need a Vercel deployment token.

## What establishes status

Stellar router events establish source transfers and claim changes. The EVM watcher indexes configured Hyperion routers with confirmation and reorg checks. The default record does not deploy an EVM Hyperion router.

For direct Stellar ITS transfers, Axelar's status API supplies a candidate destination transaction. Delivery is recorded only after the destination RPC confirms a successful receipt, sufficient confirmations, the matching ITS command/token/source/recipient/amount event and a matching token payment. The received asset is the ITS representation of Stellar USDC, with seven decimals. A rail API `executed` status alone is not delivery.

For CCTP, Circle's forwarding hash is a candidate only. The backend binds the attested message to the source transfer, then verifies finalized Circle message execution and the exact native-USDC mint to the recipient in a successful confirmed canonical destination receipt. Activity exposes the actual received amount, token and six-decimal precision, separately from the source amount before forwarding fees. Real acceptance on all three destinations is recorded in `deployments/evidence/2026-10-29-cctp.json` in the contracts repository.

Unknown or unreachable APIs produce errors; there are no fabricated deliveries or fallback attestations. Claims, route health and metrics query the actual migrated schema. Transfer amounts remain base-unit integer strings, with decimals/symbol supplied from deployment metadata when known.

## Protocol fees and claims

The active Stellar router charges 0.3% on outbound USDC and transfers that fee directly to its configured treasury during the source transaction. The backend indexes the recorded source fee; bridge and network fees are separate. Received amounts reflect actual destination payment after forwarding fees.

A claim number identifies funds parked by a destination router after an unsuccessful recipient payout. Successful transfers do not create claims. The claims API exposes actual indexed claims and settlement status. Stellar settlement always pays the recipient recorded on chain.

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

As of October 29, 2026, `npm audit` reports zero known vulnerabilities after compatible locked HTTP redirect and test-tooling patches. The verification suite passes all 220 tests.
