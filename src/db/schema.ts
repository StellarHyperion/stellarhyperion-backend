import { readdirSync } from "node:fs";
import type { Queryable } from "./pool.js";
const REQUIRED_MIGRATIONS = readdirSync(new URL("../../migrations/", import.meta.url))
  .filter((name) => /^\d{13}_[a-z0-9-]+\.sql$/.test(name))
  .map((name) => name.slice(0, -4))
  .sort();
export const EXPECTED_SCHEMA_VERSION = REQUIRED_MIGRATIONS.at(-1) ?? "unavailable";
export class SchemaIncompatibleError extends Error {
  constructor(
    readonly expected: string,
    readonly applied: string | null,
  ) {
    super(
      `Database schema admission failed: this build requires ${expected}. Apply the shipped migrations with npm run migrate:up before startup; schema checks never run migrations.`,
    );
    this.name = "SchemaIncompatibleError";
  }
}
export async function checkSchemaCompatibility(
  db: Queryable,
  expectedVersion = EXPECTED_SCHEMA_VERSION,
): Promise<void> {
  if (expectedVersion !== EXPECTED_SCHEMA_VERSION || REQUIRED_MIGRATIONS.length === 0)
    throw new SchemaIncompatibleError(EXPECTED_SCHEMA_VERSION, null);
  let rows;
  try {
    rows = (await db.query("SELECT name FROM pgmigrations ORDER BY name")).rows;
  } catch {
    throw new SchemaIncompatibleError(expectedVersion, null);
  }
  const applied = rows.map((row) => String(row.name));
  if (
    applied.length !== REQUIRED_MIGRATIONS.length ||
    REQUIRED_MIGRATIONS.some((name, index) => name !== applied[index])
  )
    throw new SchemaIncompatibleError(expectedVersion, null);
}
