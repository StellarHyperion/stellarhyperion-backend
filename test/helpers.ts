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

/** Identifiers and amounts that must survive public and database projections as strings. */
export interface IndexedTransferSemanticsFixture {
  readonly nonce: string;
  readonly sourceEventId: string;
  readonly grossAmount: string;
  readonly fee: string;
  readonly netAmount: string;
  readonly canonicalHash: string;
  readonly receipt: string;
  readonly payment: string;
}

export function assertIndexedTransferSemantics(
  first: IndexedTransferSemanticsFixture,
  second: IndexedTransferSemanticsFixture,
): void {
  const integerStrings = ["nonce", "sourceEventId", "grossAmount", "fee", "netAmount"] as const;
  for (const key of integerStrings) {
    if (!/^\d+$/.test(first[key]) || !/^\d+$/.test(second[key]))
      throw new Error(`${key} must remain an integer string`);
  }
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw new Error("entrypoints produced different indexed transfer semantics");
}

export function canonicalIndexedTransferFixture(
  overrides: Partial<IndexedTransferSemanticsFixture> = {},
): IndexedTransferSemanticsFixture {
  return {
    nonce: "18446744073709551615",
    sourceEventId: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
    grossAmount: "18446744073709551615",
    fee: "300",
    netAmount: "18446744073709551315",
    canonicalHash: `0x${"a".repeat(64)}`,
    receipt: `0x${"b".repeat(64)}`,
    payment: `0x${"c".repeat(64)}`,
    ...overrides,
  };
}

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
  readonly latencyMs?: number;
  readonly random?: () => number;
}

type SimulationAction =
  | { readonly kind: "retryAfter"; readonly seconds: number }
  | { readonly kind: "timeout"; readonly message: string }
  | { readonly kind: "malformed" };

/** Fault-only client. It never forwards destination execution or payment proof material. */
export class RateLimitSimulator implements RailClient {
  readonly rail: string;
  readonly wrapped: RailClient;
  private readonly options: RateLimitSimulatorOptions;
  private queuedActions: SimulationAction[] = [];
  private readonly transferActions = new Map<bigint, SimulationAction[]>();
  private readonly callsByTransfer = new Map<bigint, number>();
  private observedBackoffs: number[] = [];
  callCount = 0;

  constructor(options?: RateLimitSimulatorOptions);
  constructor(wrapped?: RailClient, options?: RateLimitSimulatorOptions);
  constructor(
    wrappedOrOptions?: RailClient | RateLimitSimulatorOptions,
    maybeOptions?: RateLimitSimulatorOptions,
  ) {
    this.options =
      wrappedOrOptions && "look" in wrappedOrOptions
        ? (maybeOptions ?? {})
        : (wrappedOrOptions ?? maybeOptions ?? {});
    this.wrapped =
      wrappedOrOptions && "look" in wrappedOrOptions
        ? wrappedOrOptions
        : {
            rail: "cctp",
            look: () =>
              Promise.resolve({
                kind: "found",
                report: {
                  status: "pending",
                  railStatus: "simulated_pending",
                  reference: null,
                  attestedAt: null,
                },
              }),
          };
    this.rail = this.wrapped.rail;
    for (const rate of [this.options.timeoutRate, this.options.malformedRate])
      if (rate !== undefined && (!Number.isFinite(rate) || rate < 0 || rate > 1))
        throw new RangeError("fault rate must be between zero and one");
    if (
      this.options.latencyMs !== undefined &&
      (!Number.isSafeInteger(this.options.latencyMs) ||
        this.options.latencyMs < 0 ||
        this.options.latencyMs > 60000)
    )
      throw new RangeError("simulated latency must be between zero and 60000ms");
    if (this.options.defaultRetryAfterSeconds !== undefined)
      this.validateSeconds(this.options.defaultRetryAfterSeconds);
  }

  private validateSeconds(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400)
      throw new RangeError("Retry-After must be between zero and 86400 seconds");
  }
  private enqueue(action: SimulationAction, transferId?: bigint): void {
    if (transferId === undefined) this.queuedActions.push(action);
    else {
      const actions = this.transferActions.get(transferId) ?? [];
      actions.push(action);
      this.transferActions.set(transferId, actions);
    }
  }
  get backoffTimesObserved(): readonly number[] {
    return [...this.observedBackoffs];
  }
  simulateRetryAfter(
    seconds = this.options.defaultRetryAfterSeconds ?? 30,
    transferId?: bigint,
  ): void {
    this.validateSeconds(seconds);
    this.enqueue({ kind: "retryAfter", seconds }, transferId);
  }
  simulateTimeout(message = "timeout", transferId?: bigint): void {
    this.enqueue({ kind: "timeout", message }, transferId);
  }
  simulateMalformed(transferId?: bigint): void {
    this.enqueue({ kind: "malformed" }, transferId);
  }
  simulateDelivered(): never {
    throw new Error("Simulator cannot generate fake delivered records");
  }
  callsFor(transferId: bigint): number {
    return this.callsByTransfer.get(transferId) ?? 0;
  }
  reset(): void {
    this.callCount = 0;
    this.callsByTransfer.clear();
    this.queuedActions = [];
    this.transferActions.clear();
    this.observedBackoffs = [];
  }
  private random(): number {
    const value = (this.options.random ?? Math.random)();
    if (!Number.isFinite(value) || value < 0 || value >= 1)
      throw new RangeError("random source must return a value in [0,1)");
    return value;
  }
  private async delay(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new RailTimeoutError(this.rail, "aborted simulated request");
    const latency = this.options.latencyMs ?? 0;
    if (latency === 0) return;
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const timer = setTimeout(finish, latency);
      const abort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(new RailTimeoutError(this.rail, "aborted simulated request"));
      };
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  async look(transfer: PendingTransfer, signal?: AbortSignal): Promise<RailLookup> {
    await this.delay(signal);
    this.callCount += 1;
    this.callsByTransfer.set(transfer.transferId, this.callsFor(transfer.transferId) + 1);
    const action =
      this.transferActions.get(transfer.transferId)?.shift() ?? this.queuedActions.shift();
    if (action?.kind === "retryAfter") {
      this.observedBackoffs.push(action.seconds);
      throw new RailRateLimitError(this.rail, action.seconds);
    }
    if (action?.kind === "timeout") throw new RailTimeoutError(this.rail, action.message);
    if (action?.kind === "malformed")
      throw new RailError(this.rail, "transient", "malformed simulated provider response");
    if (this.options.timeoutRate !== undefined && this.random() < this.options.timeoutRate)
      throw new RailTimeoutError(this.rail, "timeout");
    if (this.options.malformedRate !== undefined && this.random() < this.options.malformedRate)
      throw new RailError(this.rail, "transient", "malformed simulated provider response");
    const lookup = await this.wrapped.look(transfer, signal);
    if (lookup.kind === "missing") return lookup;
    return {
      kind: "found",
      report: {
        status: lookup.report.status === "failed" ? "failed" : "pending",
        railStatus: "simulated_pending",
        reference: null,
        attestedAt: null,
      },
    };
  }
}
