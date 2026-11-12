# Contribution security and deployment controls

CI executes contributor code on fresh GitHub-hosted runners with read-only repository permissions
and no application secrets. Every checkout disables credential persistence. Actions and downloaded
security tools are pinned to reviewed commits/digests; npm installs disable dependency lifecycle hooks.
The normal build, test, and migration commands still execute project code and require review.

The `gate` check includes workflow security analysis, new-commit secret scanning, and dependency
advisory checks. Secret scanning redacts findings and does not accept repository-provided suppressions.
Build jobs block outbound traffic outside their documented endpoint lists and disable sudo/container
access. No executable/compiler caches are shared between jobs. The indexer runtime has its own
network requirements and uses egress monitoring rather than the build endpoint list.

These checks reduce exposure; they cannot establish that arbitrary contributed code is trustworthy.
Review changes to wallet/transaction construction, external requests, scripts, dependencies, SDK
archives, workflow files, and deployment configuration before merge. Inspect new dependency behavior,
not just whether the package has a published vulnerability. Do not auto-merge contributor PRs based
solely on a green build or a Drips bot review.

## GitHub settings

Require the existing `gate` check from the GitHub Actions app, an up-to-date branch, one approving
review, code-owner review, dismissal of stale approvals, approval after the latest push, and resolved
review conversations. Protect workflows, CODEOWNERS, lockfiles, vendored code, and SDK archives.
The trusted owner's existing administrator bypass is retained for owner maintenance; contributors
must not receive administrative access. Require approval before running external-contributor workflows.
Set default workflow permissions to read and disallow Actions approving PRs. Require SHA-pinned actions
at repository level and allow only reviewed action publishers once this workflow update lands.

## Vercel

Vercel Git integration deploys independently of Actions. GitHub environment approvals do not protect
Vercel's own builds. Require deployment checks for `gate`, keep production deployments on reviewed
`main`, require authorization for fork previews, and keep production DB/service/signing credentials
out of preview builds. Configure these settings in Vercel; a YAML change cannot enforce them there.
The committed `.npmrc` also disables dependency hooks in Vercel installs. Review any override of it.

## Backend scheduled runtime

The backend indexer authorizes only the exact main commit with a successful CI gate from the expected
push workflow and repository. It builds without runtime secrets in a separate job, transfers only
`dist`, and installs production dependencies without hooks or build credentials. Only migration and
indexing steps receive the DB URL. Keeper signing remains disabled.

Restrict the `testnet-indexer` environment to the protected main branch. Move its database secret from
the repository secret store to that environment when practical; use a database role limited to the
indexer's schema and migrations. Do not require a human approval every five minutes for the recurring
indexer: merge review plus exact-commit CI authorization protects the routine scheduled run. Initial
migration execution, role changes, and deployment promotion remain maintainer responsibilities.

## Local verification

Use supported Node 22 and `npm ci --ignore-scripts`. Then run the repository's normal checks. Workflow
syntax is checked with actionlint; Zizmor runs offline with medium/high findings blocking the gate.
Inspect endpoint-policy failures from the hosted run and add only endpoints required by reviewed
commands. Never broaden the allowlist merely to make an unexpected request pass.
