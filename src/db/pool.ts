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
  /** Restricts session and client SQL execution to read-only queries for API-only deployments. */
  readonly readOnly?: boolean;
}

export class ReadOnlyViolationError extends Error {
  constructor(reason: string) {
    super(`Read-only database policy refused SQL execution: ${reason}`);
    this.name = "ReadOnlyViolationError";
  }
}

const FORBIDDEN_WRITE_KEYWORDS = new Set([
  "insert",
  "update",
  "delete",
  "merge",
  "truncate",
  "create",
  "alter",
  "drop",
  "grant",
  "revoke",
  "copy",
  "call",
  "do",
  "vacuum",
  "analyze",
  "cluster",
  "reindex",
  "refresh",
  "lock",
  "comment",
  "security",
  "set",
  "reset",
  "listen",
  "notify",
  "unlisten",
  "prepare",
  "execute",
  "deallocate",
]);

function stripSqlCommentsAndLiterals(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i += 1;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      out += " ";
      continue;
    }
    if (ch === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      out += " '' ";
      continue;
    }
    if (ch === '"') {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2;
          continue;
        }
        if (sql[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      out += ' "id" ';
      continue;
    }
    out += ch ?? "";
    i += 1;
  }
  return out;
}

export function assertReadOnlySql(sql: string): void {
  const sanitized = stripSqlCommentsAndLiterals(sql).trim();
  if (sanitized.length === 0) {
    throw new ReadOnlyViolationError("empty SQL statement");
  }

  const statements = sanitized
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (statements.length > 1) {
    throw new ReadOnlyViolationError("multi-statement SQL batches are not permitted");
  }

  const statement = statements[0] ?? "";
  const tokens = statement.toLowerCase().match(/[a-z_][a-z0-9_$]*/g) ?? [];
  const lead = tokens[0];
  if (lead !== "select" && lead !== "with" && lead !== "show") {
    throw new ReadOnlyViolationError(
      `only SELECT, WITH ... SELECT, and SHOW statements are permitted (found ${lead ?? "unknown"})`,
    );
  }

  for (let idx = 0; idx < tokens.length; idx += 1) {
    const token = tokens[idx] ?? "";
    if (FORBIDDEN_WRITE_KEYWORDS.has(token)) {
      throw new ReadOnlyViolationError(
        `forbidden keyword "${token.toUpperCase()}" in read-only mode`,
      );
    }
    if (token === "for") {
      const next = tokens[idx + 1];
      if (next === "update" || next === "share" || next === "no" || next === "key") {
        throw new ReadOnlyViolationError(
          "row-locking FOR clauses are not permitted in read-only mode",
        );
      }
    }
  }
}

export class Database implements Transactional {
  private closed = false;

  private constructor(
    private readonly pool: Pool,
    private readonly readOnlyMode: boolean,
  ) {}

  get isReadOnly(): boolean {
    return this.readOnlyMode;
  }

  static open(connectionString: string, options: OpenOptions = {}): Database {
    const readOnly = options.readOnly === true;
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
    if (this.readOnlyMode) {
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
      await client.query(this.readOnlyMode ? "BEGIN READ ONLY" : "BEGIN");
      const value = await work(wrapClient(client, this.readOnlyMode));
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
    if (this.readOnlyMode) {
      throw new ReadOnlyViolationError("attestation pruning requires a readwrite database role");
    }
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
  if (db.isReadOnly) {
    throw new ReadOnlyViolationError(
      "maintenance task cannot run with a read-only database handle",
    );
  }
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

function wrapClient(client: PoolClient, readOnlyMode: boolean): Queryable {
  return {
    async query(text: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
      if (readOnlyMode) {
        assertReadOnlySql(text);
      }
      const result = await client.query(text, params as unknown[]);
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? 0 };
    },
  };
}
