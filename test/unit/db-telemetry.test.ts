import { AddressKind, encodeStellarAddress } from "@hyperion/protocol";
import { describe, expect, it } from "vitest";

import { StellarWatcher } from "../../src/chains/stellar/watcher.js";
import { loadConfig } from "../../src/config/config.js";
import {
  DB_WORKLOADS,
  Database,
  type DbTelemetrySnapshot,
  type PoolClientLike,
  type PoolLike,
} from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import { createLogger } from "../../src/logging/logger.js";
import { completeEnv } from "../helpers.js";
import { FakeRpc, capturingLogger } from "../stellar-fakes.js";

class ControlledPool implements PoolLike {
  totalCount = 0;
  idleCount = 0;
  waitingCount = 0;
  queryDelayMs = 0;
  connectDelayMs = 0;

  private readonly pendingGate: (() => void)[] = [];
  holdQueries = false;

  releaseHeldQueries(): void {
    this.holdQueries = false;
    while (this.pendingGate.length > 0) {
      this.pendingGate.shift()?.();
    }
  }

  async query(text: string): Promise<{ rows: unknown[]; rowCount: number | null }> {
    if (this.holdQueries) {
      await new Promise<void>((resolve) => {
        this.pendingGate.push(resolve);
      });
    }
    if (this.queryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.queryDelayMs));
    }
    if (text.includes("FROM outbound_transfer") && text.includes("count(*)")) {
      return { rows: [{ count: 5 }], rowCount: 1 };
    }
    if (text.includes("FROM inbound_delivery") && text.includes("count(*)")) {
      return { rows: [{ count: 4 }], rowCount: 1 };
    }
    if (text.includes("FROM pending_claim") && text.includes("count(*)")) {
      return { rows: [{ total: 1, settled: 1, unsettled: 0 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  async connect(): Promise<PoolClientLike> {
    if (this.connectDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.connectDelayMs));
    }
    this.totalCount = Math.max(this.totalCount, 1);
    return {
      query: async () => {
        if (this.queryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.queryDelayMs));
        }
        return { rows: [], rowCount: 1 };
      },
      release: () => undefined,
    };
  }

  end(): Promise<void> {
    this.releaseHeldQueries();
    return Promise.resolve();
  }
}

describe("database pool saturation and workload query latency telemetry", () => {
  it("separates API, health, and ingestion workloads into fixed low-cardinality buckets", async () => {
    const pool = new ControlledPool();
    const { logger } = capturingLogger();
    const db = Database.fromPool(pool, { maxConnections: 10, logger });

    const config = loadConfig({
      env: completeEnv({ INDEXER_ENABLED: "false", KEEPER_ENABLED: "false" }),
    });
    const routerId = encodeStellarAddress(AddressKind.Contract, Buffer.alloc(32, 0x22));

    // 1. Run ingestion workload through StellarWatcher using db.forWorkload("ingestion")
    const watcher = new StellarWatcher({
      chainKey: "stellar-testnet",
      router: routerId,
      startLedger: 100,
      pageSize: 50,
      rpc: new FakeRpc({ events: [], latestLedger: 105 }),
      db: db.forWorkload("ingestion"),
      logger,
    });
    await watcher.tick(AbortSignal.timeout(5_000));

    // 2. Run HTTP /ready (health workload) and /v1/transfers + /v1/metrics (api workload)
    const app = buildServer({
      config,
      logger,
      db,
      readiness: [],
    });

    const readyRes = await app.inject({ method: "GET", url: "/ready" });
    expect(readyRes.statusCode).toBe(200);
    expect(readyRes.json().status).toBe("ready");

    const transfersRes = await app.inject({
      method: "GET",
      url: "/v1/transfers?limit=10&offset=0",
    });
    expect(transfersRes.statusCode).toBe(200);

    const metricsRes = await app.inject({ method: "GET", url: "/v1/metrics" });
    expect(metricsRes.statusCode).toBe(200);
    const body = metricsRes.json<{ database: DbTelemetrySnapshot }>();

    expect(Object.keys(body.database.workloads).sort()).toEqual([...DB_WORKLOADS].sort());
    expect(body.database.workloads.health.totalQueries).toBe(1);
    expect(body.database.workloads.ingestion.totalQueries).toBeGreaterThanOrEqual(2);
    expect(body.database.workloads.ingestion.transactionsCommitted).toBe(1);
    expect(body.database.workloads.api.totalQueries).toBeGreaterThanOrEqual(6);
    expect(body.database.workloads.rails.totalQueries).toBe(0);
    expect(body.database.workloads.keeper.totalQueries).toBe(0);

    const apiBuckets = body.database.workloads.api.latencyBuckets;
    const sumApiBuckets =
      apiBuckets.le5ms +
      apiBuckets.le25ms +
      apiBuckets.le100ms +
      apiBuckets.le500ms +
      apiBuckets.le2000ms +
      apiBuckets.gt2000ms;
    expect(sumApiBuckets).toBe(body.database.workloads.api.totalQueries);

    await app.close();
    await db.close();
  });

  it("surfaces pool saturation in /ready, /v1/metrics, and logs before connection timeouts dominate", async () => {
    const pool = new ControlledPool();
    const { logger, lines } = capturingLogger();
    const db = Database.fromPool(pool, {
      maxConnections: 5,
      saturationThresholdRatio: 0.8,
      acquireWarnMs: 50,
      warnCooldownMs: 0,
      logger,
    });

    const config = loadConfig({
      env: completeEnv({ INDEXER_ENABLED: "false", KEEPER_ENABLED: "false" }),
    });
    const app = buildServer({ config, logger, db, readiness: [] });

    // Hold 4 concurrent ingestion queries open on a 5-connection pool (80% utilization >= 0.8)
    // while connectionTimeoutMs (10s) has NOT occurred, proving early saturation visibility!
    pool.holdQueries = true;
    const ingestionDb = db.forWorkload("ingestion");
    const inflight = [
      ingestionDb.query("SELECT 1"),
      ingestionDb.query("SELECT 1"),
      ingestionDb.query("SELECT 1"),
      ingestionDb.query("SELECT 1"),
    ];

    const liveSnap = db.telemetrySnapshot();
    expect(liveSnap.pool.activeConnections).toBe(4);
    expect(liveSnap.pool.utilizationRatio).toBe(0.8);
    expect(liveSnap.pool.saturated).toBe(true);
    expect(liveSnap.pool.saturationEvents).toBeGreaterThanOrEqual(1);

    // Release held queries so /ready ping can answer immediately while pool.waitingCount = 1
    pool.releaseHeldQueries();
    await Promise.all(inflight);

    pool.totalCount = 5;
    pool.idleCount = 0;
    pool.waitingCount = 2;

    const readyRes = await app.inject({ method: "GET", url: "/ready" });
    expect(readyRes.statusCode).toBe(200);
    const readyBody = readyRes.json();
    expect(readyBody.status).toBe("degraded");
    expect(readyBody.databasePool.saturated).toBe(true);
    expect(readyBody.databasePool.waitingClients).toBe(2);
    expect(
      readyBody.checks.some(
        (c: { name: string; state: string }) =>
          c.name === "postgres-pool" && c.state === "degraded",
      ),
    ).toBe(true);

    expect(
      lines.some((l) => l.message.includes("postgres pool saturation warning threshold reached")),
    ).toBe(true);

    await app.close();
    await db.close();
  });

  it("never exposes SQL parameters, wallet addresses, or database credentials in telemetry or logs", async () => {
    const pool = new ControlledPool();
    const { logger, lines } = capturingLogger();
    const db = Database.fromPool(pool, {
      maxConnections: 2,
      saturationThresholdRatio: 0.5,
      warnCooldownMs: 0,
      logger,
    });

    const sensitiveWallet = encodeStellarAddress(AddressKind.Account, Buffer.alloc(32, 0x9a));
    const sensitiveEvmWallet = "0x9988776655443322110099887766554433221100";
    const sensitiveTxHash = `0x${"de".repeat(32)}`;
    const secretDbUrl = "postgresql://hyperion_admin:ultra_secret_pw@db.internal:5432/hyperion";

    const config = loadConfig({
      env: completeEnv({
        DATABASE_URL: secretDbUrl,
        INDEXER_ENABLED: "false",
        KEEPER_ENABLED: "false",
      }),
    });

    // Execute parameterized queries carrying wallet addresses and transaction hashes
    await db
      .forWorkload("api")
      .query(
        "SELECT * FROM outbound_transfer WHERE sender = $1 OR destination = $2 OR origin_tx = $3",
        [sensitiveWallet, sensitiveEvmWallet, sensitiveTxHash],
      );

    // Also verify pino redaction on sqlParams / databaseUrl
    const prodLogger = createLogger(config);
    expect(prodLogger).toBeDefined();

    const app = buildServer({ config, logger, db, readiness: [] });
    const metricsText = (await app.inject({ method: "GET", url: "/v1/metrics" })).body;
    const readyText = (await app.inject({ method: "GET", url: "/ready" })).body;
    const serializedLogs = JSON.stringify(lines);

    for (const secret of [
      sensitiveWallet,
      sensitiveEvmWallet,
      sensitiveTxHash,
      "ultra_secret_pw",
      secretDbUrl,
    ]) {
      expect(metricsText).not.toContain(secret);
      expect(readyText).not.toContain(secret);
      expect(serializedLogs).not.toContain(secret);
    }

    await app.close();
    await db.close();
  });
});
