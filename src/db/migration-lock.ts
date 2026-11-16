/**
 * Session-level PostgreSQL advisory lock coordinator and serialized schema migration runner.
 *
 * Ensures concurrent scheduled jobs and deployment hooks cannot execute the same migration step
 * twice, guarantees lock release on failed or interrupted runs (both via `pg_advisory_unlock` and
 * session termination), and forbids implicit migrations on read-only API instances.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runner as pgMigrateRunner } from "node-pg-migrate";
import { Client } from "pg";
import type { ClientBase } from "pg";

import { ReadOnlyDatabaseError } from "./pool.js";
import type { Database, Queryable } from "./pool.js";
import { boolean, text } from "./rows.js";

const DEFAULT_MIGRATIONS_DIR = resolvePath(
  fileURLToPath(new URL("../../migrations", import.meta.url)),
);

export interface AdvisoryLockKeyPair {
  readonly classId: number;
  readonly objId: number;
}

export interface AdvisoryLockSessionClient {
  query(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[]; readonly rowCount: number }>;
  /** Releases or closes the session; `destroy = true` terminates broken/interrupted sessions. */
  close(destroy?: boolean): Promise<void>;
}

export interface AdvisoryLockSessionSource {
  readonly isReadOnly?: boolean;
  connect(): Promise<AdvisoryLockSessionClient>;
}

export interface MigrationLockOptions {
  readonly lockNamespace?: string;
  readonly schemaName?: string;
  readonly migrationsTable?: string;
  readonly lockTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
  readonly readOnlyInstance?: boolean;
}

export interface MigrationFileStep {
  readonly name: string;
  readonly filename: string;
  readonly upSql: string;
  readonly downSql: string;
}

export interface SerializedMigrationOptions extends MigrationLockOptions {
  readonly direction?: "up" | "down";
  readonly count?: number;
  readonly migrationsDir?: string;
  readonly steps?: readonly MigrationFileStep[];
  /** Optional hook invoked inside the held lock right before applying each step (for race tests). */
  readonly beforeStep?: (stepName: string) => Promise<void>;
}

export interface SerializedMigrationResult {
  readonly direction: "up" | "down";
  readonly lockKeys: AdvisoryLockKeyPair;
  readonly appliedSteps: readonly string[];
  readonly skippedCount: number;
}

export interface ReadOnlyMigrationStatus {
  readonly migrationsTableExists: boolean;
  readonly appliedMigrations: readonly string[];
  readonly pendingMigrations: readonly string[];
  readonly upToDate: boolean;
}

export class MigrationLockTimeoutError extends Error {
  readonly code = "migration_lock_timeout" as const;
  readonly lockKeys: AdvisoryLockKeyPair;
  readonly timeoutMs: number;

  constructor(lockKeys: AdvisoryLockKeyPair, timeoutMs: number) {
    super(
      `timed out after ${String(timeoutMs)}ms waiting for PostgreSQL migration advisory lock (${String(lockKeys.classId)}, ${String(lockKeys.objId)})`,
    );
    this.name = "MigrationLockTimeoutError";
    this.lockKeys = lockKeys;
    this.timeoutMs = timeoutMs;
  }
}

export class MigrationLockInterruptedError extends Error {
  readonly code = "migration_lock_interrupted" as const;

  constructor(stage: "waiting" | "executing") {
    super(`migration run interrupted via AbortSignal while ${stage}`);
    this.name = "MigrationLockInterruptedError";
  }
}

export class ReadOnlyInstanceMigrationError extends Error {
  readonly code = "read_only_instance_migration_forbidden" as const;

  constructor(reason = "read-only API instances must never perform implicit schema migrations") {
    super(reason);
    this.name = "ReadOnlyInstanceMigrationError";
  }
}

function assertSafeIdentifier(identifier: string, label: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new RangeError(`invalid SQL identifier for ${label}: ${identifier}`);
  }
  return identifier;
}

export function redactMigrationSecretText(raw: string): string {
  return raw.replace(/\b(postgres(?:ql)?:\/\/[^:/\s@]+:)([^@\s]+)(@)/gi, "$1[REDACTED]$3");
}

/**
 * Deterministically derives a signed 32-bit `(classId, objId)` pair for PostgreSQL two-key
 * advisory locks (`pg_try_advisory_lock(int4, int4)`).
 */
export function deriveMigrationAdvisoryLockKeys(
  namespace = "hyperion-schema-migrations",
  schemaName = "public",
  migrationsTable = "pgmigrations",
): AdvisoryLockKeyPair {
  const digest = createHash("sha256")
    .update(`${namespace}:${schemaName}:${migrationsTable}`, "utf8")
    .digest();
  const classId = digest.readInt32BE(0);
  const objId = digest.readInt32BE(4);
  return { classId, objId };
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new MigrationLockInterruptedError("waiting"));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new MigrationLockInterruptedError("waiting"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Acquires a session-level PostgreSQL advisory lock on a dedicated connection, executes `work`,
 * and guarantees lock release + connection cleanup on success, failure, or `AbortSignal`
 * interruption.
 */
export async function withMigrationAdvisoryLock<T>(
  source: AdvisoryLockSessionSource,
  work: (session: AdvisoryLockSessionClient, lockKeys: AdvisoryLockKeyPair) => Promise<T>,
  options: MigrationLockOptions = {},
): Promise<T> {
  if (options.readOnlyInstance === true || source.isReadOnly === true) {
    throw new ReadOnlyInstanceMigrationError();
  }
  if (options.signal?.aborted) {
    throw new MigrationLockInterruptedError("waiting");
  }

  const schemaName = assertSafeIdentifier(options.schemaName ?? "public", "schemaName");
  const migrationsTable = assertSafeIdentifier(
    options.migrationsTable ?? "pgmigrations",
    "migrationsTable",
  );
  const lockKeys = deriveMigrationAdvisoryLockKeys(
    options.lockNamespace ?? "hyperion-schema-migrations",
    schemaName,
    migrationsTable,
  );
  const lockTimeoutMs = options.lockTimeoutMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  if (lockTimeoutMs < 1 || pollIntervalMs < 1) {
    throw new RangeError("lockTimeoutMs and pollIntervalMs must be >= 1ms");
  }

  const session = await source.connect();
  let acquired = false;
  let destroySession = false;

  try {
    const deadline = Date.now() + lockTimeoutMs;
    for (;;) {
      if (options.signal?.aborted) {
        destroySession = true;
        throw new MigrationLockInterruptedError("waiting");
      }

      const tryRows = (
        await session.query("SELECT pg_try_advisory_lock($1::int4, $2::int4) AS locked", [
          lockKeys.classId,
          lockKeys.objId,
        ])
      ).rows;
      const firstRow = tryRows[0];
      const locked = firstRow !== undefined && boolean(firstRow, "locked");
      if (locked) {
        acquired = true;
        break;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new MigrationLockTimeoutError(lockKeys, lockTimeoutMs);
      }
      await sleepWithAbort(Math.min(pollIntervalMs, remainingMs), options.signal);
    }

    if (options.signal?.aborted) {
      destroySession = true;
      throw new MigrationLockInterruptedError("executing");
    }

    return await work(session, lockKeys);
  } catch (error) {
    destroySession = true;
    if (error instanceof Error) {
      error.message = redactMigrationSecretText(error.message);
    }
    throw error;
  } finally {
    if (acquired) {
      try {
        const unlockRows = (
          await session.query("SELECT pg_advisory_unlock($1::int4, $2::int4) AS unlocked", [
            lockKeys.classId,
            lockKeys.objId,
          ])
        ).rows;
        const firstUnlock = unlockRows[0];
        if (firstUnlock === undefined || !boolean(firstUnlock, "unlocked")) {
          destroySession = true;
        }
      } catch {
        // If explicit unlock fails, destroying/closing the session guarantees PostgreSQL drops
        // all session-level advisory locks held by that backend process.
        destroySession = true;
      }
    }
    await session.close(destroySession).catch(() => undefined);
  }
}

/**
 * Loads `.sql` migration files from `migrationsDir` split at `-- Down Migration`.
 */
export function loadSqlMigrationSteps(
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): readonly MigrationFileStep[] {
  const filenames = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  return filenames.map((filename) => {
    const raw = readFileSync(join(migrationsDir, filename), "utf8");
    const marker = /^--\s*Down Migration\b/im.exec(raw);
    const upSql = (marker !== null ? raw.slice(0, marker.index) : raw).trim();
    const downSql = (marker !== null ? raw.slice(marker.index + marker[0].length) : "").trim();
    return {
      name: filename.replace(/\.sql$/i, ""),
      filename,
      upSql,
      downSql,
    };
  });
}

/**
 * Executes pending SQL migrations strictly inside `withMigrationAdvisoryLock` so concurrent
 * runners re-check `pgmigrations` after acquiring the lock and never apply a step twice.
 */
export async function runSerializedMigrations(
  source: AdvisoryLockSessionSource,
  options: SerializedMigrationOptions = {},
): Promise<SerializedMigrationResult> {
  const direction = options.direction ?? "up";
  const schemaName = assertSafeIdentifier(options.schemaName ?? "public", "schemaName");
  const migrationsTable = assertSafeIdentifier(
    options.migrationsTable ?? "pgmigrations",
    "migrationsTable",
  );
  const steps = options.steps ?? loadSqlMigrationSteps(options.migrationsDir);

  return withMigrationAdvisoryLock(
    source,
    async (session, lockKeys) => {
      await session.query(
        `CREATE TABLE IF NOT EXISTS "${schemaName}"."${migrationsTable}" (
           id serial PRIMARY KEY,
           name varchar(255) NOT NULL UNIQUE,
           run_on timestamp NOT NULL DEFAULT now()
         )`,
      );

      const appliedRows = (
        await session.query(`SELECT name FROM "${schemaName}"."${migrationsTable}" ORDER BY id ASC`)
      ).rows;
      const appliedNames = appliedRows.map((row) => text(row, "name"));
      const appliedSet = new Set(appliedNames);

      const appliedSteps: string[] = [];
      let skippedCount = 0;

      if (direction === "up") {
        const pending = steps.filter((step) => {
          if (appliedSet.has(step.name)) {
            skippedCount += 1;
            return false;
          }
          return true;
        });
        const boundedPending =
          options.count !== undefined ? pending.slice(0, options.count) : pending;

        for (const step of boundedPending) {
          if (options.signal?.aborted) {
            throw new MigrationLockInterruptedError("executing");
          }
          if (options.beforeStep) {
            await options.beforeStep(step.name);
          }
          if (options.signal?.aborted) {
            throw new MigrationLockInterruptedError("executing");
          }

          await session.query("BEGIN");
          try {
            await session.query(step.upSql);
            await session.query(
              `INSERT INTO "${schemaName}"."${migrationsTable}" (name, run_on) VALUES ($1, now())`,
              [step.name],
            );
            await session.query("COMMIT");
            appliedSteps.push(step.name);
          } catch (error) {
            await session.query("ROLLBACK").catch(() => undefined);
            throw error;
          }
        }
      } else {
        const stepByName = new Map(steps.map((s) => [s.name, s]));
        const maxRollbacks = options.count ?? 1;
        const toRollback = [...appliedNames].reverse().slice(0, maxRollbacks);

        for (const appliedName of toRollback) {
          const step = stepByName.get(appliedName);
          if (!step || step.downSql === "") {
            throw new Error(`cannot roll back migration '${appliedName}': missing down SQL`);
          }
          if (options.signal?.aborted) {
            throw new MigrationLockInterruptedError("executing");
          }
          if (options.beforeStep) {
            await options.beforeStep(step.name);
          }

          await session.query("BEGIN");
          try {
            await session.query(step.downSql);
            await session.query(
              `DELETE FROM "${schemaName}"."${migrationsTable}" WHERE name = $1`,
              [step.name],
            );
            await session.query("COMMIT");
            appliedSteps.push(step.name);
          } catch (error) {
            await session.query("ROLLBACK").catch(() => undefined);
            throw error;
          }
        }
      }

      return {
        direction,
        lockKeys,
        appliedSteps,
        skippedCount,
      };
    },
    options,
  );
}

/**
 * Pure read-only migration status inspection safe for read-only API instances.
 * Never acquires advisory locks, never creates `pgmigrations`, and never runs DDL.
 */
export async function inspectMigrationStatusReadOnly(
  db: Database | Queryable,
  options: {
    readonly schemaName?: string;
    readonly migrationsTable?: string;
    readonly migrationsDir?: string;
    readonly steps?: readonly MigrationFileStep[];
  } = {},
): Promise<ReadOnlyMigrationStatus> {
  const schemaName = assertSafeIdentifier(options.schemaName ?? "public", "schemaName");
  const migrationsTable = assertSafeIdentifier(
    options.migrationsTable ?? "pgmigrations",
    "migrationsTable",
  );
  const steps = options.steps ?? loadSqlMigrationSteps(options.migrationsDir);

  const tableExistsRows = (
    await db.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = $2`,
      [schemaName, migrationsTable],
    )
  ).rows;

  if (tableExistsRows.length === 0) {
    return {
      migrationsTableExists: false,
      appliedMigrations: [],
      pendingMigrations: steps.map((s) => s.name),
      upToDate: steps.length === 0,
    };
  }

  const appliedRows = (
    await db.query(`SELECT name FROM "${schemaName}"."${migrationsTable}" ORDER BY id ASC`)
  ).rows;
  const appliedMigrations = appliedRows.map((row) => text(row, "name"));
  const appliedSet = new Set(appliedMigrations);
  const pendingMigrations = steps.filter((s) => !appliedSet.has(s.name)).map((s) => s.name);

  return {
    migrationsTableExists: true,
    appliedMigrations,
    pendingMigrations,
    upToDate: pendingMigrations.length === 0,
  };
}

/**
 * Rejects immediately if a read-only `Database` handle is passed into a migration entrypoint.
 */
export function createPgSessionSource(
  connectionString: string,
  options: { readonly readOnly?: boolean; readonly applicationName?: string } = {},
): AdvisoryLockSessionSource {
  if (options.readOnly === true) {
    return {
      isReadOnly: true,
      connect: () => Promise.reject(new ReadOnlyDatabaseError("migration session connect")),
    };
  }
  return {
    isReadOnly: false,
    async connect(): Promise<AdvisoryLockSessionClient> {
      const client = new Client({
        connectionString,
        application_name: options.applicationName ?? "hyperion-migration-runner",
      });
      await client.connect();
      return wrapPgClient(client);
    },
  };
}

function wrapPgClient(
  client: Client,
): AdvisoryLockSessionClient & { readonly rawClient: ClientBase } {
  let closed = false;
  return {
    rawClient: client,
    async query(sql: string, params: readonly unknown[] = []) {
      const res = await client.query(sql, params as unknown[]);
      return {
        rows: res.rows as Record<string, unknown>[],
        rowCount: res.rowCount ?? 0,
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      await client.end().catch(() => undefined);
    },
  };
}

function readDatabaseUrlFromDotEnv(envPath: string): string | undefined {
  if (!existsSync(envPath)) return undefined;
  const content = readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    if (key !== "DATABASE_URL") continue;
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value || undefined;
  }
  return undefined;
}

/**
 * CLI runner wrapping `node-pg-migrate` inside our dedicated session-level PostgreSQL advisory
 * lock with bounded wait and `SIGINT`/`SIGTERM` cleanup.
 */
export async function runMigrationCli(
  argv: readonly string[] = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
  writeStderr: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<number> {
  if (env.HYPERION_READ_ONLY_API === "true") {
    writeStderr("refusing to run migrations: HYPERION_READ_ONLY_API=true");
    return 2;
  }

  const directionArg = argv.find((arg) => arg === "up" || arg === "down") ?? "up";
  const direction: "up" | "down" = directionArg === "down" ? "down" : "up";

  const connectionString =
    env.DATABASE_URL ?? readDatabaseUrlFromDotEnv(resolvePath(process.cwd(), ".env"));
  if (!connectionString || connectionString.trim() === "") {
    writeStderr("DATABASE_URL is required to run database migrations");
    return 2;
  }

  const lockTimeoutMs = env.MIGRATION_LOCK_TIMEOUT_MS
    ? Number.parseInt(env.MIGRATION_LOCK_TIMEOUT_MS, 10)
    : 60_000;

  const abortController = new AbortController();
  const onSignal = (): void => {
    abortController.abort();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const source = createPgSessionSource(connectionString);
  try {
    await withMigrationAdvisoryLock(
      source,
      async (session) => {
        const rawClient = (session as unknown as { rawClient: ClientBase }).rawClient;
        await pgMigrateRunner({
          dbClient: rawClient,
          dir: DEFAULT_MIGRATIONS_DIR,
          migrationsTable: "pgmigrations",
          direction,
          noLock: true,
          checkOrder: true,
        });
      },
      {
        lockTimeoutMs: Number.isFinite(lockTimeoutMs) && lockTimeoutMs > 0 ? lockTimeoutMs : 60_000,
        signal: abortController.signal,
      },
    );
    return 0;
  } catch (error) {
    const rawMsg = error instanceof Error ? error.message : String(error);
    writeStderr(`migration execution failed: ${redactMigrationSecretText(rawMsg)}`);
    return 1;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  void runMigrationCli().then((code) => {
    process.exitCode = code;
  });
}
