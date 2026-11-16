/**
 * The Postgres handle, kept deliberately thin, with bounded pool saturation backpressure.
 *
 * Waiting callers are split into three lanes (`probe`, `api`, `worker`) so background ingestion
 * and maintenance workers cannot monopolise all connections or starve `/ready` health probes, and
 * API callers receive an explicit retryable saturation error (`DatabaseSaturationError`) within a
 * bounded deadline instead of queueing without limit.
 */
import { Pool } from "pg";
import type { PoolConfig } from "pg";

export interface QueryResultRows {
  readonly rows: readonly Record<string, unknown>[];
  /** Null from pg for statements that do not report one. Treated as zero by every caller here. */
  readonly rowCount: number;
}

/** What both the pool and a transaction offer, so a repository never knows which it has. */
export interface Queryable {
  query(text: string, params?: readonly unknown[]): Promise<QueryResultRows>;
}

/**
 * A `Queryable` that can also open a transaction.
 *
 * Declared as an interface the watchers depend on rather than letting them name `Database`
 * directly, and that is the seam the watcher tests run through.
 */
export interface Transactional extends Queryable {
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
}

export type DbWorkloadLane = "probe" | "api" | "worker";

export type SaturationReason = "queue_full" | "acquire_timeout" | "pool_closed";

/**
 * Explicit, credential-free error thrown when pool capacity or waiting queue bounds are exhausted.
 */
export class DatabaseSaturationError extends Error {
  readonly statusCode = 503;
  readonly code = "database_pool_saturated" as const;
  readonly retryable = true;
  readonly reason: SaturationReason;
  readonly lane: DbWorkloadLane;
  readonly retryAfterSeconds: number;

  constructor(
    reason: SaturationReason,
    lane: DbWorkloadLane,
    retryAfterSeconds: number,
    message = "database connection pool is saturated; retry after backoff",
  ) {
    super(message);
    this.name = "DatabaseSaturationError";
    this.reason = reason;
    this.lane = lane;
    this.retryAfterSeconds = Math.max(1, Math.trunc(retryAfterSeconds));
  }
}

export function isDatabaseSaturationError(error: unknown): error is DatabaseSaturationError {
  if (error instanceof DatabaseSaturationError) return true;
  if (typeof error !== "object" || error === null) return false;
  return (error as { code?: unknown }).code === "database_pool_saturated";
}

export interface PoolClientLike {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  release(err?: Error | boolean): void;
}

export interface PoolBackendLike {
  connect(): Promise<PoolClientLike>;
  end(): Promise<void>;
  readonly totalCount?: number;
  readonly idleCount?: number;
  readonly waitingCount?: number;
}

export interface PoolBackpressureMetrics {
  readonly maxConnections: number;
  readonly reservedProbeConnections: number;
  readonly maxApiConnections: number;
  readonly maxWorkerConcurrency: number;
  readonly activeConnections: number;
  readonly activeByLane: {
    readonly probe: number;
    readonly api: number;
    readonly worker: number;
  };
  readonly queuedRequests: number;
  readonly queuedByLane: {
    readonly probe: number;
    readonly api: number;
    readonly worker: number;
  };
  readonly maxWaitingRequests: number;
  readonly maxWaitingWorkers: number;
  readonly maxWaitingProbes: number;
  readonly acquireTimeoutMs: number;
  readonly workerAcquireTimeoutMs: number;
  readonly probeAcquireTimeoutMs: number;
  readonly rejectedCount: number;
  readonly timedOutCount: number;
  readonly pgPoolTotalCount: number;
  readonly pgPoolIdleCount: number;
  readonly pgPoolWaitingCount: number;
}

export interface OpenOptions {
  /** Low by default. Two watchers and an HTTP server do not need twenty connections. */
  readonly maxConnections?: number;
  readonly connectionTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly applicationName?: string;
  /** Connections held back from API and background workers so `/ready` probes do not starve. */
  readonly reservedProbeConnections?: number;
  /** Maximum concurrent connections background workers may occupy simultaneously. */
  readonly maxWorkerConcurrency?: number;
  /** Maximum waiting API callers queued before immediate 503 shedding. */
  readonly maxWaitingRequests?: number;
  /** Maximum waiting background worker tasks queued before shedding. */
  readonly maxWaitingWorkers?: number;
  /** Maximum waiting readiness probe checks queued simultaneously. */
  readonly maxWaitingProbes?: number;
  /** Deadline in ms for an API caller waiting for a connection slot. */
  readonly acquireTimeoutMs?: number;
  /** Deadline in ms for a background worker waiting for a connection slot. */
  readonly workerAcquireTimeoutMs?: number;
  /** Deadline in ms for a readiness probe waiting for a connection slot. */
  readonly probeAcquireTimeoutMs?: number;
  /** Retry-After hint in seconds surfaced on saturation errors. */
  readonly retryAfterSeconds?: number;
}

interface QueuedWaiter {
  readonly lane: DbWorkloadLane;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
  readonly grant: () => void;
  readonly fail: (error: DatabaseSaturationError) => void;
}

interface ResolvedLimits {
  readonly maxConnections: number;
  readonly reservedProbeConnections: number;
  readonly maxApiConnections: number;
  readonly maxWorkerConcurrency: number;
  readonly maxWaitingRequests: number;
  readonly maxWaitingWorkers: number;
  readonly maxWaitingProbes: number;
  readonly acquireTimeoutMs: number;
  readonly workerAcquireTimeoutMs: number;
  readonly probeAcquireTimeoutMs: number;
  readonly retryAfterSeconds: number;
}

function resolveLimits(options: OpenOptions): ResolvedLimits {
  const maxConnections = options.maxConnections ?? 10;
  if (!Number.isInteger(maxConnections) || maxConnections < 1) {
    throw new RangeError("maxConnections must be an integer >= 1");
  }

  const defaultReserved = maxConnections >= 3 ? 1 : 0;
  const reservedProbeConnections = options.reservedProbeConnections ?? defaultReserved;
  if (
    !Number.isInteger(reservedProbeConnections) ||
    reservedProbeConnections < 0 ||
    reservedProbeConnections >= maxConnections
  ) {
    throw new RangeError(
      `reservedProbeConnections (${String(reservedProbeConnections)}) must be in 0..${String(maxConnections - 1)}`,
    );
  }

  const maxApiConnections = maxConnections - reservedProbeConnections;
  const defaultWorkerMax =
    maxApiConnections >= 3 ? maxApiConnections - 2 : maxApiConnections === 2 ? 1 : 1;
  const maxWorkerConcurrency = options.maxWorkerConcurrency ?? defaultWorkerMax;
  if (
    !Number.isInteger(maxWorkerConcurrency) ||
    maxWorkerConcurrency < 1 ||
    maxWorkerConcurrency > maxApiConnections
  ) {
    throw new RangeError(
      `maxWorkerConcurrency (${String(maxWorkerConcurrency)}) must be in 1..${String(maxApiConnections)}`,
    );
  }

  const maxWaitingRequests = options.maxWaitingRequests ?? 32;
  const maxWaitingWorkers = options.maxWaitingWorkers ?? 16;
  const maxWaitingProbes = options.maxWaitingProbes ?? 8;
  if (!Number.isInteger(maxWaitingRequests) || maxWaitingRequests < 0) {
    throw new RangeError("maxWaitingRequests must be an integer >= 0");
  }
  if (!Number.isInteger(maxWaitingWorkers) || maxWaitingWorkers < 0) {
    throw new RangeError("maxWaitingWorkers must be an integer >= 0");
  }
  if (!Number.isInteger(maxWaitingProbes) || maxWaitingProbes < 0) {
    throw new RangeError("maxWaitingProbes must be an integer >= 0");
  }

  const acquireTimeoutMs = options.acquireTimeoutMs ?? options.connectionTimeoutMs ?? 2_000;
  const workerAcquireTimeoutMs = options.workerAcquireTimeoutMs ?? 5_000;
  const probeAcquireTimeoutMs = options.probeAcquireTimeoutMs ?? 1_500;
  if (acquireTimeoutMs < 1 || workerAcquireTimeoutMs < 1 || probeAcquireTimeoutMs < 1) {
    throw new RangeError("acquire timeout values must be >= 1ms");
  }

  const retryAfterSeconds =
    options.retryAfterSeconds ?? Math.max(1, Math.ceil(acquireTimeoutMs / 1000));

  return {
    maxConnections,
    reservedProbeConnections,
    maxApiConnections,
    maxWorkerConcurrency,
    maxWaitingRequests,
    maxWaitingWorkers,
    maxWaitingProbes,
    acquireTimeoutMs,
    workerAcquireTimeoutMs,
    probeAcquireTimeoutMs,
    retryAfterSeconds,
  };
}

function redactConnectMessage(message: string): string {
  return message.replace(/\b(postgres(?:ql)?:\/\/[^:/\s@]+:)([^@\s]+)(@)/gi, "$1[REDACTED]$3");
}

export class Database implements Transactional {
  private closed = false;
  private activeProbe = 0;
  private activeApi = 0;
  private activeWorker = 0;
  private rejectedCount = 0;
  private timedOutCount = 0;

  private readonly probeQueue: QueuedWaiter[] = [];
  private readonly apiQueue: QueuedWaiter[] = [];
  private readonly workerQueue: QueuedWaiter[] = [];

  private constructor(
    private readonly backend: PoolBackendLike,
    private readonly limits: ResolvedLimits,
  ) {}

  static open(connectionString: string, options: OpenOptions = {}): Database {
    const limits = resolveLimits(options);
    const config: PoolConfig = {
      connectionString,
      max: limits.maxConnections,
      connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
      // Named so `pg_stat_activity` says which process is holding a connection. During an
      // incident that is the difference between knowing and guessing.
      application_name: options.applicationName ?? "hyperion-backend",
      // A watcher query that has not finished in thirty seconds is wedged, not slow, and holding
      // the connection does not help it.
      statement_timeout: options.statementTimeoutMs ?? 30_000,
    };
    return new Database(new Pool(config), limits);
  }

  /**
   * Construct a `Database` over an explicit pool backend for deterministic saturation testing.
   */
  static fromBackend(backend: PoolBackendLike, options: OpenOptions = {}): Database {
    return new Database(backend, resolveLimits(options));
  }

  /**
   * Returns a `Transactional` handle bound to the background `worker` concurrency lane.
   * Background watchers, rail pollers, and scheduled maintenance should use this handle so they
   * cannot exhaust API or health-probe connection capacity.
   */
  forWorkers(): Transactional {
    return this.viewForLane("worker");
  }

  /**
   * Returns a `Transactional` handle bound to the public `api` lane.
   */
  forApi(): Transactional {
    return this.viewForLane("api");
  }

  poolMetrics(): PoolBackpressureMetrics {
    const activeConnections = this.activeProbe + this.activeApi + this.activeWorker;
    const queuedRequests = this.probeQueue.length + this.apiQueue.length + this.workerQueue.length;
    return {
      maxConnections: this.limits.maxConnections,
      reservedProbeConnections: this.limits.reservedProbeConnections,
      maxApiConnections: this.limits.maxApiConnections,
      maxWorkerConcurrency: this.limits.maxWorkerConcurrency,
      activeConnections,
      activeByLane: {
        probe: this.activeProbe,
        api: this.activeApi,
        worker: this.activeWorker,
      },
      queuedRequests,
      queuedByLane: {
        probe: this.probeQueue.length,
        api: this.apiQueue.length,
        worker: this.workerQueue.length,
      },
      maxWaitingRequests: this.limits.maxWaitingRequests,
      maxWaitingWorkers: this.limits.maxWaitingWorkers,
      maxWaitingProbes: this.limits.maxWaitingProbes,
      acquireTimeoutMs: this.limits.acquireTimeoutMs,
      workerAcquireTimeoutMs: this.limits.workerAcquireTimeoutMs,
      probeAcquireTimeoutMs: this.limits.probeAcquireTimeoutMs,
      rejectedCount: this.rejectedCount,
      timedOutCount: this.timedOutCount,
      pgPoolTotalCount: this.backend.totalCount ?? activeConnections,
      pgPoolIdleCount: this.backend.idleCount ?? 0,
      pgPoolWaitingCount: this.backend.waitingCount ?? 0,
    };
  }

  async query(text: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
    return this.queryInLane("api", text, params);
  }

  /**
   * Run `work` inside one transaction, committing on return and rolling back on throw.
   */
  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.transactionInLane("api", work);
  }

  /**
   * Cheapest possible proof the database is answering, routed over the reserved `probe` lane so
   * background worker bursts do not starve `/ready` health checks.
   */
  async ping(): Promise<void> {
    await this.queryInLane("probe", "SELECT 1", []);
  }

  /**
   * Lightweight maintenance task that cleans up completed attestation audit rows older than 30 days.
   * Executes on the bounded `worker` lane so maintenance cannot starve public traffic.
   */
  async pruneCompletedAttestations(olderThanDays = 30): Promise<number> {
    const { rowCount } = await this.queryInLane(
      "worker",
      `DELETE FROM rail_attestation
        WHERE status = 'delivered'
          AND updated_at < now() - ($1 * INTERVAL '1 day')`,
      [olderThanDays],
    );
    return rowCount;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.drainWaitersOnClose(this.probeQueue);
    this.drainWaitersOnClose(this.apiQueue);
    this.drainWaitersOnClose(this.workerQueue);
    await this.backend.end();
  }

  private viewForLane(lane: DbWorkloadLane): Transactional {
    return {
      query: (text: string, params: readonly unknown[] = []) =>
        this.queryInLane(lane, text, params),
      transaction: <T>(work: (tx: Queryable) => Promise<T>) => this.transactionInLane(lane, work),
    };
  }

  private async queryInLane(
    lane: DbWorkloadLane,
    text: string,
    params: readonly unknown[],
  ): Promise<QueryResultRows> {
    const lease = await this.acquireClient(lane);
    try {
      const result = await lease.client.query(text, params as unknown[]);
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? 0 };
    } finally {
      lease.release();
    }
  }

  private async transactionInLane<T>(
    lane: DbWorkloadLane,
    work: (tx: Queryable) => Promise<T>,
  ): Promise<T> {
    const lease = await this.acquireClient(lane);
    try {
      await lease.client.query("BEGIN");
      const value = await work(wrapClient(lease.client));
      await lease.client.query("COMMIT");
      return value;
    } catch (error) {
      await lease.client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      lease.release();
    }
  }

  private async acquireClient(
    lane: DbWorkloadLane,
  ): Promise<{ client: PoolClientLike; release: () => void }> {
    await this.acquireSlot(lane);
    let client: PoolClientLike;
    try {
      client = await this.backend.connect();
    } catch (error) {
      this.releaseSlot(lane);
      if (error instanceof Error) {
        error.message = redactConnectMessage(error.message);
      }
      throw error;
    }

    let released = false;
    return {
      client,
      release: () => {
        if (released) return;
        released = true;
        try {
          client.release();
        } finally {
          this.releaseSlot(lane);
        }
      },
    };
  }

  private canGrantImmediately(lane: DbWorkloadLane): boolean {
    const total = this.activeProbe + this.activeApi + this.activeWorker;
    if (lane === "probe") {
      return total < this.limits.maxConnections;
    }
    if (total >= this.limits.maxApiConnections) {
      return false;
    }
    if (lane === "api") {
      return this.probeQueue.length === 0;
    }
    return (
      this.probeQueue.length === 0 &&
      this.apiQueue.length === 0 &&
      this.activeWorker < this.limits.maxWorkerConcurrency
    );
  }

  private incrementLane(lane: DbWorkloadLane): void {
    if (lane === "probe") {
      this.activeProbe += 1;
    } else if (lane === "api") {
      this.activeApi += 1;
    } else {
      this.activeWorker += 1;
    }
  }

  private decrementLane(lane: DbWorkloadLane): void {
    if (lane === "probe") {
      this.activeProbe = Math.max(0, this.activeProbe - 1);
    } else if (lane === "api") {
      this.activeApi = Math.max(0, this.activeApi - 1);
    } else {
      this.activeWorker = Math.max(0, this.activeWorker - 1);
    }
  }

  private queueForLane(lane: DbWorkloadLane): QueuedWaiter[] {
    if (lane === "probe") return this.probeQueue;
    if (lane === "api") return this.apiQueue;
    return this.workerQueue;
  }

  private maxQueueForLane(lane: DbWorkloadLane): number {
    if (lane === "probe") return this.limits.maxWaitingProbes;
    if (lane === "api") return this.limits.maxWaitingRequests;
    return this.limits.maxWaitingWorkers;
  }

  private timeoutForLane(lane: DbWorkloadLane): number {
    if (lane === "probe") return this.limits.probeAcquireTimeoutMs;
    if (lane === "api") return this.limits.acquireTimeoutMs;
    return this.limits.workerAcquireTimeoutMs;
  }

  private acquireSlot(lane: DbWorkloadLane): Promise<void> {
    if (this.closed) {
      this.rejectedCount += 1;
      return Promise.reject(
        new DatabaseSaturationError(
          "pool_closed",
          lane,
          this.limits.retryAfterSeconds,
          "database connection pool is closed",
        ),
      );
    }

    if (this.canGrantImmediately(lane)) {
      this.incrementLane(lane);
      return Promise.resolve();
    }

    const queue = this.queueForLane(lane);
    const maxQueue = this.maxQueueForLane(lane);
    if (queue.length >= maxQueue) {
      this.rejectedCount += 1;
      return Promise.reject(
        new DatabaseSaturationError(
          "queue_full",
          lane,
          this.limits.retryAfterSeconds,
          `database ${lane} wait queue is full (${String(maxQueue)} waiting); retry after backoff`,
        ),
      );
    }

    const timeoutMs = this.timeoutForLane(lane);
    return new Promise<void>((resolve, reject) => {
      const waiter: QueuedWaiter = {
        lane,
        timer: null,
        settled: false,
        grant: () => {
          if (waiter.settled) return;
          waiter.settled = true;
          if (waiter.timer !== null) {
            clearTimeout(waiter.timer);
            waiter.timer = null;
          }
          resolve();
        },
        fail: (err: DatabaseSaturationError) => {
          if (waiter.settled) return;
          waiter.settled = true;
          if (waiter.timer !== null) {
            clearTimeout(waiter.timer);
            waiter.timer = null;
          }
          reject(err);
        },
      };

      waiter.timer = setTimeout(() => {
        if (waiter.settled) return;
        const idx = queue.indexOf(waiter);
        if (idx >= 0) queue.splice(idx, 1);
        this.rejectedCount += 1;
        this.timedOutCount += 1;
        waiter.fail(
          new DatabaseSaturationError(
            "acquire_timeout",
            lane,
            this.limits.retryAfterSeconds,
            `timed out after ${String(timeoutMs)}ms waiting for a ${lane} database connection`,
          ),
        );
      }, timeoutMs);

      queue.push(waiter);
    });
  }

  private releaseSlot(lane: DbWorkloadLane): void {
    this.decrementLane(lane);
    if (this.closed) return;
    this.dispatchNext();
  }

  private dispatchNext(): void {
    // 1. Always wake waiting health probes first whenever any connection slot is free.
    while (
      this.probeQueue.length > 0 &&
      this.activeProbe + this.activeApi + this.activeWorker < this.limits.maxConnections
    ) {
      const nextProbe = this.probeQueue.shift();
      if (!nextProbe || nextProbe.settled) continue;
      this.activeProbe += 1;
      nextProbe.grant();
    }

    // 2. Wake public API requests next within non-probe capacity.
    while (
      this.apiQueue.length > 0 &&
      this.activeProbe + this.activeApi + this.activeWorker < this.limits.maxApiConnections
    ) {
      const nextApi = this.apiQueue.shift();
      if (!nextApi || nextApi.settled) continue;
      this.activeApi += 1;
      nextApi.grant();
    }

    // 3. Wake background workers last within both non-probe capacity and worker concurrency cap.
    while (
      this.workerQueue.length > 0 &&
      this.activeProbe + this.activeApi + this.activeWorker < this.limits.maxApiConnections &&
      this.activeWorker < this.limits.maxWorkerConcurrency
    ) {
      const nextWorker = this.workerQueue.shift();
      if (!nextWorker || nextWorker.settled) continue;
      this.activeWorker += 1;
      nextWorker.grant();
    }
  }

  private drainWaitersOnClose(queue: QueuedWaiter[]): void {
    while (queue.length > 0) {
      const waiter = queue.shift();
      if (!waiter || waiter.settled) continue;
      this.rejectedCount += 1;
      waiter.fail(
        new DatabaseSaturationError(
          "pool_closed",
          waiter.lane,
          this.limits.retryAfterSeconds,
          "database connection pool closed while waiting for a connection",
        ),
      );
    }
  }
}

export interface MaintenanceTaskOptions {
  readonly intervalMs?: number;
  readonly olderThanDays?: number;
  readonly logger?: {
    info?: (obj: unknown, msg: string) => void;
    error?: (obj: unknown, msg: string) => void;
    warn?: (obj: unknown, msg: string) => void;
  };
}

/**
 * Periodically runs the attestation cleanup maintenance task.
 * Returns a function to cancel the scheduled task.
 */
export function startMaintenanceTask(
  db: Database,
  options: MaintenanceTaskOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? 24 * 60 * 60 * 1000;
  const olderThanDays = options.olderThanDays ?? 30;

  const timer = setInterval(() => {
    void db.pruneCompletedAttestations(olderThanDays).catch((error: unknown) => {
      options.logger?.warn?.({ err: error }, "maintenance attestation pruning failed");
    });
  }, intervalMs);

  timer.unref();
  return () => {
    clearInterval(timer);
  };
}

function wrapClient(client: PoolClientLike): Queryable {
  return {
    async query(text: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
      const result = await client.query(text, params as unknown[]);
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? 0 };
    },
  };
}
