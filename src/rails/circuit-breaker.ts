/**
 * Per-provider circuit breaker for external rail discovery lookups.
 *
 * External rail APIs (Circle Iris, Axelar GMP) are candidate discovery sources, never proof of
 * destination payout. When a discovery API suffers repeated transient failures or rate limits,
 * hammering it once per transfer per tick wastes quota and risks burning per-transfer retry
 * budgets. Each rail pass owns an isolated `RailCircuitBreaker` that pauses discovery lookups,
 * admits bounded half-open probes after the open window expires, exposes observable state for
 * readiness reporting, and never implies destination delivery.
 */

export type RailCircuitState = "closed" | "open" | "half_open";

export interface RailCircuitSnapshot {
  readonly provider: string;
  readonly state: RailCircuitState;
  readonly consecutiveFailures: number;
  readonly openUntil: Date | null;
  readonly lastError: string | null;
  readonly halfOpenProbesRemaining: number;
  readonly halfOpenSuccesses: number;
  readonly totalTrips: number;
  /** Circuit state is exclusively about provider discovery health and never implies payout. */
  readonly deliveryImplied: false;
}

export interface RailCircuitBreakerOptions {
  readonly provider: string;
  readonly failureThreshold?: number | undefined;
  readonly openDurationMs?: number | undefined;
  readonly maxOpenDurationMs?: number | undefined;
  readonly halfOpenMaxProbes?: number | undefined;
  readonly halfOpenSuccessThreshold?: number | undefined;
}

export type DiscoveryPermit =
  | { readonly allowed: true; readonly mode: "normal" | "probe" }
  | {
      readonly allowed: false;
      readonly state: "open" | "half_open";
      readonly retryAt: Date | null;
    };

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_OPEN_DURATION_MS = 30_000;
const DEFAULT_MAX_OPEN_DURATION_MS = 300_000;
const DEFAULT_HALF_OPEN_MAX_PROBES = 1;
const DEFAULT_HALF_OPEN_SUCCESS_THRESHOLD = 1;
const MAX_ERROR_DETAIL_LENGTH = 240;

export function sanitizeCircuitError(raw: string): string {
  const scrubbed = raw
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1[redacted]@")
    .replace(
      /\b(api[_-]?key|token|secret|password|authorization)\s*([:=])\s*\S+/gi,
      "$1$2[redacted]",
    )
    .trim();
  return scrubbed.length <= MAX_ERROR_DETAIL_LENGTH
    ? scrubbed
    : `${scrubbed.slice(0, MAX_ERROR_DETAIL_LENGTH)}...`;
}

export class RailCircuitBreaker {
  private readonly providerName: string;
  private readonly failureThreshold: number;
  private readonly openDurationMs: number;
  private readonly maxOpenDurationMs: number;
  private readonly halfOpenMaxProbes: number;
  private readonly halfOpenSuccessThreshold: number;

  private currentState: RailCircuitState = "closed";
  private consecutiveFailureCount = 0;
  private openedUntil: Date | null = null;
  private lastFailureReason: string | null = null;
  private halfOpenProbesUsed = 0;
  private halfOpenSuccessCount = 0;
  private tripCount = 0;
  private backoffStep = 0;

  constructor(options: RailCircuitBreakerOptions) {
    if (options.provider.trim().length === 0) {
      throw new Error("RailCircuitBreaker requires a non-empty provider name");
    }
    this.providerName = options.provider.trim();
    this.failureThreshold = Math.max(1, options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD);
    this.openDurationMs = Math.max(1, options.openDurationMs ?? DEFAULT_OPEN_DURATION_MS);
    this.maxOpenDurationMs = Math.max(
      this.openDurationMs,
      options.maxOpenDurationMs ?? DEFAULT_MAX_OPEN_DURATION_MS,
    );
    this.halfOpenMaxProbes = Math.max(1, options.halfOpenMaxProbes ?? DEFAULT_HALF_OPEN_MAX_PROBES);
    this.halfOpenSuccessThreshold = Math.max(
      1,
      options.halfOpenSuccessThreshold ?? DEFAULT_HALF_OPEN_SUCCESS_THRESHOLD,
    );
  }

  get provider(): string {
    return this.providerName;
  }

  snapshot(now: Date = new Date()): RailCircuitSnapshot {
    this.advanceClock(now);
    return {
      provider: this.providerName,
      state: this.currentState,
      consecutiveFailures: this.consecutiveFailureCount,
      openUntil: this.openedUntil,
      lastError: this.lastFailureReason,
      halfOpenProbesRemaining:
        this.currentState === "half_open"
          ? Math.max(0, this.halfOpenMaxProbes - this.halfOpenProbesUsed)
          : 0,
      halfOpenSuccesses: this.currentState === "half_open" ? this.halfOpenSuccessCount : 0,
      totalTrips: this.tripCount,
      deliveryImplied: false,
    };
  }

  tryAcquireDiscoveryPermit(now: Date = new Date()): DiscoveryPermit {
    this.advanceClock(now);

    if (this.currentState === "closed") {
      return { allowed: true, mode: "normal" };
    }

    if (this.currentState === "open") {
      return { allowed: false, state: "open", retryAt: this.openedUntil };
    }

    if (this.halfOpenProbesUsed < this.halfOpenMaxProbes) {
      this.halfOpenProbesUsed += 1;
      return { allowed: true, mode: "probe" };
    }

    return { allowed: false, state: "half_open", retryAt: this.openedUntil };
  }

  recordSuccess(now: Date = new Date()): RailCircuitSnapshot {
    this.advanceClock(now);
    this.consecutiveFailureCount = 0;
    this.lastFailureReason = null;

    if (this.currentState === "half_open") {
      this.halfOpenSuccessCount += 1;
      if (this.halfOpenSuccessCount >= this.halfOpenSuccessThreshold) {
        this.currentState = "closed";
        this.openedUntil = null;
        this.halfOpenProbesUsed = 0;
        this.halfOpenSuccessCount = 0;
        this.backoffStep = 0;
      }
    }

    return this.snapshot(now);
  }

  recordProviderFailure(
    now: Date,
    reason: string,
    retryAfterMs: number | null = null,
  ): RailCircuitSnapshot {
    this.advanceClock(now);
    this.consecutiveFailureCount += 1;
    this.lastFailureReason = sanitizeCircuitError(reason);

    const shouldTrip =
      this.currentState === "half_open" ||
      this.consecutiveFailureCount >= this.failureThreshold ||
      (retryAfterMs !== null && retryAfterMs > 0);

    if (shouldTrip) {
      this.tripCount += 1;
      this.backoffStep += 1;
      const exponentialWait = Math.min(
        this.maxOpenDurationMs,
        this.openDurationMs * 2 ** Math.min(10, this.backoffStep - 1),
      );
      const waitMs =
        retryAfterMs !== null && retryAfterMs > exponentialWait ? retryAfterMs : exponentialWait;
      this.currentState = "open";
      this.openedUntil = new Date(now.getTime() + waitMs);
      this.halfOpenProbesUsed = 0;
      this.halfOpenSuccessCount = 0;
    }

    return this.snapshot(now);
  }

  private advanceClock(now: Date): void {
    if (
      this.currentState === "open" &&
      this.openedUntil !== null &&
      now.getTime() >= this.openedUntil.getTime()
    ) {
      this.currentState = "half_open";
      this.halfOpenProbesUsed = 0;
      this.halfOpenSuccessCount = 0;
    }
  }
}
