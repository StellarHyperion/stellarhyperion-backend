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
  const applied = (await db.query("SELECT name FROM pgmigrations ORDER BY id")).rows.map((row) =>
    text(row, "name"),
  );
  const missing = options.expectedMigrations.filter((name) => !applied.includes(name));
  const rowCounts: Record<string, number> = {};
  for (const table of MIGRATION_REPORT_TABLES) {
    const result = await db.query(`SELECT count(*)::int AS count FROM ${table}`);
    rowCounts[table] = integer(result.rows[0] ?? {}, "count");
  }
  const invalidConstraints = (await db.query(
    `SELECT conrelid::regclass::text AS relation, conname
       FROM pg_constraint
      WHERE convalidated = false
      ORDER BY relation, conname`,
  )).rows.map((row) => `${text(row, "relation")}.${text(row, "conname")}`);
  const backupRows = (await db.query(
    `SELECT backup_id, migration_name, verified_at
       FROM migration_backup_boundary
      WHERE ($1::text IS NULL OR backup_id = $1)
      ORDER BY verified_at DESC
      LIMIT 1`,
    [options.backupBoundaryId ?? null],
  )).rows;
  const backup = backupRows[0];
  const backupBoundary = backup
    ? {
        id: text(backup, "backup_id"),
        migration: text(backup, "migration_name"),
        verifiedAt: (timestampOrNull(backup, "verified_at") ?? new Date(0)).toISOString(),
      }
    : null;
  const migrationLockAvailable = db.transaction
    ? await db.transaction(async (tx) => {
        const result = await tx.query(
          "SELECT pg_try_advisory_xact_lock(hashtextextended('pgmigrations', 0)) AS available",
        );
        return result.rows[0]?.available === true;
      })
    : false;
  const failures = [
    ...(!migrationLockAvailable ? ["migration advisory lock is not available"] : []),
    ...(invalidConstraints.length > 0
      ? [`unvalidated constraints: ${invalidConstraints.join(", ")}`]
      : []),
    ...(backupBoundary === null ? ["no verified backup boundary is recorded"] : []),
  ];
  return {
    safe: failures.length === 0,
    schema: { applied, missing },
    migrationLockAvailable,
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
    const down = downSql.trim();
    const irreversibleDataRewrite = /\b(?:DELETE|UPDATE|INSERT|TRUNCATE)\b/i.test(down);
    const reversibleSchema = down.length > 0 && !irreversibleDataRewrite;
    return {
      name,
      reversibleSchema,
      irreversibleDataRewrite,
      reason: irreversibleDataRewrite
        ? "down migration rewrites or removes data; restore from the verified backup boundary"
        : reversibleSchema
          ? "down migration contains schema-only reversal"
          : "no executable down migration is present",
    };
  });
  return { entries, backupBoundaryRequired: entries.some((entry) => entry.irreversibleDataRewrite) };
}
