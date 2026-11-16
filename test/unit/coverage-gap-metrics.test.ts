import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CoverageTracker,
  readCoverageGapMetrics,
  recordCoverageGap,
  resolveBackfillCoverage,
} from "../../src/chains/coverage.js";
import { StellarWatcher } from "../../src/chains/stellar/watcher.js";
import { loadConfig } from "../../src/config/config.js";
import type { Database, Queryable, QueryResultRows } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import { completeEnv } from "../helpers.js";
import { FakeRpc, capturingLogger } from "../stellar-fakes.js";

const ACTIVE_TESTNET_DEPLOYMENT = fileURLToPath(
  new URL("../../deployments/testnet.json", import.meta.url),
);

function migrationPath(name: string): string {
  return fileURLToPath(new URL(`../../migrations/${name}`, import.meta.url));
}

describe("historical coverage-gap metrics", () => {
  const pg = new PGlite();
  let txLock: Promise<void> = Promise.resolve();

  function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = txLock.then(fn, fn);
    txLock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  const rawQuery = async (sql: string, params?: readonly unknown[]): Promise<QueryResultRows> => {
    const result = await pg.query(sql, [...(params ?? [])]);
    const int8 = result.fields
      .filter((field) => field.dataTypeID === 20)
      .map((field) => field.name);
    const rows = result.rows.map((raw) => {
      const row = { ...(raw as Record<string, unknown>) };
      for (const column of int8) {
        const value = row[column];
        if (typeof value === "number" || typeof value === "bigint") {
          row[column] = String(value);
        }
      }
      return row;
    });
    return { rows, rowCount: result.affectedRows ?? result.rows.length };
  };

  const pgliteDb = {
    query: (sql: string, params?: readonly unknown[]) => runExclusive(() => rawQuery(sql, params)),
    ping: () =>
      runExclusive(async () => {
        await pg.query("SELECT 1");
      }),
    transaction: <T>(work: (tx: Queryable) => Promise<T>): Promise<T> =>
      runExclusive(async () => {
        await pg.exec("BEGIN");
        try {
          const val = await work({ query: rawQuery });
          await pg.exec("COMMIT");
          return val;
        } catch (error) {
          await pg.exec("ROLLBACK").catch(() => undefined);
          throw error;
        }
      }),
  } as unknown as Database;

  beforeAll(async () => {
    for (const name of [
      "1790900000000_initial-schema.sql",
      "1791000000000_cursor-block-hash.sql",
      "1791100000000_cursor-autovacuum-tuning.sql",
      "1791200000000_coverage-gaps.sql",
    ]) {
      const sql = readFileSync(migrationPath(name), "utf8").split("-- Down Migration")[0]!;
      await pg.exec(sql);
    }
  }, 30_000);

  afterAll(async () => {
    await pg.close();
  });

  it("represents unknown historical coverage explicitly before deployment history is verified", async () => {
    await pg.exec(
      "DELETE FROM indexer_coverage_gap; DELETE FROM indexer_coverage_state; DELETE FROM indexer_cursor;",
    );

    const config = loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: ACTIVE_TESTNET_DEPLOYMENT,
        KEEPER_ENABLED: "false",
      }),
    });

    // 1. Cold database: zero cursor and zero coverage rows -> unknown, never complete.
    const coldSnapshot = await readCoverageGapMetrics(pgliteDb, config);
    expect(coldSnapshot.overallStatus).toBe("unknown");
    expect(coldSnapshot.byChain[0]).toMatchObject({
      chain: "stellar-testnet",
      coverageStatus: "unknown",
      unresolvedGapCount: 0,
      missingBlocksTotal: "0",
      oldestMissingRange: null,
    });

    // 2. Cursor row exists alone without verified historical coverage state -> still unknown.
    await pgliteDb.query(
      `INSERT INTO indexer_cursor (chain_key, family, contract, last_processed)
       VALUES ('stellar-testnet', 'stellar', $1, 5440000)`,
      [config.indexer.stellar!.routerContractId],
    );

    const unverifiedCursorSnapshot = await readCoverageGapMetrics(pgliteDb, config);
    expect(unverifiedCursorSnapshot.overallStatus).toBe("unknown");
    expect(unverifiedCursorSnapshot.byChain[0]?.coverageStatus).toBe("unknown");
    expect(unverifiedCursorSnapshot.byChain[0]?.currentCursor).toBe("5440000");
  });

  it("keeps historical retention gaps visible even after the live cursor catches up to head", async () => {
    await pg.exec(
      "DELETE FROM indexer_coverage_gap; DELETE FROM indexer_coverage_state; DELETE FROM indexer_cursor;",
    );

    const config = loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: ACTIVE_TESTNET_DEPLOYMENT,
        KEEPER_ENABLED: "false",
      }),
    });
    const router = config.indexer.stellar!.routerContractId;
    const deployedLedger = 5_433_808;
    const coverage = new CoverageTracker(pgliteDb);
    const { logger } = capturingLogger();

    // First pass indexes [5433808..5433820] cleanly.
    const initialRpc = new FakeRpc({ latestLedger: 5_433_820 });
    const initialWatcher = new StellarWatcher({
      chainKey: "stellar-testnet",
      router,
      startLedger: deployedLedger,
      deployedLedger,
      pageSize: 50,
      rpc: initialRpc,
      db: pgliteDb,
      logger,
      coverage,
    });
    await initialWatcher.tick(new AbortController().signal);

    // Retention window then advances past 5433820: oldestLedger = 5433900, latestLedger = 5433950.
    // Ledgers [5433821..5433899] (79 ledgers) fell out of retention while cursor catches up to 5433950!
    const gappedRpc = new FakeRpc({
      oldestLedger: 5_433_900,
      latestLedger: 5_433_950,
    });
    const gappedWatcher = new StellarWatcher({
      chainKey: "stellar-testnet",
      router,
      startLedger: deployedLedger,
      deployedLedger,
      pageSize: 50,
      rpc: gappedRpc,
      db: pgliteDb,
      logger,
      coverage,
    });
    const hasMore = await gappedWatcher.tick(new AbortController().signal);
    expect(hasMore).toBe(false);
    // Live watcher cursor is completely caught up at head (behind === 0):
    expect(gappedWatcher.progress?.ledger).toBe(5_433_950);
    expect(gappedWatcher.progress?.behind).toBe(0);

    // Separate API-only server checks /v1/metrics: recent cursor at 5433950 MUST NOT hide [5433821..5433899]!
    const apiConfig = loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: ACTIVE_TESTNET_DEPLOYMENT,
        INDEXER_ENABLED: "false",
        KEEPER_ENABLED: "false",
      }),
    });
    const app = buildServer({ config: apiConfig, logger, db: pgliteDb, readiness: [] });
    try {
      const res = await app.inject({ method: "GET", url: "/v1/metrics" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.cursors).toEqual([
        expect.objectContaining({
          chain: "stellar-testnet",
          block: "5433950",
        }),
      ]);

      expect(body.coverageGaps.overallStatus).toBe("gapped");
      expect(body.coverageGaps.unresolvedGapCount).toBe(1);
      expect(body.coverageGaps.missingBlocksTotal).toBe("79");
      expect(body.coverageGaps.oldestMissingRange).toMatchObject({
        chain: "stellar-testnet",
        family: "stellar",
        fromHeight: "5433821",
        toHeight: "5433899",
        missingCount: "79",
        reason: "rpc_retention_gap",
      });
    } finally {
      await app.close();
    }
  });

  it("updates gap counts, missing totals, and oldest missing range deterministically as backfills resolve slices", async () => {
    await pg.exec(
      "DELETE FROM indexer_coverage_gap; DELETE FROM indexer_coverage_state; DELETE FROM indexer_cursor;",
    );

    const config = loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: ACTIVE_TESTNET_DEPLOYMENT,
        KEEPER_ENABLED: "false",
      }),
    });
    const deployedStart = 5_433_808n;

    // Seed verified base [5433808..5434500] plus two open gaps: [5433900..5433999] (100) and [5434100..5434149] (50).
    await resolveBackfillCoverage(pgliteDb, {
      chainKey: "stellar-testnet",
      family: "stellar",
      deployedStart,
      fromHeight: 5_433_808n,
      toHeight: 5_434_500n,
    });
    await recordCoverageGap(pgliteDb, {
      chainKey: "stellar-testnet",
      family: "stellar",
      fromHeight: 5_433_900n,
      toHeight: 5_433_999n,
      reason: "rpc_retention_gap",
    });
    await recordCoverageGap(pgliteDb, {
      chainKey: "stellar-testnet",
      family: "stellar",
      fromHeight: 5_434_100n,
      toHeight: 5_434_149n,
      reason: "rpc_retention_gap",
    });

    // Duplicate/overlapping gap recording coalesces deterministically rather than double-counting.
    await recordCoverageGap(pgliteDb, {
      chainKey: "stellar-testnet",
      family: "stellar",
      fromHeight: 5_433_920n,
      toHeight: 5_433_980n,
      reason: "rpc_retention_gap",
    });

    let metrics = await readCoverageGapMetrics(pgliteDb, config);
    expect(metrics.overallStatus).toBe("gapped");
    expect(metrics.unresolvedGapCount).toBe(2);
    expect(metrics.missingBlocksTotal).toBe("150");
    expect(metrics.oldestMissingRange).toMatchObject({
      fromHeight: "5433900",
      toHeight: "5433999",
      missingCount: "100",
    });

    // Partial interior backfill [5433920..5433979] (60 ledgers) splits the first gap into [5433900..5433919] (20) and [5433980..5433999] (20).
    await resolveBackfillCoverage(pgliteDb, {
      chainKey: "stellar-testnet",
      family: "stellar",
      deployedStart,
      fromHeight: 5_433_920n,
      toHeight: 5_433_979n,
    });

    metrics = await readCoverageGapMetrics(pgliteDb, config);
    expect(metrics.overallStatus).toBe("gapped");
    expect(metrics.unresolvedGapCount).toBe(3);
    expect(metrics.missingBlocksTotal).toBe("90");
    expect(metrics.oldestMissingRange).toMatchObject({
      fromHeight: "5433900",
      toHeight: "5433919",
      missingCount: "20",
    });

    // Resolve the entire first gap region [5433900..5433999]: oldestMissingRange shifts deterministically to [5434100..5434149]!
    await resolveBackfillCoverage(pgliteDb, {
      chainKey: "stellar-testnet",
      family: "stellar",
      deployedStart,
      fromHeight: 5_433_900n,
      toHeight: 5_433_999n,
    });

    metrics = await readCoverageGapMetrics(pgliteDb, config);
    expect(metrics.overallStatus).toBe("gapped");
    expect(metrics.unresolvedGapCount).toBe(1);
    expect(metrics.missingBlocksTotal).toBe("50");
    expect(metrics.oldestMissingRange).toMatchObject({
      fromHeight: "5434100",
      toHeight: "5434149",
      missingCount: "50",
    });

    // Resolve the remaining gap [5434100..5434149] -> coverageStatus transitions cleanly to "complete"!
    await resolveBackfillCoverage(pgliteDb, {
      chainKey: "stellar-testnet",
      family: "stellar",
      deployedStart,
      fromHeight: 5_434_100n,
      toHeight: 5_434_149n,
    });

    metrics = await readCoverageGapMetrics(pgliteDb, config);
    expect(metrics.overallStatus).toBe("complete");
    expect(metrics.unresolvedGapCount).toBe(0);
    expect(metrics.missingBlocksTotal).toBe("0");
    expect(metrics.oldestMissingRange).toBeNull();
  });
});
