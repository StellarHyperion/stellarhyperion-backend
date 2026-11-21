import { Client } from "pg";
import { PG_MIGRATE_LOCK_ID } from "node-pg-migrate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "../../src/db/pool.js";

const connection = process.env.TEST_DATABASE_URL;
(connection ? describe : describe.skip)("real migration preflight lock exclusion", () => {
  const db = Database.open(connection ?? "", { maxConnections: 2 });
  const migrator = new Client({ connectionString: connection });
  beforeAll(() => migrator.connect());
  afterAll(async () => {
    await migrator.end();
    await db.close();
  });

  it("does not claim safety while the real node-pg-migrate lock is held, then resumes a consistent read", async () => {
    await migrator.query("SELECT pg_advisory_lock($1::bigint)", [String(PG_MIGRATE_LOCK_ID)]);
    try {
      const blocked = await db.migrationPreflight({ expectedMigrations: [] });
      expect(blocked.safe).toBe(false);
      expect(blocked.migrationLockAvailable).toBe(false);
      expect(blocked.rowCounts).toEqual({});
    } finally {
      await migrator.query("SELECT pg_advisory_unlock($1::bigint)", [String(PG_MIGRATE_LOCK_ID)]);
    }
    const report = await db.migrationPreflight({ expectedMigrations: ["missing-test-migration"] });
    expect(report.migrationLockAvailable).toBe(true);
    expect(report.schema.applied.length).toBeGreaterThan(0);
    expect(report.schema.missing).toEqual(["missing-test-migration"]);
    expect(report.safe).toBe(false);
    expect(report.rowCounts.indexer_cursor).toBeGreaterThanOrEqual(0);
  });
});
