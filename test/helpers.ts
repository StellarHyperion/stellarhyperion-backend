/**
 * Shared test helpers. No network, no filesystem, no process environment.
 *
 * The deployment record under `fixtures/` is a real deployment record: every strkey in it was
 * produced by `encodeStellarAddress` from `@hyperion/protocol` and carries a valid CRC16, and
 * `parseDeploymentSet` accepts it for the same reasons it would accept a live one. That matters,
 * because a fixture the validator would reject tests the validator and nothing else.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export const TESTNET_DEPLOYMENTS = join(FIXTURES_DIR, "deployments-testnet.json");

export function readFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

export interface SqlMigration {
  readonly name: string;
  readonly upSql: string;
}

/**
 * Load every `-- Up Migration` section from `migrations/*.sql` in execution order.
 */
export function loadUpMigrations(): readonly SqlMigration[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((entry) => entry.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  return files.map((name) => {
    const raw = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    const downIndex = raw.indexOf("-- Down Migration");
    const upSql = (downIndex >= 0 ? raw.slice(0, downIndex) : raw).trim();
    return { name, upSql };
  });
}

export interface SeededRandom {
  readonly seed: number;
  nextUint32(): number;
  nextInt(minInclusive: number, maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
}

/**
 * Deterministic 32-bit PRNG (Mulberry32) so fault-injection schedules replay identically from a seed.
 */
export function createSeededRandom(seed: number): SeededRandom {
  const normalizedSeed = seed >>> 0;
  let state = normalizedSeed;

  const nextUint32 = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };

  return {
    seed: normalizedSeed,
    nextUint32,
    nextInt(minInclusive: number, maxExclusive: number): number {
      if (maxExclusive <= minInclusive) {
        throw new RangeError(
          `maxExclusive (${String(maxExclusive)}) must exceed minInclusive (${String(minInclusive)})`,
        );
      }
      const span = maxExclusive - minInclusive;
      return minInclusive + (nextUint32() % span);
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) {
        throw new RangeError("cannot pick from an empty list");
      }
      const index = nextUint32() % items.length;
      return items[index]!;
    },
  };
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
