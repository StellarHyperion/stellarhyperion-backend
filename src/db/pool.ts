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
import { Pool } from "pg";
import type { PoolClient, PoolConfig } from "pg";

export interface QueryResultRows {
  readonly rows: readonly Record<string, unknown>[];
  /** Null from pg for statements that do not report one. Treated as zero by every caller here. */
  readonly rowCount: number;
}

export interface ReadQueryOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export class QueryCancelledError extends Error {
  readonly code = "QUERY_CANCELLED";

  constructor(message = "database query cancelled after client disconnect") {
    super(message);
    this.name = "QueryCancelledError";
  }
}

export class QueryBudgetExceededError extends Error {
  readonly code = "QUERY_BUDGET_EXCEEDED";

  constructor(message = "database query exceeded request budget") {
    super(message);
    this.name = "QueryBudgetExceededError";
  }
}

/** What both the pool and a transaction offer, so a repository never knows which it has. */
export interface Queryable {
  query(text: string, params?: readonly unknown[]): Promise<QueryResultRows>;
  readQuery?(
    text: string,
    params?: readonly unknown[],
    options?: ReadQueryOptions,
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
  /** Low by default. Two watchers and an HTTP server do not need twenty connections. */
  readonly maxConnections?: number;
  readonly connectionTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly applicationName?: string;
}

export class Database implements Transactional {
  private closed = false;

  private constructor(private readonly pool: Pool) {}

  static open(connectionString: string, options: OpenOptions = {}): Database {
    const config: PoolConfig = {
      connectionString,
      max: options.maxConnections ?? 10,
      connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
      // Named so `pg_stat_activity` says which process is holding a connection. During an
      // incident that is the difference between knowing and guessing.
      application_name: options.applicationName ?? "hyperion-backend",
      // A watcher query that has not finished in thirty seconds is wedged, not slow, and holding
      // the connection does not help it.
      statement_timeout: options.statementTimeoutMs ?? 30_000,
    };
    return new Database(new Pool(config));
  }

  static fromPool(pool: Pool): Database {
    return new Database(pool);
  }

  async query(text: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
    const result = await this.pool.query(text, params as unknown[]);
    return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? 0 };
  }

  /**
   * Execute a read-only statement under an explicit deadline and optional `AbortSignal`.
   *
   * Uses `BEGIN READ ONLY` + `SET LOCAL statement_timeout` so the timeout stays scoped to this
   * transaction, issues `pg_cancel_backend` when the caller aborts, and rolls back cleanly on
   * timeout or cancellation so the pooled connection remains usable for subsequent queries.
   */
  async readQuery(
    text: string,
    params: readonly unknown[] = [],
    options: ReadQueryOptions = {},
  ): Promise<QueryResultRows> {
    if (options.signal?.aborted) {
      throw classifyAbortError(options.signal.reason);
    }
    if (options.timeoutMs !== undefined && options.timeoutMs <= 0) {
      throw new QueryBudgetExceededError();
    }

    const client = await this.pool.connect();
    if (options.signal?.aborted) {
      client.release();
      throw classifyAbortError(options.signal.reason);
    }

    const boundedTimeoutMs = Math.max(1, Math.min(Math.floor(options.timeoutMs ?? 5_000), 60_000));
    const state = { txStarted: false, brokenConnection: false };
    const cleanups: (() => void)[] = [];

    try {
      let backendPid = (client as unknown as { readonly processID?: number }).processID ?? null;
      if (backendPid === null && options.signal !== undefined) {
        const pidResult = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const candidatePid = pidResult.rows[0]?.pid;
        if (typeof candidatePid === "number" && Number.isInteger(candidatePid)) {
          backendPid = candidatePid;
        }
      }

      await client.query("BEGIN READ ONLY");
      state.txStarted = true;
      await client.query(`SET LOCAL statement_timeout = '${String(boundedTimeoutMs)}ms'`);

      if (options.signal?.aborted) {
        throw classifyAbortError(options.signal.reason);
      }

      const signal = options.signal;
      const queryPromise = client.query(text, params as unknown[]);
      const result =
        signal === undefined
          ? await queryPromise
          : await new Promise<Awaited<typeof queryPromise>>((resolve, reject) => {
              const onAbort = () => {
                if (backendPid !== null) {
                  void this.pool
                    .query("SELECT pg_cancel_backend($1)", [backendPid])
                    .catch(() => undefined);
                }
                const graceTimer = setTimeout(() => {
                  state.brokenConnection = true;
                  reject(classifyAbortError(signal.reason));
                }, 200);
                graceTimer.unref();
                cleanups.push(() => {
                  clearTimeout(graceTimer);
                });
              };

              signal.addEventListener("abort", onAbort, { once: true });
              cleanups.push(() => {
                signal.removeEventListener("abort", onAbort);
              });
              queryPromise.then(resolve, reject);
            });

      await client.query("COMMIT");
      state.txStarted = false;
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? 0 };
    } catch (error) {
      if (state.txStarted && !state.brokenConnection) {
        await client.query("ROLLBACK").catch(() => {
          state.brokenConnection = true;
        });
        state.txStarted = false;
      }
      if (options.signal?.aborted) {
        throw classifyAbortError(options.signal.reason);
      }
      if (isPostgresStatementCancelled(error)) {
        throw new QueryBudgetExceededError();
      }
      throw error;
    } finally {
      for (const fn of cleanups) {
        fn();
      }
      client.release(
        state.brokenConnection
          ? new Error("discarding connection after unsettled cancel")
          : undefined,
      );
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
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

function wrapClient(client: PoolClient): Queryable {
  return {
    async query(text: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
      const result = await client.query(text, params as unknown[]);
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? 0 };
    },
  };
}

function classifyAbortError(reason: unknown): QueryCancelledError | QueryBudgetExceededError {
  if (reason instanceof QueryBudgetExceededError) {
    return reason;
  }
  if (reason instanceof QueryCancelledError) {
    return reason;
  }
  return new QueryCancelledError();
}

export function isPostgresStatementCancelled(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const pgCode = (error as { readonly code?: unknown }).code;
  if (pgCode === "57014") {
    return true;
  }
  const message = (error as { readonly message?: unknown }).message;
  if (typeof message === "string") {
    const lower = message.toLowerCase();
    return lower.includes("statement timeout") || lower.includes("canceling statement due to");
  }
  return false;
}

export async function executeBoundedRead(
  db: Queryable,
  text: string,
  params: readonly unknown[] = [],
  options: ReadQueryOptions = {},
): Promise<QueryResultRows> {
  if (typeof db.readQuery === "function") {
    return db.readQuery(text, params, options);
  }

  if (options.signal?.aborted) {
    throw classifyAbortError(options.signal.reason);
  }
  if (options.timeoutMs !== undefined && options.timeoutMs <= 0) {
    throw new QueryBudgetExceededError();
  }

  const queryPromise = db.query(text, params);
  if (options.signal === undefined && options.timeoutMs === undefined) {
    return queryPromise;
  }

  const cleanups: (() => void)[] = [];
  const signal = options.signal;

  try {
    return await new Promise<QueryResultRows>((resolve, reject) => {
      if (options.timeoutMs !== undefined) {
        const timer = setTimeout(() => {
          reject(new QueryBudgetExceededError());
        }, options.timeoutMs);
        timer.unref();
        cleanups.push(() => {
          clearTimeout(timer);
        });
      }

      if (signal !== undefined) {
        const onAbort = () => {
          reject(classifyAbortError(signal.reason));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        cleanups.push(() => {
          signal.removeEventListener("abort", onAbort);
        });
      }

      queryPromise.then(resolve, (error: unknown) => {
        if (signal?.aborted) {
          reject(classifyAbortError(signal.reason));
          return;
        }
        if (isPostgresStatementCancelled(error)) {
          reject(new QueryBudgetExceededError());
          return;
        }
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  } finally {
    for (const fn of cleanups) {
      fn();
    }
  }
}
