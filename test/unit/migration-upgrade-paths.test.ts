import { describe, expect, it } from "vitest";

import {
  applyPendingMigrationSteps,
  createDedicatedMigrationPGliteDb,
  listCommittedMigrations,
  loadHistoricalSnapshotFixtures,
  loadRepositoryMigrations,
  MIGRATION_U256_MAX,
  MIGRATION_U64_MAX,
  runUpgradePathFromSnapshot,
  verifyMigrationFailureBoundary,
} from "../helpers.js";

describe("PostgreSQL migration upgrade-path fixtures (#140)", () => {
  it("upgrades every supported historical schema snapshot through head while keeping transfer and claim identities, amounts, constraints, and joins intact", async () => {
    const snapshots = loadHistoricalSnapshotFixtures();
    const allMigrations = loadRepositoryMigrations();
    expect(snapshots.length).toBeGreaterThanOrEqual(3);

    for (const snapshot of snapshots) {
      const db = await createDedicatedMigrationPGliteDb();
      try {
        const result = await runUpgradePathFromSnapshot(db, snapshot, allMigrations);

        expect(result.identitiesUnchanged).toBe(true);
        expect(result.transfersAfter).toEqual(result.transfersBefore);
        expect(result.claimsAfter).toEqual(result.claimsBefore);
        expect(result.committedMigrationsAfter).toEqual(allMigrations.map((m) => m.name));

        // Verify extreme U64_MAX nonce and U256_MAX gross_amount survived bit-for-bit.
        const maxTransfer = result.transfersAfter.find((t) => t.nonce === MIGRATION_U64_MAX);
        expect(maxTransfer?.grossAmount).toBe(MIGRATION_U256_MAX);

        // Verify both unsettled and settled claims kept exact identities and settlement metadata.
        expect(result.claimsAfter).toHaveLength(2);
        expect(result.claimsAfter.some((c) => !c.settled && c.settledBy === null)).toBe(true);
        expect(result.claimsAfter.some((c) => c.settled && c.settledBy !== null)).toBe(true);

        // Verify post-upgrade CHECK, UNIQUE, partial index, FK cascade, 4-table joins, and cursor options.
        expect(result.verification.checkConstraintsVerified).toBe(true);
        expect(result.verification.uniqueAndPartialIndexesVerified).toBe(true);
        expect(result.verification.cascadeDeleteVerified).toBe(true);
        expect(result.verification.lifecycleJoinRowsMatched).toBe(3);
        expect(result.verification.cursorHasBlockHashColumn).toBe(true);
        expect(result.verification.cursorAutovacuumOptions).toEqual(
          expect.arrayContaining([
            "autovacuum_vacuum_scale_factor=0.05",
            "autovacuum_vacuum_cost_limit=500",
          ]),
        );
      } finally {
        await db.close();
      }
    }
  }, 45_000);

  it("rolls back a failing migration step atomically, leaves a documented recoverable boundary, and completes cleanly once fixed", async () => {
    const snapshots = loadHistoricalSnapshotFixtures();
    const allMigrations = loadRepositoryMigrations();
    const v1Snapshot = snapshots[0];
    if (v1Snapshot === undefined) throw new Error("Missing v1 snapshot fixture");

    const db = await createDedicatedMigrationPGliteDb();
    try {
      const brokenStep = {
        name: "1799900000000_broken-upgrade-step",
        // Mutates rows and adds a column before hitting a constraint failure mid-transaction.
        upSql: `
          ALTER TABLE outbound_transfer ADD COLUMN temp_upgrade_probe text DEFAULT 'dirty';
          UPDATE outbound_transfer SET fee = fee + 1;
        `,
        downSql: "ALTER TABLE outbound_transfer DROP COLUMN IF EXISTS temp_upgrade_probe;",
      };

      const report = await verifyMigrationFailureBoundary(
        db,
        v1Snapshot,
        brokenStep,
        allMigrations,
      );

      expect(report.failedMigration).toBe("1799900000000_broken-upgrade-step");
      expect(report.lastCommittedMigration).toBe(
        allMigrations[allMigrations.length - 1]?.name ?? null,
      );
      expect(report.pendingMigrations).toEqual(["1799900000000_broken-upgrade-step"]);
      expect(report.preUpgradeTransfersIntact).toBe(true);
      expect(report.preUpgradeClaimsIntact).toBe(true);
      expect(report.recoveryBoundaryDocumented).toContain("Transactional DDL rolled back");

      // Confirm partial DDL (temp_upgrade_probe) was completely rolled back!
      const leakedCol = await db.query(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_name = 'outbound_transfer' AND column_name = 'temp_upgrade_probe'`,
      );
      expect(leakedCol.rows).toHaveLength(0);

      // Now supply the repaired migration step and prove recovery advances cleanly from lastCommittedMigration!
      const repairedStep = {
        name: "1799900000000_broken-upgrade-step",
        upSql:
          "ALTER TABLE indexer_cursor ADD COLUMN IF NOT EXISTS upgrade_repaired_at timestamptz;",
        downSql: "ALTER TABLE indexer_cursor DROP COLUMN IF EXISTS upgrade_repaired_at;",
      };
      const appliedOnRecovery = await applyPendingMigrationSteps(db, [
        ...allMigrations,
        repairedStep,
      ]);
      expect(appliedOnRecovery).toEqual(["1799900000000_broken-upgrade-step"]);

      const finalCommitted = await listCommittedMigrations(db);
      expect(finalCommitted).toContain("1799900000000_broken-upgrade-step");
    } finally {
      await db.close();
    }
  }, 30_000);
});
