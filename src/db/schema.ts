/**
 * Startup schema compatibility check.
 *
 * Verifies the database has been migrated to the expected schema version before the
 * process serves requests or indexes events. It never runs migrations itself: an
 * incompatible schema is a startup failure with an actionable message, not a silent
 * schema drift that corrupts indexed rows.
 *
 * node-pg-migrate records each applied migration in `pgmigrations.name`. The expected
 * version is the newest migration file this build ships, so a database that has not
 * had `npm run migrate:up` applied is refused rather than served against stale tables.
 *
 * Nothing in an error message carries a connection string, host or password: only the
 * variable name and the shape of the failure.
 */

import type { Queryable } from "../db/pool.js";

/** The newest migration this build ships. Kept in step with `migrations/`. */
export const EXPECTED_SCHEMA_VERSION = "1792000000000_evm-backfill-jobs";

/** Thrown when the database schema is not at the expected version. */
export class SchemaIncompatibleError extends Error {
  constructor(readonly expected: string, readonly applied: string | null) {
    super(
      applied === null
        ? `Database schema is uninitialised: expected ${expected}, found no applied migrations. Run \`npm run migrate:up\` before starting.`
        : `Database schema is incompatible: expected ${expected}, found ${applied}. Run \`npm run migrate:up\` to apply pending migrations before starting.`,
    );
    this.name = "SchemaIncompatibleError";
  }
}

/** Query the migration table and throw if the expected version has not been applied. */
export async function checkSchemaCompatibility(
  db: Queryable,
  expectedVersion: string,
): Promise<void> {
  const { rows } = await db.query(
    "SELECT name FROM pgmigrations WHERE name = $1 ORDER BY name DESC LIMIT 1",
    [expectedVersion],
  );
  const applied = rows.length > 0 ? String(rows[0].name) : null;
  if (applied !== expectedVersion) {
    throw new SchemaIncompatibleError(expectedVersion, applied);
  }
}
