# Contributing to Hyperion Backend

Hyperion backend indexes cross-chain transfers between Stellar and EVM chains, polls rail
attestation APIs, runs on-chain keeper upkeep jobs, and exposes transfer queries via REST.

## Development waves and pull request target

`dev` is the default branch. Create feature branches from the latest `origin/dev`
and open contributor pull requests against `dev`:

```bash
git fetch origin
git switch -c feature/my-change origin/dev
# Make and commit the change, then push the feature branch.
git push -u origin feature/my-change
gh pr create --base dev
```

Keep your branch updated with `origin/dev` before automatic merging. Issue assignment,
PR descriptions and contribution security remain required. `dev ci` checks formatting,
lint and types; the contracts repository also checks Rust and Solidity formatting.
It omits production builds, integration suites, CodeQL and deployment rehearsals.
Passing these fast checks permits integration into the contributor wave, not release.
The required `dev gate` check is distinct from main's full `gate`, so a fast
development result cannot satisfy main promotion protection.
The bot verifies `dev-ci.yml`; historical or optional `ci.yml` results belong to main
promotion. Failed dev checks and other workflows or external checks still block it.

When a wave is complete, maintainers open a promotion PR from `dev` to `main`:

```bash
gh pr create --base main --head dev
```

`ci.yml` runs the existing full correctness, build, test and security pipeline for
that promotion. Maintainers review correctness, security, migrations and deployment
behavior, then merge manually with a merge commit. The auto-merge bot handles only
`dev`. After promotion, merge the updated `main` back into `dev` so future feature
branches include the release history. Automatic issue completion on `dev` records
integration of an assigned issue; it does not assert that the wave has been released.

The default-branch scheduler dispatches `indexer.yml` on `main`. The indexer still
requires successful full main CI and uses the existing main-only environment; dev
code never receives its runtime credentials.

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

Run the fast checks before opening a pull request; run the full suite before main promotion:

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

## Locked dependency audits

CI checks every committed npm lockfile version, including development and optional
dependencies, with npm's official Bulk Advisory endpoint and blocks high or critical
active advisories. No package scripts execute during the audit.
The audit verifies each finding against GitHub's canonical advisory API. A finding
is removed only when GitHub confirms that advisory was withdrawn; API errors,
incomplete evidence, and active findings remain blocking. This handles stale npm
reports without a repository allowlist or disabling security checks.

Run the audit and its regression tests locally:

```bash
python3 -B .github/scripts/test_audit_npm_dependencies.py
python3 -B .github/scripts/audit_npm_dependencies.py . --audit-level high
```

An optional `GITHUB_TOKEN` increases the API rate limit. It is sent only to the
canonical GitHub API; npm's advisory endpoint receives no GitHub credential.

Automatic Vercel Git deployments are disabled in `vercel.json` while the hosting
project is paused. Build, test, and security checks continue to run in GitHub Actions.
The Vercel GitHub app no longer has access to this repository because the paused
account reported failed statuses before reading deployment settings. Regrant the
app access and restore `git.deploymentEnabled` when hosting is ready to deploy again.

Manage app repository access in the [organization integration settings](https://github.com/organizations/StellarHyperion/settings/installations).

## Automatic pull request checks

CI runs on opened, updated, reopened, and edited pull requests, including changes
from draft to ready for review. `Automatic PR CI` responds to those PR events
without waiting for a scheduled sweep. It authorizes waiting fork CI only when the
author is assigned to every referenced issue, or satisfies a documented trusted
bot, organization-role, or code-owner exemption. Issue-assignment events and the
five-minute scheduled sweep remain recovery paths. GitHub event delivery and runner
availability can still delay execution; conflicted PRs may have no runnable CI.

The approval job uses a `pull_request_target` event restricted to `dev`. It never
checks out a branch, downloads contributed artifacts, or executes PR code. It loads
only default-branch authorization modules through the GitHub API. Only the current
fork head's ordinary `dev-ci.yml` run can be approved. The job waits briefly for a newly
submitted or edited PR's CI run to register, rechecks all issue assignments, and
checks the PR head and description again immediately before approval. It cannot
approve a code review or merge a PR. PR build jobs retain read-only permissions and
receive no deployment or signing secrets.

The workflow-security scan permits the privileged trigger only in this exact,
reviewed approval workflow, pinned by SHA-256 in `scan_workflow_security.py`. A
workflow edit invalidates that exception until its trust boundary is reviewed and
the fingerprint updated. Every other medium/high Zizmor finding, including a
privileged trigger in another workflow, still blocks the gate. Repository ignore
comments and configuration cannot suppress findings.

## PR description requirements

The gate checks human descriptions against `.github/pull_request_template.md` at
the PR's base commit. Keep its level-two sections in order, answer each section,
and retain and select applicable checklist items. If a section does not apply,
write `Not applicable:` followed by the reason. Hidden comments, code examples,
blank answers, and unfilled TODO/TBD placeholders do not satisfy the template.
Description edits rerun CI. This validates the description's structure and
attestations; reviewers still assess whether its claims match the change.

Authenticated `dependabot[bot]` and `renovate[bot]` accounts are exempt only from
description formatting. Their branch-specific checks remain required; full builds and source security run on main promotion.

## Source and dependency security

The main promotion gate includes CodeQL's `security-extended` analysis for
JavaScript/TypeScript and Python, without executing a project build. High and
critical source findings block; all findings are retained as SARIF artifacts for
14 days. The analysis uses read-only permissions and does not require a paid plan
for these public repositories. Existing dependency, secret, workflow and
contract-specific main checks remain required. These tools do not prove that arbitrary
code is free of malware.

For dependency behavior and suspected malware detection, the
[Socket Security GitHub App](https://github.com/apps/socket-security) offers a
[free plan for public repositories](https://socket.dev/pricing). It can identify
known malware, suspicious install scripts, obfuscation, typosquatting, and risky
API usage. Install it through GitHub's app installation screen and select the
three StellarHyperion repositories. Installation is separate from these committed
checks and requires the organization's GitHub browser authorization. This change
does not claim that the Socket app is already installed. Review its first alerts
and check names before making its external check required; do not bypass existing
gates to accommodate an alert.

Run its regression tests locally:

```bash
python3 -B .github/scripts/test_approve_pr_ci.py
```

## Test-based automatic merging

`Automatic PR merge` runs after `dev ci` completes, on issue assignment/description changes,
and every 15 minutes as recovery. It has no model, review credits, or daily merge quota.
It merge-commits open, non-draft PRs targeting `dev` only after the current head's newest
CI attempt and every CI job (including `gate`) succeed, every external check/status succeeds,
the head includes current `dev`, and GitHub reports no conflicts. Existing assignment
exemptions and automatic closure of unauthorized contributors are preserved. A PR must still
reference at least one real StellarHyperion issue, and its current description must satisfy
the established template. Dependency bots retain their description-formatting exemption.

Tests and description attestations provide evidence of correctness; this bot does not
independently establish that every referenced issue is semantically resolved. Add acceptance
and regression tests covering the issue's requirements. No model or mandatory approving human
review is used. Existing change requests and unresolved review conversations still block.

When merging is blocked, one bot-owned PR comment explains current blockers and is updated
when they change. Fix failing checks, complete the description, request issue assignment,
resolve conflicts, or update your branch as instructed. CI links identify the failed run;
read its job logs for exact failures. API errors preserve PRs and are retried. Closed PRs
receive no new comments. Scheduled workflows can be delayed by GitHub.

The privileged workflow never checks out or executes PR code, downloads PR artifacts, or
uses caches. It loads policy modules from its immutable default-branch workflow revision.
It verifies PR text/head/base, issue content/assignments, and the latest CI attempt twice,
then checks the head/default branch again and supplies the expected head to GitHub's merge
API. GitHub enforces branch rules at the merge boundary. Changes to `.github/`, CODEOWNERS,
agent instructions or secret-scan suppression files require a maintainer merge so a PR cannot
replace the checks that authorize it. Its privileged trigger has a separately byte-pinned
Zizmor exception; all other security findings still block.

Run `python3 -B .github/scripts/test_auto_merge_prs.py` for regression tests. Dispatch the
workflow with its default `dry_run: true` to inspect eligibility without merges or comments;
set `dry_run: false` to perform the same automatic behavior as event/scheduled runs.

After a verified merge, automatic issue completion requires successful current-head PR CI
and all PR head checks. Each explicitly declared closing reference or development-linked issue must still be assigned
to the original PR author; maintainer roles do not bypass this condition. Only its state and
state reason are updated to `closed` / `completed`. Issue assignees and contributor authorship
are preserved. Already completed issues are left alone. The checkout-free closed-PR trigger
also covers maintainer merges; the seven-day updated-PR sweep retries missed or partial issue
updates. A default-branch ancestry check refuses closed/unmerged PRs or merges into other
branches. Dry runs never merge, comment, or update issues. Cross-repository updates require
issue-write permission in that target repository; failures are reported and retried.
