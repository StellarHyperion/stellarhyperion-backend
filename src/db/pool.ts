/**
 * The Postgres handle, kept deliberately thin.
 *
 * There is no ORM here and there is not going to be one. The queries this service runs are a
 * handful of upserts keyed on a business identity and two or three claim style selects, and every
 * one of them reads better as the SQL it is than as a builder chain that compiles to it. What a
 * wrapper does buy is the one thing the correctness of the indexer rests on: a transaction helper
 * that cannot be forgotten, so writing a page of events and advancing the cursor that says the
 * page was written are the same commit.
 *
 * Rows come back as `Record<string, unknown>` rather than a generic the caller invents. pg does
 * not check the shape it returns against anything, so a generic there is a cast wearing a
 * costume. Narrowing happens once per table, in `rows.ts`, where it is visible.
 */
import { performance } from "node:perf_hooks";

import { Client, Pool } from "pg";
import type { PoolClient, PoolConfig } from "pg";
import { currentWorkerRun } from "../runtime/worker-runs.js";
import {
  migrationPreflight,
  migrationRollbackReport,
  type MigrationPreflightOptions,
  type MigrationPreflightReport,
  type MigrationRollbackReport,
} from "./migration-report.js";
import {
  computeHistoryDigest as computeRangeDigest,
  recordHistoryDigest as storeRangeDigest,
  verifyHistoryDigest as verifyRangeDigest,
  type ComputeHistoryDigestOptions,
  type DigestVerificationResult,
  type HistoryDigestResult,
  type StoredHistoryDigest,
  auditTransferAndClaimInvariants,
  compactRouteHealthSamples,
  type CompactRouteHealthOptions,
  type RouteHealthCompactionResult,
  type TransferClaimAuditReport,
} from "../chains/writers.js";

import {
  DbTelemetryCollector,
  classifySqlWorkload,
  type DbTelemetrySnapshot,
  type DbWorkload,
  type PoolSaturationSnapshot,
  type QueryOptions,
} from "./telemetry.js";

export interface QueryResultRows {
  readonly rows: readonly Record<string, unknown>[];
  /** Null from pg for statements that do not report one. Treated as zero by every caller here. */
  readonly rowCount: number;
}

/** What both the pool and a transaction offer, so a repository never knows which it has. */
export interface Queryable {
  query(
    text: string,
    params?: readonly unknown[],
    options?: QueryOptions,
  ): Promise<QueryResultRows>;
}

/**
 * A `Queryable` that can also open a transaction.
 *
 * Declared as an interface the watchers depend on rather than letting them name `Database`
 * directly, and that is the seam the watcher tests run through. A watcher's whole correctness
 * claim is about what lands in one transaction, so a test has to be able to watch the
 * transaction boundary rather than infer it, and a real pool cannot be asked what it was told.
 */
export interface Transactional extends Queryable {
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
}

export interface OpenOptions {
  /** Enforce read-only statements on every connection, including diagnostics probes. */
  readonly readOnly?: boolean;
  /** Low by default. Two watchers and an HTTP server do not need twenty connections. */
  readonly maxConnections?: number;
  /** Maximum number of callers admitted to the bounded wait queue. */
  readonly maxWaitingRequests?: number;
  /** Maximum time a caller may wait for a database connection. */
  readonly acquireTimeoutMs?: number;
  readonly connectionTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  /** Maximum time a public statement may wait for a conflicting lock. */
  readonly lockTimeoutMs?: number;
  /** Longer bound for an atomic ingestion/maintenance transaction. */
  readonly transactionStatementTimeoutMs?: number;
  readonly transactionLockTimeoutMs?: number;
  readonly applicationName?: string;
  readonly maxLatencySamplesPerWorkload?: number;
  readonly slowQueryThresholdMs?: number;
  readonly logger?: {
    warn?: (obj: unknown, msg: string) => void;
  };
}

export class Database implements Transactional {
  private closing: Promise<void> | null = null;
  private readonly telemetry: DbTelemetryCollector;
  private readonly maxConnections: number;
  private readonly slowQueryThresholdMs: number | undefined;
  private readonly logger: OpenOptions["logger"];
  private readonly transactionStatementTimeoutMs: number;
  private readonly transactionLockTimeoutMs: number;
  private readonly admission: PoolAdmission;
  private readonly acquireTimeoutMs: number;

  private constructor(
    private readonly pool: Pool,
    private readonly connectionConfig: PoolConfig,
    options: OpenOptions = {},
  ) {
    this.maxConnections = options.maxConnections ?? 10;
    this.telemetry = new DbTelemetryCollector(options.maxLatencySamplesPerWorkload);
    this.slowQueryThresholdMs = options.slowQueryThresholdMs;
    this.logger = options.logger;
    this.transactionStatementTimeoutMs = options.transactionStatementTimeoutMs ?? 60_000;
    this.transactionLockTimeoutMs = options.transactionLockTimeoutMs ?? 5_000;
    this.acquireTimeoutMs = timeoutMilliseconds(options.acquireTimeoutMs, 1_000);
    this.admission = new PoolAdmission(
      this.maxConnections,
      options.maxWaitingRequests ?? Math.max(16, this.maxConnections * 4),
      this.acquireTimeoutMs,
    );
  }

  static open(connectionString: string, options: OpenOptions = {}): Database {
    const maxConnections = options.maxConnections ?? 10;
    if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 1_000)
      throw new RangeError("Database connections must be an integer from 1 to 1000.");
    const statementTimeoutMs = timeoutMilliseconds(options.statementTimeoutMs, 30_000);
    const lockTimeoutMs = timeoutMilliseconds(options.lockTimeoutMs, 5_000);
    const transactionStatementTimeoutMs = timeoutMilliseconds(
      options.transactionStatementTimeoutMs,
      60_000,
    );
    const transactionLockTimeoutMs = timeoutMilliseconds(options.transactionLockTimeoutMs, 5_000);
    const startupOptions = [
      `-c statement_timeout=${statementTimeoutMs}`,
      `-c lock_timeout=${lockTimeoutMs}`,
      ...(options.readOnly ? ["-c default_transaction_read_only=on"] : []),
    ];
    const config: PoolConfig = {
      connectionString,
      max: maxConnections,
      options: startupOptions.join(" "),
      connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
      // Named so `pg_stat_activity` says which process is holding a connection. During an
      // incident that is the difference between knowing and guessing.
      application_name: options.applicationName ?? "hyperion-backend",
      // A watcher query that has not finished in thirty seconds is wedged, not slow, and holding
      // the connection does not help it.
      statement_timeout: statementTimeoutMs,
    };
    const pool = new Pool(config);
    // pg emits idle-connection failures outside a query promise. Consume them so the pool can
    // remove the dead client and reconnect; raw errors can contain credential-bearing details.
    pool.on("error", () => {
      options.logger?.warn?.(
        { event: "database_idle_connection_error" },
        "database idle connection failed",
      );
    });
    return new Database(pool, config, {
      ...options,
      maxConnections,
      transactionStatementTimeoutMs,
      transactionLockTimeoutMs,
    });
  }

  async query(
    text: string,
    params: readonly unknown[] = [],
    options?: QueryOptions,
  ): Promise<QueryResultRows> {
    const workload = options?.workload ?? classifySqlWorkload(text);
    const { client, release } = await this.acquireClient(workload, options?.signal);
    try {
      return await this.queryClient(client, text, params, options);
    } finally {
      release();
    }
  }

  /**
   * Run `work` inside one transaction, committing on return and rolling back on throw.
   *
   * This is the whole reason the wrapper exists. The indexer's restart safety is the claim that a
   * page of events and the cursor advance past it land together or not at all, and that claim is
   * only as good as nobody being able to write one without the other.
   */
  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    const { client, release } = await this.acquireClient("transaction");
    try {
      await this.measure("transaction", () => client.query("BEGIN"));
      const run = currentWorkerRun();
      // SET LOCAL does not establish a data snapshot, so callers can still select isolation.
      await this.measure("transaction", () =>
        client.query(`SET LOCAL lock_timeout = ${this.transactionLockTimeoutMs}`),
      );
      await this.measure("transaction", () =>
        client.query(`SET LOCAL statement_timeout = ${this.transactionStatementTimeoutMs}`),
      );
      if (run !== undefined)
        await client.query("SELECT set_config('hyperion.worker_run_id',$1,true)", [run.runId]);
      const value = await work(this.wrapClient(client));
      await this.measure("transaction", () => client.query("COMMIT"));
      return value;
    } catch (error) {
      // A rollback that itself fails means the connection is gone, in which case the server has
      // already rolled back and the original error is the one worth reporting.
      await this.measure("transaction", () => client.query("ROLLBACK")).catch(() => undefined);
      throw normalizeDatabaseError(error);
    } finally {
      release();
    }
  }

  private async acquireClient(
    workload: DbWorkload,
    signal?: AbortSignal,
  ): Promise<{ client: PoolClient; release: () => void }> {
    const deadline = Date.now() + this.acquireTimeoutMs;
    const releaseAdmission = await this.admission.acquire(workload, signal);
    const remaining = deadline - Date.now();
    if (remaining <= 0 || signal?.aborted) {
      releaseAdmission();
      signal?.throwIfAborted();
      throw new DatabaseBackpressureError(this.acquireTimeoutMs);
    }
    return new Promise((resolve, reject) => {
      let abandoned = false;
      const fail = (error: unknown) => {
        if (abandoned) return;
        abandoned = true;
        cleanup();
        // Cancellation preserves the caller-provided AbortSignal reason.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(error);
      };
      const timer = setTimeout(() => {
        fail(new DatabaseBackpressureError(this.acquireTimeoutMs));
      }, remaining);
      const abort = () => {
        fail(signal?.reason);
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      signal?.addEventListener("abort", abort, { once: true });
      // An abandoned connect keeps its admission permit until pg settles. This bounds pg's
      // own queue, and any late client is released before another caller can borrow it.
      this.pool.connect().then(
        (client) => {
          cleanup();
          if (abandoned) {
            client.release();
            releaseAdmission();
            return;
          }
          let released = false;
          resolve({
            client,
            release: () => {
              if (released) return;
              released = true;
              client.release();
              releaseAdmission();
            },
          });
        },
        () => {
          cleanup();
          releaseAdmission();
          fail(new DatabaseBackpressureError(this.acquireTimeoutMs));
        },
      );
    });
  }

  /** Cheapest possible proof the database is answering, for the ready check. */
  async ping(): Promise<void> {
    await this.query("SELECT 1", [], { workload: "health" });
  }

  poolSnapshot(): PoolSaturationSnapshot {
    return this.telemetry.poolSnapshot({
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
      maxConnections: this.maxConnections,
      queuedRequests: this.admission.snapshot().queuedRequests,
      queuedBackgroundRequests: this.admission.snapshot().queuedBackgroundRequests,
      activeWorkloads: this.admission.snapshot().activeWorkloads,
    });
  }

  telemetrySnapshot(): DbTelemetrySnapshot {
    return this.telemetry.snapshot({
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
      maxConnections: this.maxConnections,
      queuedRequests: this.admission.snapshot().queuedRequests,
      queuedBackgroundRequests: this.admission.snapshot().queuedBackgroundRequests,
      activeWorkloads: this.admission.snapshot().activeWorkloads,
    });
  }

  private wrapClient(client: PoolClient): Queryable {
    return {
      query: (text: string, params: readonly unknown[] = [], options?: QueryOptions) =>
        this.queryClient(client, text, params, options),
    };
  }

  private async queryClient(
    client: PoolClient,
    text: string,
    params: readonly unknown[],
    options?: QueryOptions,
  ): Promise<QueryResultRows> {
    const signal = options?.signal;
    signal?.throwIfAborted();
    // Cancellation uses PostgreSQL's supported function on a short-lived connection with the
    // same role. Hold the borrowed client until cancellation completes so a late cancellation
    // cannot target its next user's query. Parameters and connection details are never logged.
    const pid =
      signal === undefined
        ? null
        : (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
    signal?.throwIfAborted();
    const cancellation: { promise?: Promise<void> } = {};
    const cancel = () => {
      if (pid === null || pid === undefined || cancellation.promise !== undefined) return;
      cancellation.promise = (async () => {
        const canceller = new Client({
          ...this.connectionConfig,
          application_name: "hyperion-public-cancel",
        });
        canceller.on("error", () => undefined);
        try {
          await canceller.connect();
          await canceller.query("SELECT pg_cancel_backend($1)", [pid]);
        } catch {
          // The connection's existing statement timeout remains the final bound if cancellation
          // transport is unavailable. Do not expose its connection error to public clients.
        } finally {
          await canceller.end();
        }
      })();
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const result = await this.measure(options?.workload ?? classifySqlWorkload(text), () =>
        client.query(text, params as unknown[]),
      );
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      throw normalizeDatabaseError(error);
    } finally {
      signal?.removeEventListener("abort", cancel);
      if (cancellation.promise !== undefined) await cancellation.promise;
    }
  }

  private async measure(
    workload: DbWorkload,
    exec: () => Promise<{ rows: unknown[]; rowCount: number | null }>,
  ): Promise<QueryResultRows> {
    const startedAt = performance.now();
    try {
      const result = await exec();
      const durationMs = performance.now() - startedAt;
      this.telemetry.record(workload, durationMs, true);
      const rowCount = result.rowCount ?? 0;
      if (this.slowQueryThresholdMs !== undefined && durationMs >= this.slowQueryThresholdMs) {
        // Never log SQL parameters or raw SQL text that might be misinterpreted.
        this.logger?.warn?.(
          { workload, durationMs: Math.round(durationMs * 1000) / 1000, rowCount },
          "slow database query",
        );
      }
      return { rows: result.rows as Record<string, unknown>[], rowCount };
    } catch (error) {
      const durationMs = performance.now() - startedAt;
      this.telemetry.record(workload, durationMs, false);
      throw error;
    }
  }

  /** Compute a deterministic range digest for indexed event and monetary records (#63). */
  async computeHistoryDigest(options: ComputeHistoryDigestOptions): Promise<HistoryDigestResult> {
    return computeRangeDigest(this, options);
  }

  /** Persist a computed range digest for later backfill/restore verification (#63). */
  async recordHistoryDigest(result: HistoryDigestResult): Promise<StoredHistoryDigest> {
    return storeRangeDigest(this, result);
  }

  /** Recompute and verify a range digest against an expected or stored digest (#63). */
  async verifyHistoryDigest(
    options: ComputeHistoryDigestOptions & { readonly expectedDigest?: string },
  ): Promise<DigestVerificationResult> {
    return verifyRangeDigest(this, options);
  }

  /**
   * Lightweight maintenance task that cleans up completed attestation audit rows older than 30 days.
   * Returns the count of deleted rows.
   */
  async pruneCompletedAttestations(olderThanDays = 30): Promise<number> {
    const { rowCount } = await this.query(
      `DELETE FROM rail_attestation
        WHERE status = 'delivered'
          AND updated_at < now() - ($1 * INTERVAL '1 day')`,
      [olderThanDays],
    );
    return rowCount;
  }

  /**
   * Compact old identical `route_health` samples in bounded batches while preserving change
   * boundaries and recent diagnostic detail.
   */
  async compactRouteHealthSamples(
    options: CompactRouteHealthOptions = {},
  ): Promise<RouteHealthCompactionResult> {
    return compactRouteHealthSamples(this, options);
  }

  /**
   * Run read-only SQL audits for source amount conservation, claim liabilities, and
   * delivery/settlement consistency.
   */
  async auditTransferAndClaimInvariants(): Promise<TransferClaimAuditReport> {
    return auditTransferAndClaimInvariants(this);
  }

  async migrationPreflight(options: MigrationPreflightOptions): Promise<MigrationPreflightReport> {
    return migrationPreflight(this, options);
  }

  migrationRollbackReport(
    migrations: readonly { readonly name: string; readonly downSql: string }[],
  ): MigrationRollbackReport {
    return migrationRollbackReport(migrations);
  }

  async close(): Promise<void> {
    this.admission.close();
    this.closing ??= this.pool.end();
    await this.closing;
  }
}

export class DatabaseTimeoutError extends Error {
  readonly code = "DATABASE_TIMEOUT";

  constructor(readonly kind: "statement" | "lock") {
    super(
      kind === "lock"
        ? "Database lock wait exceeded the configured limit"
        : "Database operation exceeded the configured time limit",
    );
    this.name = "DatabaseTimeoutError";
  }
}

/** A bounded, retryable admission failure that is safe to expose through the public API. */
export class DatabaseBackpressureError extends Error {
  readonly statusCode = 503;
  readonly code = "DATABASE_BACKPRESSURE";

  constructor(readonly retryAfterMs = 250) {
    super("database capacity is temporarily reserved for active work");
    this.name = "DatabaseBackpressureError";
  }
}

const BACKGROUND_WORKLOADS: ReadonlySet<DbWorkload> = new Set([
  "indexer",
  "rails",
  "keeper",
  "maintenance",
  "diagnostics",
  "transaction",
]);

interface AdmissionWaiter {
  readonly workload: DbWorkload;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly cleanup: () => void;
}

/**
 * Keeps pg's internal FIFO queue from becoming the backpressure policy. Foreground work is
 * admitted ahead of worker work, and one connection is reserved for it whenever the pool has
 * more than one connection. The queue is bounded and every waiter has a deadline.
 */
class PoolAdmission {
  private closed = false;
  private active = 0;
  private activeBackground = 0;
  private readonly activeWorkloads = new Map<string, number>();
  private readonly waiting: AdmissionWaiter[] = [];
  private readonly backgroundLimit: number;

  constructor(
    private readonly maxConnections: number,
    private readonly maxWaitingRequests: number,
    private readonly acquireTimeoutMs: number,
  ) {
    if (!Number.isSafeInteger(maxWaitingRequests) || maxWaitingRequests < 1) {
      throw new RangeError("Database waiting requests must be a positive bounded integer.");
    }
    if (maxWaitingRequests > 100_000) {
      throw new RangeError("Database waiting requests exceed the supported bound.");
    }
    this.backgroundLimit = maxConnections > 1 ? maxConnections - 1 : maxConnections;
  }

  async acquire(workload: DbWorkload, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.closed) throw new DatabaseBackpressureError();
    if (this.canStart(workload)) return this.start(workload);
    if (this.waiting.length >= this.maxWaitingRequests) throw new DatabaseBackpressureError();

    return new Promise<() => void>((resolve, reject) => {
      const abort = () => {
        const index = this.waiting.indexOf(waiter);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        waiter.cleanup();
        // Preserve AbortSignal.reason, which may intentionally be any value.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(signal?.reason);
      };
      const waiter: AdmissionWaiter = {
        workload,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) this.waiting.splice(index, 1);
          waiter.cleanup();
          reject(new DatabaseBackpressureError(this.acquireTimeoutMs));
        }, this.acquireTimeoutMs),
        cleanup: () => {
          clearTimeout(waiter.timer);
          signal?.removeEventListener("abort", abort);
        },
      };
      this.waiting.push(waiter);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) {
      waiter.cleanup();
      waiter.reject(new DatabaseBackpressureError());
    }
  }

  snapshot(): {
    queuedRequests: number;
    queuedBackgroundRequests: number;
    activeWorkloads: Readonly<Record<string, number>>;
  } {
    let queuedBackgroundRequests = 0;
    for (const waiter of this.waiting) {
      if (BACKGROUND_WORKLOADS.has(waiter.workload)) queuedBackgroundRequests += 1;
    }
    return {
      queuedRequests: this.waiting.length,
      queuedBackgroundRequests,
      activeWorkloads: Object.fromEntries(this.activeWorkloads),
    };
  }

  private canStart(workload: DbWorkload): boolean {
    return (
      this.active < this.maxConnections &&
      (!BACKGROUND_WORKLOADS.has(workload) || this.activeBackground < this.backgroundLimit)
    );
  }

  private start(workload: DbWorkload): () => void {
    this.active += 1;
    if (BACKGROUND_WORKLOADS.has(workload)) this.activeBackground += 1;
    this.activeWorkloads.set(workload, (this.activeWorkloads.get(workload) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      if (BACKGROUND_WORKLOADS.has(workload)) this.activeBackground -= 1;
      const count = (this.activeWorkloads.get(workload) ?? 1) - 1;
      if (count > 0) this.activeWorkloads.set(workload, count);
      else this.activeWorkloads.delete(workload);
      this.pump();
    };
  }

  private pump(): void {
    if (this.closed) return;
    while (this.active < this.maxConnections) {
      const foreground = this.waiting.findIndex(
        (waiter) => !BACKGROUND_WORKLOADS.has(waiter.workload) && this.canStart(waiter.workload),
      );
      const index =
        foreground >= 0
          ? foreground
          : this.waiting.findIndex((waiter) => this.canStart(waiter.workload));
      if (index < 0) return;
      const [waiter] = this.waiting.splice(index, 1);
      if (waiter === undefined) return;
      waiter.cleanup();
      waiter.resolve(this.start(waiter.workload));
    }
  }
}

function normalizeDatabaseError(error: unknown): unknown {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "57014") return new DatabaseTimeoutError("statement");
  if (code === "55P03") return new DatabaseTimeoutError("lock");
  return error;
}

export interface MaintenanceTaskOptions {
  readonly intervalMs?: number;
  readonly olderThanDays?: number;
  readonly routeHealthRetainRecentHours?: number;
  readonly routeHealthBatchSize?: number;
  readonly logger?: {
    info?: (obj: unknown, msg: string) => void;
    error?: (obj: unknown, msg: string) => void;
    warn?: (obj: unknown, msg: string) => void;
  };
}

/**
 * Periodically runs the attestation cleanup and bounded route-health compaction maintenance tasks.
 * Returns a function to cancel the scheduled task.
 */
export function startMaintenanceTask(
  db: Database,
  options: MaintenanceTaskOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? 24 * 60 * 60 * 1000;
  const olderThanDays = options.olderThanDays ?? 30;
  const routeHealthRetainRecentHours = options.routeHealthRetainRecentHours;
  const routeHealthBatchSize = options.routeHealthBatchSize;

  const timer = setInterval(() => {
    void db.pruneCompletedAttestations(olderThanDays).catch((error: unknown) => {
      options.logger?.warn?.({ err: error }, "maintenance attestation pruning failed");
    });
    void db
      .compactRouteHealthSamples({
        ...(routeHealthRetainRecentHours !== undefined
          ? { retainRecentHours: routeHealthRetainRecentHours }
          : {}),
        ...(routeHealthBatchSize !== undefined ? { batchSize: routeHealthBatchSize } : {}),
      })
      .catch((error: unknown) => {
        options.logger?.warn?.({ err: error }, "maintenance route_health compaction failed");
      });
  }, intervalMs);

  timer.unref();
  return () => {
    clearInterval(timer);
  };
}

function timeoutMilliseconds(value: number | undefined, fallback: number): number {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647)
    throw new RangeError("Database timeouts must be positive bounded integer milliseconds.");
  return timeout;
}
