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
  readonly connectionTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly applicationName?: string;
  readonly maxLatencySamplesPerWorkload?: number;
  readonly slowQueryThresholdMs?: number;
  readonly logger?: {
    warn?: (obj: unknown, msg: string) => void;
  };
}

export class Database implements Transactional {
  private closed = false;
  private readonly telemetry: DbTelemetryCollector;
  private readonly maxConnections: number;
  private readonly slowQueryThresholdMs: number | undefined;
  private readonly logger: OpenOptions["logger"];

  private constructor(
    private readonly pool: Pool,
    private readonly connectionConfig: PoolConfig,
    options: OpenOptions = {},
  ) {
    this.maxConnections = options.maxConnections ?? 10;
    this.telemetry = new DbTelemetryCollector(options.maxLatencySamplesPerWorkload);
    this.slowQueryThresholdMs = options.slowQueryThresholdMs;
    this.logger = options.logger;
  }

  static open(connectionString: string, options: OpenOptions = {}): Database {
    const maxConnections = options.maxConnections ?? 10;
    const config: PoolConfig = {
      connectionString,
      max: maxConnections,
      ...(options.readOnly ? { options: "-c default_transaction_read_only=on" } : {}),
      connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
      // Named so `pg_stat_activity` says which process is holding a connection. During an
      // incident that is the difference between knowing and guessing.
      application_name: options.applicationName ?? "hyperion-backend",
      // A watcher query that has not finished in thirty seconds is wedged, not slow, and holding
      // the connection does not help it.
      statement_timeout: options.statementTimeoutMs ?? 30_000,
    };
    return new Database(new Pool(config), config, { ...options, maxConnections });
  }

  async query(
    text: string,
    params: readonly unknown[] = [],
    options?: QueryOptions,
  ): Promise<QueryResultRows> {
    const workload = options?.workload ?? classifySqlWorkload(text);
    if (options?.signal === undefined)
      return this.measure(workload, () => this.pool.query(text, params as unknown[]));
    const client = await this.pool.connect();
    try {
      return await this.queryClient(client, text, params, options);
    } finally {
      client.release();
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
    const client = await this.pool.connect();
    try {
      await this.measure("transaction", () => client.query("BEGIN"));
      const run = currentWorkerRun();
      if (run !== undefined)
        await client.query("SELECT set_config('hyperion.worker_run_id',$1,true)", [run.runId]);
      const value = await work(this.wrapClient(client));
      await this.measure("transaction", () => client.query("COMMIT"));
      return value;
    } catch (error) {
      // A rollback that itself fails means the connection is gone, in which case the server has
      // already rolled back and the original error is the one worth reporting.
      await this.measure("transaction", () => client.query("ROLLBACK")).catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
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
    });
  }

  telemetrySnapshot(): DbTelemetrySnapshot {
    return this.telemetry.snapshot({
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
      maxConnections: this.maxConnections,
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
      throw error;
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
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
