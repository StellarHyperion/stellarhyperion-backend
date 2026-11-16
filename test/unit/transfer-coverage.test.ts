import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildIndexer } from "../../src/chains/runner.js";
import { loadConfig } from "../../src/config/config.js";
import type { Database } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import type { ReadinessSource } from "../../src/runtime/readiness.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const ACTIVE_DEPLOYMENTS_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../deployments/testnet.json",
);

const pg = new PGlite();

function createDbAdapter(): Database {
  return {
    query: async (sql: string, params: readonly unknown[] = []) => {
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
    },
    ping: async () => {
      await pg.query("SELECT 1");
    },
  } as unknown as Database;
}

describe("transfer, claim, and route history coverage and freshness metadata", () => {
  const db = createDbAdapter();
  const { logger } = capturingLogger();
  const fixedNow = new Date("2026-10-30T00:01:00.000Z");

  beforeAll(async () => {
    for (const name of [
      "1790900000000_initial-schema.sql",
      "1791000000000_cursor-block-hash.sql",
      "1791100000000_cursor-autovacuum-tuning.sql",
    ]) {
      const sql = readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8").split(
        "-- Down Migration",
      )[0]!;
      await pg.exec(sql);
    }
  }, 30_000);

  beforeEach(async () => {
    await pg.exec(`
      TRUNCATE outbound_transfer, rail_attestation, inbound_delivery, pending_claim, route_health, indexer_cursor RESTART IDENTITY CASCADE;
    `);
  });

  afterAll(async () => {
    await pg.close();
  });

  it("distinguishes empty complete history from unavailable EVM source deployments on active testnet", async () => {
    const config = loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: ACTIVE_DEPLOYMENTS_FILE,
        INDEXER_ENABLED: "false",
        KEEPER_ENABLED: "false",
      }),
    });
    const stellarDeployment = config.deployments.networks["stellar-testnet"];
    if (stellarDeployment?.family !== "stellar") {
      throw new Error("Expected active stellar-testnet deployment");
    }

    await pg.query(
      `INSERT INTO indexer_cursor (chain_key, family, contract, last_processed, last_processed_hash, last_processed_at, updated_at)
       VALUES ('stellar-testnet', 'stellar', $1, $2, 'ledger-hash-ok', '2026-10-30T00:00:40.000Z', '2026-10-30T00:00:45.000Z')`,
      [stellarDeployment.router, stellarDeployment.deployedAt.ledger + 250],
    );

    const app = buildServer({
      config,
      logger,
      db,
      readiness: [],
      now: () => fixedNow,
    });
    await app.ready();

    try {
      const stellarHistory = await app.inject("/v1/transfers?originChain=stellar-testnet");
      expect(stellarHistory.statusCode).toBe(200);
      const stellarBody = stellarHistory.json();
      expect(stellarBody.transfers).toEqual([]);
      expect(stellarBody.historyState).toBe("empty");
      expect(stellarBody.coverage.status).toBe("complete");
      expect(stellarBody.coverage.latestUpdateAt).toBe("2026-10-30T00:00:45.000Z");
      expect(stellarBody.coverage.chains[0].freshness.cursorAgeMs).toBe(15_000);
      expect(stellarBody.coverage.chains[0].freshness.liveWatcherActive).toBe(false);
      expect(stellarBody.coverage.chains[0].freshness.mode).toBe("stored_cursor");

      // Active deployments/testnet.json has no Hyperion EVM router.
      const evmHistory = await app.inject("/v1/transfers?originChain=sepolia");
      expect(evmHistory.statusCode).toBe(200);
      const evmBody = evmHistory.json();
      expect(evmBody.transfers).toEqual([]);
      expect(evmBody.historyState).toBe("unavailable");
      expect(evmBody.coverage.status).toBe("unavailable");
      expect(evmBody.coverage.scope).toEqual({
        mode: "requested_chain",
        requestedChain: "sepolia",
        chains: ["sepolia"],
      });
      expect(evmBody.coverage.chains[0]).toMatchObject({
        chain: "sepolia",
        deployed: false,
        status: "unavailable",
        scannedThrough: null,
      });
      expect(evmBody.coverage.knownGaps).toEqual([
        expect.objectContaining({
          chain: "sepolia",
          kind: "unindexed_deployment",
        }),
      ]);
    } finally {
      await app.close();
    }
  });

  it("reports unscanned_prefix and missing_cursor gaps and scopes metadata to the requested chain", async () => {
    const config = loadConfig({
      env: completeEnv({
        STELLAR_START_LEDGER: "1288000",
        KEEPER_ENABLED: "false",
      }),
    });
    const stellarDeployment = config.deployments.networks["stellar-testnet"];
    if (stellarDeployment?.family !== "stellar") {
      throw new Error("Expected fixture stellar-testnet deployment");
    }

    // Insert cursor for stellar-testnet at 1288100, leaving [1287400..1287999] as unscanned_prefix,
    // and leave sepolia with no cursor at all.
    await pg.query(
      `INSERT INTO indexer_cursor (chain_key, family, contract, last_processed, last_processed_hash, last_processed_at, updated_at)
       VALUES ('stellar-testnet', 'stellar', $1, 1288100, 'hash-1288100', '2026-10-30T00:00:50.000Z', '2026-10-30T00:00:55.000Z')`,
      [stellarDeployment.router],
    );

    const app = buildServer({
      config,
      logger,
      db,
      readiness: [],
      now: () => fixedNow,
    });
    await app.ready();

    try {
      const scopedStellar = await app.inject("/v1/transfers?originChain=stellar-testnet");
      expect(scopedStellar.statusCode).toBe(200);
      const stellarBody = scopedStellar.json();
      expect(stellarBody.historyState).toBe("incomplete");
      expect(stellarBody.coverage.scope.chains).toEqual(["stellar-testnet"]);
      expect(stellarBody.coverage.knownGaps).toEqual([
        {
          chain: "stellar-testnet",
          kind: "unscanned_prefix",
          fromBlock: "1287400",
          toBlock: "1287999",
          detail: "configured start position 1288000 skips blocks after deployment height 1287400",
        },
      ]);

      const scopedSepolia = await app.inject("/v1/transfers?originChain=sepolia");
      expect(scopedSepolia.statusCode).toBe(200);
      const sepoliaBody = scopedSepolia.json();
      expect(sepoliaBody.historyState).toBe("incomplete");
      expect(sepoliaBody.coverage.scope.chains).toEqual(["sepolia"]);
      expect(sepoliaBody.coverage.knownGaps).toEqual([
        expect.objectContaining({
          chain: "sepolia",
          kind: "missing_cursor",
          fromBlock: "9412880",
          toBlock: null,
        }),
      ]);

      const claimsScoped = await app.inject("/v1/claims?chain=sepolia");
      expect(claimsScoped.statusCode).toBe(200);
      expect(claimsScoped.json().historyState).toBe("incomplete");
      expect(claimsScoped.json().coverage.scope.chains).toEqual(["sepolia"]);

      const routesScoped = await app.inject("/v1/routes/health?originChain=sepolia");
      expect(routesScoped.statusCode).toBe(200);
      expect(routesScoped.json().historyState).toBe("incomplete");
      expect(routesScoped.json().coverage.scope.chains).toEqual(["sepolia"]);
    } finally {
      await app.close();
    }
  });

  it("never claims live watcher freshness in API-only processes and scrubs credentials from degraded watcher reports", async () => {
    const disabledConfig = loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: ACTIVE_DEPLOYMENTS_FILE,
        INDEXER_ENABLED: "false",
        KEEPER_ENABLED: "false",
      }),
    });
    const stellarDeployment = disabledConfig.deployments.networks["stellar-testnet"];
    if (stellarDeployment?.family !== "stellar") {
      throw new Error("Expected active stellar-testnet deployment");
    }

    const sender = stellarDeployment.admin;
    await pg.query(
      `INSERT INTO outbound_transfer (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount, destination_chain, destination, origin_block, origin_tx)
       VALUES ('stellar-testnet', 0, 1, $1, $2, 10000000, 30000, 9970000, 'sepolia', '0x0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38', $3, 'tx-1')`,
      [sender, stellarDeployment.tokens.USDC!.sacId, stellarDeployment.deployedAt.ledger + 5],
    );
    await pg.query(
      `INSERT INTO indexer_cursor (chain_key, family, contract, last_processed, last_processed_hash, last_processed_at, updated_at)
       VALUES ('stellar-testnet', 'stellar', $1, $2, 'hash-ok', '2026-10-30T00:00:55.000Z', '2026-10-30T00:00:58.000Z')`,
      [stellarDeployment.router, stellarDeployment.deployedAt.ledger + 10],
    );

    const disabledIndexer = buildIndexer({
      config: disabledConfig,
      logger,
      db,
    });
    const spoofedReadySource: ReadinessSource = {
      readiness: () => ({
        name: "stellar-testnet",
        state: "ready",
        detail: "current at ledger 5433818",
      }),
    };

    const apiOnlyApp = buildServer({
      config: disabledConfig,
      logger,
      db,
      readiness: [...disabledIndexer.readiness, spoofedReadySource],
      now: () => fixedNow,
    });
    await apiOnlyApp.ready();

    try {
      const res = await apiOnlyApp.inject("/v1/transfers?originChain=stellar-testnet");
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.historyState).toBe("complete");
      expect(body.coverage.freshness.liveWatcherActive).toBe(false);
      expect(body.coverage.freshness.mode).toBe("stored_cursor");
      expect(body.coverage.chains[0].freshness.liveWatcherActive).toBe(false);
      expect(body.coverage.chains[0].freshness.watcherState).toBeNull();
    } finally {
      await apiOnlyApp.close();
    }

    const enabledConfig = loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: ACTIVE_DEPLOYMENTS_FILE,
        INDEXER_ENABLED: "true",
        KEEPER_ENABLED: "false",
      }),
    });

    const liveReadyApp = buildServer({
      config: enabledConfig,
      logger,
      db,
      readiness: [spoofedReadySource],
      now: () => fixedNow,
    });
    await liveReadyApp.ready();

    try {
      const res = await liveReadyApp.inject("/v1/transfers?originChain=stellar-testnet");
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.historyState).toBe("complete");
      expect(body.coverage.freshness.liveWatcherActive).toBe(true);
      expect(body.coverage.freshness.mode).toBe("live_watcher");
      expect(body.coverage.chains[0].freshness.liveWatcherActive).toBe(true);
      expect(body.coverage.chains[0].freshness.watcherState).toBe("ready");
    } finally {
      await liveReadyApp.close();
    }

    const syntheticRpcCredentialUrl = [
      "https://rpc-op",
      "erator:super",
      "-secret@soroban.example.test/rpc?api_key=",
      "priv_987654",
    ].join("");
    const degradedWatcher: ReadinessSource = {
      readiness: () => ({
        name: "stellar-testnet",
        state: "degraded",
        detail: `3 polls in a row failed: upstream error from ${syntheticRpcCredentialUrl} with Authorization Bearer tok_abc123`,
      }),
    };

    const degradedApp = buildServer({
      config: enabledConfig,
      logger,
      db,
      readiness: [degradedWatcher],
      now: () => fixedNow,
    });
    await degradedApp.ready();

    try {
      const res = await degradedApp.inject("/v1/transfers?originChain=stellar-testnet");
      expect(res.statusCode).toBe(200);
      const payload = res.body;
      expect(payload).not.toContain("super-secret");
      expect(payload).not.toContain("priv_987654");
      expect(payload).not.toContain("tok_abc123");

      const body = res.json();
      expect(body.historyState).toBe("incomplete");
      expect(body.coverage.freshness.liveWatcherActive).toBe(false);
      expect(body.coverage.knownGaps).toEqual([
        expect.objectContaining({
          chain: "stellar-testnet",
          kind: "watcher_degraded",
        }),
      ]);
    } finally {
      await degradedApp.close();
    }
  });
});
