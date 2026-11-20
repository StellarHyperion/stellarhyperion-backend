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

import {
  RailError,
  type PendingTransfer,
  type RailClient,
  type RailLookup,
} from "../src/rails/types.js";

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
  if (!Number.isInteger(workers) || workers < 1 || workers > 32)
    throw new RangeError("workers must be between 1 and 32");
  return Promise.allSettled(Array.from({ length: workers }, (_, worker) => task(worker)));
}

/** Concurrency stress uses TEST_DATABASE_URL only; remote or non-test databases require a separate opt-in. */
export function validateConcurrencyDatabase(connection: string, allowRemote = false): void {
  const url = new URL(connection);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("PostgreSQL test URL required");
  if (
    !allowRemote &&
    (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !/test|session|concurrency/.test(url.pathname))
  ) {
    throw new Error(
      "concurrency requires a dedicated local test database or explicit HYPERION_ALLOW_REMOTE_CONCURRENCY_TEST_DATABASE=true",
    );
  }
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

export class RailRateLimitError extends RailError {
  readonly retryAfter: number;

  constructor(rail: string, seconds: number, message = "rate limited") {
    super(rail, "rateLimited", message, seconds * 1000);
    this.name = "RailRateLimitError";
    this.retryAfter = seconds;
  }
}

export class RailTimeoutError extends RailError {
  constructor(rail: string, message = "timeout") {
    super(rail, "transient", message);
    this.name = "RailTimeoutError";
    this.message = message;
  }
}

export interface RateLimitSimulatorOptions {
  readonly timeoutRate?: number;
  readonly malformedRate?: number;
  readonly defaultRetryAfterSeconds?: number;
}

type SimulationAction =
  | { readonly kind: "retryAfter"; readonly seconds: number }
  | { readonly kind: "timeout"; readonly message: string }
  | { readonly kind: "malformed" };

export class RateLimitSimulator implements RailClient {
  readonly rail: string;
  readonly wrapped: RailClient;
  private readonly options: RateLimitSimulatorOptions;
  private queuedActions: SimulationAction[] = [];
  private callsByTransfer = new Map<bigint, number>();
  private observedBackoffs: number[] = [];
  callCount = 0;

  constructor(options?: RateLimitSimulatorOptions);
  constructor(wrapped?: RailClient, options?: RateLimitSimulatorOptions);
  constructor(
    wrappedOrOptions?: RailClient | RateLimitSimulatorOptions,
    maybeOptions?: RateLimitSimulatorOptions,
  ) {
    if (wrappedOrOptions && "look" in wrappedOrOptions) {
      this.wrapped = wrappedOrOptions;
      this.options = maybeOptions ?? {};
    } else {
      this.options = wrappedOrOptions ?? maybeOptions ?? {};
      this.wrapped = {
        rail: "cctp",
        look: (_transfer: PendingTransfer): Promise<RailLookup> =>
          Promise.resolve({
            kind: "found",
            report: {
              status: "pending",
              railStatus: "pending_confirmations",
              reference: "ref-default",
              attestedAt: null,
            },
          }),
      };
    }
    this.rail = this.wrapped.rail;
  }

  get backoffTimesObserved(): readonly number[] {
    return this.observedBackoffs;
  }

  simulateRetryAfter(seconds: number): void {
    this.queuedActions.push({ kind: "retryAfter", seconds });
  }

  simulateTimeout(message = "timeout"): void {
    this.queuedActions.push({ kind: "timeout", message });
  }

  simulateMalformed(): void {
    this.queuedActions.push({ kind: "malformed" });
  }

  simulateDelivered(): void {
    throw new Error(
      "Simulator cannot generate fake delivered records: provider status alone must never establish destination delivery",
    );
  }

  callsFor(transferId: bigint): number {
    return this.callsByTransfer.get(transferId) ?? 0;
  }

  reset(): void {
    this.callCount = 0;
    this.callsByTransfer.clear();
    this.queuedActions = [];
    this.observedBackoffs = [];
  }

  async look(transfer: PendingTransfer, signal?: AbortSignal): Promise<RailLookup> {
    this.callCount += 1;
    this.callsByTransfer.set(
      transfer.transferId,
      (this.callsByTransfer.get(transfer.transferId) ?? 0) + 1,
    );

    if (this.queuedActions.length > 0) {
      const action = this.queuedActions.shift()!;
      if (action.kind === "retryAfter") {
        this.observedBackoffs.push(action.seconds);
        throw new RailRateLimitError(this.rail, action.seconds);
      } else if (action.kind === "timeout") {
        throw new RailTimeoutError(this.rail, action.message);
      } else {
        return {
          kind: "malformed",
          report: null,
        } as unknown as RailLookup;
      }
    }

    if (this.options.timeoutRate !== undefined && Math.random() < this.options.timeoutRate) {
      throw new RailTimeoutError(this.rail, "timeout");
    }

    if (this.options.malformedRate !== undefined && Math.random() < this.options.malformedRate) {
      return {
        kind: "malformed",
        report: null,
      } as unknown as RailLookup;
    }

    const lookup = await this.wrapped.look(transfer, signal);

    // CRITICAL: simulator must NEVER produce a "delivered" status for any transfer — it may only produce "pending", "failed", or error states
    if (lookup.kind === "found") {
      const status = lookup.report.status;
      if (status === "delivered" || (status !== "pending" && status !== "failed")) {
        // Strip delivery-only fields so the report is a valid "pending" RailReport.
        // We omit delivery fields rather than set to undefined (exactOptionalPropertyTypes).
        const rest = { ...lookup.report };
        delete (rest as { forwardTxHash?: unknown }).forwardTxHash;
        delete (rest as { execution?: unknown }).execution;
        return {
          kind: "found",
          report: {
            ...rest,
            status: "pending",
          },
        };
      }
    }

    return lookup;
  }
}
