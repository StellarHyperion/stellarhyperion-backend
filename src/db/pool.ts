/**
 * The Postgres handle with separated per-workload (`api`, `ingestion`, `maintenance`) statement,
 * lock, and idle-in-transaction timeout policies and credential-safe timeout error normalization.
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

export type DbWorkload = "api" | "ingestion" | "maintenance";

export interface WorkloadTimeoutPolicy {
  readonly statementTimeoutMs: number;
  readonly lockTimeoutMs: number;
  readonly idleInTransactionSessionTimeoutMs: number;
  /** Enforces `SET LOCAL transaction_read_only = on` so public API queries cannot take write locks. */
  readonly readOnly: boolean;
}

export type WorkloadTimeoutOverrides = Partial<
  Readonly<Record<DbWorkload, Partial<WorkloadTimeoutPolicy>>>
>;

export const DEFAULT_WORKLOAD_TIMEOUTS: Readonly<Record<DbWorkload, WorkloadTimeoutPolicy>> = {
  api: {
    statementTimeoutMs: 5_000,
    lockTimeoutMs: 1_000,
    idleInTransactionSessionTimeoutMs: 5_000,
    readOnly: true,
  },
  ingestion: {
    statementTimeoutMs: 30_000,
    lockTimeoutMs: 5_000,
    idleInTransactionSessionTimeoutMs: 15_000,
    readOnly: false,
  },
  maintenance: {
    statementTimeoutMs: 60_000,
    lockTimeoutMs: 2_000,
    idleInTransactionSessionTimeoutMs: 30_000,
    readOnly: false,
  },
};

export type DatabaseTimeoutKind =
  "statement_timeout" | "lock_timeout" | "idle_in_transaction_timeout" | "connection_timeout";

/**
 * Normalized, credential-free timeout error surfaced across database workloads.
 */
export class DatabaseTimeoutError extends Error {
  readonly kind: DatabaseTimeoutKind;
  readonly code:
    | "database_statement_timeout"
    | "database_lock_timeout"
    | "database_idle_in_transaction_timeout"
    | "database_connection_timeout";
  readonly workload: DbWorkload;
  readonly sqlState: string | null;
  readonly timeoutMs: number;
  readonly retryable = true;
  readonly statusCode = 503;

  constructor(options: {
    readonly kind: DatabaseTimeoutKind;
    readonly workload: DbWorkload;
    readonly sqlState: string | null;
    readonly timeoutMs: number;
    readonly detail: string;
  }) {
    const code = codeForTimeoutKind(options.kind);
    const cleanDetail = sanitizeDatabaseErrorMessage(options.detail);
    super(`${options.workload} ${options.kind} (${String(options.timeoutMs)}ms): ${cleanDetail}`);
    this.name = "DatabaseTimeoutError";
    this.kind = options.kind;
    this.code = code;
    this.workload = options.workload;
    this.sqlState = options.sqlState;
    this.timeoutMs = options.timeoutMs;
  }
}

function codeForTimeoutKind(
  kind: DatabaseTimeoutKind,
):
  | "database_statement_timeout"
  | "database_lock_timeout"
  | "database_idle_in_transaction_timeout"
  | "database_connection_timeout" {
  switch (kind) {
    case "statement_timeout":
      return "database_statement_timeout";
    case "lock_timeout":
      return "database_lock_timeout";
    case "idle_in_transaction_timeout":
      return "database_idle_in_transaction_timeout";
    case "connection_timeout":
      return "database_connection_timeout";
  }
}

export function isDatabaseTimeoutError(error: unknown): error is DatabaseTimeoutError {
  if (error instanceof DatabaseTimeoutError) return true;
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return (
    code === "database_statement_timeout" ||
    code === "database_lock_timeout" ||
    code === "database_idle_in_transaction_timeout" ||
    code === "database_connection_timeout"
  );
}

/**
 * Strips credentials from PostgreSQL URLs, DSN key/value pairs, and environment hints so logs and
 * normalized error messages never expose passwords or tokens.
 */
export function sanitizeDatabaseErrorMessage(raw: string): string {
  return raw
    .replace(/\b(postgres(?:ql)?:\/\/[^:/\s@]+:)([^@\s]+)(@)/gi, "$1[REDACTED]$3")
    .replace(/\b(password\s*=\s*)('[^']*'|[^\s;]+)/gi, "$1[REDACTED]")
    .replace(/\b(PGPASSWORD\s*=\s*)('[^']*'|[^\s;]+)/gi, "$1[REDACTED]");
}

/**
 * Normalizes PostgreSQL timeout SQLSTATEs (`57014`, `55P03`, `25P03`) and pool connection timeouts
 * into `DatabaseTimeoutError` without preserving raw credential-bearing causes. Any non-timeout
 * `Error` also has embedded DSN credentials scrubbed in place.
 */
export function normalizeWorkloadError(
  error: unknown,
  workload: DbWorkload,
  policy: WorkloadTimeoutPolicy,
  connectionTimeoutMs: number,
): Error {
  if (error instanceof DatabaseTimeoutError) {
    return error;
  }

  const sqlState =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : null;

  const rawMessage = error instanceof Error ? error.message : String(error);
  const cleanMessage = sanitizeDatabaseErrorMessage(rawMessage);

  if (sqlState === "55P03" || /\block timeout\b|could not obtain lock/i.test(cleanMessage)) {
    return new DatabaseTimeoutError({
      kind: "lock_timeout",
      workload,
      sqlState: sqlState ?? "55P03",
      timeoutMs: policy.lockTimeoutMs,
      detail: cleanMessage,
    });
  }

  if (sqlState === "57014" || /\bstatement timeout\b/i.test(cleanMessage)) {
    return new DatabaseTimeoutError({
      kind: "statement_timeout",
      workload,
      sqlState: sqlState ?? "57014",
      timeoutMs: policy.statementTimeoutMs,
      detail: cleanMessage,
    });
  }

  if (sqlState === "25P03" || /idle-in-transaction timeout/i.test(cleanMessage)) {
    return new DatabaseTimeoutError({
      kind: "idle_in_transaction_timeout",
      workload,
      sqlState: sqlState ?? "25P03",
      timeoutMs: policy.idleInTransactionSessionTimeoutMs,
      detail: cleanMessage,
    });
  }

  if (
    /timeout expired|connection terminated due to connection timeout|connect ETIMEDOUT/i.test(
      cleanMessage,
    )
  ) {
    return new DatabaseTimeoutError({
      kind: "connection_timeout",
      workload,
      sqlState,
      timeoutMs: connectionTimeoutMs,
      detail: cleanMessage,
    });
  }

  if (error instanceof Error) {
    error.message = cleanMessage;
    return error;
  }
  return new Error(cleanMessage);
}

export interface PoolClientLike {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  release(err?: Error | boolean): void;
}

export interface PoolBackendLike {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  connect(): Promise<PoolClientLike>;
  end(): Promise<void>;
}

export interface OpenOptions {
  /** Low by default. Two watchers and an HTTP server do not need twenty connections. */
  readonly maxConnections?: number;
  readonly connectionTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly applicationName?: string;
  readonly workloadTimeouts?: WorkloadTimeoutOverrides;
}

function validatePositiveMs(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 3_600_000) {
    throw new RangeError(`${name} (${String(value)}) must be an integer in 1..3600000 ms`);
  }
  return value;
}

export function resolveWorkloadTimeouts(
  options: OpenOptions = {},
): Readonly<Record<DbWorkload, WorkloadTimeoutPolicy>> {
  const overrides = options.workloadTimeouts;
  const ingestionBase =
    options.statementTimeoutMs !== undefined
      ? {
          ...DEFAULT_WORKLOAD_TIMEOUTS.ingestion,
          statementTimeoutMs: options.statementTimeoutMs,
          ...(options.lockTimeoutMs !== undefined ? { lockTimeoutMs: options.lockTimeoutMs } : {}),
        }
      : {
          ...DEFAULT_WORKLOAD_TIMEOUTS.ingestion,
          ...(options.lockTimeoutMs !== undefined ? { lockTimeoutMs: options.lockTimeoutMs } : {}),
        };

  const buildPolicy = (
    workload: DbWorkload,
    defaults: WorkloadTimeoutPolicy,
  ): WorkloadTimeoutPolicy => {
    const custom = overrides?.[workload];
    const statementTimeoutMs = validatePositiveMs(
      `${workload}.statementTimeoutMs`,
      custom?.statementTimeoutMs ?? defaults.statementTimeoutMs,
    );
    const lockTimeoutMs = validatePositiveMs(
      `${workload}.lockTimeoutMs`,
      custom?.lockTimeoutMs ?? defaults.lockTimeoutMs,
    );
    const idleInTransactionSessionTimeoutMs = validatePositiveMs(
      `${workload}.idleInTransactionSessionTimeoutMs`,
      custom?.idleInTransactionSessionTimeoutMs ?? defaults.idleInTransactionSessionTimeoutMs,
    );
    const readOnly = custom?.readOnly ?? defaults.readOnly;
    return {
      statementTimeoutMs,
      lockTimeoutMs,
      idleInTransactionSessionTimeoutMs,
      readOnly,
    };
  };

  const resolved = {
    api: buildPolicy("api", DEFAULT_WORKLOAD_TIMEOUTS.api),
    ingestion: buildPolicy("ingestion", ingestionBase),
    maintenance: buildPolicy("maintenance", DEFAULT_WORKLOAD_TIMEOUTS.maintenance),
  };

  if (resolved.api.lockTimeoutMs > resolved.api.statementTimeoutMs) {
    throw new RangeError("api.lockTimeoutMs cannot exceed api.statementTimeoutMs");
  }

  return resolved;
}

function buildLocalTimeoutSql(policy: WorkloadTimeoutPolicy): string {
  const statements = [
    `SET LOCAL statement_timeout = '${String(policy.statementTimeoutMs)}ms'`,
    `SET LOCAL lock_timeout = '${String(policy.lockTimeoutMs)}ms'`,
    `SET LOCAL idle_in_transaction_session_timeout = '${String(policy.idleInTransactionSessionTimeoutMs)}ms'`,
  ];
  if (policy.readOnly) {
    statements.push("SET LOCAL transaction_read_only = on");
  }
  return statements.join("; ");
}

interface SharedPoolState {
  closed: boolean;
  readonly backend: PoolBackendLike;
  readonly policies: Readonly<Record<DbWorkload, WorkloadTimeoutPolicy>>;
  readonly connectionTimeoutMs: number;
}

export class Database implements Transactional {
  private constructor(
    private readonly state: SharedPoolState,
    private readonly boundWorkload: DbWorkload | null,
  ) {}

  static open(connectionString: string, options: OpenOptions = {}): Database {
    const policies = resolveWorkloadTimeouts(options);
    const connectionTimeoutMs = options.connectionTimeoutMs ?? 10_000;
    const config: PoolConfig = {
      connectionString,
      max: options.maxConnections ?? 10,
      connectionTimeoutMillis: connectionTimeoutMs,
      // Named so `pg_stat_activity` says which process is holding a connection. During an
      // incident that is the difference between knowing and guessing.
      application_name: options.applicationName ?? "hyperion-backend",
      // Connection-level ceiling for direct queries; workload handles tighten or widen per transaction
      // via transaction-scoped `SET LOCAL` so pooled sessions never bleed settings across workloads.
      statement_timeout: options.statementTimeoutMs ?? policies.ingestion.statementTimeoutMs,
      lock_timeout: options.lockTimeoutMs ?? policies.ingestion.lockTimeoutMs,
      idle_in_transaction_session_timeout: policies.ingestion.idleInTransactionSessionTimeoutMs,
    };
    return new Database(
      {
        closed: false,
        backend: new Pool(config),
        policies,
        connectionTimeoutMs,
      },
      null,
    );
  }

  /**
   * Construct a `Database` over an explicit backend for deterministic timeout policy testing.
   */
  static fromBackend(backend: PoolBackendLike, options: OpenOptions = {}): Database {
    const policies = resolveWorkloadTimeouts(options);
    const connectionTimeoutMs = options.connectionTimeoutMs ?? 10_000;
    return new Database(
      {
        closed: false,
        backend,
        policies,
        connectionTimeoutMs,
      },
      null,
    );
  }

  /**
   * Inspect the resolved timeout policy for a workload (`api`, `ingestion`, or `maintenance`).
   */
  timeoutPolicyFor(workload: DbWorkload): WorkloadTimeoutPolicy {
    return this.state.policies[workload];
  }

  /**
   * Return a `Transactional` handle whose queries and transactions execute under `workload`'s
   * isolated `SET LOCAL` statement, lock, and idle-in-transaction timeout policy.
   */
  forWorkload(workload: DbWorkload): Transactional {
    return this.withWorkload(workload);
  }

  /**
   * Return a `Database` view bound to `workload` while sharing the underlying connection pool.
   */
  withWorkload(workload: DbWorkload): Database {
    return new Database(this.state, workload);
  }

  async query(text: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
    if (this.boundWorkload !== null) {
      return this.queryForWorkload(this.boundWorkload, text, params);
    }
    const policy = this.state.policies.ingestion;
    try {
      const result = await this.state.backend.query(text, params as unknown[]);
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? 0 };
    } catch (error) {
      throw normalizeWorkloadError(error, "ingestion", policy, this.state.connectionTimeoutMs);
    }
  }

  /**
   * Run `work` inside one transaction with workload-scoped `SET LOCAL` timeouts.
   * Defaults to the `ingestion` policy when called on an unbound `Database` handle so atomic page
   * writes + cursor commits retain their full bounded window.
   */
  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.transactionForWorkload(this.boundWorkload ?? "ingestion", work);
  }

  async queryForWorkload(
    workload: DbWorkload,
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResultRows> {
    return this.transactionForWorkload(workload, (tx) => tx.query(text, params));
  }

  async transactionForWorkload<T>(
    workload: DbWorkload,
    work: (tx: Queryable) => Promise<T>,
  ): Promise<T> {
    const policy = this.state.policies[workload];
    let client: PoolClientLike;
    try {
      client = await this.state.backend.connect();
    } catch (error) {
      throw normalizeWorkloadError(error, workload, policy, this.state.connectionTimeoutMs);
    }

    try {
      await client.query("BEGIN");
      await client.query(buildLocalTimeoutSql(policy));
      const value = await work(
        wrapClient(client, workload, policy, this.state.connectionTimeoutMs),
      );
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw normalizeWorkloadError(error, workload, policy, this.state.connectionTimeoutMs);
    } finally {
      client.release();
    }
  }

  /** Cheapest possible proof the database is answering, bounded by the tight `api` policy. */
  async ping(): Promise<void> {
    await this.queryForWorkload("api", "SELECT 1");
  }

  /**
   * Lightweight maintenance task that cleans up completed attestation audit rows older than 30 days.
   * Executes under the dedicated `maintenance` timeout policy (`lock_timeout` yields fast while
   * retaining a bounded statement window for batch deletes).
   */
  async pruneCompletedAttestations(olderThanDays = 30): Promise<number> {
    const { rowCount } = await this.queryForWorkload(
      "maintenance",
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
    await this.state.backend.end();
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

function wrapClient(
  client: PoolClientLike,
  workload: DbWorkload,
  policy: WorkloadTimeoutPolicy,
  connectionTimeoutMs: number,
): Queryable {
  return {
    async query(text: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
      if (
        policy.readOnly &&
        /(?:^\s*LOCK\s+TABLE\b|\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b|\bFOR\s+(?:KEY\s+)?SHARE\b)/i.test(
          text,
        )
      ) {
        throw new Error(
          `${workload} read-only workload forbids explicit table or row lock acquisition`,
        );
      }
      try {
        const result = await client.query(text, params as unknown[]);
        return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? 0 };
      } catch (error) {
        throw normalizeWorkloadError(error, workload, policy, connectionTimeoutMs);
      }
    },
  };
}
