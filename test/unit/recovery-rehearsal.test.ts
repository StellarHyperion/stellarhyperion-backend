import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RawStellarEvent } from "../../src/chains/stellar/events.js";
import { destinationRpcUrl, loadConfig } from "../../src/config/config.js";
import { ConfigError } from "../../src/config/env.js";
import { runRecoveryRehearsal, wrapTransactionalEngine } from "../../src/rehearsal/recovery.js";
import { FIXTURES_DIR } from "../helpers.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");
const REHEARSAL_DEPLOYMENTS = join(FIXTURES_DIR, "rehearsal-deployments-testnet.json");
const REHEARSAL_EVENTS_FILE = join(FIXTURES_DIR, "rehearsal-stellar-events.json");
const LIVE_DEPLOYMENTS = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../deployments/testnet.json",
);

describe("local multi-service recovery rehearsal", () => {
  const pg = new PGlite();
  const rawLogs: string[] = [];
  const rehearsalLogger = pino(
    {
      level: "info",
      redact: {
        paths: ["databaseUrl", "redisUrl", "password", "*.databaseUrl", "*.redisUrl"],
        censor: "[redacted]",
      },
    },
    {
      write(chunk: string) {
        rawLogs.push(chunk);
      },
    },
  );

  const db = wrapTransactionalEngine({
    query: async (sql: string, params: readonly unknown[] = []) => {
      const result = await pg.query(sql, [...params]);
      const int8Columns = result.fields
        .filter((field) => field.dataTypeID === 20)
        .map((field) => field.name);
      const rows = result.rows.map((raw) => {
        const copy = { ...(raw as Record<string, unknown>) };
        for (const col of int8Columns) {
          const val = copy[col];
          if (typeof val === "number" || typeof val === "bigint") {
            copy[col] = String(val);
          }
        }
        return copy;
      });
      return { rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  });

  beforeAll(async () => {
    for (const migration of [
      "1790900000000_initial-schema.sql",
      "1791000000000_cursor-block-hash.sql",
      "1791100000000_cursor-autovacuum-tuning.sql",
    ]) {
      const fullSql = readFileSync(join(MIGRATIONS_DIR, migration), "utf8");
      const upSql = fullSql.split("-- Down Migration")[0] ?? fullSql;
      await pg.exec(upSql);
    }
  }, 30_000);

  afterAll(async () => {
    await pg.close();
  });

  it("uses dedicated fixtures with no EVM router and preserves records across faults and restarts", async () => {
    const liveJson = JSON.parse(readFileSync(LIVE_DEPLOYMENTS, "utf8")) as {
      networks: { "stellar-testnet": { router: string } };
    };
    const rehearsalJson = JSON.parse(readFileSync(REHEARSAL_DEPLOYMENTS, "utf8")) as {
      networks: Record<string, { router: string }>;
    };
    expect(Object.keys(rehearsalJson.networks)).toEqual(["stellar-testnet"]);
    expect(rehearsalJson.networks["stellar-testnet"]?.router).not.toBe(
      liveJson.networks["stellar-testnet"].router,
    );

    const events = JSON.parse(readFileSync(REHEARSAL_EVENTS_FILE, "utf8")) as RawStellarEvent[];
    const report = await runRecoveryRehearsal({
      db,
      deploymentsFile: REHEARSAL_DEPLOYMENTS,
      events,
      staleAfterMs: 4_000,
      logger: rehearsalLogger,
    });

    // Active deployment has no Hyperion EVM router.
    expect(report.watchingEvm).toEqual([]);

    // Separate API availability vs worker freshness across cold start, faults, stale window, and recovery.
    expect(report.initial).toMatchObject({
      apiReadyStatus: 200,
      apiReadyState: "ready",
      workerFreshnessState: "empty",
      outboundCount: 0,
      inboundCount: 0,
    });

    // Provider status ("complete" / "executed") without confirmed canonical receipt never establishes delivery.
    expect(report.afterProviderOnlyStatus).toMatchObject({
      apiReadyStatus: 200,
      apiReadyState: "ready",
      workerReadyState: "ready",
      workerFreshnessState: "fresh",
      outboundCount: 2,
      inboundCount: 0,
      cursorBlock: "6100112",
    });

    // During provider faults and worker outage, API stays ready while worker freshness becomes stale.
    expect(report.duringProviderFaultAndStaleWindow).toMatchObject({
      apiReadyStatus: 200,
      apiReadyState: "ready",
      workerReadyState: "degraded",
      workerFreshnessState: "stale",
      outboundCount: 2,
      inboundCount: 0,
    });

    // Restart resumes from persisted cursor and establishes delivery only with canonical receipt + payment.
    expect(report.resumedFromPersistedCursor).toBe(true);
    expect(report.afterFirstRestartAndCanonicalProof).toMatchObject({
      apiReadyStatus: 200,
      apiReadyState: "ready",
      workerFreshnessState: "fresh",
      outboundCount: 2,
      inboundCount: 1,
      cursorBlock: "6100112",
    });

    // Full replay across restart duplicates neither source nor destination records and preserves observed_at.
    expect(report.afterSecondRestartReplay).toMatchObject({
      apiReadyStatus: 200,
      apiReadyState: "ready",
      workerFreshnessState: "fresh",
      outboundCount: 2,
      inboundCount: 1,
      cursorBlock: "6100112",
    });
    expect(report.preservedOutboundObservedAt).toBe(true);
    expect(report.preservedInboundObservedAt).toBe(true);

    // Full-width stored identifier and exact integer-string base-unit amounts.
    const storedOutbound = await db.query(
      "SELECT destination, gross_amount::text AS gross_amount, net_amount::text AS net_amount FROM outbound_transfer WHERE nonce = 1",
    );
    expect(storedOutbound.rows[0]?.destination).toBe(
      "0x0000000000000000000000001111111111111111111111111111111111111111",
    );
    expect(storedOutbound.rows[0]?.gross_amount).toBe("10000000");
    expect(storedOutbound.rows[0]?.net_amount).toBe("9970000");
    expect(report.transferDestinationRecipient).toBe("0x1111111111111111111111111111111111111111");
    expect(report.transferOriginNetAmount).toBe("9970000");
    expect(report.transferDestinationAmount).toBe("996000");

    // Logs and report never expose database or Redis credentials.
    const combinedLogs = rawLogs.join("\n");
    expect(combinedLogs).not.toContain("rehearsal-local-only");
    expect(JSON.stringify(report)).not.toContain("rehearsal-local-only");
  }, 20_000);

  it("resolves destination RPC overrides without inferring an EVM router and redacts URL userinfo", () => {
    const config = loadConfig({
      env: {
        DATABASE_URL: "postgres://rehearsal:not-a-real-password@127.0.0.1:55433/hyperion",
        REDIS_URL: "redis://127.0.0.1:56380",
        HYPERION_NETWORK: "testnet",
        HYPERION_DEPLOYMENTS_FILE: REHEARSAL_DEPLOYMENTS,
        KEEPER_ENABLED: "false",
        EVM_RPC_URL_SEPOLIA: "http://127.0.0.1:18090/sepolia",
      },
    });
    expect(config.indexer.evm).toEqual([]);
    expect(destinationRpcUrl(config, "sepolia")).toBe("http://127.0.0.1:18090/sepolia");

    expect(() =>
      loadConfig({
        env: {
          DATABASE_URL: "postgres://rehearsal:not-a-real-password@127.0.0.1:55433/hyperion",
          REDIS_URL: "redis://127.0.0.1:56380",
          HYPERION_NETWORK: "testnet",
          HYPERION_DEPLOYMENTS_FILE: REHEARSAL_DEPLOYMENTS,
          KEEPER_ENABLED: "false",
          STELLAR_RPC_URL: "ws://rpcuser:not-a-real-password@127.0.0.1:18090/soroban",
        },
      }),
    ).toThrow(ConfigError);

    try {
      loadConfig({
        env: {
          DATABASE_URL: "postgres://rehearsal:not-a-real-password@127.0.0.1:55433/hyperion",
          REDIS_URL: "redis://127.0.0.1:56380",
          HYPERION_NETWORK: "testnet",
          HYPERION_DEPLOYMENTS_FILE: REHEARSAL_DEPLOYMENTS,
          KEEPER_ENABLED: "false",
          WORKER_FRESHNESS_STALE_MS: "500",
        },
      });
      throw new Error("Expected ConfigError for invalid WORKER_FRESHNESS_STALE_MS");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain("WORKER_FRESHNESS_STALE_MS");
      expect((error as ConfigError).message).not.toContain("not-a-real-password");
    }
  });
});
