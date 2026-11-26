# Contribution security and deployment controls

CI executes contributor code on fresh GitHub-hosted runners with read-only repository permissions
and no application secrets. Every checkout disables credential persistence. Actions and downloaded
security tools are pinned to reviewed commits/digests; npm installs disable dependency lifecycle hooks.
The normal build, test, and migration commands still execute project code and require review.

## Dev PR safety

`PR safety` is a required GitHub Actions status on the exact contributor commit. A trusted
`dev` workflow reads GitHub's immutable base/head diff as data. It never checks out the PR, runs
its commands, or installs its dependencies. It checks for obscured text and puts editor/startup
configuration, changes to npm scripts, CI/security policy changes, and incomplete or opaque diffs
on hold. Automatic fork approval and the merge bot enforce the policy independently. The normal
`dev` CI jobs also wait for the successful status on PR runs before checking out the branch.
Large diffs can require manual review; split them where practical.

When the check fails, open its **Details** in GitHub and review the indicated paths in the browser
without opening the PR in an editor or installing packages. Ask for a clean revision when possible.
Legitimate changes to protected entrypoints require maintainer review rather than automatic merge.
Do not bypass a finding just to make CI run. This is a conservative preflight, not a guarantee that
ordinary source or dependencies are safe; keep reviewing them and treat third-party bot flags as
independent evidence.

The `gate` check includes workflow security analysis, new-commit secret scanning, and dependency
advisory checks. Secret scanning redacts findings and does not accept repository-provided suppressions.
Build jobs block outbound traffic outside their documented endpoint lists and disable sudo/container
access. No executable/compiler caches are shared between jobs. The indexer runtime has its own
network requirements and uses egress monitoring rather than the build endpoint list.

Backend integration tests use the PostgreSQL installed on the Ubuntu 24.04 runner. Trusted inline
setup creates a disposable, runner-owned cluster bound to loopback before checkout. It requires no
sudo or Docker access, which Harden-Runner disables before job steps run. Redis interactions in
the current suite use mocks.

These checks reduce exposure; they cannot establish that arbitrary contributed code is trustworthy.
Review changes to wallet/transaction construction, external requests, scripts, dependencies, SDK
archives, workflow files, and deployment configuration before merge. Inspect new dependency behavior,
not just whether the package has a published vulnerability. Test-based automatic merging uses the
full CI/security/description gate, assignment authorization, current-base checks and resolved feedback.
It does not prove semantic issue resolution or use a Drips bot review as merge authorization.

## GitHub settings

Require the existing `gate` check and existing build checks from the GitHub Actions app, an
up-to-date branch and resolved review conversations. Test-based merging replaces the mandatory
human/code-owner approval requirement; no automated model approval is claimed. Protect workflows,
CODEOWNERS, lockfiles, vendored code, and SDK archives.
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
syntax is checked with actionlint. Zizmor runs offline with medium/high findings blocking the gate,
except for the byte-pinned, reviewed authorization and merge workflow triggers described in CONTRIBUTING.md.
The gate also requires CodeQL source analysis and the established PR description template.
Inspect endpoint-policy failures from the hosted run and add only endpoints required by reviewed
commands. Never broaden the allowlist merely to make an unexpected request pass.
