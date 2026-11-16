import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildIndexer } from "../../src/chains/runner.js";
import { loadConfig } from "../../src/config/config.js";
import { ConfigError } from "../../src/config/env.js";
import type { Database, QueryResultRows } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import { fixedReadiness } from "../../src/runtime/readiness.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const ACTIVE_TESTNET_DEPLOYMENT = fileURLToPath(
  new URL("../../deployments/testnet.json", import.meta.url),
);

function migrationPath(name: string): string {
  return fileURLToPath(new URL(`../../migrations/${name}`, import.meta.url));
}

describe("readiness dependency policy configuration", () => {
  const pg = new PGlite();

  const queryPg = async (sql: string, params?: readonly unknown[]): Promise<QueryResultRows> => {
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
    query: queryPg,
    ping: async () => {
      await pg.query("SELECT 1");
    },
    transaction: async <T>(work: (tx: { query: typeof queryPg }) => Promise<T>) =>
      work({ query: queryPg }),
  } as unknown as Database;

  beforeAll(async () => {
    for (const name of [
      "1790900000000_initial-schema.sql",
      "1791000000000_cursor-block-hash.sql",
      "1791100000000_cursor-autovacuum-tuning.sql",
    ]) {
      const sql = readFileSync(migrationPath(name), "utf8").split("-- Down Migration")[0]!;
      await pg.exec(sql);
    }
  }, 30_000);

  afterAll(async () => {
    await pg.close();
  });

  it("never certifies absent workers in api-only mode and rejects contradictory mode flags", async () => {
    expect(() =>
      loadConfig({
        env: completeEnv({
          DEPLOYMENT_MODE: "api-only",
          INDEXER_ENABLED: "true",
        }),
      }),
    ).toThrow(ConfigError);

    expect(() =>
      loadConfig({
        env: completeEnv({
          DEPLOYMENT_MODE: "worker",
          INDEXER_ENABLED: "false",
          RAILS_ENABLED: "false",
          KEEPER_ENABLED: "false",
        }),
      }),
    ).toThrow(ConfigError);

    const apiConfig = loadConfig({
      env: completeEnv({
        DEPLOYMENT_MODE: "api-only",
        HYPERION_DEPLOYMENTS_FILE: ACTIVE_TESTNET_DEPLOYMENT,
      }),
    });
    expect(apiConfig.readinessPolicy.mode).toBe("api-only");
    expect(apiConfig.indexer.enabled).toBe(false);
    expect(apiConfig.rails.enabled).toBe(false);
    expect(apiConfig.keeper.enabled).toBe(false);

    const { logger } = capturingLogger();
    const indexerHandle = buildIndexer({ config: apiConfig, logger, db: pgliteDb });
    const app = buildServer({
      config: apiConfig,
      logger,
      db: pgliteDb,
      readiness: indexerHandle.readiness,
    });

    try {
      const res = await app.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("ready");
      expect(body.mode).toBe("api-only");
      expect(body.certifiedWorkers).toEqual([]);

      for (const absentName of ["indexer", "rails", "keeper", "redis"]) {
        const entry = body.checks.find((item: { name: string }) => item.name === absentName);
        expect(entry).toMatchObject({
          name: absentName,
          observedState: "absent",
          certified: false,
          policy: "disabled",
        });
      }
    } finally {
      await app.close();
    }

    // Even if a caller accidentally registers an in-process worker source in api-only mode,
    // /ready refuses to certify it and reports degraded.
    const miswiredApp = buildServer({
      config: apiConfig,
      logger,
      db: pgliteDb,
      readiness: [fixedReadiness("stellar", "ready", "caught up")],
    });
    try {
      const res = await miswiredApp.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("degraded");
      expect(res.json().certifiedWorkers).toEqual([]);
      const stellarCheck = res
        .json()
        .checks.find((item: { name: string }) => item.name === "stellar");
      expect(stellarCheck.certified).toBe(false);
    } finally {
      await miswiredApp.close();
    }
  });

  it("evaluates required stale persisted cursors consistently across api-only and worker modes", async () => {
    await pg.exec("DELETE FROM indexer_cursor");
    await pg.exec(`
      INSERT INTO indexer_cursor (chain_key, family, contract, last_processed, updated_at)
      VALUES (
        'stellar-testnet',
        'stellar',
        'CCXPCT3YFLVANSF3AQMYCCZVGCMLTURAYQ6O6DYGQJMTKVYQL6NTOC2V',
        5433810,
        now() - INTERVAL '10 minutes'
      )
    `);

    const { logger } = capturingLogger();
    const apiStaleConfig = loadConfig({
      env: completeEnv({
        DEPLOYMENT_MODE: "api-only",
        HYPERION_DEPLOYMENTS_FILE: ACTIVE_TESTNET_DEPLOYMENT,
        READINESS_INDEXER_POLICY: "required",
        READINESS_MAX_CURSOR_STALE_MS: "60000",
      }),
    });
    const workerStaleConfig = loadConfig({
      env: completeEnv({
        DEPLOYMENT_MODE: "worker",
        HYPERION_DEPLOYMENTS_FILE: ACTIVE_TESTNET_DEPLOYMENT,
        KEEPER_ENABLED: "false",
        READINESS_INDEXER_POLICY: "required",
        READINESS_MAX_CURSOR_STALE_MS: "60000",
      }),
    });

    const apiApp = buildServer({
      config: apiStaleConfig,
      logger,
      db: pgliteDb,
      readiness: [],
    });
    const workerApp = buildServer({
      config: workerStaleConfig,
      logger,
      db: pgliteDb,
      readiness: [fixedReadiness("stellar", "ready", "in-memory pass cached")],
    });

    try {
      const apiStaleRes = await apiApp.inject({ method: "GET", url: "/ready" });
      const workerStaleRes = await workerApp.inject({ method: "GET", url: "/ready" });

      expect(apiStaleRes.statusCode).toBe(503);
      expect(apiStaleRes.json().status).toBe("down");
      expect(workerStaleRes.statusCode).toBe(503);
      expect(workerStaleRes.json().status).toBe("down");

      const cursorCheck = apiStaleRes
        .json()
        .checks.find((item: { name: string }) => item.name === "indexer-cursor");
      expect(cursorCheck).toMatchObject({
        name: "indexer-cursor",
        policy: "required",
        stale: true,
        state: "down",
        certified: false,
      });

      // Refreshing the persisted cursor clears the 503 on both, while api-only still certifies no workers.
      await pg.exec("UPDATE indexer_cursor SET updated_at = now()");

      const apiFreshRes = await apiApp.inject({ method: "GET", url: "/ready" });
      const workerFreshRes = await workerApp.inject({ method: "GET", url: "/ready" });

      expect(apiFreshRes.statusCode).toBe(200);
      expect(apiFreshRes.json().status).toBe("ready");
      expect(apiFreshRes.json().certifiedWorkers).toEqual([]);

      expect(workerFreshRes.statusCode).toBe(200);
      expect(workerFreshRes.json().status).toBe("ready");
      expect(workerFreshRes.json().certifiedWorkers).toContain("stellar");
    } finally {
      await apiApp.close();
      await workerApp.close();
    }
  });

  it("keeps optional dependency outages visible as degraded (200) with policy metadata", async () => {
    const config = loadConfig({
      env: completeEnv({
        DEPLOYMENT_MODE: "combined",
        HYPERION_DEPLOYMENTS_FILE: ACTIVE_TESTNET_DEPLOYMENT,
        READINESS_REDIS_POLICY: "optional",
        READINESS_RAILS_POLICY: "optional",
      }),
    });

    const { logger } = capturingLogger();
    const unreachableRedis = {
      ping: () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:6379")),
    };

    const app = buildServer({
      config,
      logger,
      db: pgliteDb,
      redis: unreachableRedis,
      readiness: [
        fixedReadiness("stellar", "ready", "watching head"),
        fixedReadiness("cctp", "down", "iris upstream 503"),
      ],
    });

    try {
      const res = await app.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("degraded");
      expect(body.policy).toMatchObject({
        database: "required",
        redis: "optional",
        indexer: "required",
        rails: "optional",
        keeper: "required",
      });

      const redisCheck = body.checks.find((item: { name: string }) => item.name === "redis");
      expect(redisCheck).toMatchObject({
        name: "redis",
        category: "redis",
        policy: "optional",
        observedState: "down",
        state: "degraded",
        certified: false,
      });

      const cctpCheck = body.checks.find((item: { name: string }) => item.name === "cctp");
      expect(cctpCheck).toMatchObject({
        name: "cctp",
        category: "rails",
        policy: "optional",
        observedState: "down",
        state: "degraded",
        certified: false,
      });
    } finally {
      await app.close();
    }
  });
});
