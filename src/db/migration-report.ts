import { PG_MIGRATE_LOCK_ID } from "node-pg-migrate";
import type { Queryable } from "./pool.js";
import { integer, text, timestampOrNull } from "./rows.js";

export const MIGRATION_REPORT_TABLES = [
  "indexer_cursor",
  "outbound_transfer",
  "inbound_delivery",
  "pending_claim",
  "rail_attestation",
  "admin_action",
  "route_health",
] as const;

export interface MigrationPreflightOptions {
  readonly expectedMigrations: readonly string[];
  readonly backupBoundaryId?: string;
}

export interface MigrationPreflightReport {
  readonly safe: boolean;
  readonly schema: { readonly applied: readonly string[]; readonly missing: readonly string[] };
  readonly migrationLockAvailable: boolean;
  readonly rowCounts: Readonly<Record<string, number>>;
  readonly invalidConstraints: readonly string[];
  readonly backupBoundary: {
    readonly id: string;
    readonly migration: string;
    readonly verifiedAt: string;
  } | null;
  readonly failures: readonly string[];
}

export interface MigrationRollbackEntry {
  readonly name: string;
  readonly reversibleSchema: boolean;
  readonly irreversibleDataRewrite: boolean;
  readonly reason: string;
}

export interface MigrationRollbackReport {
  readonly entries: readonly MigrationRollbackEntry[];
  readonly backupBoundaryRequired: boolean;
}

export async function migrationPreflight(
  db: Queryable & { transaction?<T>(work: (tx: Queryable) => Promise<T>): Promise<T> },
  options: MigrationPreflightOptions,
): Promise<MigrationPreflightReport> {
  const unavailable = (failure: string): MigrationPreflightReport => ({
    safe: false,
    schema: { applied: [], missing: [...options.expectedMigrations] },
    migrationLockAvailable: false,
    rowCounts: {},
    invalidConstraints: [],
    backupBoundary: null,
    failures: [failure],
  });
  if (!db.transaction) return unavailable("consistent migration preflight transaction unavailable");
  try {
    return await db.transaction(async (tx) => {
      await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const lock = await tx.query("SELECT pg_try_advisory_xact_lock($1::bigint) AS available", [
        String(PG_MIGRATE_LOCK_ID),
      ]);
      if (lock.rows[0]?.available !== true)
        return unavailable("migration advisory lock is not available");
      return await readMigrationPreflight(tx, options);
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "42P01")
      return unavailable(
        "migration preflight schema is unavailable; apply the required migrations",
      );
    throw error;
  }
}

async function readMigrationPreflight(
  db: Queryable,
  options: MigrationPreflightOptions,
): Promise<MigrationPreflightReport> {
  const applied = (await db.query("SELECT name FROM pgmigrations ORDER BY id")).rows.map((row) =>
    text(row, "name"),
  );
  const missing = options.expectedMigrations.filter((name) => !applied.includes(name));
  const rowCounts: Record<string, number> = {};
  for (const table of MIGRATION_REPORT_TABLES) {
    const result = await db.query(`SELECT count(*)::text AS count FROM ${table}`);
    rowCounts[table] = integer(result.rows[0] ?? {}, "count");
  }
  const invalidConstraints = (
    await db.query(
      `SELECT conrelid::regclass::text AS relation, conname
       FROM pg_constraint
      WHERE convalidated = false
      ORDER BY relation, conname`,
    )
  ).rows.map((row) => `${text(row, "relation")}.${text(row, "conname")}`);
  const backupRows = (
    await db.query(
      `SELECT backup_id, migration_name, verified_at
       FROM migration_backup_boundary
      WHERE ($1::text IS NULL OR backup_id = $1)
      ORDER BY verified_at DESC
      LIMIT 1`,
      [options.backupBoundaryId ?? null],
    )
  ).rows;
  const backup = backupRows[0];
  const backupBoundary = backup
    ? {
        id: text(backup, "backup_id"),
        migration: text(backup, "migration_name"),
        verifiedAt: (timestampOrNull(backup, "verified_at") ?? new Date(0)).toISOString(),
      }
    : null;
  const failures = [
    ...(missing.length > 0 ? [`missing expected migrations: ${missing.join(", ")}`] : []),
    ...(invalidConstraints.length > 0
      ? [`unvalidated constraints: ${invalidConstraints.join(", ")}`]
      : []),
    ...(backupBoundary === null ? ["no verified backup boundary is recorded"] : []),
  ];
  return {
    safe: failures.length === 0,
    schema: { applied, missing },
    migrationLockAvailable: true,
    rowCounts,
    invalidConstraints,
    backupBoundary,
    failures,
  };
}

export function migrationRollbackReport(
  migrations: readonly { readonly name: string; readonly downSql: string }[],
): MigrationRollbackReport {
  const entries = migrations.map(({ name, downSql }) => {
    const down = downSql
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/--[^\n]*/g, " ")
      .trim();
    const statements = down
      .split(";")
      .map((sql) => sql.trim())
      .filter(Boolean);
    // Only explicitly understood non-data reversals can be described as reversible.
    // Dropping tables/columns, CASCADE, procedural SQL and unknown statements require backup.
    const identifier = '(?:[a-z_][a-z0-9_]*|"[^"]+")';
    const qualified = `${identifier}(?:\\.${identifier})?`;
    const nonDataReversal = new RegExp(
      `^(?:DROP\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+EXISTS\\s+)?${qualified}(?:\\s+RESTRICT)?|` +
        `ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${qualified}\\s+DROP\\s+CONSTRAINT\\s+(?:IF\\s+EXISTS\\s+)?${identifier}(?:\\s+RESTRICT)?|` +
        `ALTER\\s+(?:TABLE|INDEX)\\s+${qualified}\\s+RENAME\\s+(?:(?:COLUMN|CONSTRAINT)\\s+${identifier}\\s+)?TO\\s+${identifier}|` +
        `COMMENT\\s+ON\\s+(?:TABLE|INDEX|COLUMN)\\s+${qualified}\\s+IS\\s+(?:NULL|'(?:''|[^'])*'))$`,
      "i",
    );
    const reversibleSchema =
      statements.length > 0 && statements.every((sql) => nonDataReversal.test(sql));
    const irreversibleDataRewrite = statements.length > 0 && !reversibleSchema;
    return {
      name,
      reversibleSchema,
      irreversibleDataRewrite,
      reason: irreversibleDataRewrite
        ? "down migration may rewrite or remove data; restore from the verified backup boundary"
        : reversibleSchema
          ? "down migration contains schema-only reversal"
          : "no executable down migration is present",
    };
  });
  return { entries, backupBoundaryRequired: entries.some((entry) => !entry.reversibleSchema) };
}
