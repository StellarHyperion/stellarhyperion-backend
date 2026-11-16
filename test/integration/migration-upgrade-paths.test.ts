import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../../src/db/pool.js";
import {
  loadHistoricalSnapshotFixtures,
  loadRepositoryMigrations,
  runUpgradePathFromSnapshot,
  verifyMigrationFailureBoundary,
} from "../helpers.js";

const CONNECTION = process.env.TEST_DATABASE_URL;
const suite = CONNECTION === undefined ? describe.skip : describe;

suite("PostgreSQL migration upgrade-path fixtures on real PostgreSQL (#140)", () => {
  let db: Database;

  beforeAll(() => {
    db = Database.open(CONNECTION ?? "", { applicationName: "hyperion-migration-upgrades" });
  });

  afterAll(async () => {
    await db.close();
  });

  it("runs all historical upgrade paths and failure recovery boundaries in isolated PostgreSQL schemas", async () => {
    const snapshots = loadHistoricalSnapshotFixtures();
    const allMigrations = loadRepositoryMigrations();

    for (let i = 0; i < snapshots.length; i += 1) {
      const snapshot = snapshots[i];
      if (snapshot === undefined) continue;
      const schemaName = `mig_upgrade_path_${String(i)}`;
      await db.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await db.query(`CREATE SCHEMA ${schemaName}`);
      try {
        await db.query(`SET search_path TO ${schemaName}`);
        const res = await runUpgradePathFromSnapshot(db, snapshot, allMigrations);
        expect(res.identitiesUnchanged).toBe(true);
        expect(res.verification.checkConstraintsVerified).toBe(true);
        expect(res.verification.uniqueAndPartialIndexesVerified).toBe(true);
        expect(res.verification.cascadeDeleteVerified).toBe(true);
      } finally {
        await db.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      }
    }

    const v1 = snapshots[0];
    if (v1 !== undefined) {
      await db.query("DROP SCHEMA IF EXISTS mig_upgrade_failure CASCADE");
      await db.query("CREATE SCHEMA mig_upgrade_failure");
      try {
        await db.query("SET search_path TO mig_upgrade_failure");
        const failure = await verifyMigrationFailureBoundary(
          db,
          v1,
          {
            name: "1799900000000_real-pg-fail",
            upSql: "UPDATE outbound_transfer SET fee = fee + 1;",
            downSql: "",
          },
          allMigrations,
        );
        expect(failure.preUpgradeTransfersIntact).toBe(true);
        expect(failure.preUpgradeClaimsIntact).toBe(true);
      } finally {
        await db.query("DROP SCHEMA IF EXISTS mig_upgrade_failure CASCADE");
      }
    }
  }, 45_000);
});
