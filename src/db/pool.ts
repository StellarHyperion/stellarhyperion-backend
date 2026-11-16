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
  /** Enforce read-only sessions and reject write statements on API-hosted pools. */
  readonly readOnly?: boolean;
}

export class ReadOnlyDatabaseError extends Error {
  constructor(operation: string) {
    super(`read-only database handle refused mutating SQL operation (${operation})`);
    this.name = "ReadOnlyDatabaseError";
  }
}

const MUTATING_SQL_HEAD =
  /^(?:insert|update|delete|create|alter|drop|truncate|grant|revoke|vacuum|reindex|copy|call|do)\b/i;

/**
 * Guard any `Queryable` or `Transactional` handle against write statements on API read paths.
 */
export function assertReadOnlySql(text: string): void {
  const stripped = stripLeadingSqlTrivia(text);
  const match = MUTATING_SQL_HEAD.exec(stripped);
  if (match?.[0] !== undefined) {
    throw new ReadOnlyDatabaseError(match[0].toUpperCase());
  }
}

export class Database implements Transactional {
  private closed = false;

  private constructor(
    private readonly pool: Pool,
    readonly isReadOnly: boolean,
  ) {}

  static open(connectionString: string, options: OpenOptions = {}): Database {
    const readOnly = options.readOnly ?? false;
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
      ...(readOnly ? { options: "-c default_transaction_read_only=on" } : {}),
    };
    return new Database(new Pool(config), readOnly);
  }

  async query(text: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
    if (this.isReadOnly) {
      assertReadOnlySql(text);
    }
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
      await client.query(this.isReadOnly ? "BEGIN READ ONLY" : "BEGIN");
      const value = await work(wrapClient(client, this.isReadOnly));
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

function wrapClient(client: PoolClient, readOnly: boolean): Queryable {
  return {
    async query(text: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
      if (readOnly) {
        assertReadOnlySql(text);
      }
      const result = await client.query(text, params as unknown[]);
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? 0 };
    },
  };
}

function stripLeadingSqlTrivia(sql: string): string {
  let index = 0;
  while (index < sql.length) {
    while (index < sql.length && /\s/.test(sql[index] ?? "")) {
      index += 1;
    }
    if (sql.startsWith("--", index)) {
      const nextNewline = sql.indexOf("\n", index + 2);
      if (nextNewline === -1) return "";
      index = nextNewline + 1;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      const closing = sql.indexOf("*/", index + 2);
      if (closing === -1) return "";
      index = closing + 2;
      continue;
    }
    break;
  }
  return sql.slice(index);
}
