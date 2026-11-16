/**
 * The part of a transfer's life neither chain can tell you about, and one vocabulary for it.
 *
 * A transfer leaves one chain and arrives on another, and in between it exists only as an entry in
 * a rail's own API. Each rail names those states differently: Circle says `pending_confirmations`
 * and `complete`, Axelar says `called`, `approved`, `executed`, `error`. An operator reading one
 * table should not have to learn four sets of words, so everything is mapped onto the five the
 * schema's check constraint allows, and the rail's own word is kept verbatim alongside it so a
 * support question can be taken straight to them.
 *
 * `missing` is a state and not an error, which is the single most important thing in this file.
 * Both rails report a transfer they have not indexed yet, and they report it differently: Circle
 * returns 404 and Axelar returns 200 with an empty array. Treating either as a failure would make
 * every transfer in flight look broken and would spend the backoff on the normal case.
 */

import type { InboundRow, Position } from "../chains/writers.js";

/**
 * Hyperion's own five words.
 *
 * `delivered` is deliberately not something a rail tells us. It means an `inbound_delivery` row
 * exists for the hop, which is our own index saying the money arrived, and that is a stronger
 * claim than any rail's opinion about whether it will.
 */
export type AttestationStatus = "pending" | "attested" | "delivered" | "failed" | "expired";

/** Terminal states. Nothing polls a transfer again once it reaches one. */
export const TERMINAL: readonly AttestationStatus[] = ["delivered", "failed", "expired"];

export function isTerminal(status: AttestationStatus): boolean {
  return TERMINAL.includes(status);
}

export interface RailReport {
  readonly forwardTxHash?: `0x${string}`;
  readonly execution?: { readonly txHash: `0x${string}`; readonly commandId: `0x${string}` };
  readonly status: AttestationStatus;
  /**
   * The rail's own word for it, verbatim.
   *
   * Where a rail also explains a delay, the explanation is appended rather than dropped:
   * `pending_confirmations/insufficient_fee` is still Circle's vocabulary, and the reason is the
   * difference between a transfer that is progressing and one that will sit forever until somebody
   * tops up a fee.
   */
  readonly railStatus: string;
  /** The identifier to quote at the rail's support. Circle's event nonce, Axelar's message id. */
  readonly reference: string | null;
  readonly attestedAt: Date | null;
  readonly message?: string | null;
  readonly messageBytes?: string | null;
  readonly attestation?: string | null;
  readonly attestationSignature?: string | null;
  readonly attestationTimestamp?: Date | null;
  readonly fastTransfer?: boolean;
}

export type RailLookup =
  /** The rail has not indexed this transfer yet. Normal, and not a failure. */
  { readonly kind: "missing" } | { readonly kind: "found"; readonly report: RailReport };

export type RailErrorKind =
  /** Worth another go: a timeout, a 5xx, a body that did not parse. */
  | "transient"
  /** Will be wrong the same way next time: a malformed request, an unsupported domain. */
  | "permanent"
  /**
   * The rail has asked us to stop for a while.
   *
   * Circle's documented behaviour is the reason this is its own kind rather than a transient with
   * a status code: exceeding forty requests a second blocks *every* request for the next five
   * minutes. A poller that backed off a second and tried again would spend those five minutes
   * refreshing the block.
   */
  | "rateLimited";

export class RailError extends Error {
  constructor(
    readonly rail: string,
    readonly kind: RailErrorKind,
    reason: string,
    /** How long the rail has asked us to wait, when it says. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(`${rail}: ${reason}`);
    this.name = "RailError";
  }
}

/** One transfer waiting on a rail, as the queue hands it over. */
export interface PendingTransfer {
  readonly transferId: bigint;
  readonly route: number;
  readonly originChain: string;
  readonly destinationChain: string;
  readonly nonce: bigint;
  readonly originTx: string;
  /** Null until the first check. */
  readonly status: AttestationStatus | null;
  readonly checkFailures: number;
  /** True when an inbound delivery already exists, which settles it without asking the rail. */
  readonly delivered: boolean;
}

/** What a rail client has to offer the pass that polls it. */
export interface RailClient {
  readonly rail: string;
  /** Throws `RailError`; returns `missing` rather than throwing for a transfer not yet indexed. */
  look(transfer: PendingTransfer, signal?: AbortSignal): Promise<RailLookup>;
}

export interface VerifiedRailDelivery {
  readonly at: Position;
  readonly row: InboundRow;
}

export type DeliveryVerifier = (
  transfer: PendingTransfer,
  report: RailReport,
  signal?: AbortSignal,
) => Promise<VerifiedRailDelivery | null>;

export interface SemaphoreStats {
  readonly limit: number;
  readonly active: number;
  readonly queued: number;
  readonly peak: number;
}

export class BudgetAbortedError extends Error {
  constructor() {
    super("rail concurrency slot acquisition aborted");
    this.name = "BudgetAbortedError";
  }
}

interface QueuedPermit {
  cancelled: boolean;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  cleanup: () => void;
}

/**
 * Bounded async semaphore with direct permit handoff and AbortSignal cancellation.
 */
export class AsyncSemaphore {
  readonly limit: number;
  private activeCount = 0;
  private peakCount = 0;
  private readonly waiters: QueuedPermit[] = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`concurrency limit must be a positive integer, got ${String(limit)}`);
    }
    this.limit = limit;
  }

  get stats(): SemaphoreStats {
    return {
      limit: this.limit,
      active: this.activeCount,
      queued: this.waiters.filter((entry) => !entry.cancelled).length,
      peak: this.peakCount,
    };
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new BudgetAbortedError());
    }

    if (this.activeCount < this.limit) {
      this.activeCount += 1;
      if (this.activeCount > this.peakCount) {
        this.peakCount = this.activeCount;
      }
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const entry: QueuedPermit = {
        cancelled: false,
        resolve,
        reject,
        cleanup: () => undefined,
      };

      if (signal) {
        const onAbort = () => {
          if (entry.cancelled) return;
          entry.cancelled = true;
          entry.cleanup();
          reject(new BudgetAbortedError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        entry.cleanup = () => {
          signal.removeEventListener("abort", onAbort);
        };
      }

      this.waiters.push(entry);
    });
  }

  private release(): void {
    while (this.waiters.length > 0) {
      const next = this.waiters.shift();
      if (next && !next.cancelled) {
        next.cleanup();
        next.resolve();
        return;
      }
    }
    this.activeCount -= 1;
  }
}

export interface DestinationBudgetPoolOptions {
  readonly defaultConcurrency: number;
  readonly overrides?: Readonly<Record<string, number>> | undefined;
}

/**
 * Keyed per-destination concurrency limiter shared across rail pollers so slow or rate-limited
 * destination RPCs cannot exhaust healthy destinations or exceed per-chain RPC budgets.
 */
export class DestinationBudgetPool {
  private readonly defaultConcurrency: number;
  private readonly overrides: Readonly<Record<string, number>>;
  private readonly semaphores = new Map<string, AsyncSemaphore>();

  constructor(options: DestinationBudgetPoolOptions) {
    if (!Number.isInteger(options.defaultConcurrency) || options.defaultConcurrency < 1) {
      throw new RangeError(
        `default destination concurrency must be >= 1, got ${String(options.defaultConcurrency)}`,
      );
    }
    this.defaultConcurrency = options.defaultConcurrency;
    this.overrides = options.overrides ?? {};
    for (const [chain, budget] of Object.entries(this.overrides)) {
      if (!Number.isInteger(budget) || budget < 1) {
        throw new RangeError(
          `destination concurrency override for ${chain} must be >= 1, got ${String(budget)}`,
        );
      }
    }
  }

  limitFor(destinationChain: string): number {
    return this.overrides[destinationChain] ?? this.defaultConcurrency;
  }

  stats(destinationChain: string): SemaphoreStats {
    const existing = this.semaphores.get(destinationChain);
    if (existing !== undefined) return existing.stats;
    return {
      limit: this.limitFor(destinationChain),
      active: 0,
      queued: 0,
      peak: 0,
    };
  }

  run<T>(destinationChain: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let semaphore = this.semaphores.get(destinationChain);
    if (semaphore === undefined) {
      semaphore = new AsyncSemaphore(this.limitFor(destinationChain));
      this.semaphores.set(destinationChain, semaphore);
    }
    return semaphore.run(fn, signal);
  }
}

/**
 * In-process ownership set preventing overlapping passes or slots from checking the same transfer
 * concurrently.
 */
export class TransferOwnershipGuard {
  private readonly activeKeys = new Set<string>();

  tryAcquire(
    transfer: Pick<PendingTransfer, "transferId" | "originChain" | "nonce">,
  ): (() => void) | null {
    const idKey = `id:${transfer.transferId.toString()}`;
    const hopKey = `hop:${transfer.originChain}:${transfer.nonce.toString()}`;
    if (this.activeKeys.has(idKey) || this.activeKeys.has(hopKey)) {
      return null;
    }
    this.activeKeys.add(idKey);
    this.activeKeys.add(hopKey);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeKeys.delete(idKey);
      this.activeKeys.delete(hopKey);
    };
  }
}
