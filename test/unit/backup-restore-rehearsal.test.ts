import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { writeOutbound } from "../../src/chains/writers.js";
import type { Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";
import {
  RehearsalSafetyError,
  RehearsalValidationError,
  assertRestoreTargetSafe,
  exportIndexedSnapshot,
  restoreIndexedSnapshot,
  runBackupRestoreRehearsal,
  seedRepresentativeDataset,
  verifyRestoredSnapshot,
} from "../../src/db/rehearsal.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

const sourcePg = new PGlite();
const targetPg = new PGlite();

function normalizeRows(result: {
  readonly rows: readonly unknown[];
  readonly fields: readonly { readonly name: string; readonly dataTypeID: number }[];
  readonly affectedRows?: number;
}): QueryResultRows {
  const int8Columns = result.fields
    .filter((field) => field.dataTypeID === 20)
    .map((field) => field.name);
  const rows = result.rows.map((raw) => {
    const row = { ...(raw as Record<string, unknown>) };
    for (const column of int8Columns) {
      const value = row[column];
      if (typeof value === "number" || typeof value === "bigint") {
        row[column] = String(value);
      }
    }
    return row;
  });
  return { rows, rowCount: result.affectedRows ?? rows.length };
}

class PgliteHandle implements Transactional {
  constructor(
    private readonly instance: PGlite,
    private readonly simulatedDbName: string,
  ) {}

  async query(text: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
    if (text.trim() === "SELECT current_database() AS current_db") {
      return { rows: [{ current_db: this.simulatedDbName }], rowCount: 1 };
    }
    const res = await this.instance.query(text, [...params]);
    return normalizeRows(res);
  }

  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    await this.instance.exec("BEGIN");
    try {
      const value = await work(this);
      await this.instance.exec("COMMIT");
      return value;
    } catch (error) {
      await this.instance.exec("ROLLBACK");
      throw error;
    }
  }
}

async function applyMigrations(instance: PGlite): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const fullSql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const upSql = fullSql.split("-- Down Migration")[0] ?? fullSql;
    await instance.exec(upSql);
  }
}

describe("schema-safe backup and restore rehearsals", () => {
  const sourceDb = new PgliteHandle(sourcePg, "hyperion_source_test");
  const targetDb = new PgliteHandle(targetPg, "hyperion_rehearsal");
  let tempDir: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "hyperion-rehearsal-"));
    await applyMigrations(sourcePg);
    await applyMigrations(targetPg);
  });

  beforeEach(async () => {
    const resetSql = `
      TRUNCATE TABLE
        rail_attestation,
        route_health,
        admin_action,
        pending_claim,
        inbound_delivery,
        outbound_transfer,
        indexer_cursor
      RESTART IDENTITY CASCADE;
    `;
    await sourcePg.exec(resetSql);
    await targetPg.exec(resetSql);
  });

  afterAll(async () => {
    rmSync(tempDir, { recursive: true, force: true });
    await sourcePg.close();
    await targetPg.close();
  });

  it("exports, restores, and verifies counts, monetary digests, and cursor/provenance joins", async () => {
    const exportPath = join(tempDir, "snapshot.json");
    const targetUrl = "postgres://hyperion:local-only@127.0.0.1:5433/hyperion_rehearsal";

    const summary = await runBackupRestoreRehearsal({
      sourceDb,
      targetDb,
      targetConnectionString: targetUrl,
      seedRepresentative: true,
      exportFilePath: exportPath,
      env: {},
    });

    expect(summary.targetDatabase).toBe("hyperion_rehearsal");
    expect(summary.targetRedactedUrl).toContain("[REDACTED]@");
    expect(summary.targetRedactedUrl).not.toContain("local-only");

    expect(summary.counts).toEqual({
      indexer_cursor: 1,
      outbound_transfer: 2,
      inbound_delivery: 2,
      pending_claim: 2,
      rail_attestation: 2,
      admin_action: 1,
      route_health: 1,
    });

    // Exact arbitrary-precision monetary sums match across 10^29 + 10^7 raw amounts.
    expect(summary.monetaryDigests).toEqual({
      outboundGrossTotal: "100000000000000000000010000000",
      outboundFeeTotal: "300000000000000000000030000",
      outboundNetTotal: "99700000000000000000009970000",
      inboundAmountTotal: "99700000000000000000000997000",
      inboundDeliveredTotal: "997000",
      inboundParkedTotal: "99700000000000000000000000000",
      pendingClaimAmountTotal: "99700000000000000000005000000",
      pendingClaimSettledTotal: "5000000",
      pendingClaimUnsettledTotal: "99700000000000000000000000000",
      routeHealthFlowTotal: "500000000000",
    });

    // Cursor and provenance joins remain 100% consistent after restore.
    expect(summary.joins).toEqual({
      pairedInboundToOutbound: 2,
      pairedParkedInboundToClaim: 1,
      orphanedParkedInbound: 0,
      boundAttestationsToOutbound: 2,
      unprovenDeliveredAttestations: 0,
      cursorWatermarkViolations: 0,
    });

    // Exported snapshot file round-trips cleanly and preserves microsecond timestamps.
    const rawFile = readFileSync(exportPath, "utf8");
    expect(rawFile).toContain("2026-10-28T12:00:00.123456Z");
    expect(rawFile).toContain("18446744073709551615");

    // Serial sequence on targetDb was advanced past restored IDs so subsequent live writes succeed.
    await writeOutbound(
      targetDb,
      {
        chainKey: "stellar-testnet",
        block: 4_990_220n,
        txHash: "9f".repeat(32),
        logIndex: null,
        observedAt: new Date("2026-10-28T12:09:00.000Z"),
      },
      {
        route: 0,
        nonce: 2n,
        sender: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        token: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
        grossAmount: 1_000n,
        fee: 3n,
        netAmount: 997n,
        destinationChain: "base-sepolia",
        destination: `0x${"11".repeat(32)}`,
        railRef: null,
      },
    );

    const postWriteIds = await targetDb.query(
      "SELECT id::int AS id FROM outbound_transfer ORDER BY id ASC",
    );
    expect(postWriteIds.rows.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it("detects monetary tampering, cursor watermark drift, and unproven delivered attestations", async () => {
    await seedRepresentativeDataset(sourceDb);
    const snapshot = await exportIndexedSnapshot(sourceDb);

    await restoreIndexedSnapshot(targetDb, snapshot, {
      targetConnectionString: "postgres://hyperion:pw@localhost:5433/hyperion_rehearsal",
      env: {},
    });

    // Tamper 1: rewind cursor below committed outbound_transfer.origin_block AND mark second
    // attestation delivered without a delivered destination row (hop 2 is parked, but delete its inbound row).
    await targetDb.query(
      "UPDATE indexer_cursor SET last_processed = 4990000 WHERE chain_key = 'stellar-testnet'",
    );
    await targetDb.query("DELETE FROM inbound_delivery WHERE destination_chain = 'sepolia'");
    await targetDb.query("UPDATE rail_attestation SET status = 'delivered' WHERE route = 1");

    const report = await verifyRestoredSnapshot(targetDb, snapshot.manifest);
    expect(report.ok).toBe(false);
    expect(report.mismatches).toEqual(
      expect.arrayContaining([
        "invariant_violation:cursor_watermark_violations=2",
        "invariant_violation:unproven_delivered_attestations=1",
      ]),
    );
  });

  it("refuses production or non-rehearsal databases unless explicit override configuration is provided", async () => {
    const secretPw = ["prod", "db", "secret", "98765"].join("_");
    const remoteProdUrl = `postgres://admin:${secretPw}@ep-floral-meadow.us-east-2.aws.neon.tech:5432/hyperion`;
    const localNonTestUrl = `postgres://hyperion:${secretPw}@127.0.0.1:5433/hyperion`;
    const localRehearsalUrl = `postgres://hyperion:${secretPw}@127.0.0.1:5433/hyperion_rehearsal`;

    // 1. Remote host blocked and password redacted from thrown message
    expect(() =>
      assertRestoreTargetSafe({ targetConnectionString: remoteProdUrl, env: {} }),
    ).toThrow(
      expect.objectContaining({
        name: "RehearsalSafetyError",
        code: "non_local_target_blocked",
      }),
    );

    try {
      assertRestoreTargetSafe({ targetConnectionString: remoteProdUrl, env: {} });
    } catch (error) {
      expect(error).toBeInstanceOf(RehearsalSafetyError);
      expect((error as Error).message).not.toContain(secretPw);
      expect((error as Error).message).toContain("[REDACTED]@");
    }

    // 2. Local database named 'hyperion' (without _test / _rehearsal) blocked by default
    expect(() =>
      assertRestoreTargetSafe({ targetConnectionString: localNonTestUrl, env: {} }),
    ).toThrow(
      expect.objectContaining({
        code: "non_rehearsal_database_blocked",
      }),
    );

    // 3. Mainnet or production env blocked even against a local rehearsal DB
    expect(() =>
      assertRestoreTargetSafe({
        targetConnectionString: localRehearsalUrl,
        env: { HYPERION_NETWORK: "mainnet" },
      }),
    ).toThrow(
      expect.objectContaining({
        code: "production_environment_blocked",
      }),
    );

    // 4. Connected live database name mismatch blocked during restore
    await seedRepresentativeDataset(sourceDb);
    const snapshot = await exportIndexedSnapshot(sourceDb);
    const aliasedDb = new PgliteHandle(targetPg, "hyperion_live_primary");
    await expect(
      restoreIndexedSnapshot(aliasedDb, snapshot, {
        targetConnectionString: localRehearsalUrl,
        env: {},
      }),
    ).rejects.toMatchObject({
      code: "target_database_mismatch",
    });

    // 5. Explicit three-part override permits deliberate non-test target
    const unlocked = assertRestoreTargetSafe({
      targetConnectionString: remoteProdUrl,
      env: { HYPERION_ALLOW_NON_TEST_RESTORE: "true", NODE_ENV: "production" },
      allowNonTestTarget: true,
      confirmTargetDatabase: "hyperion",
    });
    expect(unlocked.databaseName).toBe("hyperion");
    expect(unlocked.redactedUrl).not.toContain(secretPw);

    // Also verify schema drift rejection when target table is missing a required column
    const driftedSnapshot = {
      ...snapshot,
      schema: [
        ...snapshot.schema,
        {
          tableName: "outbound_transfer" as const,
          columnName: "nonexistent_future_column",
          dataType: "text",
          numericPrecision: null,
          numericScale: null,
          isNullable: true,
        },
      ],
    };
    await expect(
      restoreIndexedSnapshot(targetDb, driftedSnapshot, {
        targetConnectionString: localRehearsalUrl,
        env: {},
      }),
    ).rejects.toThrow(RehearsalValidationError);
  });
});
