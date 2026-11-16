/**
 * Read-only startup schema compatibility check.
 *
 * Verifies that `public.pgmigrations` and the core application tables and column types match the
 * repository's migration inventory before serving HTTP traffic or starting chain/rail workers.
 * Never executes migrations automatically and never echoes database connection values.
 */
import type { SchemaCheckConfig } from "../config/config.js";
import { redactConnectionSecrets } from "../config/env.js";
import type { Queryable } from "./pool.js";

export type SchemaIncompatibilityCode =
  | "database_unreachable"
  | "migrations_table_missing"
  | "pending_migrations"
  | "migration_order_mismatch"
  | "ahead_migrations"
  | "schema_drift";

export interface SchemaCompatibilityDetails {
  readonly code: SchemaIncompatibilityCode;
  readonly expectedVersion: string | null;
  readonly appliedVersion: string | null;
  readonly missingMigrations: readonly string[];
  readonly aheadMigrations: readonly string[];
  readonly schemaIssues: readonly string[];
}

export class SchemaCompatibilityError extends Error {
  readonly code: SchemaIncompatibilityCode;
  readonly details: SchemaCompatibilityDetails;
  readonly publicMessage: string;

  constructor(message: string, details: SchemaCompatibilityDetails) {
    const sanitized = redactConnectionSecrets(message);
    super(sanitized);
    this.name = "SchemaCompatibilityError";
    this.code = details.code;
    this.details = details;
    this.publicMessage = sanitized;
  }
}

export interface SchemaCompatibilityResult {
  readonly compatible: true;
  readonly expectedVersion: string | null;
  readonly appliedVersion: string | null;
  readonly appliedMigrations: readonly string[];
  readonly aheadMigrations: readonly string[];
}

interface ExpectedColumnSpec {
  readonly name: string;
  readonly dataType: string;
  readonly precision?: number;
  readonly scale?: number;
}

const REQUIRED_TABLE_COLUMNS: Readonly<Record<string, readonly ExpectedColumnSpec[]>> = {
  indexer_cursor: [
    { name: "chain_key", dataType: "text" },
    { name: "family", dataType: "text" },
    { name: "contract", dataType: "text" },
    { name: "last_processed", dataType: "numeric", precision: 20, scale: 0 },
    { name: "last_processed_at", dataType: "timestamp with time zone" },
    { name: "last_processed_hash", dataType: "text" },
    { name: "updated_at", dataType: "timestamp with time zone" },
  ],
  outbound_transfer: [
    { name: "id", dataType: "bigint" },
    { name: "origin_chain", dataType: "text" },
    { name: "route", dataType: "smallint" },
    { name: "nonce", dataType: "numeric", precision: 20, scale: 0 },
    { name: "sender", dataType: "text" },
    { name: "token", dataType: "text" },
    { name: "gross_amount", dataType: "numeric", precision: 78, scale: 0 },
    { name: "fee", dataType: "numeric", precision: 78, scale: 0 },
    { name: "net_amount", dataType: "numeric", precision: 78, scale: 0 },
    { name: "destination_chain", dataType: "text" },
    { name: "destination", dataType: "text" },
    { name: "rail_ref", dataType: "text" },
    { name: "origin_block", dataType: "numeric", precision: 20, scale: 0 },
    { name: "origin_tx", dataType: "text" },
    { name: "origin_log_index", dataType: "integer" },
    { name: "observed_at", dataType: "timestamp with time zone" },
  ],
  inbound_delivery: [
    { name: "id", dataType: "bigint" },
    { name: "destination_chain", dataType: "text" },
    { name: "route", dataType: "smallint" },
    { name: "source_chain", dataType: "text" },
    { name: "source_nonce", dataType: "numeric", precision: 20, scale: 0 },
    { name: "rail_message_id", dataType: "text" },
    { name: "recipient", dataType: "text" },
    { name: "token", dataType: "text" },
    { name: "amount", dataType: "numeric", precision: 78, scale: 0 },
    { name: "delivered", dataType: "boolean" },
    { name: "claim_id", dataType: "numeric", precision: 20, scale: 0 },
    { name: "destination_block", dataType: "numeric", precision: 20, scale: 0 },
    { name: "destination_tx", dataType: "text" },
    { name: "destination_log_index", dataType: "integer" },
    { name: "observed_at", dataType: "timestamp with time zone" },
  ],
  pending_claim: [
    { name: "chain", dataType: "text" },
    { name: "claim_id", dataType: "numeric", precision: 20, scale: 0 },
    { name: "recipient", dataType: "text" },
    { name: "token", dataType: "text" },
    { name: "amount", dataType: "numeric", precision: 78, scale: 0 },
    { name: "route", dataType: "smallint" },
    { name: "source_chain", dataType: "text" },
    { name: "source_nonce", dataType: "numeric", precision: 20, scale: 0 },
    { name: "created_at", dataType: "timestamp with time zone" },
    { name: "settled", dataType: "boolean" },
    { name: "settled_at", dataType: "timestamp with time zone" },
    { name: "settled_by", dataType: "text" },
    { name: "settled_tx", dataType: "text" },
    { name: "observed_at", dataType: "timestamp with time zone" },
  ],
  rail_attestation: [
    { name: "transfer_id", dataType: "bigint" },
    { name: "route", dataType: "smallint" },
    { name: "status", dataType: "text" },
    { name: "rail_status", dataType: "text" },
    { name: "rail_reference", dataType: "text" },
    { name: "attested_at", dataType: "timestamp with time zone" },
    { name: "last_checked_at", dataType: "timestamp with time zone" },
    { name: "check_failures", dataType: "integer" },
    { name: "last_error", dataType: "text" },
    { name: "updated_at", dataType: "timestamp with time zone" },
  ],
  admin_action: [
    { name: "chain", dataType: "text" },
    { name: "action_id", dataType: "numeric", precision: 20, scale: 0 },
    { name: "kind", dataType: "smallint" },
    { name: "state", dataType: "text" },
    { name: "payload", dataType: "jsonb" },
    { name: "eta", dataType: "timestamp with time zone" },
    { name: "expires_at", dataType: "timestamp with time zone" },
    { name: "queued_at", dataType: "timestamp with time zone" },
    { name: "settled_at", dataType: "timestamp with time zone" },
    { name: "actor", dataType: "text" },
    { name: "observed_at", dataType: "timestamp with time zone" },
  ],
  route_health: [
    { name: "id", dataType: "bigint" },
    { name: "sampled_at", dataType: "timestamp with time zone" },
    { name: "origin_chain", dataType: "text" },
    { name: "destination_chain", dataType: "text" },
    { name: "route", dataType: "smallint" },
    { name: "token", dataType: "text" },
    { name: "available", dataType: "boolean" },
    { name: "blocker", dataType: "smallint" },
    { name: "flow_available", dataType: "numeric", precision: 78, scale: 0 },
    { name: "median_seconds", dataType: "integer" },
  ],
};

function safeReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactConnectionSecrets(raw);
}

function assertSafeIdentifier(identifier: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }
  return identifier;
}

export async function verifySchemaCompatibility(
  db: Queryable,
  config: SchemaCheckConfig,
): Promise<SchemaCompatibilityResult> {
  const expected = config.expectedMigrations;
  const expectedVersion = expected[expected.length - 1] ?? null;
  const migrationsTable = assertSafeIdentifier(config.migrationsTable);

  let tableRows: readonly Record<string, unknown>[];
  try {
    const res = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    tableRows = res.rows;
  } catch (error) {
    throw new SchemaCompatibilityError(
      `Schema compatibility check could not query PostgreSQL metadata: ${safeReason(error)}. Verify database connectivity and permissions without exposing credentials.`,
      {
        code: "database_unreachable",
        expectedVersion,
        appliedVersion: null,
        missingMigrations: expected,
        aheadMigrations: [],
        schemaIssues: [],
      },
    );
  }

  const existingTables = new Set(tableRows.map((row) => String(row.table_name)));
  if (!existingTables.has(migrationsTable)) {
    throw new SchemaCompatibilityError(
      `Database schema is uninitialized: migration table "public.${migrationsTable}" is missing. Run "npm run migrate:up" explicitly before starting the service.`,
      {
        code: "migrations_table_missing",
        expectedVersion,
        appliedVersion: null,
        missingMigrations: expected,
        aheadMigrations: [],
        schemaIssues: [`missing table public.${migrationsTable}`],
      },
    );
  }

  let appliedRows: readonly Record<string, unknown>[];
  try {
    const res = await db.query(`SELECT name FROM public.${migrationsTable} ORDER BY id ASC`);
    appliedRows = res.rows;
  } catch (error) {
    throw new SchemaCompatibilityError(
      `Schema compatibility check could not read "public.${migrationsTable}": ${safeReason(error)}. Grant SELECT on public.${migrationsTable} or run "npm run migrate:up".`,
      {
        code: "migrations_table_missing",
        expectedVersion,
        appliedVersion: null,
        missingMigrations: expected,
        aheadMigrations: [],
        schemaIssues: [`unreadable table public.${migrationsTable}`],
      },
    );
  }

  const applied = appliedRows.map((row) => String(row.name).replace(/\.sql$/i, ""));
  const appliedSet = new Set(applied);
  const appliedVersion = applied[applied.length - 1] ?? null;
  const missingMigrations = expected.filter((name) => !appliedSet.has(name));
  const expectedSet = new Set(expected);
  const aheadMigrations = applied.filter((name) => !expectedSet.has(name));

  if (missingMigrations.length > 0) {
    throw new SchemaCompatibilityError(
      `Database schema is behind this application build (applied: ${appliedVersion ?? "none"}, expected: ${expectedVersion ?? "none"}). Missing migrations: ${missingMigrations.join(", ")}. Run "npm run migrate:up" explicitly before starting the service.`,
      {
        code: "pending_migrations",
        expectedVersion,
        appliedVersion,
        missingMigrations,
        aheadMigrations,
        schemaIssues: [],
      },
    );
  }

  for (let idx = 0; idx < expected.length; idx += 1) {
    if (applied[idx] !== expected[idx]) {
      throw new SchemaCompatibilityError(
        `Database migration history order does not match this application build at position ${String(idx + 1)} (found "${applied[idx] ?? "none"}", expected "${expected[idx] ?? "none"}"). Reconcile "public.${migrationsTable}" against migrations/ before starting the service.`,
        {
          code: "migration_order_mismatch",
          expectedVersion,
          appliedVersion,
          missingMigrations: [],
          aheadMigrations,
          schemaIssues: [],
        },
      );
    }
  }

  if (aheadMigrations.length > 0 && !config.allowAhead) {
    throw new SchemaCompatibilityError(
      `Database schema version (${appliedVersion ?? "unknown"}) is ahead of this application build (${expectedVersion ?? "none"}): unrecognized migrations ${aheadMigrations.join(", ")}. Deploy the matching application version or set SCHEMA_ALLOW_AHEAD=true only for verified additive migrations.`,
      {
        code: "ahead_migrations",
        expectedVersion,
        appliedVersion,
        missingMigrations: [],
        aheadMigrations,
        schemaIssues: [],
      },
    );
  }

  let columnRows: readonly Record<string, unknown>[];
  try {
    const res = await db.query(
      `SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
         FROM information_schema.columns
        WHERE table_schema = 'public'`,
    );
    columnRows = res.rows;
  } catch (error) {
    throw new SchemaCompatibilityError(
      `Schema compatibility check could not inspect public table columns: ${safeReason(error)}.`,
      {
        code: "database_unreachable",
        expectedVersion,
        appliedVersion,
        missingMigrations: [],
        aheadMigrations,
        schemaIssues: [],
      },
    );
  }

  const columnMap = new Map<
    string,
    {
      readonly dataType: string;
      readonly precision: number | null;
      readonly scale: number | null;
    }
  >();
  for (const row of columnRows) {
    const key = `${String(row.table_name)}.${String(row.column_name)}`;
    columnMap.set(key, {
      dataType: String(row.data_type).toLowerCase(),
      precision:
        row.numeric_precision === null || row.numeric_precision === undefined
          ? null
          : Number(row.numeric_precision),
      scale:
        row.numeric_scale === null || row.numeric_scale === undefined
          ? null
          : Number(row.numeric_scale),
    });
  }

  const schemaIssues: string[] = [];
  for (const [tableName, requiredColumns] of Object.entries(REQUIRED_TABLE_COLUMNS)) {
    if (!existingTables.has(tableName)) {
      schemaIssues.push(`missing required table public.${tableName}`);
      continue;
    }
    for (const col of requiredColumns) {
      const actual = columnMap.get(`${tableName}.${col.name}`);
      if (!actual) {
        schemaIssues.push(`missing column public.${tableName}.${col.name}`);
        continue;
      }
      if (actual.dataType !== col.dataType) {
        schemaIssues.push(
          `column public.${tableName}.${col.name} has type "${actual.dataType}", expected "${col.dataType}"`,
        );
        continue;
      }
      if (col.precision !== undefined && actual.precision !== col.precision) {
        schemaIssues.push(
          `column public.${tableName}.${col.name} has numeric precision ${String(actual.precision)}, expected ${String(col.precision)}`,
        );
      }
      if (col.scale !== undefined && actual.scale !== col.scale) {
        schemaIssues.push(
          `column public.${tableName}.${col.name} has numeric scale ${String(actual.scale)}, expected ${String(col.scale)}`,
        );
      }
    }
  }

  if (schemaIssues.length > 0) {
    throw new SchemaCompatibilityError(
      `Database schema is incompatible with this application build despite recorded migrations: ${schemaIssues.join("; ")}. Verify database migrations and schema state before starting the service.`,
      {
        code: "schema_drift",
        expectedVersion,
        appliedVersion,
        missingMigrations: [],
        aheadMigrations,
        schemaIssues,
      },
    );
  }

  return {
    compatible: true,
    expectedVersion,
    appliedVersion,
    appliedMigrations: applied,
    aheadMigrations,
  };
}
