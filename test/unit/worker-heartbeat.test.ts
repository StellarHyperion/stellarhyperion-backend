import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PolledWorker } from "../../src/chains/runner.js";
import { StellarWatcher } from "../../src/chains/stellar/watcher.js";
import { loadConfig } from "../../src/config/config.js";
import type { Database, Queryable, Transactional } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import {
  MAX_DIAGNOSTIC_LENGTH,
  MAX_REPLICA_ID_LENGTH,
  sanitizeDiagnosticText,
  sanitizeReplicaId,
} from "../../src/logging/logger.js";
import { RailPass } from "../../src/rails/pass.js";
import type { PendingTransfer, RailClient, RailLookup } from "../../src/rails/types.js";
import { recordWorkerHeartbeat } from "../../src/runtime/heartbeat.js";
import { completeEnv } from "../helpers.js";
import { FakeRpc, capturingLogger } from "../stellar-fakes.js";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(THIS_DIR, "..", "..");
const ACTIVE_TESTNET_DEPLOYMENTS = join(REPO_ROOT, "deployments", "testnet.json");
const MIGRATIONS = [
  "1790900000000_initial-schema.sql",
  "1791000000000_cursor-block-hash.sql",
  "1791100000000_cursor-autovacuum-tuning.sql",
  "1791200000000_worker-heartbeat.sql",
];

function createPgliteTransactional(pg: PGlite): Transactional & { ping(): Promise<void> } {
  const query = async (sql: string, params: readonly unknown[] = []) => {
    const result = await pg.query(sql, [...params]);
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

  return {
    query,
    async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      await pg.query("BEGIN");
      try {
        const value = await work({ query });
        await pg.query("COMMIT");
        return value;
      } catch (error) {
        await pg.query("ROLLBACK");
        throw error;
      }
    },
    async ping(): Promise<void> {
      await pg.query("SELECT 1");
    },
  };
}

describe("persistent indexer heartbeat reporting", () => {
  const pg = new PGlite();
  const db = createPgliteTransactional(pg);
  let clockMs = Date.parse("2026-10-30T12:00:00.000Z");
  const now = () => new Date(clockMs);

  const apiConfig = loadConfig({
    env: completeEnv({
      HYPERION_DEPLOYMENTS_FILE: ACTIVE_TESTNET_DEPLOYMENTS,
      INDEXER_ENABLED: "false",
      RAILS_ENABLED: "false",
      KEEPER_ENABLED: "false",
    }),
  });

  beforeAll(async () => {
    for (const file of MIGRATIONS) {
      const fullPath = join(REPO_ROOT, "migrations", file);
      const upSql = readFileSync(fullPath, "utf8").split("-- Down Migration")[0] ?? "";
      await pg.exec(upSql);
    }
  }, 30_000);

  beforeEach(async () => {
    clockMs = Date.parse("2026-10-30T12:00:00.000Z");
    await pg.exec(
      "TRUNCATE worker_heartbeat, indexer_cursor, rail_attestation, inbound_delivery, outbound_transfer RESTART IDENTITY CASCADE",
    );
  });

  afterAll(async () => {
    await pg.close();
  });

  it("never treats a healthy database alone as a fresh indexer heartbeat on an API replica", async () => {
    const { logger } = capturingLogger();
    const app = buildServer({
      config: apiConfig,
      logger,
      db: db as unknown as Database,
      readiness: [],
      replicaId: "vercel-iad1-01",
      now,
    });

    const readyRes = await app.inject({ method: "GET", url: "/ready" });
    expect(readyRes.statusCode).toBe(200);
    const readyBody = readyRes.json();
    expect(readyBody.status).toBe("degraded");
    expect(readyBody.replicaId).toBe("vercel-iad1-01");

    const pgCheck = readyBody.checks.find((c: { name: string }) => c.name === "postgres");
    const hbCheck = readyBody.checks.find((c: { name: string }) => c.name === "indexer-heartbeat");
    expect(pgCheck).toEqual({ name: "postgres", state: "ready", detail: "answering" });
    expect(hbCheck).toBeDefined();
    expect(hbCheck.state).toBe("degraded");
    expect(hbCheck.detail).toContain("missing heartbeat for stellar-testnet");

    const metricsRes = await app.inject({ method: "GET", url: "/v1/metrics" });
    expect(metricsRes.statusCode).toBe(200);
    const metricsBody = metricsRes.json();
    expect(metricsBody.indexerHeartbeat.status).toBe("degraded");
    expect(metricsBody.indexerHeartbeat.expectedWorkers).toEqual(["stellar-testnet"]);
    expect(metricsBody.indexerHeartbeat.missingWorkers).toEqual(["stellar-testnet"]);
    expect(metricsBody.heartbeats).toEqual([]);

    await app.close();
  });

  it("persists completed worker progress and workload across processes and degrades once stale", async () => {
    const { logger } = capturingLogger();
    const stellarCfg = apiConfig.indexer.stellar;
    expect(stellarCfg).not.toBeNull();
    expect(apiConfig.indexer.evm).toEqual([]);
    if (stellarCfg === null) return;

    const fakeRpc = new FakeRpc({
      latestLedger: stellarCfg.startLedger + 20,
    });
    const stellarWatcher = new StellarWatcher({
      chainKey: stellarCfg.chain,
      router: stellarCfg.routerContractId,
      startLedger: stellarCfg.startLedger,
      pageSize: 200,
      rpc: fakeRpc,
      db,
      logger,
    });
    const polledStellar = new PolledWorker(stellarWatcher, 5_000, logger, {
      db,
      replicaId: "indexer-worker-a",
      now,
    });

    await pg.exec(`
      INSERT INTO outbound_transfer (
        origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
        destination_chain, destination, origin_block, origin_tx
      ) VALUES (
        'stellar-testnet', 0, 1, 'GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA',
        'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
        10000000, 30000, 9970000,
        'sepolia', '0x0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38',
        5433810, 'b95ca748421ea4774dea6a08edebc3ad3a301244034cd10f1209f3cea234862d'
      );
    `);

    const mockIris: RailClient = {
      rail: "cctp",
      look: (_transfer: PendingTransfer): Promise<RailLookup> =>
        Promise.resolve({ kind: "missing" }),
    };
    const railPass = new RailPass({
      route: 0,
      client: mockIris,
      db,
      logger,
      batchSize: 20,
      recheckAfterMs: 10_000,
      maxCheckFailures: 10,
      now,
    });
    const polledRail = new PolledWorker(railPass, 15_000, logger, {
      db,
      replicaId: "indexer-worker-a",
      now,
    });

    polledStellar.start();
    polledRail.start();
    while (stellarWatcher.progress === null || railPass.progress === null) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await polledStellar.stop();
    await polledRail.stop();
    await polledStellar.flushHeartbeat();
    await polledRail.flushHeartbeat();

    const app = buildServer({
      config: apiConfig,
      logger,
      db: db as unknown as Database,
      readiness: [],
      replicaId: "serverless-api-1",
      now,
    });

    const freshReady = await app.inject({ method: "GET", url: "/ready" });
    expect(freshReady.statusCode).toBe(200);
    expect(freshReady.json().status).toBe("ready");
    const freshCheck = freshReady
      .json()
      .checks.find((c: { name: string }) => c.name === "indexer-heartbeat");
    expect(freshCheck.state).toBe("ready");
    expect(freshCheck.detail).toContain("stellar-testnet");

    const freshMetrics = await app.inject({ method: "GET", url: "/v1/metrics" });
    expect(freshMetrics.statusCode).toBe(200);
    const metricsJson = freshMetrics.json();
    expect(metricsJson.indexerHeartbeat.status).toBe("ready");
    expect(metricsJson.indexerHeartbeat.totalWorkloadPending).toBe(1);

    const stellarHb = metricsJson.heartbeats.find(
      (h: { worker: string }) => h.worker === "stellar-testnet",
    );
    expect(stellarHb).toBeDefined();
    expect(stellarHb.completedPosition).toBe(String(stellarCfg.startLedger + 20));
    expect(stellarHb.lagUnits).toBe(0);
    expect(stellarHb.fresh).toBe(true);

    // Advance clock past both workers' staleness budgets without new heartbeats.
    clockMs += 120_000;

    const staleReady = await app.inject({ method: "GET", url: "/ready" });
    expect(staleReady.statusCode).toBe(200);
    expect(staleReady.json().status).toBe("degraded");
    const staleCheck = staleReady
      .json()
      .checks.find((c: { name: string }) => c.name === "indexer-heartbeat");
    expect(staleCheck.state).toBe("degraded");
    expect(staleCheck.detail).toContain("stale heartbeat");

    await app.close();
  });

  it("surfaces evidence gaps and prefers an active replica over a retired stale replica", async () => {
    const { logger } = capturingLogger();
    const stellarCfg = apiConfig.indexer.stellar;
    if (stellarCfg === null) return;

    // Seed an older cursor so oldestLedger > base + 1 triggers a retention gap in StellarWatcher.
    await pg.exec(`
      INSERT INTO indexer_cursor (chain_key, family, contract, last_processed, last_processed_at)
      VALUES ('stellar-testnet', 'stellar', '${stellarCfg.routerContractId}', 5400000, '2026-10-28T00:00:00Z');
    `);

    const gappedRpc = new FakeRpc({
      latestLedger: 5_400_010,
      oldestLedger: 5_400_005,
    });
    const gappedWatcher = new StellarWatcher({
      chainKey: "stellar-testnet",
      router: stellarCfg.routerContractId,
      startLedger: stellarCfg.startLedger,
      pageSize: 200,
      rpc: gappedRpc,
      db,
      logger,
    });
    await gappedWatcher.tick(AbortSignal.timeout(5_000));
    const snapshot = gappedWatcher.heartbeatSnapshot();
    expect(snapshot.evidenceGap).toBe(true);

    await recordWorkerHeartbeat(
      db,
      {
        workerName: "stellar-testnet",
        replicaId: "retired-replica",
        workerKind: "chain",
        state: "ready",
        detail: "old pass",
        heartbeatAt: new Date(clockMs - 300_000),
        expectedIntervalMs: 5_000,
      },
      { now },
    );

    await recordWorkerHeartbeat(
      db,
      {
        workerName: "stellar-testnet",
        replicaId: "active-replica",
        workerKind: "chain",
        state: "ready",
        detail: "current at ledger 5400010",
        heartbeatAt: new Date(clockMs),
        completedPosition: snapshot.completedPosition ?? null,
        lagUnits: snapshot.lagUnits ?? null,
        expectedIntervalMs: 5_000,
        evidenceGap: true,
      },
      { now },
    );

    const app = buildServer({
      config: apiConfig,
      logger,
      db: db as unknown as Database,
      readiness: [],
      now,
    });

    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().status).toBe("degraded");
    const hbCheck = ready
      .json()
      .checks.find((c: { name: string }) => c.name === "indexer-heartbeat");
    expect(hbCheck.detail).toContain("evidence gap reported on stellar-testnet");
    expect(hbCheck.detail).not.toContain("stale heartbeat");

    await app.close();
  });

  it("bounds replica identities, timestamps, and diagnostic strings while scrubbing credentials", async () => {
    const { logger } = capturingLogger();
    const syntheticStellarSecret = `S${"B".repeat(55)}`;
    const credentialUrl = ["postgres://dbadmin", "supersecret99@db.internal:5432/hyperion"].join(
      ":",
    );
    const rpcLeak = [
      "https://rpcuser:topsecret@soroban.internal/rpc?api_key=",
      "key_live_98765",
    ].join("");
    const oversizedReplica = `worker-${"x".repeat(120)}`;

    expect(sanitizeReplicaId(credentialUrl, "safe-fallback")).toBe("safe-fallback");
    expect(sanitizeReplicaId(syntheticStellarSecret, "safe-fallback")).toBe("safe-fallback");
    expect(sanitizeReplicaId(oversizedReplica).length).toBeLessThanOrEqual(MAX_REPLICA_ID_LENGTH);

    const scrubbedDetail = sanitizeDiagnosticText(
      `rpc failed at ${rpcLeak} with secret=${syntheticStellarSecret} ${"z".repeat(400)}`,
    );
    expect(scrubbedDetail).not.toContain("topsecret");
    expect(scrubbedDetail).not.toContain("key_live_98765");
    expect(scrubbedDetail).not.toContain(syntheticStellarSecret);
    expect(scrubbedDetail.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_LENGTH);

    await recordWorkerHeartbeat(
      db,
      {
        workerName: "stellar-testnet",
        replicaId: credentialUrl,
        workerKind: "chain",
        state: "degraded",
        detail: `failed against ${rpcLeak} key=${syntheticStellarSecret}`,
        heartbeatAt: new Date(clockMs + 86_400_000),
        lastProgressAt: new Date("1970-01-01T00:00:00.000Z"),
        expectedIntervalMs: 5_000,
      },
      { now },
    );

    // Also insert an unbonded future timestamp directly in SQL to verify read-path clock skew defense.
    await pg.query(
      `UPDATE worker_heartbeat SET heartbeat_at = $1 WHERE worker_name = 'stellar-testnet'`,
      [new Date(clockMs + 3_600_000)],
    );

    const app = buildServer({
      config: apiConfig,
      logger,
      db: db as unknown as Database,
      readiness: [],
      replicaId: credentialUrl,
      now,
    });

    const healthRes = await app.inject({ method: "GET", url: "/health" });
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.json().replicaId).not.toContain("supersecret99");
    expect(healthRes.json().replicaId.length).toBeLessThanOrEqual(MAX_REPLICA_ID_LENGTH);

    const metricsRes = await app.inject({ method: "GET", url: "/v1/metrics" });
    expect(metricsRes.statusCode).toBe(200);
    const bodyText = metricsRes.payload;
    expect(bodyText).not.toContain("supersecret99");
    expect(bodyText).not.toContain("topsecret");
    expect(bodyText).not.toContain("key_live_98765");
    expect(bodyText).not.toContain(syntheticStellarSecret);

    const hb = metricsRes.json().heartbeats[0];
    expect(hb.replicaId).toBe("replica-default");
    expect(hb.timestampOutOfBounds).toBe(true);
    expect(hb.stale).toBe(true);
    expect(hb.heartbeatAt).toBe(new Date(clockMs).toISOString());
    expect(hb.lastProgressAt).toBeNull();

    await app.close();
  });
});
