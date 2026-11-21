import { describe, expect, it } from "vitest";
import { PG_MIGRATE_LOCK_ID } from "node-pg-migrate";
import { migrationPreflight, migrationRollbackReport } from "../../src/db/migration-report.js";
import type { Queryable, QueryResultRows } from "../../src/db/pool.js";

function fixture(lockAvailable = true) {
  const queries: { sql: string; params: readonly unknown[] }[] = [];
  let inTransaction = false;
  const tx: Queryable = {
    query(sql, params = []): Promise<QueryResultRows> {
      expect(inTransaction).toBe(true);
      queries.push({ sql, params });
      let rows: Record<string, unknown>[] = [];
      if (sql.includes("pg_try_advisory")) rows = [{ available: lockAvailable }];
      else if (sql.includes("FROM pgmigrations")) rows = [{ name: "initial" }];
      else if (sql.includes("count(*)")) rows = [{ count: "3000000000" }];
      else if (sql.includes("FROM migration_backup_boundary"))
        rows = [{ backup_id: "backup", migration_name: "initial", verified_at: new Date(0) }];
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  };
  return {
    queries,
    db: {
      query: (sql: string, params?: readonly unknown[]) => tx.query(sql, params),
      async transaction<T>(work: (tx: Queryable) => Promise<T>) {
        inTransaction = true;
        try {
          return await work(tx);
        } finally {
          inTransaction = false;
        }
      },
    },
  };
}

describe("migration preflight safety", () => {
  it("holds the actual migration lock before reading a consistent snapshot and full-width counts", async () => {
    const { db, queries } = fixture();
    const report = await migrationPreflight(db, { expectedMigrations: ["initial"] });
    expect(report.safe).toBe(true);
    expect(report.rowCounts.indexer_cursor).toBe(3_000_000_000);
    expect(queries[0]?.sql).toBe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    expect(queries[1]?.params).toEqual([String(PG_MIGRATE_LOCK_ID)]);
    expect(queries[2]?.sql).toContain("FROM pgmigrations");
  });

  it("fails closed without reading schema while a migrator owns the lock", async () => {
    const { db, queries } = fixture(false);
    const report = await migrationPreflight(db, { expectedMigrations: ["initial"] });
    expect(report.safe).toBe(false);
    expect(report.migrationLockAvailable).toBe(false);
    expect(queries).toHaveLength(2);
  });

  it("reports missing expected migrations even when backup and constraints are valid", async () => {
    const { db } = fixture();
    const report = await migrationPreflight(db, { expectedMigrations: ["initial", "upgrade"] });
    expect(report.safe).toBe(false);
    expect(report.schema.missing).toEqual(["upgrade"]);
    expect(report.failures).toContain("missing expected migrations: upgrade");
  });

  it("requires a transaction instead of claiming an inconsistent preflight is safe", async () => {
    const report = await migrationPreflight(
      { query: () => Promise.reject(new Error("unexpected")) },
      { expectedMigrations: [] },
    );
    expect(report.safe).toBe(false);
    expect(report.failures[0]).toContain("transaction unavailable");
  });
});

describe("migration rollback classification", () => {
  it.each([
    "DROP TABLE transfers;",
    "ALTER TABLE transfers DROP COLUMN amount;",
    "ALTER TABLE transfers DROP CONSTRAINT amount_check, DROP COLUMN amount;",
    "ALTER TABLE transfers RENAME COLUMN amount TO old_amount, DROP COLUMN old_amount;",
    "DROP INDEX idx CASCADE;",
    "UPDATE transfers SET amount=0;",
    "DO $$ BEGIN DELETE FROM transfers; END $$;",
    "-- irreversible by design\n",
  ])("requires a backup for destructive, unknown or absent reversal: %s", (downSql) => {
    const report = migrationRollbackReport([{ name: "upgrade", downSql }]);
    expect(report.backupBoundaryRequired).toBe(true);
    expect(report.entries[0]?.reversibleSchema).toBe(false);
  });

  it("recognizes explicitly non-data schema reversals after stripping comments", () => {
    const report = migrationRollbackReport([
      {
        name: "upgrade",
        downSql:
          "/* DROP TABLE users; */ DROP INDEX IF EXISTS idx; ALTER TABLE transfers DROP CONSTRAINT amount_check; -- UPDATE transfers\n",
      },
    ]);
    expect(report.backupBoundaryRequired).toBe(false);
    expect(report.entries[0]?.reversibleSchema).toBe(true);
  });
});
