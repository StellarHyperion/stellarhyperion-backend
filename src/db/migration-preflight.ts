/**
 * Executable database migration preflight analyzer and rollback feasibility reporter.
 *
 * Inspects migration SQL files alongside live read-only PostgreSQL catalog, lock, row-count, and
 * constraint state before any schema change runs:
 *   - Classifies each pending migration as reversible schema DDL vs irreversible data rewrite.
 *   - Blocks unsafe conditions (conflicting locks, long open transactions, broken/NOT VALID
 *     constraints, missing down migrations, weakened monetary constraints, or irreversible
 *     rewrites lacking a verified backup boundary) before altering schema.
 *   - Emits deterministic recovery instructions anchored to a verified backup boundary and live
 *     indexer cursor replay floor.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Database } from "./pool.js";
import type { Queryable, Transactional } from "./pool.js";
import { bigintOf, boolean, integer, text, textOrNull, timestampOrNull } from "./rows.js";

const DEFAULT_MIGRATIONS_DIR = resolvePath(
  fileURLToPath(new URL("../../migrations", import.meta.url)),
);

const CORE_INDEXED_TABLES = [
  "indexer_cursor",
  "outbound_transfer",
  "inbound_delivery",
  "pending_claim",
  "rail_attestation",
  "admin_action",
  "route_health",
] as const;

const PROTECTED_MONETARY_CONSTRAINTS = [
  "outbound_transfer_amounts",
  "outbound_transfer_identity",
  "inbound_delivery_claim",
  "inbound_delivery_hop",
  "pending_claim_settlement",
] as const;

export type RollbackFeasibility =
  | "reversible_schema"
  | "reversible_when_empty"
  | "irreversible_data_rewrite"
  | "missing_down_migration";

export type LockRiskClass =
  "metadata_only" | "share_index_build" | "access_exclusive_ddl" | "table_rewrite";

export type UnsafeConditionCode =
  | "blocking_locks_detected"
  | "long_running_transaction_detected"
  | "unvalidated_constraint_detected"
  | "missing_down_migration"
  | "monetary_constraint_weakened"
  | "irreversible_migration_without_verified_backup"
  | "backup_boundary_invalid"
  | "applied_migration_missing_on_disk"
  | "row_count_rewrite_threshold_exceeded";

export interface MigrationStatementAnalysis {
  readonly summary: string;
  readonly targetTable: string | null;
  readonly feasibility: Exclude<RollbackFeasibility, "missing_down_migration">;
  readonly lockRisk: LockRiskClass;
  readonly weakensMonetaryConstraint: boolean;
}

export interface MigrationFileReport {
  readonly name: string;
  readonly filename: string;
  readonly applied: boolean;
  readonly hasDownMigration: boolean;
  readonly upStatementCount: number;
  readonly downStatementCount: number;
  readonly targetTables: readonly string[];
  readonly affectedRowCount: number;
  readonly feasibility: RollbackFeasibility;
  readonly highestLockRisk: LockRiskClass;
  readonly weakensMonetaryConstraint: boolean;
  readonly statements: readonly MigrationStatementAnalysis[];
  readonly notes: readonly string[];
}

export interface ActiveLockDiagnostic {
  readonly pid: number;
  readonly relation: string;
  readonly mode: string;
  readonly granted: boolean;
  readonly state: string | null;
  readonly ageSeconds: number;
}

export interface UnvalidatedConstraintDiagnostic {
  readonly tableName: string;
  readonly constraintName: string;
}

export interface CursorReplayPoint {
  readonly chainKey: string;
  readonly family: string;
  readonly contract: string;
  readonly lastProcessed: string;
  readonly lastProcessedHash: string | null;
}

export interface BackupBoundaryInput {
  readonly backupId: string;
  readonly capturedAt: string;
  readonly artifactSha256?: string;
  readonly lastAppliedMigration?: string | null;
  readonly cursorCheckpoints?: Readonly<Record<string, string>>;
}

export interface VerifiedBackupBoundary {
  readonly verified: boolean;
  readonly status: "verified_artifact" | "empty_database_baseline" | "unverified";
  readonly backupId: string | null;
  readonly capturedAt: string | null;
  readonly artifactSha256: string | null;
  readonly schemaBoundary: string | null;
  readonly cursorReplayFloor: readonly CursorReplayPoint[];
  readonly verificationDetail: string;
}

export interface UnsafeMigrationCondition {
  readonly code: UnsafeConditionCode;
  readonly message: string;
  readonly migration: string | null;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

export interface MigrationRecoveryInstructions {
  readonly strategy: "down_migration_rollback" | "restore_verified_backup_and_replay";
  readonly backupBoundaryId: string;
  readonly backupCapturedAt: string | null;
  readonly schemaBoundary: string | null;
  readonly steps: readonly string[];
}

export interface MigrationPreflightReport {
  readonly safe: boolean;
  readonly checkedAt: string;
  readonly schemaName: string;
  readonly appliedMigrations: readonly string[];
  readonly pendingMigrations: readonly string[];
  readonly tableRowCounts: Readonly<Record<string, number>>;
  readonly totalIndexedRows: number;
  readonly activeLocks: readonly ActiveLockDiagnostic[];
  readonly longRunningTransactionCount: number;
  readonly unvalidatedConstraints: readonly UnvalidatedConstraintDiagnostic[];
  readonly migrations: readonly MigrationFileReport[];
  readonly backupBoundary: VerifiedBackupBoundary;
  readonly unsafeConditions: readonly UnsafeMigrationCondition[];
  readonly recoveryInstructions: MigrationRecoveryInstructions;
}

export interface MigrationFileInput {
  readonly filename: string;
  readonly sql: string;
}

export interface MigrationPreflightOptions {
  readonly migrationsDir?: string;
  readonly migrationFiles?: readonly MigrationFileInput[];
  readonly schemaName?: string;
  readonly migrationsTable?: string;
  readonly backupBoundary?: BackupBoundaryInput;
  readonly requireVerifiedBackup?: boolean;
  readonly maxOpenTransactionSeconds?: number;
  readonly maxRewriteTableRows?: number;
}

export class MigrationPreflightError extends Error {
  readonly code = "migration_preflight_failed" as const;
  readonly report: MigrationPreflightReport;

  constructor(report: MigrationPreflightReport) {
    const reasons = report.unsafeConditions.map((c) => `${c.code}: ${c.message}`).join("; ");
    super(`migration preflight blocked unsafe schema execution: ${reasons}`);
    this.name = "MigrationPreflightError";
    this.report = report;
  }
}

function isTransactional(db: Queryable): db is Transactional {
  return "transaction" in db && typeof (db as { transaction?: unknown }).transaction === "function";
}

function assertSafeIdentifier(identifier: string, label: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new RangeError(`invalid SQL identifier for ${label}: ${identifier}`);
  }
  return identifier;
}

export function redactPreflightSecrets(raw: string): string {
  return raw.replace(/\b(postgres(?:ql)?:\/\/[^:/\s@]+:)([^@\s]+)(@)/gi, "$1[REDACTED]$3");
}

/**
 * Loads `.sql` migration files from disk sorted in execution order.
 */
export function loadMigrationFilesFromDir(
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): readonly MigrationFileInput[] {
  const entries = readdirSync(migrationsDir)
    .filter((entry) => entry.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));
  return entries.map((filename) => ({
    filename,
    sql: readFileSync(join(migrationsDir, filename), "utf8"),
  }));
}

/**
 * Strips SQL comments and string literal bodies so classification inspects executable tokens only.
 */
function stripCommentsAndStrings(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      out += "\n";
      i += 1;
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
      out += "''";
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
      continue;
    }
    out += ch ?? "";
    i += 1;
  }
  return out;
}

function splitSqlStatements(sectionSql: string): readonly string[] {
  const cleaned = stripCommentsAndStrings(sectionSql);
  return cleaned
    .split(";")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0);
}

function normalizeTableName(rawTable: string): string {
  const cleaned = rawTable.replace(/"/g, "").trim();
  const segments = cleaned.split(".");
  return (segments[segments.length - 1] ?? cleaned).toLowerCase();
}

function extractTargetTable(rawStmt: string): string | null {
  const patterns = [
    /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."]+)/i,
    /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([A-Za-z0-9_."]+)/i,
    /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([A-Za-z0-9_."]+)/i,
    /^TRUNCATE\s+(?:TABLE\s+)?([A-Za-z0-9_."]+)/i,
    /^UPDATE\s+(?:ONLY\s+)?([A-Za-z0-9_."]+)/i,
    /^DELETE\s+FROM\s+(?:ONLY\s+)?([A-Za-z0-9_."]+)/i,
    /^INSERT\s+INTO\s+([A-Za-z0-9_."]+)/i,
    /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?[A-Za-z0-9_."]+\s+ON\s+(?:ONLY\s+)?([A-Za-z0-9_."]+)/i,
    /^COMMENT\s+ON\s+TABLE\s+([A-Za-z0-9_."]+)/i,
    /^COMMENT\s+ON\s+COLUMN\s+([A-Za-z0-9_."]+)\.[A-Za-z0-9_"]+/i,
    /^COMMENT\s+ON\s+CONSTRAINT\s+[A-Za-z0-9_"]+\s+ON\s+([A-Za-z0-9_."]+)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(rawStmt);
    if (match?.[1]) {
      return normalizeTableName(match[1]);
    }
  }
  return null;
}

function classifyUpStatement(stmt: string): MigrationStatementAnalysis {
  const upper = stmt.toUpperCase();
  const targetTable = extractTargetTable(stmt);
  const summary = stmt.length > 96 ? `${stmt.slice(0, 93)}...` : stmt;

  let weakensMonetaryConstraint = false;
  for (const protectedName of PROTECTED_MONETARY_CONSTRAINTS) {
    const dropRegex = new RegExp(
      `\\bDROP\\s+CONSTRAINT\\s+(?:IF\\s+EXISTS\\s+)?${protectedName}\\b`,
      "i",
    );
    if (dropRegex.test(stmt)) {
      weakensMonetaryConstraint = true;
    }
  }
  if (
    /\bALTER\s+COLUMN\s+(?:gross_amount|fee|net_amount|amount|flow_available)\b[\s\S]*\bTYPE\s+(?:bigint|integer|int8|int4|real|float|double|numeric\s*\(\s*(?:[1-6]?\d|7[0-7])\b)/i.test(
      stmt,
    ) ||
    /\bALTER\s+COLUMN\s+(?:nonce|source_nonce|claim_id|action_id|last_processed|origin_block|destination_block)\b[\s\S]*\bTYPE\s+(?:bigint|integer|int8|int4)\b/i.test(
      stmt,
    )
  ) {
    weakensMonetaryConstraint = true;
  }

  // Irreversible data mutations / rewrites
  if (
    upper.startsWith("UPDATE ") ||
    upper.startsWith("DELETE FROM ") ||
    upper.startsWith("TRUNCATE ")
  ) {
    return {
      summary,
      targetTable,
      feasibility: "irreversible_data_rewrite",
      lockRisk: upper.startsWith("TRUNCATE ") ? "access_exclusive_ddl" : "table_rewrite",
      weakensMonetaryConstraint,
    };
  }

  if (upper.startsWith("ALTER TABLE ")) {
    if (/\bALTER\s+COLUMN\b[\s\S]*\bTYPE\b/i.test(stmt)) {
      return {
        summary,
        targetTable,
        feasibility: "irreversible_data_rewrite",
        lockRisk: "table_rewrite",
        weakensMonetaryConstraint,
      };
    }
    if (/\bDROP\s+COLUMN\b/i.test(stmt)) {
      return {
        summary,
        targetTable,
        feasibility: "reversible_when_empty",
        lockRisk: "access_exclusive_ddl",
        weakensMonetaryConstraint,
      };
    }
    if (/\bSET\s*\(|\bRESET\s*\(/i.test(stmt)) {
      return {
        summary,
        targetTable,
        feasibility: "reversible_schema",
        lockRisk: "metadata_only",
        weakensMonetaryConstraint,
      };
    }
    if (/\bADD\s+COLUMN\b[\s\S]*\bNOT\s+NULL\b/i.test(stmt) && !/\bDEFAULT\b/i.test(stmt)) {
      return {
        summary,
        targetTable,
        feasibility: "reversible_when_empty",
        lockRisk: "table_rewrite",
        weakensMonetaryConstraint,
      };
    }
    return {
      summary,
      targetTable,
      feasibility: "reversible_schema",
      lockRisk: "access_exclusive_ddl",
      weakensMonetaryConstraint,
    };
  }

  if (upper.startsWith("DROP TABLE ")) {
    return {
      summary,
      targetTable,
      feasibility: "reversible_when_empty",
      lockRisk: "access_exclusive_ddl",
      weakensMonetaryConstraint,
    };
  }

  if (/^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(stmt)) {
    const isConcurrent = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(stmt);
    return {
      summary,
      targetTable,
      feasibility: "reversible_schema",
      lockRisk: isConcurrent ? "metadata_only" : "share_index_build",
      weakensMonetaryConstraint,
    };
  }

  if (upper.startsWith("COMMENT ON ")) {
    return {
      summary,
      targetTable,
      feasibility: "reversible_schema",
      lockRisk: "metadata_only",
      weakensMonetaryConstraint,
    };
  }

  if (upper.startsWith("INSERT INTO ")) {
    return {
      summary,
      targetTable,
      feasibility: "irreversible_data_rewrite",
      lockRisk: "table_rewrite",
      weakensMonetaryConstraint,
    };
  }

  return {
    summary,
    targetTable,
    feasibility: "reversible_schema",
    lockRisk: "access_exclusive_ddl",
    weakensMonetaryConstraint,
  };
}

function rankLockRisk(risk: LockRiskClass): number {
  switch (risk) {
    case "metadata_only":
      return 0;
    case "share_index_build":
      return 1;
    case "access_exclusive_ddl":
      return 2;
    case "table_rewrite":
      return 3;
  }
}

/**
 * Pure static analyzer for a single migration SQL file given current live table row counts.
 */
export function analyzeMigrationSql(
  file: MigrationFileInput,
  applied: boolean,
  tableRowCounts: Readonly<Record<string, number>>,
): MigrationFileReport {
  const name = file.filename.replace(/\.sql$/i, "");
  const downMarkerMatch = /^--\s*Down Migration\b/im.exec(file.sql);
  const upSection = downMarkerMatch !== null ? file.sql.slice(0, downMarkerMatch.index) : file.sql;
  const downSection =
    downMarkerMatch !== null
      ? file.sql.slice(downMarkerMatch.index + downMarkerMatch[0].length)
      : "";

  const upSqlStatements = splitSqlStatements(upSection);
  const downSqlStatements = splitSqlStatements(downSection);
  const hasDownMigration = downMarkerMatch !== null && downSqlStatements.length > 0;

  const statements = upSqlStatements.map((stmt) => classifyUpStatement(stmt));
  const targetTableSet = new Set<string>();
  let highestLockRisk: LockRiskClass = "metadata_only";
  let weakensMonetaryConstraint = false;

  for (const stmt of statements) {
    if (stmt.targetTable !== null) {
      targetTableSet.add(stmt.targetTable);
    }
    if (rankLockRisk(stmt.lockRisk) > rankLockRisk(highestLockRisk)) {
      highestLockRisk = stmt.lockRisk;
    }
    if (stmt.weakensMonetaryConstraint) {
      weakensMonetaryConstraint = true;
    }
  }

  const targetTables = [...targetTableSet].sort();
  let affectedRowCount = 0;
  for (const tbl of targetTables) {
    affectedRowCount += tableRowCounts[tbl] ?? 0;
  }

  const notes: string[] = [];
  let feasibility: RollbackFeasibility = "reversible_schema";

  if (!hasDownMigration) {
    feasibility = "missing_down_migration";
    notes.push("migration has no executable -- Down Migration statements");
  } else if (statements.some((s) => s.feasibility === "irreversible_data_rewrite")) {
    feasibility = "irreversible_data_rewrite";
    notes.push(
      "contains in-place data mutation or column type rewrite that cannot be losslessly inverted by SQL DDL alone",
    );
  } else if (statements.some((s) => s.feasibility === "reversible_when_empty")) {
    if (affectedRowCount > 0) {
      feasibility = "irreversible_data_rewrite";
      notes.push(
        `drops column/table or adds un-defaulted NOT NULL on populated target (${String(affectedRowCount)} existing rows)`,
      );
    } else {
      feasibility = "reversible_when_empty";
      notes.push("reversible while affected target tables contain zero rows");
    }
  } else {
    notes.push("additive or metadata-only schema DDL with explicit -- Down Migration reversal");
  }

  if (weakensMonetaryConstraint) {
    notes.push("attempts to drop or narrow a protected monetary or replay uniqueness constraint");
  }

  return {
    name,
    filename: file.filename,
    applied,
    hasDownMigration,
    upStatementCount: upSqlStatements.length,
    downStatementCount: downSqlStatements.length,
    targetTables,
    affectedRowCount,
    feasibility,
    highestLockRisk,
    weakensMonetaryConstraint,
    statements,
    notes,
  };
}

/**
 * Runs read-only live database preflight and static SQL rollback feasibility checks without
 * altering any database schema or row.
 */
export async function runMigrationPreflight(
  db: Transactional | Queryable,
  options: MigrationPreflightOptions = {},
): Promise<MigrationPreflightReport> {
  if (isTransactional(db)) {
    return db.transaction(async (tx) => {
      await tx.query("SET TRANSACTION READ ONLY");
      return evaluatePreflightInReadOnlyScope(tx, options);
    });
  }
  return evaluatePreflightInReadOnlyScope(db, options);
}

/**
 * Executes `migrateAction` ONLY if `runMigrationPreflight` reports zero unsafe conditions.
 * Unsafe conditions throw `MigrationPreflightError` before `migrateAction` is ever invoked.
 */
export async function executeMigrationsWithPreflight<T>(
  db: Transactional | Queryable,
  migrateAction: () => Promise<T>,
  options: MigrationPreflightOptions = {},
): Promise<{ readonly preflight: MigrationPreflightReport; readonly result: T }> {
  const preflight = await runMigrationPreflight(db, options);
  if (!preflight.safe) {
    throw new MigrationPreflightError(preflight);
  }
  const result = await migrateAction();
  return { preflight, result };
}

async function evaluatePreflightInReadOnlyScope(
  tx: Queryable,
  options: MigrationPreflightOptions,
): Promise<MigrationPreflightReport> {
  const schemaName = assertSafeIdentifier(options.schemaName ?? "public", "schemaName");
  const migrationsTable = assertSafeIdentifier(
    options.migrationsTable ?? "pgmigrations",
    "migrationsTable",
  );
  const maxOpenTxSec = options.maxOpenTransactionSeconds ?? 60;
  const maxRewriteRows = options.maxRewriteTableRows ?? 250_000;

  const files = options.migrationFiles ?? loadMigrationFilesFromDir(options.migrationsDir);

  // 1. Discover existing tables in target schema
  const existingTablesRows = (
    await tx.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       ORDER BY table_name ASC`,
      [schemaName],
    )
  ).rows;
  const existingTables = new Set(existingTablesRows.map((row) => text(row, "table_name")));

  // 2. Read applied migrations if `pgmigrations` exists
  const appliedMigrations: string[] = [];
  if (existingTables.has(migrationsTable)) {
    const migRows = (
      await tx.query(
        `SELECT name, run_on FROM "${schemaName}"."${migrationsTable}" ORDER BY id ASC`,
      )
    ).rows;
    for (const row of migRows) {
      appliedMigrations.push(text(row, "name"));
      timestampOrNull(row, "run_on");
    }
  }
  const appliedSet = new Set(appliedMigrations);

  // 3. Collect exact row counts on existing tables
  const tableRowCounts: Record<string, number> = {};
  let totalIndexedRows = 0;
  for (const tbl of CORE_INDEXED_TABLES) {
    if (!existingTables.has(tbl)) {
      tableRowCounts[tbl] = 0;
      continue;
    }
    const safeTbl = assertSafeIdentifier(tbl, "table");
    const countRows = (
      await tx.query(`SELECT COUNT(*)::int AS row_count FROM "${schemaName}"."${safeTbl}"`)
    ).rows;
    const count = countRows[0] ? integer(countRows[0], "row_count") : 0;
    tableRowCounts[tbl] = count;
    totalIndexedRows += count;
  }

  // 4. Collect live cursor checkpoints for recovery replay instructions
  const cursorReplayFloor: CursorReplayPoint[] = [];
  if (existingTables.has("indexer_cursor")) {
    const hasHashColRows = (
      await tx.query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = $1
           AND table_name = 'indexer_cursor'
           AND column_name = 'last_processed_hash'`,
        [schemaName],
      )
    ).rows;
    const hasHashCol = hasHashColRows.length > 0;
    const cursorRows = (
      await tx.query(
        hasHashCol
          ? `SELECT chain_key, family, contract, last_processed::text AS last_processed, last_processed_hash
             FROM "${schemaName}".indexer_cursor
             ORDER BY chain_key ASC`
          : `SELECT chain_key, family, contract, last_processed::text AS last_processed, NULL::text AS last_processed_hash
             FROM "${schemaName}".indexer_cursor
             ORDER BY chain_key ASC`,
      )
    ).rows;

    for (const row of cursorRows) {
      cursorReplayFloor.push({
        chainKey: text(row, "chain_key"),
        family: text(row, "family"),
        contract: text(row, "contract"),
        lastProcessed: bigintOf(row, "last_processed").toString(),
        lastProcessedHash: textOrNull(row, "last_processed_hash"),
      });
    }
  }

  // 5. Inspect live locks & long-running open transactions in `pg_locks` / `pg_stat_activity`
  const lockRows = (
    await tx.query(
      `SELECT
         l.pid::int AS pid,
         c.relname AS relation,
         l.mode AS mode,
         l.granted AS granted,
         a.state AS state,
         COALESCE(EXTRACT(EPOCH FROM (clock_timestamp() - COALESCE(a.xact_start, a.query_start))), 0)::int AS age_seconds
       FROM pg_locks l
       JOIN pg_class c ON c.oid = l.relation
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE n.nspname = $1
         AND l.pid <> pg_backend_pid()
         AND (
           NOT l.granted
           OR l.mode IN (
             'AccessExclusiveLock',
             'ExclusiveLock',
             'ShareRowExclusiveLock',
             'ShareUpdateExclusiveLock'
           )
         )
       ORDER BY l.pid ASC, c.relname ASC`,
      [schemaName],
    )
  ).rows;

  const activeLocks: ActiveLockDiagnostic[] = lockRows.map((row) => ({
    pid: integer(row, "pid"),
    relation: text(row, "relation"),
    mode: text(row, "mode"),
    granted: boolean(row, "granted"),
    state: textOrNull(row, "state"),
    ageSeconds: Math.max(0, integer(row, "age_seconds")),
  }));

  const longTxRows = (
    await tx.query(
      `SELECT COUNT(*)::int AS count
       FROM pg_stat_activity
       WHERE pid <> pg_backend_pid()
         AND xact_start IS NOT NULL
         AND state <> 'idle'
         AND EXTRACT(EPOCH FROM (clock_timestamp() - xact_start)) >= $1`,
      [maxOpenTxSec],
    )
  ).rows;
  const longRunningTransactionCount = longTxRows[0] ? integer(longTxRows[0], "count") : 0;

  // 6. Inspect unvalidated (`NOT VALID`) constraints in target schema
  const unvalidatedRows = (
    await tx.query(
      `SELECT
         rel.relname AS table_name,
         con.conname AS constraint_name
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
       WHERE nsp.nspname = $1
         AND NOT con.convalidated
       ORDER BY rel.relname ASC, con.conname ASC`,
      [schemaName],
    )
  ).rows;

  const unvalidatedConstraints: UnvalidatedConstraintDiagnostic[] = unvalidatedRows.map((row) => ({
    tableName: text(row, "table_name"),
    constraintName: text(row, "constraint_name"),
  }));

  // 7. Analyze migration files
  const migrationReports = files.map((file) => {
    const migName = file.filename.replace(/\.sql$/i, "");
    return analyzeMigrationSql(file, appliedSet.has(migName), tableRowCounts);
  });
  const fileNameSet = new Set(migrationReports.map((m) => m.name));
  const pendingReports = migrationReports.filter((m) => !m.applied);
  const pendingMigrations = pendingReports.map((m) => m.name);

  // 8. Verify backup boundary against live database state
  const unsafeConditions: UnsafeMigrationCondition[] = [];
  const lastApplied =
    appliedMigrations.length > 0 ? (appliedMigrations[appliedMigrations.length - 1] ?? null) : null;

  const backupBoundary = verifyBackupBoundary(
    options.backupBoundary,
    lastApplied,
    totalIndexedRows,
    cursorReplayFloor,
    unsafeConditions,
  );

  // 9. Evaluate unsafe conditions before altering schema
  for (const appliedName of appliedMigrations) {
    if (!fileNameSet.has(appliedName)) {
      unsafeConditions.push({
        code: "applied_migration_missing_on_disk",
        message: `applied migration '${appliedName}' recorded in ${migrationsTable} is missing from migrations directory`,
        migration: appliedName,
        details: { migrationsTable },
      });
    }
  }

  if (activeLocks.length > 0) {
    const firstLock = activeLocks[0];
    unsafeConditions.push({
      code: "blocking_locks_detected",
      message: `${String(activeLocks.length)} conflicting or waiting lock(s) active on schema '${schemaName}'`,
      migration: null,
      details: {
        lockCount: activeLocks.length,
        sampleRelation: firstLock ? firstLock.relation : null,
        sampleMode: firstLock ? firstLock.mode : null,
      },
    });
  }

  if (longRunningTransactionCount > 0) {
    unsafeConditions.push({
      code: "long_running_transaction_detected",
      message: `${String(longRunningTransactionCount)} active transaction(s) exceed ${String(maxOpenTxSec)}s threshold`,
      migration: null,
      details: {
        longRunningTransactionCount,
        thresholdSeconds: maxOpenTxSec,
      },
    });
  }

  if (unvalidatedConstraints.length > 0) {
    const sample = unvalidatedConstraints[0];
    unsafeConditions.push({
      code: "unvalidated_constraint_detected",
      message: `${String(unvalidatedConstraints.length)} unvalidated constraint(s) present before migration`,
      migration: null,
      details: {
        count: unvalidatedConstraints.length,
        sampleConstraint: sample ? `${sample.tableName}.${sample.constraintName}` : null,
      },
    });
  }

  for (const mig of pendingReports) {
    if (mig.feasibility === "missing_down_migration") {
      unsafeConditions.push({
        code: "missing_down_migration",
        message: `pending migration '${mig.name}' has no executable -- Down Migration section`,
        migration: mig.name,
        details: { filename: mig.filename },
      });
    }

    if (mig.weakensMonetaryConstraint) {
      unsafeConditions.push({
        code: "monetary_constraint_weakened",
        message: `pending migration '${mig.name}' drops or narrows a protected monetary or replay constraint`,
        migration: mig.name,
        details: { filename: mig.filename },
      });
    }

    if (
      mig.feasibility === "irreversible_data_rewrite" &&
      backupBoundary.status !== "verified_artifact"
    ) {
      unsafeConditions.push({
        code: "irreversible_migration_without_verified_backup",
        message: `pending migration '${mig.name}' performs an irreversible data rewrite without a verified backup boundary`,
        migration: mig.name,
        details: {
          affectedRowCount: mig.affectedRowCount,
          backupStatus: backupBoundary.status,
        },
      });
    }

    if (mig.highestLockRisk === "table_rewrite" && mig.affectedRowCount > maxRewriteRows) {
      unsafeConditions.push({
        code: "row_count_rewrite_threshold_exceeded",
        message: `pending migration '${mig.name}' rewrites ${String(mig.affectedRowCount)} rows exceeding online limit ${String(maxRewriteRows)}`,
        migration: mig.name,
        details: {
          affectedRowCount: mig.affectedRowCount,
          maxRewriteRows,
        },
      });
    }
  }

  if (
    options.requireVerifiedBackup === true &&
    pendingReports.length > 0 &&
    backupBoundary.status !== "verified_artifact"
  ) {
    unsafeConditions.push({
      code: "irreversible_migration_without_verified_backup",
      message: "requireVerifiedBackup is enabled and no verified backup artifact was supplied",
      migration: null,
      details: { backupStatus: backupBoundary.status },
    });
  }

  const recoveryInstructions = buildRecoveryInstructions(
    pendingReports,
    backupBoundary,
    migrationsTable,
  );

  return {
    safe: unsafeConditions.length === 0,
    checkedAt: new Date().toISOString(),
    schemaName,
    appliedMigrations,
    pendingMigrations,
    tableRowCounts,
    totalIndexedRows,
    activeLocks,
    longRunningTransactionCount,
    unvalidatedConstraints,
    migrations: migrationReports,
    backupBoundary,
    unsafeConditions,
    recoveryInstructions,
  };
}

function verifyBackupBoundary(
  input: BackupBoundaryInput | undefined,
  lastAppliedMigration: string | null,
  totalIndexedRows: number,
  cursorReplayFloor: readonly CursorReplayPoint[],
  unsafeConditions: UnsafeMigrationCondition[],
): VerifiedBackupBoundary {
  if (input === undefined) {
    if (lastAppliedMigration === null && totalIndexedRows === 0) {
      return {
        verified: true,
        status: "empty_database_baseline",
        backupId: "baseline:empty-uninitialized-schema",
        capturedAt: null,
        artifactSha256: null,
        schemaBoundary: null,
        cursorReplayFloor,
        verificationDetail:
          "target database has zero applied migrations and zero indexed rows; empty baseline verified",
      };
    }
    return {
      verified: false,
      status: "unverified",
      backupId: null,
      capturedAt: null,
      artifactSha256: null,
      schemaBoundary: lastAppliedMigration,
      cursorReplayFloor,
      verificationDetail:
        "no backup artifact metadata provided; reversible additive schema changes only",
    };
  }

  const trimmedId = input.backupId.trim();
  const parsedDate = new Date(input.capturedAt);
  if (trimmedId === "" || Number.isNaN(parsedDate.getTime())) {
    unsafeConditions.push({
      code: "backup_boundary_invalid",
      message:
        "backupBoundary requires a non-empty backupId and valid ISO-8601 capturedAt timestamp",
      migration: null,
      details: {
        backupId: trimmedId || null,
        capturedAt: input.capturedAt,
      },
    });
    return {
      verified: false,
      status: "unverified",
      backupId: trimmedId || null,
      capturedAt: null,
      artifactSha256: input.artifactSha256 ?? null,
      schemaBoundary: lastAppliedMigration,
      cursorReplayFloor,
      verificationDetail: "supplied backupBoundary failed basic identifier or timestamp validation",
    };
  }

  if (parsedDate.getTime() > Date.now() + 60_000) {
    unsafeConditions.push({
      code: "backup_boundary_invalid",
      message: `backupBoundary '${trimmedId}' capturedAt (${parsedDate.toISOString()}) lies in the future`,
      migration: null,
      details: {
        backupId: trimmedId,
        capturedAt: parsedDate.toISOString(),
      },
    });
  }

  if (
    input.lastAppliedMigration !== undefined &&
    input.lastAppliedMigration !== lastAppliedMigration
  ) {
    unsafeConditions.push({
      code: "backup_boundary_invalid",
      message: `backupBoundary '${trimmedId}' schema boundary (${String(input.lastAppliedMigration)}) disagrees with live database (${String(lastAppliedMigration)})`,
      migration: null,
      details: {
        backupId: trimmedId,
        backupMigration: input.lastAppliedMigration,
        liveMigration: lastAppliedMigration,
      },
    });
  }

  const liveCursorMap = new Map<string, bigint>();
  for (const cursor of cursorReplayFloor) {
    liveCursorMap.set(cursor.chainKey, BigInt(cursor.lastProcessed));
  }

  if (input.cursorCheckpoints !== undefined) {
    for (const [chainKey, rawBlock] of Object.entries(input.cursorCheckpoints)) {
      if (!/^\d+$/.test(rawBlock)) {
        unsafeConditions.push({
          code: "backup_boundary_invalid",
          message: `backupBoundary '${trimmedId}' cursor checkpoint for '${chainKey}' is not an unsigned integer string`,
          migration: null,
          details: { chainKey, checkpoint: rawBlock },
        });
        continue;
      }
      const backupBlock = BigInt(rawBlock);
      const liveBlock = liveCursorMap.get(chainKey);
      if (liveBlock === undefined || backupBlock > liveBlock) {
        unsafeConditions.push({
          code: "backup_boundary_invalid",
          message: `backupBoundary '${trimmedId}' cursor checkpoint ${chainKey}@${rawBlock} exceeds or is absent from live cursor state`,
          migration: null,
          details: {
            chainKey,
            backupCheckpoint: rawBlock,
            liveCheckpoint: liveBlock === undefined ? null : liveBlock.toString(),
          },
        });
      }
    }
  }

  if (input.artifactSha256 !== undefined && !/^[0-9a-fA-F]{64}$/.test(input.artifactSha256)) {
    unsafeConditions.push({
      code: "backup_boundary_invalid",
      message: `backupBoundary '${trimmedId}' artifactSha256 is not a 64-character hex SHA-256 digest`,
      migration: null,
      details: { backupId: trimmedId },
    });
  }

  const anyInvalid = unsafeConditions.some((c) => c.code === "backup_boundary_invalid");
  return {
    verified: !anyInvalid,
    status: anyInvalid ? "unverified" : "verified_artifact",
    backupId: trimmedId,
    capturedAt: parsedDate.toISOString(),
    artifactSha256: input.artifactSha256 ? input.artifactSha256.toLowerCase() : null,
    schemaBoundary: lastAppliedMigration,
    cursorReplayFloor,
    verificationDetail: anyInvalid
      ? `backup '${trimmedId}' failed consistency checks against live schema/cursor state`
      : `verified backup '${trimmedId}' matches schema boundary '${lastAppliedMigration ?? "empty"}'`,
  };
}

function buildRecoveryInstructions(
  pendingReports: readonly MigrationFileReport[],
  backupBoundary: VerifiedBackupBoundary,
  migrationsTable: string,
): MigrationRecoveryInstructions {
  const boundaryRef =
    backupBoundary.backupId ??
    (backupBoundary.schemaBoundary !== null
      ? `unverified-live-boundary:${backupBoundary.schemaBoundary}`
      : "baseline:empty-uninitialized-schema");

  const hasIrreversible = pendingReports.some(
    (m) =>
      m.feasibility === "irreversible_data_rewrite" || m.feasibility === "missing_down_migration",
  );

  const cursorSummary =
    backupBoundary.cursorReplayFloor.length > 0
      ? backupBoundary.cursorReplayFloor.map((c) => `${c.chainKey}@${c.lastProcessed}`).join(", ")
      : "startBlock/startLedger deployment floor";

  if (hasIrreversible) {
    const steps: string[] = [
      `Stop indexer and keeper writers before initiating recovery (do not run SQL down migrations for irreversible data rewrites).`,
      `Restore verified backup boundary '${boundaryRef}'${backupBoundary.capturedAt ? ` (captured ${backupBoundary.capturedAt})` : ""}${backupBoundary.artifactSha256 ? ` [sha256:${backupBoundary.artifactSha256}]` : ""} into a clean target database.`,
      `Confirm ${migrationsTable} matches pre-migration boundary '${backupBoundary.schemaBoundary ?? "empty"}' and run read-only invariant audit.`,
      `Resume watchers to deterministically replay chain events forward from verified cursor floor (${cursorSummary}).`,
    ];
    return {
      strategy: "restore_verified_backup_and_replay",
      backupBoundaryId: boundaryRef,
      backupCapturedAt: backupBoundary.capturedAt,
      schemaBoundary: backupBoundary.schemaBoundary,
      steps,
    };
  }

  const downSteps = [...pendingReports]
    .reverse()
    .map(
      (mig) =>
        `Revert reversible migration '${mig.name}' via 'npm run migrate:down' (confirming ${migrationsTable} returns toward '${backupBoundary.schemaBoundary ?? "empty"}').`,
    );

  const steps: string[] = [
    `Pause indexer writes if rolling back an active schema change.`,
    ...(downSteps.length > 0
      ? downSteps
      : [
          `No pending migrations require reversal; schema already matches '${backupBoundary.schemaBoundary ?? "empty"}'.`,
        ]),
    `If DDL rollback is blocked or data drift is suspected, restore verified backup boundary '${boundaryRef}'${backupBoundary.capturedAt ? ` (captured ${backupBoundary.capturedAt})` : ""} and replay from cursor floor (${cursorSummary}).`,
  ];

  return {
    strategy: "down_migration_rollback",
    backupBoundaryId: boundaryRef,
    backupCapturedAt: backupBoundary.capturedAt,
    schemaBoundary: backupBoundary.schemaBoundary,
    steps,
  };
}

export async function runMigrationPreflightCli(
  env: Readonly<Record<string, string | undefined>> = process.env,
  writeStdout: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  writeStderr: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<number> {
  const connectionString = env.DATABASE_URL;
  if (!connectionString || connectionString.trim() === "") {
    writeStderr("DATABASE_URL is required to run migration preflight");
    return 2;
  }

  const backupBoundary: BackupBoundaryInput | undefined =
    env.VERIFIED_BACKUP_ID && env.VERIFIED_BACKUP_CAPTURED_AT
      ? {
          backupId: env.VERIFIED_BACKUP_ID,
          capturedAt: env.VERIFIED_BACKUP_CAPTURED_AT,
          ...(env.VERIFIED_BACKUP_SHA256 ? { artifactSha256: env.VERIFIED_BACKUP_SHA256 } : {}),
          ...(env.VERIFIED_BACKUP_MIGRATION !== undefined
            ? { lastAppliedMigration: env.VERIFIED_BACKUP_MIGRATION || null }
            : {}),
        }
      : undefined;

  const db = Database.open(connectionString, {
    maxConnections: 2,
    applicationName: "hyperion-migration-preflight",
  });
  try {
    const report = await runMigrationPreflight(db, {
      ...(backupBoundary ? { backupBoundary } : {}),
      requireVerifiedBackup: env.REQUIRE_VERIFIED_BACKUP === "true",
    });
    writeStdout(JSON.stringify(report, null, 2));
    return report.safe ? 0 : 1;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    writeStderr(`migration preflight failed: ${redactPreflightSecrets(msg)}`);
    return 2;
  } finally {
    await db.close();
  }
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  void runMigrationPreflightCli().then((code) => {
    process.exitCode = code;
  });
}
