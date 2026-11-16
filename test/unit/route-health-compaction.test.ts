import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  compactRouteHealthSamples,
  queryRouteHealthHistory,
  writeHealthSample,
} from "../../src/chains/writers.js";
import { loadConfig } from "../../src/config/config.js";
import type { Database, Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import { completeEnv } from "../helpers.js";
import { LIVE_ROUTER, capturingLogger } from "../stellar-fakes.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

const pg = new PGlite();

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

class PgliteDb implements Transactional {
  async query(text: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
    const res = await pg.query(text, [...params]);
    return normalizeRows(res);
  }

  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    await pg.exec("BEGIN");
    try {
      const value = await work(this);
      await pg.exec("COMMIT");
      return value;
    } catch (error) {
      await pg.exec("ROLLBACK");
      throw error;
    }
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }
}

describe("bounded route-health sample compaction", () => {
  const db = new PgliteDb();
  const U256_FLOW_A =
    115792089237316195423570985008687907853269984665640564039457584007913129639935n;
  const U256_FLOW_B =
    115792089237316195423570985008687907853269984665640564039457584007913129639934n;

  beforeAll(async () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const fullSql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      const upSql = fullSql.split("-- Down Migration")[0] ?? fullSql;
      await pg.exec(upSql);
    }
  });

  beforeEach(async () => {
    await pg.exec(`
      TRUNCATE TABLE
        health_sample_compaction,
        route_health
      RESTART IDENTITY CASCADE;
    `);
  });

  afterAll(async () => {
    await pg.close();
  });

  async function appendSample(
    isoTime: string,
    state: {
      readonly available: boolean;
      readonly blocker: number;
      readonly flowAvailable: bigint | null;
    },
  ): Promise<void> {
    await writeHealthSample(
      db,
      {
        chainKey: "stellar-testnet",
        block: 5_000_000n,
        txHash: `tx-${isoTime}`,
        logIndex: null,
        observedAt: new Date(isoTime),
      },
      {
        originChain: "stellar-testnet",
        destinationChain: "base-sepolia",
        route: 0,
        token: LIVE_ROUTER,
        available: state.available,
        blocker: state.blocker,
        flowAvailable: state.flowAvailable,
      },
    );
  }

  it("retains every distinct configuration transition across bounded batches while keeping recent samples raw", async () => {
    // Transition 1: available=true, blocker=0, flow=U256_FLOW_A (3 samples)
    await appendSample("2026-10-01T00:00:00.000Z", {
      available: true,
      blocker: 0,
      flowAvailable: U256_FLOW_A,
    });
    await appendSample("2026-10-01T00:05:00.000Z", {
      available: true,
      blocker: 0,
      flowAvailable: U256_FLOW_A,
    });
    await appendSample("2026-10-01T00:10:00.000Z", {
      available: true,
      blocker: 0,
      flowAvailable: U256_FLOW_A,
    });

    // Transition 2: 1-wei flow limit change at uint256 scale must NOT be merged with Transition 1
    await appendSample("2026-10-01T00:15:00.000Z", {
      available: true,
      blocker: 0,
      flowAvailable: U256_FLOW_B,
    });
    await appendSample("2026-10-01T00:20:00.000Z", {
      available: true,
      blocker: 0,
      flowAvailable: U256_FLOW_B,
    });

    // Transition 3: router paused (available=false, blocker=1, flow=null) (2 samples)
    await appendSample("2026-10-01T00:25:00.000Z", {
      available: false,
      blocker: 1,
      flowAvailable: null,
    });
    await appendSample("2026-10-01T00:30:00.000Z", {
      available: false,
      blocker: 1,
      flowAvailable: null,
    });

    // Transition 4: unpaused back to initial U256_FLOW_A (must remain separate from Transition 1!)
    await appendSample("2026-10-01T00:35:00.000Z", {
      available: true,
      blocker: 0,
      flowAvailable: U256_FLOW_A,
    });
    await appendSample("2026-10-01T00:40:00.000Z", {
      available: true,
      blocker: 0,
      flowAvailable: U256_FLOW_A,
    });

    // Recent diagnostic window (>= 2026-10-01T23:00:00Z): identical samples stay raw!
    await appendSample("2026-10-01T23:30:00.000Z", {
      available: true,
      blocker: 0,
      flowAvailable: U256_FLOW_A,
    });
    await appendSample("2026-10-01T23:45:00.000Z", {
      available: true,
      blocker: 0,
      flowAvailable: U256_FLOW_A,
    });

    const result = await compactRouteHealthSamples(db, {
      rawWindowSeconds: 3_600,
      batchSize: 2,
      maxBatches: 10,
      now: () => new Date("2026-10-02T00:00:00.000Z"),
    });

    // 5 redundant old samples deleted across bounded batches of size 2.
    expect(result.deletedRows).toBe(5);
    expect(result.batchesRun).toBeGreaterThanOrEqual(3);
    expect(result.hasMore).toBe(false);

    // Re-running compaction is a complete no-op.
    const secondRun = await compactRouteHealthSamples(db, {
      rawWindowSeconds: 3_600,
      batchSize: 2,
      maxBatches: 10,
      now: () => new Date("2026-10-02T00:00:00.000Z"),
    });
    expect(secondRun.deletedRows).toBe(0);

    const history = await queryRouteHealthHistory(db, {
      originChain: "stellar-testnet",
      destinationChain: "base-sepolia",
      route: 0,
    });

    // 4 compacted transition boundaries + 2 raw recent diagnostic samples = 6 stored rows, 11 represented samples.
    expect(history.coverage.storedRowCount).toBe(6);
    expect(history.coverage.representedSampleCount).toBe(11);
    expect(history.coverage.compactedBoundaryRowCount).toBe(4);
    expect(history.coverage.rawRowCount).toBe(2);
    expect(history.coverage.compactedBefore?.toISOString()).toBe("2026-10-01T23:00:00.000Z");

    expect(
      history.samples.map((s) => ({
        sampledAt: s.sampledAt.toISOString(),
        windowEndedAt: s.windowEndedAt?.toISOString() ?? null,
        available: s.available,
        blocker: s.blocker,
        flowAvailable: s.flowAvailable,
        compactedCount: s.compactedCount,
        resolution: s.resolution,
      })),
    ).toEqual([
      {
        sampledAt: "2026-10-01T00:00:00.000Z",
        windowEndedAt: "2026-10-01T00:10:00.000Z",
        available: true,
        blocker: 0,
        flowAvailable: U256_FLOW_A.toString(),
        compactedCount: 3,
        resolution: "compacted",
      },
      {
        sampledAt: "2026-10-01T00:15:00.000Z",
        windowEndedAt: "2026-10-01T00:20:00.000Z",
        available: true,
        blocker: 0,
        flowAvailable: U256_FLOW_B.toString(),
        compactedCount: 2,
        resolution: "compacted",
      },
      {
        sampledAt: "2026-10-01T00:25:00.000Z",
        windowEndedAt: "2026-10-01T00:30:00.000Z",
        available: false,
        blocker: 1,
        flowAvailable: null,
        compactedCount: 2,
        resolution: "compacted",
      },
      {
        sampledAt: "2026-10-01T00:35:00.000Z",
        windowEndedAt: "2026-10-01T00:40:00.000Z",
        available: true,
        blocker: 0,
        flowAvailable: U256_FLOW_A.toString(),
        compactedCount: 2,
        resolution: "compacted",
      },
      {
        sampledAt: "2026-10-01T23:30:00.000Z",
        windowEndedAt: null,
        available: true,
        blocker: 0,
        flowAvailable: U256_FLOW_A.toString(),
        compactedCount: 1,
        resolution: "raw",
      },
      {
        sampledAt: "2026-10-01T23:45:00.000Z",
        windowEndedAt: null,
        available: true,
        blocker: 0,
        flowAvailable: U256_FLOW_A.toString(),
        compactedCount: 1,
        resolution: "raw",
      },
    ]);
  });

  it("keeps active ingestion available between bounded batches and exposes coverage on REST endpoints", async () => {
    for (let minute = 0; minute < 6; minute++) {
      await appendSample(`2026-10-01T01:0${String(minute)}:00.000Z`, {
        available: true,
        blocker: 0,
        flowAvailable: 50_000_000n,
      });
    }

    let liveIngestedCount = 0;
    const compactionResult = await compactRouteHealthSamples(db, {
      rawWindowSeconds: 3_600,
      batchSize: 2,
      maxBatches: 10,
      now: () => new Date("2026-10-02T00:00:00.000Z"),
      onBatchComplete: async (batchIndex) => {
        if (batchIndex < 2) {
          liveIngestedCount += 1;
          await appendSample(`2026-10-01T23:5${String(batchIndex)}:00.000Z`, {
            available: batchIndex === 0,
            blocker: batchIndex === 0 ? 0 : 2,
            flowAvailable: batchIndex === 0 ? 50_000_000n : null,
          });
        }
      },
    });

    expect(compactionResult.deletedRows).toBe(5);
    expect(liveIngestedCount).toBe(2);

    const config = loadConfig({ env: completeEnv() });
    const { logger } = capturingLogger();
    const app = buildServer({
      config,
      logger,
      db: db as unknown as Database,
      readiness: [],
    });

    const latestRes = await app.inject({
      method: "GET",
      url: "/v1/routes/health",
    });
    expect(latestRes.statusCode).toBe(200);
    const latestBody = latestRes.json();
    expect(latestBody.count).toBe(1);
    expect(latestBody.routes[0].available).toBe(false);
    expect(latestBody.routes[0].blocker.code).toBe(2);
    expect(latestBody.routes[0].resolution).toBe("raw");
    expect(latestBody.coverage.hasCompactedHistory).toBe(true);
    expect(latestBody.coverage.compactedBefore).toBe("2026-10-01T23:00:00.000Z");

    const historyRes = await app.inject({
      method: "GET",
      url: "/v1/routes/health/history?originChain=stellar-testnet&route=0",
    });
    expect(historyRes.statusCode).toBe(200);
    const historyBody = historyRes.json();
    expect(historyBody.count).toBe(3);
    expect(historyBody.coverage).toMatchObject({
      compactedBefore: "2026-10-01T23:00:00.000Z",
      rawFrom: "2026-10-01T23:00:00.000Z",
      rawWindowSeconds: 3_600,
      storedRowCount: 3,
      representedSampleCount: 8,
      compactedBoundaryRowCount: 1,
      rawRowCount: 2,
    });
  });
});
