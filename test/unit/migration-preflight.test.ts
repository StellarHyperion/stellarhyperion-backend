import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MigrationPreflightError,
  analyzeMigrationSql,
  executeMigrationsWithPreflight,
  loadMigrationFilesFromDir,
  redactPreflightSecrets,
  runMigrationPreflight,
} from "../../src/db/migration-preflight.js";
import type { MigrationFileInput } from "../../src/db/migration-preflight.js";
import type { Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";

const STELLAR_ROUTER = "CDVDU67TASWDY7ECUQWGPIIAYVLFYTGULAQVLMUEYRIBILVHKJHBCPSI";
const STELLAR_SENDER = "GC4FD5G3CZJ57VPYTVNWU4FRDLLV37EYDGT3OVZA35WKHBWDI6PKTYTN";
const STELLAR_USDC = "CD5IB466XCQIUDYWV22PUMJTF6EE3KPXBDGLLBSKAPNE6QPXVUZLXJGA";
const DEST_WORD = `0x000000000000000000000000${"55".repeat(20)}`;

class PglitePreflightDb implements Transactional {
  simulatedLocks: readonly Record<string, unknown>[] = [];
  simulatedLongTxCount = 0;

  constructor(private readonly pg: PGlite) {}

  async query(sql: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
    if (sql.includes("FROM pg_locks l") && this.simulatedLocks.length > 0) {
      return { rows: this.simulatedLocks, rowCount: this.simulatedLocks.length };
    }
    if (sql.includes("FROM pg_stat_activity") && this.simulatedLongTxCount > 0) {
      return {
        rows: [{ count: this.simulatedLongTxCount }],
        rowCount: 1,
      };
    }

    const res = await this.pg.query(sql, [...params]);
    const int8 = res.fields.filter((f) => f.dataTypeID === 20).map((f) => f.name);
    const rows = res.rows.map((raw) => {
      const row = { ...(raw as Record<string, unknown>) };
      for (const col of int8) {
        const val = row[col];
        if (typeof val === "number" || typeof val === "bigint") {
          row[col] = String(val);
        }
      }
      return row;
    });
    return { rows, rowCount: res.affectedRows ?? res.rows.length };
  }

  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    await this.pg.exec("BEGIN");
    try {
      const value = await work({
        query: (sql, params) => this.query(sql, params),
      });
      await this.pg.exec("COMMIT");
      return value;
    } catch (error) {
      await this.pg.exec("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
}

async function applyRepoMigrationsWithTracking(
  pg: PGlite,
  files: readonly MigrationFileInput[],
): Promise<void> {
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS pgmigrations (
      id serial PRIMARY KEY,
      name varchar(255) NOT NULL,
      run_on timestamp NOT NULL DEFAULT now()
    );
  `);
  for (const file of files) {
    const upSql = file.sql.split("-- Down Migration")[0] ?? file.sql;
    await pg.exec(upSql);
    const migName = file.filename.replace(/\.sql$/i, "");
    await pg.query("INSERT INTO pgmigrations (name, run_on) VALUES ($1, now())", [migName]);
  }
}

describe("migration preflight and rollback feasibility reports (#56)", () => {
  let pg: PGlite;
  let db: PglitePreflightDb;
  const repoFiles = loadMigrationFilesFromDir();

  beforeEach(() => {
    pg = new PGlite();
    db = new PglitePreflightDb(pg);
  });

  afterEach(async () => {
    await pg.close();
  });

  it("classifies repository migrations as reversible_schema and distinguishes irreversible data rewrites", async () => {
    // 1. Empty uninitialized DB preflight passes with empty-schema baseline
    const emptyReport = await runMigrationPreflight(db, { migrationFiles: repoFiles });
    expect(emptyReport.safe).toBe(true);
    expect(emptyReport.appliedMigrations).toEqual([]);
    expect(emptyReport.pendingMigrations).toEqual([
      "1790900000000_initial-schema",
      "1791000000000_cursor-block-hash",
      "1791100000000_cursor-autovacuum-tuning",
    ]);
    for (const mig of emptyReport.migrations) {
      expect(mig.feasibility).toBe("reversible_schema");
      expect(mig.weakensMonetaryConstraint).toBe(false);
    }
    expect(emptyReport.recoveryInstructions.strategy).toBe("down_migration_rollback");
    expect(emptyReport.recoveryInstructions.backupBoundaryId).toBe(
      "baseline:empty-uninitialized-schema",
    );

    // 2. Static distinction between reversible schema changes vs irreversible data rewrites
    const additiveReport = analyzeMigrationSql(
      {
        filename: "1791200000000_additive-index.sql",
        sql: `-- Up Migration
CREATE INDEX CONCURRENTLY outbound_transfer_by_token ON outbound_transfer (token);
-- Down Migration
DROP INDEX IF EXISTS outbound_transfer_by_token;`,
      },
      false,
      { outbound_transfer: 500 },
    );
    expect(additiveReport.feasibility).toBe("reversible_schema");
    expect(additiveReport.highestLockRisk).toBe("metadata_only");

    const rewriteReport = analyzeMigrationSql(
      {
        filename: "1791300000000_backfill-rewrite.sql",
        sql: `-- Up Migration
UPDATE outbound_transfer SET destination = lower(destination) WHERE origin_chain = 'base-sepolia';
-- Down Migration
SELECT 1;`,
      },
      false,
      { outbound_transfer: 500 },
    );
    expect(rewriteReport.feasibility).toBe("irreversible_data_rewrite");
    expect(rewriteReport.affectedRowCount).toBe(500);

    const dropPopulatedReport = analyzeMigrationSql(
      {
        filename: "1791400000000_drop-rail-ref.sql",
        sql: `-- Up Migration
ALTER TABLE outbound_transfer DROP COLUMN rail_ref;
-- Down Migration
ALTER TABLE outbound_transfer ADD COLUMN rail_ref text;`,
      },
      false,
      { outbound_transfer: 12 },
    );
    expect(dropPopulatedReport.feasibility).toBe("irreversible_data_rewrite");
  });

  it("blocks unsafe migration conditions before altering schema", async () => {
    await applyRepoMigrationsWithTracking(pg, repoFiles);
    await pg.query(
      `INSERT INTO outbound_transfer
         (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
          destination_chain, destination, origin_block, origin_tx)
       VALUES ('stellar-testnet', 0, 1, $1, $2, 10000000, 10000, 9990000, 'base-sepolia', $3, 500, 'tx1')`,
      [STELLAR_SENDER, STELLAR_USDC, DEST_WORD],
    );

    const unsafeIrreversible: MigrationFileInput = {
      filename: "1791200000000_unsafe-rewrite-and-constraint-drop.sql",
      sql: `-- Up Migration
ALTER TABLE outbound_transfer DROP CONSTRAINT outbound_transfer_amounts;
UPDATE outbound_transfer SET fee = 0;`,
    };

    let actionExecuted = false;
    await expect(
      executeMigrationsWithPreflight(
        db,
        async () => {
          actionExecuted = true;
          await pg.exec("ALTER TABLE outbound_transfer ADD COLUMN should_never_exist text");
        },
        {
          migrationFiles: [...repoFiles, unsafeIrreversible],
        },
      ),
    ).rejects.toBeInstanceOf(MigrationPreflightError);

    expect(actionExecuted).toBe(false);

    // Confirm schema was NOT altered
    const colCheck = await db.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'outbound_transfer'
         AND column_name = 'should_never_exist'`,
    );
    expect(colCheck.rows).toEqual([]);

    // Inspect exact unsafe condition codes
    const preflight = await runMigrationPreflight(db, {
      migrationFiles: [...repoFiles, unsafeIrreversible],
    });
    expect(preflight.safe).toBe(false);
    const codes = preflight.unsafeConditions.map((c) => c.code);
    expect(codes).toContain("missing_down_migration");
    expect(codes).toContain("monetary_constraint_weakened");

    // Blocking locks & unvalidated NOT VALID constraints also fail preflight before schema changes
    await pg.exec(
      "ALTER TABLE outbound_transfer ADD CONSTRAINT tmp_unvalidated CHECK (route >= 0) NOT VALID",
    );
    db.simulatedLocks = [
      {
        pid: 4242,
        relation: "outbound_transfer",
        mode: "AccessExclusiveLock",
        granted: true,
        state: "idle in transaction",
        age_seconds: 95,
      },
    ];
    db.simulatedLongTxCount = 1;

    const lockBlocked = await runMigrationPreflight(db, { migrationFiles: repoFiles });
    expect(lockBlocked.safe).toBe(false);
    expect(lockBlocked.unsafeConditions.map((c) => c.code)).toEqual(
      expect.arrayContaining([
        "blocking_locks_detected",
        "long_running_transaction_detected",
        "unvalidated_constraint_detected",
      ]),
    );
  });

  it("references a verified backup boundary and live cursor replay floor in recovery instructions", async () => {
    await applyRepoMigrationsWithTracking(pg, repoFiles);
    await pg.query(
      `INSERT INTO indexer_cursor (chain_key, family, contract, last_processed, last_processed_hash)
       VALUES ('stellar-testnet', 'stellar', $1, 885000, NULL)`,
      [STELLAR_ROUTER],
    );
    await pg.query(
      `INSERT INTO outbound_transfer
         (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
          destination_chain, destination, origin_block, origin_tx)
       VALUES ('stellar-testnet', 0, 7, $1, $2, 5000000, 5000, 4995000, 'base-sepolia', $3, 884990, 'tx7')`,
      [STELLAR_SENDER, STELLAR_USDC, DEST_WORD],
    );

    const plannedRewrite: MigrationFileInput = {
      filename: "1791200000000_normalize-rail-ref.sql",
      sql: `-- Up Migration
UPDATE outbound_transfer SET rail_ref = lower(rail_ref) WHERE rail_ref IS NOT NULL;
-- Down Migration
SELECT 1;`,
    };

    // 1. Fails without a verified backup boundary
    const withoutBackup = await runMigrationPreflight(db, {
      migrationFiles: [...repoFiles, plannedRewrite],
    });
    expect(withoutBackup.safe).toBe(false);
    expect(withoutBackup.unsafeConditions.map((c) => c.code)).toContain(
      "irreversible_migration_without_verified_backup",
    );

    // 2. Fails if backup boundary claims a cursor ahead of live database state
    const mismatchedBackup = await runMigrationPreflight(db, {
      migrationFiles: [...repoFiles, plannedRewrite],
      backupBoundary: {
        backupId: "snap-2026-10-28-bad",
        capturedAt: "2026-10-28T11:55:00.000Z",
        lastAppliedMigration: "1791100000000_cursor-autovacuum-tuning",
        cursorCheckpoints: { "stellar-testnet": "999999" },
      },
    });
    expect(mismatchedBackup.safe).toBe(false);
    expect(mismatchedBackup.unsafeConditions.map((c) => c.code)).toContain(
      "backup_boundary_invalid",
    );

    // 3. Succeeds when anchored to a verified backup boundary and emits recovery plan referencing it
    const sha = "a1".repeat(32);
    const verified = await runMigrationPreflight(db, {
      migrationFiles: [...repoFiles, plannedRewrite],
      backupBoundary: {
        backupId: "snap-2026-10-28-pre-17912",
        capturedAt: "2026-10-28T11:55:00.000Z",
        artifactSha256: sha,
        lastAppliedMigration: "1791100000000_cursor-autovacuum-tuning",
        cursorCheckpoints: { "stellar-testnet": "885000" },
      },
    });

    expect(verified.safe).toBe(true);
    expect(verified.backupBoundary.verified).toBe(true);
    expect(verified.backupBoundary.status).toBe("verified_artifact");
    expect(verified.recoveryInstructions.strategy).toBe("restore_verified_backup_and_replay");
    expect(verified.recoveryInstructions.backupBoundaryId).toBe("snap-2026-10-28-pre-17912");
    expect(verified.recoveryInstructions.schemaBoundary).toBe(
      "1791100000000_cursor-autovacuum-tuning",
    );
    expect(verified.recoveryInstructions.steps.join("\n")).toContain("snap-2026-10-28-pre-17912");
    expect(verified.recoveryInstructions.steps.join("\n")).toContain(`sha256:${sha}`);
    expect(verified.recoveryInstructions.steps.join("\n")).toContain("stellar-testnet@885000");

    const secret = ["preflight", "secret", "321"].join("_");
    expect(
      redactPreflightSecrets(`postgres://hyperion:${secret}@127.0.0.1:5432/hyperion`),
    ).toContain("postgres://hyperion:[REDACTED]@127.0.0.1:5432/hyperion");
  });
});
