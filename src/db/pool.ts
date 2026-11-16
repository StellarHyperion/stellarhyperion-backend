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
import { Pool } from "pg";
import type { PoolConfig } from "pg";

import {
  DbTelemetryCollector,
  createEmptyDbTelemetrySnapshot,
  type DbTelemetrySnapshot,
  type DbWorkload,
  type PoolStatsSource,
  type TelemetryWarnLogger,
} from "./telemetry.js";

export type { DbTelemetrySnapshot, DbWorkload } from "./telemetry.js";
export { DB_WORKLOADS, createEmptyDbTelemetrySnapshot } from "./telemetry.js";

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
 * directly, and that is the seam the watcher tests run through. A watcher's whole correctness
 * claim is about what lands in one transaction, so a test has to be able to watch the
 * transaction boundary rather than infer it, and a real pool cannot be asked what it was told.
 */
export interface Transactional extends Queryable {
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
}

export interface PoolClientLike {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  release(): void;
}

export interface PoolLike extends PoolStatsSource {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  connect(): Promise<PoolClientLike>;
  end(): Promise<void>;
}

export interface OpenOptions {
  /** Low by default. Two watchers and an HTTP server do not need twenty connections. */
  readonly maxConnections?: number | undefined;
  readonly connectionTimeoutMs?: number | undefined;
  readonly statementTimeoutMs?: number | undefined;
  readonly applicationName?: string | undefined;
  readonly saturationThresholdRatio?: number | undefined;
  readonly acquireWarnMs?: number | undefined;
  readonly warnCooldownMs?: number | undefined;
  readonly logger?: TelemetryWarnLogger | undefined;
}

interface SharedPoolState {
  closed: boolean;
}

export class Database implements Transactional {
  private constructor(
    private readonly pool: PoolLike,
    private readonly telemetry: DbTelemetryCollector,
    private readonly workload: DbWorkload,
    private readonly state: SharedPoolState,
  ) {}

  static open(connectionString: string, options: OpenOptions = {}): Database {
    const maxConnections = options.maxConnections ?? 10;
    const config: PoolConfig = {
      connectionString,
      max: maxConnections,
      connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
      // Named so `pg_stat_activity` says which process is holding a connection. During an
      // incident that is the difference between knowing and guessing.
      application_name: options.applicationName ?? "hyperion-backend",
      // A watcher query that has not finished in thirty seconds is wedged, not slow, and holding
      // the connection does not help it.
      statement_timeout: options.statementTimeoutMs ?? 30_000,
    };
    return Database.fromPool(new Pool(config), options);
  }

  static fromPool(pool: PoolLike, options: OpenOptions = {}): Database {
    const telemetry = new DbTelemetryCollector(pool, {
      maxConnections: options.maxConnections ?? 10,
      saturationThresholdRatio: options.saturationThresholdRatio,
      acquireWarnMs: options.acquireWarnMs,
      warnCooldownMs: options.warnCooldownMs,
      logger: options.logger,
    });
    return new Database(pool, telemetry, "api", { closed: false });
  }

  /**
   * Return a lightweight view sharing the underlying connection pool and telemetry collector,
   * attributing all queries and transactions executed through it to `workload`.
   */
  forWorkload(workload: DbWorkload): Database {
    if (workload === this.workload) return this;
    return new Database(this.pool, this.telemetry, workload, this.state);
  }

  telemetrySnapshot(): DbTelemetrySnapshot {
    return this.telemetry.snapshot();
  }

  async query(text: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
    this.telemetry.beginQuery(this.workload);
    const started = performance.now();
    let failed = false;
    try {
      const result = await this.pool.query(text, params as unknown[]);
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? 0 };
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      this.telemetry.endQuery(this.workload, performance.now() - started, failed);
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
    this.telemetry.beginAcquire(this.workload);
    const acquireStarted = performance.now();
    let client: PoolClientLike;
    try {
      client = await this.pool.connect();
      this.telemetry.endAcquire(this.workload, performance.now() - acquireStarted, true);
    } catch (error) {
      this.telemetry.endAcquire(this.workload, performance.now() - acquireStarted, false);
      throw error;
    }

    try {
      await client.query("BEGIN");
      const value = await work(wrapClient(client, this.telemetry, this.workload));
      await client.query("COMMIT");
      this.telemetry.recordTransactionOutcome(this.workload, true);
      return value;
    } catch (error) {
      this.telemetry.recordTransactionOutcome(this.workload, false);
      // A rollback that itself fails means the connection is gone, in which case the server has
      // already rolled back and the original error is the one worth reporting.
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      this.telemetry.releaseCheckout();
      client.release();
    }
  }

  /** Cheapest possible proof the database is answering, for the ready check. */
  async ping(): Promise<void> {
    await this.query("SELECT 1");
  }

  /**
   * Lightweight maintenance task that cleans up completed attestation audit rows older than 30 days.
   * Returns the count of deleted rows.
   */
  async pruneCompletedAttestations(olderThanDays = 30): Promise<number> {
    const maintenanceDb = this.forWorkload("maintenance");
    const { rowCount } = await maintenanceDb.query(
      `DELETE FROM rail_attestation
        WHERE status = 'delivered'
          AND updated_at < now() - ($1 * INTERVAL '1 day')`,
      [olderThanDays],
    );
    return rowCount;
  }

  async close(): Promise<void> {
    if (this.state.closed) return;
    this.state.closed = true;
    await this.pool.end();
  }
}

export function withTransactionalWorkload(db: Transactional, workload: DbWorkload): Transactional {
  const candidate = db as Partial<Database>;
  if (typeof candidate.forWorkload === "function") {
    return candidate.forWorkload(workload);
  }
  return db;
}

export function withDatabaseWorkload(db: Database, workload: DbWorkload): Database {
  const candidate = db as Partial<Database>;
  if (typeof candidate.forWorkload === "function") {
    return candidate.forWorkload(workload);
  }
  return db;
}

export function getDatabaseTelemetry(db: unknown): DbTelemetrySnapshot {
  const candidate = db as Partial<Database> | null | undefined;
  if (candidate && typeof candidate.telemetrySnapshot === "function") {
    return candidate.telemetrySnapshot();
  }
  return createEmptyDbTelemetrySnapshot();
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

function wrapClient(
  client: PoolClientLike,
  telemetry: DbTelemetryCollector,
  workload: DbWorkload,
): Queryable {
  return {
    async query(text: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
      const started = performance.now();
      let failed = false;
      try {
        const result = await client.query(text, params as unknown[]);
        return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? 0 };
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        telemetry.recordClientQuery(workload, performance.now() - started, failed);
      }
    },
  };
}
