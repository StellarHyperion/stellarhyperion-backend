# Security policy

Hyperion backend operates the off-chain watchers, rail status pollers, keeper workers, and query
APIs that track cross-chain transfers between Stellar and EVM chains. A defect in this service can
delay transfers, misreport settlement states, or execute erroneous keeper actions. This page describes
how to report security issues, our response process, and the boundaries of in-scope systems.

## Supported versions

| Revision               | Supported | Notes                               |
| ---------------------- | --------- | ----------------------------------- |
| `main`                 | Yes       | Active development branch.          |
| Tagged releases        | Not yet   | Pre-release phase.                  |
| Production deployments | Not yet   | Testnet and local development only. |

Report vulnerabilities against the latest commit on `main`.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:

**https://github.com/StellarHyperion/stellarhyperion-backend/security/advisories/new**

Advisories are confidential between the reporter and the maintainers. They provide a shared workspace
to collaborate on patches and coordinate disclosure timelines.

Do not submit vulnerability reports through public GitHub issues or forum discussions. If you lack
access to GitHub security advisories, open a public issue stating only that you have a private security
finding to report, and request an alternate secure channel.

### What makes a report actionable

A clear reproduction saves time and speeds remediation:

- The specific commit hash under evaluation.
- The affected subsystem (watcher, poller, keeper, or REST API).
- Attack preconditions (e.g. requires network access to backend internal port, requires specific chain reorg depth).
- Demonstrated impact: data manipulation, unhandled state injection, denial of service, or unauthorized resource usage.
- A reproduction script, curl command, or test case using the existing test harness.

## Scope

### In scope

- Event watcher bypasses or silent event omission during reorgs or RPC disconnections.
- Injection flaws in hand-crafted SQL queries and schema constraints.
- Denial of service attacks against Fastify endpoints or rate limit circumvention.
- Keeper service transaction misconstruction, balance drainage, or unintended state transitions.
- State corruption in rail attestation or transfer lifecycle tables.

### Out of scope

- Outages or invalid responses from third-party RPC providers (Alchemy, Infura, Soroban RPC).
- Upstream bugs within Circle Iris or Axelar GMP external APIs.
- Attacks requiring physical access or root compromise of the host server.
- Volumetric network denial of service targeting hosting infrastructure.
