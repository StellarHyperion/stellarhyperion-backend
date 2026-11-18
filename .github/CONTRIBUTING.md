# Contributing to Hyperion Backend

Hyperion backend indexes cross-chain transfers between Stellar and EVM chains, polls rail
attestation APIs, runs on-chain keeper upkeep jobs, and exposes transfer queries via REST.

## Issue assignment requirement

Request assignment from a maintainer before opening a pull request. Reference the issue in
the PR title or description, preferably with `Closes #42`. You must be a current assignee
on every referenced issue in the StellarHyperion organization. Local issue numbers,
`StellarHyperion/repository#42`, full GitHub issue URLs, and GitHub's linked closing issues
are supported. References inside HTML comments and fenced examples do not count.
Descriptions pasted entirely inside a code fence are read as PR descriptions.
References to other pull requests or issues outside StellarHyperion do not grant eligibility.

The `PR assignment enforcement` action closes unauthorized PRs and PRs without a referenced
issue. It sweeps all open PRs every five minutes and runs when an issue is assigned or
unassigned. GitHub may delay scheduled runs. Reopened and edited PRs are included in the
next sweep. Closing a PR leaves its issue open and never merges its changes. Ask for
assignment before reopening a rejected PR.

Organization owners and members, repository collaborators, users with admin, maintain,
write, or triage permission, and users named in the default branch's CODEOWNERS are exempt.
Team code owners qualify through organization membership. Public read access and previous
contributions alone do not grant an exemption.

Trusted helper bots are Dependabot, Renovate, GitHub Actions, GitHub Copilot, and CodeRabbit.
Maintainers can add other exact bot or service account logins to the comma-separated
repository Actions variable `PR_ASSIGNMENT_HELPER_BOTS`. An unknown bot still needs issue
assignment unless it qualifies through a repository role or code ownership.

The action uses GitHub's built-in token and only executes the policy on the default branch.
It never checks out a PR branch. API verification errors preserve affected PRs and fail the
workflow for maintainer review. No personal access token is needed in Actions. The action
records its decisions in the run log and summary. Use its manual `dry_run` input to inspect
decisions without closing PRs.

Policy regression tests also run in the required contribution security job. Run them locally:

```bash
python3 -B .github/scripts/test_enforce_pr_assignments.py
```

## Prerequisites

- Node.js >= 20.11
- Docker and Docker Compose (or local Postgres 16 and Redis 7 instances)
- Built protocol package at `../contracts/packages/protocol`

### Protocol package dependency

The backend depends directly on `@hyperion/protocol` via local file path:

```bash
cd ../contracts/packages/protocol
npm install
npm run build
```

The protocol package contains shared codecs, chain registry definitions, ABIs, and deployment records.
Never vendor protocol definitions or redefine protocol types locally in the backend codebase.

## Local environment setup

Start local backing services using Docker Compose:

```bash
cd backend
docker compose up -d
```

The compose file starts:

- PostgreSQL on port 5433 (user: `hyperion`, database: `hyperion`, test database: `hyperion_test`)
- Redis on port 6380

Run database migrations:

```bash
DATABASE_URL=postgres://hyperion:hyperion-local-only@127.0.0.1:5433/hyperion npm run migrate:up
DATABASE_URL=postgres://hyperion:hyperion-local-only@127.0.0.1:5433/hyperion_test npm run migrate:up
```

## Running checks and test suites

All checks must pass before opening a pull request:

```bash
# Code style and formatting
npm run fmt:check

# ESLint checks
npm run lint

# TypeScript compilation check without emitting files
npm run typecheck

# TypeScript build
npm run build

# Unit and integration test suites against live Postgres
TEST_DATABASE_URL=postgres://hyperion:hyperion-local-only@127.0.0.1:5433/hyperion_test npm test
```

## Architectural conventions

These conventions are settled and strictly followed across the backend:

1. Hand-written SQL and node-pg-migrate:
   No ORMs (Prisma, TypeORM, Drizzle) are permitted. We use explicit SQL migrations with descriptive comments on every column and table.
2. Arbitrary-precision numbers:
   All token amounts are stored as `NUMERIC(78,0)`. Unsigned 64-bit integers (e.g. nonces, timestamps) are stored as `NUMERIC(20,0)` because Postgres signed `bigint` overflows at 2^63 - 1.
3. Centralized chain writing:
   All event writes pass through `src/chains/writers.ts`. Event mappers (`stellar/store.ts`, `evm/store.ts`) transform chain logs into typed writer payloads. This guarantees cross-chain consistency and constraint enforcement.
4. Watcher idempotency:
   Watchers must be idempotent over block and ledger ranges. Inbound and outbound records use `ON CONFLICT DO UPDATE` while preserving original `observed_at` timestamps.
5. Watcher readiness:
   When an external RPC becomes unavailable, the corresponding chain watcher reports status `degraded`, never `down`. The global `/ready` endpoint reports the worst status among subsystems, and an outage on one chain must not cause the replica to fail health checks for unaffected chains.

## Commit guidelines

Commits in this repository follow strict identity requirements:

- Committer identity: `dotmantissa <negativemantissa@gmail.com>`.
- Commit trailers (e.g. `Co-Authored-By`, `Signed-off-by`, or generator annotations) are forbidden.
- Use imperative, concise commit summaries describing the technical change.
