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
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { PoolClient, PoolConfig } from "pg";
import { runAttestationRetentionJob, runRouteHealthRetentionJob } from "../chains/writers.js";
import type {
  AttestationRetentionJobOptions,
  MaintenanceRunResult,
  RouteHealthRetentionJobOptions,
} from "../chains/writers.js";

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

export interface OpenOptions {
  /** Low by default. Two watchers and an HTTP server do not need twenty connections. */
  readonly maxConnections?: number;
  readonly connectionTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly applicationName?: string;
  readonly maintenanceOwnerId?: string;
}

export interface MaintenanceCycleOptions {
  readonly ownerId?: string;
  readonly attestationOlderThanDays?: number;
  readonly routeHealthOlderThanDays?: number;
  readonly batchSize?: number;
  readonly maxBatches?: number;
  readonly leaseDurationMs?: number;
  readonly requireInboundProvenance?: boolean;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

export interface MaintenanceCycleResult {
  readonly attestations: MaintenanceRunResult;
  readonly routeHealth: MaintenanceRunResult;
}

export class Database implements Transactional {
  private closed = false;
  readonly maintenanceOwnerId: string;

  private constructor(
    private readonly pool: Pool,
    maintenanceOwnerId: string,
  ) {
    this.maintenanceOwnerId = maintenanceOwnerId;
  }

  static open(connectionString: string, options: OpenOptions = {}): Database {
    const appName = options.applicationName ?? "hyperion-backend";
    const config: PoolConfig = {
      connectionString,
      max: options.maxConnections ?? 10,
      connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
      // Named so `pg_stat_activity` says which process is holding a connection. During an
      // incident that is the difference between knowing and guessing.
      application_name: appName,
      // A watcher query that has not finished in thirty seconds is wedged, not slow, and holding
      // the connection does not help it.
      statement_timeout: options.statementTimeoutMs ?? 30_000,
    };
    const ownerId = options.maintenanceOwnerId ?? `${appName}:${randomUUID()}`;
    return new Database(new Pool(config), ownerId);
  }

  async query(text: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
    const result = await this.pool.query(text, params as unknown[]);
    return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? 0 };
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
      await client.query("BEGIN");
      const value = await work(wrapClient(client));
      await client.query("COMMIT");
      return value;
    } catch (error) {
      // A rollback that itself fails means the connection is gone, in which case the server has
      // already rolled back and the original error is the one worth reporting.
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Cheapest possible proof the database is answering, for the ready check. */
  async ping(): Promise<void> {
    await this.query("SELECT 1");
  }

  /**
   * Bounded, lease-protected cleanup of completed attestation audit rows older than the configured
   * retention window. Returns the count of deleted rows in this run.
   */
  async pruneCompletedAttestations(
    olderThanDays = 30,
    options: Omit<Partial<AttestationRetentionJobOptions>, "olderThanDays"> = {},
  ): Promise<number> {
    const result = await runAttestationRetentionJob(this, {
      ...options,
      ownerId: options.ownerId ?? this.maintenanceOwnerId,
      olderThanDays,
    });
    return result.deletedCount;
  }

  /**
   * Bounded, lease-protected cleanup of superseded route health samples older than the configured
   * retention window while preserving the latest sample per route and token.
   */
  async pruneRouteHealthSamples(
    olderThanDays = 14,
    options: Omit<Partial<RouteHealthRetentionJobOptions>, "olderThanDays"> = {},
  ): Promise<number> {
    const result = await runRouteHealthRetentionJob(this, {
      ...options,
      ownerId: options.ownerId ?? this.maintenanceOwnerId,
      olderThanDays,
    });
    return result.deletedCount;
  }

  async runMaintenanceCycle(
    options: MaintenanceCycleOptions = {},
  ): Promise<MaintenanceCycleResult> {
    const ownerId = options.ownerId ?? this.maintenanceOwnerId;
    const shared = {
      ownerId,
      ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
      ...(options.maxBatches !== undefined ? { maxBatches: options.maxBatches } : {}),
      ...(options.leaseDurationMs !== undefined
        ? { leaseDurationMs: options.leaseDurationMs }
        : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    };

    const attestations = await runAttestationRetentionJob(this, {
      ...shared,
      olderThanDays: options.attestationOlderThanDays ?? 30,
      ...(options.requireInboundProvenance !== undefined
        ? { requireInboundProvenance: options.requireInboundProvenance }
        : {}),
    });

    const routeHealth = await runRouteHealthRetentionJob(this, {
      ...shared,
      olderThanDays: options.routeHealthOlderThanDays ?? 14,
    });

    return { attestations, routeHealth };
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
  readonly routeHealthOlderThanDays?: number;
  readonly batchSize?: number;
  readonly maxBatches?: number;
  readonly leaseDurationMs?: number;
  readonly ownerId?: string;
  readonly requireInboundProvenance?: boolean;
  readonly logger?: {
    info?: (obj: unknown, msg: string) => void;
    error?: (obj: unknown, msg: string) => void;
    warn?: (obj: unknown, msg: string) => void;
  };
}

/**
 * Periodically runs bounded, lease-protected retention maintenance tasks.
 * Returns a function to cancel the scheduled task and abort any active batch loop.
 */
export function startMaintenanceTask(
  db: Pick<Database, "runMaintenanceCycle">,
  options: MaintenanceTaskOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? 24 * 60 * 60 * 1000;
  const controller = new AbortController();
  let inFlight = false;

  const timer = setInterval(() => {
    if (inFlight || controller.signal.aborted) return;
    inFlight = true;
    void db
      .runMaintenanceCycle({
        attestationOlderThanDays: options.olderThanDays ?? 30,
        routeHealthOlderThanDays: options.routeHealthOlderThanDays ?? 14,
        ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
        ...(options.maxBatches !== undefined ? { maxBatches: options.maxBatches } : {}),
        ...(options.leaseDurationMs !== undefined
          ? { leaseDurationMs: options.leaseDurationMs }
          : {}),
        ...(options.ownerId !== undefined ? { ownerId: options.ownerId } : {}),
        ...(options.requireInboundProvenance !== undefined
          ? { requireInboundProvenance: options.requireInboundProvenance }
          : {}),
        signal: controller.signal,
      })
      .then((cycle) => {
        if (cycle.attestations.deletedCount > 0 || cycle.routeHealth.deletedCount > 0) {
          options.logger?.info?.(
            {
              attestationsDeleted: cycle.attestations.deletedCount,
              attestationsCompleted: cycle.attestations.completed,
              routeHealthDeleted: cycle.routeHealth.deletedCount,
              routeHealthCompleted: cycle.routeHealth.completed,
            },
            "maintenance retention cycle completed",
          );
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "unknown maintenance error";
        options.logger?.warn?.({ errorMessage: message }, "maintenance retention cycle failed");
      })
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);

  timer.unref();
  return () => {
    controller.abort();
    clearInterval(timer);
  };
}

function wrapClient(client: PoolClient): Queryable {
  return {
    async query(text: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
      const result = await client.query(text, params as unknown[]);
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? 0 };
    },
  };
}
