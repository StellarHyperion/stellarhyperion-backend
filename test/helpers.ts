/**
 * Shared test helpers. No network, no filesystem, no process environment.
 *
 * The deployment record under `fixtures/` is a real deployment record: every strkey in it was
 * produced by `encodeStellarAddress` from `@hyperion/protocol` and carries a valid CRC16, and
 * `parseDeploymentSet` accepts it for the same reasons it would accept a live one. That matters,
 * because a fixture the validator would reject tests the validator and nothing else.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export const TESTNET_DEPLOYMENTS = join(FIXTURES_DIR, "deployments-testnet.json");

export function readFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

/**
 * An environment that satisfies every required variable.
 *
 * Deliberately not a partial. Tests that want a missing variable delete one from a copy, which
 * reads as "without DATABASE_URL" at the call site rather than as a list of six things that
 * happen to be enough.
 */
export function completeEnv(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  return {
    DATABASE_URL: "postgres://hyperion:not-a-real-password@127.0.0.1:5433/hyperion",
    REDIS_URL: "redis://127.0.0.1:6380",
    HYPERION_NETWORK: "testnet",
    HYPERION_DEPLOYMENTS_FILE: TESTNET_DEPLOYMENTS,
    ...overrides,
  };
}
