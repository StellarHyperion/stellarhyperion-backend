import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import { ConfigError } from "../../src/config/env.js";
import type { Database } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import { createLogger } from "../../src/logging/logger.js";
import type { FreshnessSloReport } from "../../src/observability/slo.js";
import {
  evaluateFreshnessSlo,
  setWatcherRuntimeState,
  syncWatcherRuntimeState,
} from "../../src/observability/slo.js";
import type { ReadinessReport } from "../../src/runtime/readiness.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const ACTIVE_DEPLOYMENTS_FILE = fileURLToPath(
  new URL("../../deployments/testnet.json", import.meta.url),
);

const MIGRATIONS = [
  "1790900000000_initial-schema.sql",
  "1791000000000_cursor-block-hash.sql",
  "1791100000000_cursor-autovacuum-tuning.sql",
  "1791200000000_watcher-runtime-state.sql",
] as const;

function createPgAdapter(pg: PGlite): Database {
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
    ping: async () => {
      await pg.query("SELECT 1");
    },
    transaction: async <T>(fn: (tx: { query: typeof query }) => Promise<T>): Promise<T> => {
      await pg.exec("BEGIN");
      try {
        const out = await fn({ query });
        await pg.exec("COMMIT");
        return out;
      } catch (error) {
        await pg.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => Promise.resolve(),
  } as unknown as Database;
}

describe("configurable per-lane freshness and destination proof backlog SLO evaluation", () => {
  const pg = new PGlite();
  const db = createPgAdapter(pg);

  beforeAll(async () => {
    for (const name of MIGRATIONS) {
      const sql = readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8").split(
        "-- Down Migration",
      )[0]!;
      await pg.exec(sql);
    }
  }, 30_000);

  beforeEach(async () => {
    await pg.exec(`
      TRUNCATE TABLE
        watcher_runtime_state,
        inbound_delivery,
        rail_attestation,
        outbound_transfer,
        indexer_cursor
      RESTART IDENTITY CASCADE;
    `);
  });

  afterAll(async () => {
    await pg.close();
  });

  it("validates SLO configuration overrides and rejects malformed lane keys or unknown watchers", () => {
    expect(() =>
      loadConfig({
        env: completeEnv({
          HYPERION_DEPLOYMENTS_FILE: ACTIVE_DEPLOYMENTS_FILE,
          SLO_LANE_TARGETS_JSON: '{"bad-lane-key":{"maxProofBacklog":5}}',
        }),
      }),
    ).toThrow(ConfigError);

    expect(() =>
      loadConfig({
        env: completeEnv({
          HYPERION_DEPLOYMENTS_FILE: ACTIVE_DEPLOYMENTS_FILE,
          SLO_DISABLED_WATCHERS: "unknown-chain",
        }),
      }),
    ).toThrow(ConfigError);
  });

  it("identifies the exact breached lane and missing progress stage without accepting provider status as delivery", async () => {
    const now = new Date("2026-11-16T12:00:00.000Z");
    const workerConfig = loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: ACTIVE_DEPLOYMENTS_FILE,
        KEEPER_ENABLED: "false",
        SLO_SOURCE_SCAN_LAG_SECONDS: "300",
        SLO_ATTESTATION_POLL_LAG_SECONDS: "180",
        SLO_DESTINATION_PROOF_LAG_SECONDS: "900",
        SLO_MAX_PROOF_BACKLOG: "5",
        SLO_LANE_TARGETS_JSON: JSON.stringify({
          "stellar-testnet->sepolia:cctp": {
            maxAttestationPollLagSeconds: 120,
            maxDestinationProofLagSeconds: 600,
            maxProofBacklog: 1,
          },
        }),
      }),
    });

    // Active deployment has no EVM Hyperion router; lanes are strictly Stellar -> active EVM routes.
    await syncWatcherRuntimeState(db, workerConfig, new Date("2026-11-16T11:50:00.000Z"));

    // 1. Stalled cursor (> 300s) breaches source_scan across Stellar outbound lanes.
    await db.query(
      `INSERT INTO indexer_cursor (chain_key, family, contract, last_processed, updated_at)
       VALUES ('stellar-testnet', 'stellar', $1, 5433900, $2)`,
      [
        workerConfig.deployments.networks["stellar-testnet"]!.router,
        new Date("2026-11-16T11:52:00.000Z"),
      ],
    );

    const sourceBreachReport = await evaluateFreshnessSlo(db, workerConfig, { now });
    expect(sourceBreachReport.status).toBe("breached");
    expect(sourceBreachReport.lanes.map((lane) => lane.laneKey)).toEqual([
      "stellar-testnet->arc-testnet:cctp",
      "stellar-testnet->base-sepolia:cctp",
      "stellar-testnet->sepolia:axelar-its",
      "stellar-testnet->sepolia:cctp",
    ]);
    expect(sourceBreachReport.breaches).toHaveLength(4);
    expect(sourceBreachReport.breaches.every((b) => b.missingStage === "source_scan")).toBe(true);

    // 2. Refresh cursor to 10s lag; insert an unchecked transfer on stellar-testnet->sepolia:cctp
    // observed 150s ago (> per-lane 120s attestation target, <= 600s proof lag target).
    await db.query(
      `UPDATE indexer_cursor SET updated_at = $1 WHERE chain_key = 'stellar-testnet'`,
      [new Date("2026-11-16T11:59:50.000Z")],
    );
    const tx1 = await db.query(
      `INSERT INTO outbound_transfer
         (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
          destination_chain, destination, origin_block, origin_tx, observed_at)
       VALUES ('stellar-testnet', 0, 101, 'Gsender', 'USDC', 10000000, 30000, 9970000,
               'sepolia', '0x0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38',
               5433901, 'tx-cctp-101', $1)
       RETURNING id`,
      [new Date("2026-11-16T11:57:30.000Z")],
    );
    const tx1Id = String(tx1.rows[0]!.id);

    const attestationBreachReport = await evaluateFreshnessSlo(db, workerConfig, { now });
    expect(attestationBreachReport.status).toBe("breached");
    expect(attestationBreachReport.breaches).toHaveLength(1);
    expect(attestationBreachReport.breaches[0]?.laneKey).toBe("stellar-testnet->sepolia:cctp");
    expect(attestationBreachReport.breaches[0]?.missingStage).toBe("attestation_poll");

    // 3. Record a fresh rail attestation (`attested` / `complete`) checked 5s ago WITHOUT a canonical
    // inbound_delivery row, and age the transfer to 700s (> 600s per-lane destination_proof target)
    // plus add a second undelivered transfer (backlog = 2 > maxProofBacklog = 1).
    await db.query(`UPDATE outbound_transfer SET observed_at = $1 WHERE id = $2`, [
      new Date("2026-11-16T11:48:20.000Z"),
      tx1Id,
    ]);
    await db.query(
      `INSERT INTO rail_attestation (transfer_id, route, status, rail_status, last_checked_at)
       VALUES ($1, 0, 'attested', 'complete', $2)`,
      [tx1Id, new Date("2026-11-16T11:59:55.000Z")],
    );
    const tx2 = await db.query(
      `INSERT INTO outbound_transfer
         (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
          destination_chain, destination, origin_block, origin_tx, observed_at)
       VALUES ('stellar-testnet', 0, 102, 'Gsender', 'USDC', 20000000, 60000, 19940000,
               'sepolia', '0x0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38',
               5433902, 'tx-cctp-102', $1)
       RETURNING id`,
      [new Date("2026-11-16T11:59:40.000Z")],
    );
    const tx2Id = String(tx2.rows[0]!.id);
    await db.query(
      `INSERT INTO rail_attestation (transfer_id, route, status, rail_status, last_checked_at)
       VALUES ($1, 0, 'delivered', 'executed', $2)`,
      [tx2Id, new Date("2026-11-16T11:59:55.000Z")],
    );

    const proofBreachReport = await evaluateFreshnessSlo(db, workerConfig, { now });
    expect(proofBreachReport.status).toBe("breached");
    expect(proofBreachReport.breaches).toHaveLength(1);
    expect(proofBreachReport.breaches[0]?.laneKey).toBe("stellar-testnet->sepolia:cctp");
    expect(proofBreachReport.breaches[0]?.missingStage).toBe("destination_proof");
    const sepoliaLane = proofBreachReport.lanes.find(
      (lane) => lane.laneKey === "stellar-testnet->sepolia:cctp",
    );
    expect(sepoliaLane?.proofBacklogCount).toBe(2);
    expect(sepoliaLane?.oldestUndeliveredAgeSeconds).toBe(700);

    // 4. Canonical inbound_delivery rows settle the destination proof backlog.
    await db.query(
      `INSERT INTO inbound_delivery
         (destination_chain, route, source_chain, source_nonce, recipient, token, amount,
          delivered, destination_block, destination_tx, observed_at)
       VALUES
         ('sepolia', 0, 'stellar-testnet', 101, '0x6ef8032ffe4943f27388172549f6700f18bb8b38',
          '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', 997000, true, 7000100, '0xdest101', $1),
         ('sepolia', 0, 'stellar-testnet', 102, '0x6ef8032ffe4943f27388172549f6700f18bb8b38',
          '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', 1994000, true, 7000101, '0xdest102', $1)`,
      [now],
    );

    const healthyReport = await evaluateFreshnessSlo(db, workerConfig, { now });
    expect(healthyReport.status).toBe("healthy");
    expect(healthyReport.breaches).toEqual([]);
  });

  it("distinguishes intentionally disabled watchers and rail pollers from stalled enabled ones", async () => {
    const now = new Date("2026-11-16T12:00:00.000Z");

    // Worker started with RAILS_ENABLED=false persists disabled rail pollers while keeping chain watcher enabled.
    const workerNoRails = loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: ACTIVE_DEPLOYMENTS_FILE,
        KEEPER_ENABLED: "false",
        RAILS_ENABLED: "false",
        SLO_SOURCE_SCAN_LAG_SECONDS: "300",
        SLO_ATTESTATION_POLL_LAG_SECONDS: "60",
        SLO_DESTINATION_PROOF_LAG_SECONDS: "120",
      }),
    });
    await syncWatcherRuntimeState(db, workerNoRails, now);

    // Fresh cursor (10s lag), plus an old undelivered transfer (1800s old).
    await db.query(
      `INSERT INTO indexer_cursor (chain_key, family, contract, last_processed, updated_at)
       VALUES ('stellar-testnet', 'stellar', $1, 5434000, $2)`,
      [
        workerNoRails.deployments.networks["stellar-testnet"]!.router,
        new Date("2026-11-16T11:59:50.000Z"),
      ],
    );
    await db.query(
      `INSERT INTO outbound_transfer
         (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
          destination_chain, destination, origin_block, origin_tx, observed_at)
       VALUES ('stellar-testnet', 1, 201, 'Gsender', 'USDC', 10000000, 30000, 9970000,
               'sepolia', '0x0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38',
               5434000, 'tx-its-201', $1)`,
      [new Date("2026-11-16T11:30:00.000Z")],
    );

    const railsDisabledReport = await evaluateFreshnessSlo(db, workerNoRails, { now });
    expect(railsDisabledReport.status).toBe("disabled");
    expect(railsDisabledReport.breaches).toEqual([]);
    const itsLane = railsDisabledReport.lanes.find(
      (lane) => lane.laneKey === "stellar-testnet->sepolia:axelar-its",
    );
    expect(itsLane?.status).toBe("disabled");
    expect(itsLane?.disabledBy).toContain("rail:axelar-its");

    // If the enabled chain watcher stalls (> 300s), source_scan still breaches even while rails are disabled!
    await db.query(
      `UPDATE indexer_cursor SET updated_at = $1 WHERE chain_key = 'stellar-testnet'`,
      [new Date("2026-11-16T11:40:00.000Z")],
    );
    const stalledSourceReport = await evaluateFreshnessSlo(db, workerNoRails, { now });
    expect(stalledSourceReport.status).toBe("breached");
    expect(stalledSourceReport.breaches.every((b) => b.missingStage === "source_scan")).toBe(true);

    // Intentionally disabling the source watcher too marks every lane disabled rather than breached.
    await setWatcherRuntimeState(db, {
      componentKey: "stellar-testnet",
      componentKind: "chain_watcher",
      enabled: false,
      at: now,
    });
    const fullyDisabledReport = await evaluateFreshnessSlo(db, workerNoRails, { now });
    expect(fullyDisabledReport.status).toBe("disabled");
    expect(fullyDisabledReport.breaches).toEqual([]);
  });

  it("evaluates persisted evidence from an API-only replica on /ready and /v1/metrics without leaking credentials", async () => {
    const workerStart = new Date(Date.now() - 30_000);
    const workerConfig = loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: ACTIVE_DEPLOYMENTS_FILE,
        KEEPER_ENABLED: "false",
      }),
    });
    await syncWatcherRuntimeState(db, workerConfig, workerStart);

    // Insert stale Stellar cursor (20 minutes behind) so API-only replica observes a persisted breach.
    await db.query(
      `INSERT INTO indexer_cursor (chain_key, family, contract, last_processed, updated_at)
       VALUES ('stellar-testnet', 'stellar', $1, 5434100, $2)`,
      [
        workerConfig.deployments.networks["stellar-testnet"]!.router,
        new Date(Date.now() - 20 * 60 * 1000),
      ],
    );

    const secretPassword = "super-secret-db-password-999";
    const apiOnlyConfig = loadConfig({
      env: completeEnv({
        DATABASE_URL: `postgres://hyperion:${secretPassword}@127.0.0.1:5433/hyperion`,
        REDIS_URL: `redis://:${secretPassword}@127.0.0.1:6380`,
        HYPERION_DEPLOYMENTS_FILE: ACTIVE_DEPLOYMENTS_FILE,
        INDEXER_ENABLED: "false",
        RAILS_ENABLED: "false",
        KEEPER_ENABLED: "false",
        SLO_SOURCE_SCAN_LAG_SECONDS: "300",
      }),
    });

    const { logger } = capturingLogger();
    const app = buildServer({
      config: apiOnlyConfig,
      logger,
      db,
      readiness: [],
    });
    await app.ready();

    try {
      const readyRes = await app.inject({ method: "GET", url: "/ready" });
      expect(readyRes.statusCode).toBe(200);
      const readyBody = readyRes.json<{
        status: string;
        indexer: string;
        checks: ReadinessReport[];
        freshnessSlo: FreshnessSloReport;
      }>();
      expect(readyBody.indexer).toBe("disabled");
      expect(readyBody.status).toBe("degraded");
      const sloCheck = readyBody.checks.find((c) => c.name === "freshness-slo");
      expect(sloCheck?.state).toBe("degraded");
      expect(sloCheck?.detail).toContain("stellar-testnet->sepolia:cctp (source_scan)");
      expect(readyBody.freshnessSlo.status).toBe("breached");
      expect(readyRes.body).not.toContain(secretPassword);

      const metricsRes = await app.inject({ method: "GET", url: "/v1/metrics" });
      expect(metricsRes.statusCode).toBe(200);
      const metricsBody = metricsRes.json<{ freshnessSlo: FreshnessSloReport }>();
      expect(metricsBody.freshnessSlo.status).toBe("breached");
      expect(metricsBody.freshnessSlo.breaches).toHaveLength(4);
      expect(metricsRes.body).not.toContain(secretPassword);
    } finally {
      await app.close();
    }

    // Verify structured logger redacts database, Redis, API key, and authorization credentials.
    const logChunks: string[] = [];
    const prodConfig = loadConfig({
      env: completeEnv({
        NODE_ENV: "production",
        DATABASE_URL: `postgres://hyperion:${secretPassword}@127.0.0.1:5433/hyperion`,
        HYPERION_DEPLOYMENTS_FILE: ACTIVE_DEPLOYMENTS_FILE,
        KEEPER_ENABLED: "false",
      }),
    });
    const stream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        logChunks.push(chunk.toString("utf8"));
        cb();
      },
    });
    const baseRedactedLogger = createLogger(prodConfig, stream);
    baseRedactedLogger.warn(
      {
        databaseUrl: prodConfig.databaseUrl,
        redisUrl: prodConfig.redisUrl,
        headers: { authorization: `Bearer ${secretPassword}` },
        apiKey: secretPassword,
      },
      "redaction check",
    );
    expect(logChunks.join("")).toContain("[redacted]");
    expect(logChunks.join("")).not.toContain(secretPassword);
  });
});
