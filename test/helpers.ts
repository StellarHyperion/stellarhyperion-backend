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

/** Run workers together and retain every outcome, including rejected transactions. */
export async function runConcurrent<T>(
  workers: number,
  task: (worker: number) => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  if (!Number.isInteger(workers) || workers < 1) throw new RangeError("workers must be positive");
  return Promise.allSettled(Array.from({ length: workers }, (_, worker) => task(worker)));
}

/** A start gate for tests that must prove work overlaps rather than merely repeats. */
export function concurrencyBarrier(parties: number): {
  readonly wait: () => Promise<void>;
} {
  if (!Number.isInteger(parties) || parties < 2) throw new RangeError("parties must be at least 2");
  let arrived = 0;
  let release: (() => void) | null = null;
  const opened = new Promise<void>((resolve) => (release = resolve));
  return {
    wait: () => {
      arrived += 1;
      if (arrived === parties) release?.();
      return opened;
    },
  };
}

/**
 * A single targeted mutation applied to a receipt or message, recording the field that changed,
 * the original value, and the mutated value so the corpus can report exactly what was altered.
 */
export interface Mutation {
  readonly field: "recipient" | "amount" | "token" | "domain" | "canonicalHash";
  readonly original: string;
  readonly mutated: string;
}

/**
 * Applies a targeted mutation to a delivery record and returns the mutated copy plus the
 * mutation descriptor. Harmless unrelated fields are left untouched so only the intended
 * field change is exercised.
 */
export function mutateDelivery(
  delivery: {
    readonly recipient: string;
    readonly amount: string;
    readonly token: string;
    readonly domain: string;
    readonly canonicalHash: string;
  },
  mutation: Mutation,
): { readonly delivery: typeof delivery; readonly mutation: Mutation } {
  const mutated = { ...delivery };
  switch (mutation.field) {
    case "recipient":
      mutated.recipient = mutation.mutated;
      break;
    case "amount":
      mutated.amount = mutation.mutated;
      break;
    case "token":
      mutated.token = mutation.mutated;
      break;
    case "domain":
      mutated.domain = mutation.mutated;
      break;
    case "canonicalHash":
      mutated.canonicalHash = mutation.mutated;
      break;
  }
  return { delivery: mutated, mutation };
}

/**
 * Generates the standard mutation set used by the destination-proof corpus: one mutation
 * per protected field, each flipping a single character so the verifier must reject it.
 */
export function destinationProofMutations(delivery: {
  readonly recipient: string;
  readonly amount: string;
  readonly token: string;
  readonly domain: string;
  readonly canonicalHash: string;
}): readonly Mutation[] {
  const flip = (value: string): string => {
    if (value.length === 0) return "x";
    const chars = Array.from(value);
    chars[0] = chars[0] === "a" ? "b" : "a";
    return chars.join("");
  };
  return [
    { field: "recipient", original: delivery.recipient, mutated: flip(delivery.recipient) },
    { field: "amount", original: delivery.amount, mutated: flip(delivery.amount) },
    { field: "token", original: delivery.token, mutated: flip(delivery.token) },
    { field: "domain", original: delivery.domain, mutated: flip(delivery.domain) },
    {
      field: "canonicalHash",
      original: delivery.canonicalHash,
      mutated: flip(delivery.canonicalHash),
    },
  ];
}
