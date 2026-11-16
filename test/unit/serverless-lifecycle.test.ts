import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolConfig } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import handler, { getServerlessHost, resetServerlessHost } from "../../api/index.js";
import { Database } from "../../src/db/pool.js";
import {
  buildServerlessEnv,
  countProcessLifecycleListeners,
  createServerlessRuntimeHost,
  runServerlessLifecycleHarness,
} from "../../src/runtime/serverless.js";
import { completeEnv } from "../helpers.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

class PGliteBackedPool extends EventEmitter {
  totalCount = 1;
  idleCount = 1;
  waitingCount = 0;
  ended = false;

  constructor(
    readonly config: PoolConfig,
    private readonly pg: PGlite,
    private readonly shouldFail: () => boolean,
  ) {
    super();
  }

  async query(
    text: string,
    params: unknown[] = [],
  ): Promise<{ rows: unknown[]; rowCount: number }> {
    if (this.ended) {
      throw new Error("Pool has already ended.");
    }
    if (this.shouldFail()) {
      throw new Error("simulated serverless database connection drop");
    }
    const res = await this.pg.query<Record<string, unknown>>(text, params);
    return {
      rows: res.rows,
      rowCount: res.affectedRows ?? res.rows.length,
    };
  }

  connect(): Promise<{
    query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
    release: () => void;
  }> {
    if (this.ended || this.shouldFail()) {
      return Promise.reject(new Error("simulated client checkout failure"));
    }
    return Promise.resolve({
      query: (text: string, params: unknown[] = []) => this.query(text, params),
      release: () => undefined,
    });
  }

  end(): Promise<void> {
    this.ended = true;
    this.totalCount = 0;
    this.idleCount = 0;
    return Promise.resolve();
  }
}

describe("Serverless cold-start and pooled database lifecycle harness", () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = new PGlite();
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const fullSql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      const upSql = fullSql.split("-- Down Migration")[0] ?? fullSql;
      await pg.exec(upSql);
    }
  });

  afterEach(async () => {
    await resetServerlessHost();
  });

  afterAll(async () => {
    await pg.close();
  });

  it("passes the full cold-burst, warm-reuse, freeze-thaw outage and recovery harness without leaking pools or listeners", async () => {
    const capturedConfigs: PoolConfig[] = [];
    const createdPools: PGliteBackedPool[] = [];

    const report = await runServerlessLifecycleHarness({
      env: completeEnv({
        SERVERLESS_DB_MAX_CONNECTIONS: "2",
        SERVERLESS_DB_IDLE_TIMEOUT_MS: "10000",
        SERVERLESS_DB_CONNECTION_TIMEOUT_MS: "2000",
        SERVERLESS_DB_WARM_HEALTH_INTERVAL_MS: "5000",
      }),
      cwd: REPO_ROOT,
      concurrentColdBurst: 10,
      warmInvocations: 16,
      freezeGapMs: 25_000,
      openDatabase: (connectionString, options, controls) =>
        Database.open(connectionString, {
          ...options,
          poolFactory: (poolConfig) => {
            capturedConfigs.push(poolConfig);
            const pool = new PGliteBackedPool(poolConfig, pg, controls.shouldFailPing);
            createdPools.push(pool);
            return pool as unknown as Pool;
          },
        }),
    });

    expect(report.passed).toBe(true);
    expect(report.coldStarts).toBe(2);
    expect(report.warmReuses).toBe(16);
    expect(report.evictedBrokenRuntimes).toBe(1);
    expect(report.maxConcurrentOpenPools).toBe(1);
    expect(report.poolsOpened).toBe(3); // 1 initial + 1 failed recovery attempt during outage + 1 healthy recovery
    expect(report.poolsClosed).toBe(3);
    expect(report.activePoolsAfterReset).toBe(0);
    expect(report.processListenerDelta).toBe(0);
    expect(report.maxPoolErrorListeners).toBe(1);
    expect(createdPools.every((pool) => pool.ended && pool.listenerCount("error") === 0)).toBe(
      true,
    );

    expect(capturedConfigs[0]).toMatchObject({
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 2_000,
      allowExitOnIdle: true,
      application_name: "hyperion-vercel-api",
    });
  });

  it("does not cache a failed cold-start connection and recovers cleanly once the database answers", async () => {
    let failDb = true;
    const createdPools: PGliteBackedPool[] = [];

    const host = createServerlessRuntimeHost({
      env: completeEnv(),
      cwd: REPO_ROOT,
      openDatabase: (connectionString, options) =>
        Database.open(connectionString, {
          ...options,
          poolFactory: (poolConfig) => {
            const pool = new PGliteBackedPool(poolConfig, pg, () => failDb);
            createdPools.push(pool);
            return pool as unknown as Pool;
          },
        }),
    });

    try {
      await expect(host.inject({ method: "GET", url: "/ready" })).rejects.toThrow(
        "simulated serverless database connection drop",
      );
      expect(host.inspect().hasActiveRuntime).toBe(false);
      expect(host.inspect().failedColdStarts).toBe(1);
      expect(host.inspect().poolsOpened).toBe(1);
      expect(host.inspect().poolsClosed).toBe(1);
      expect(createdPools[0]?.ended).toBe(true);

      // Next invocation after DB recovers initializes cleanly instead of returning a cached failure!
      failDb = false;
      const readyRes = await host.inject({ method: "GET", url: "/ready" });
      expect(readyRes.statusCode).toBe(200);
      expect(readyRes.json()).toMatchObject({
        status: "ready",
        indexer: "disabled",
      });

      // Idle pool error also triggers immediate verification & eviction on next request if broken.
      createdPools[1]?.emit("error", new Error("idle connection terminated by server"));
      failDb = true;
      await expect(host.inject({ method: "GET", url: "/v1/metrics" })).rejects.toThrow();
      expect(host.inspect().hasActiveRuntime).toBe(false);
      expect(createdPools[1]?.ended).toBe(true);
    } finally {
      await host.reset();
    }
  });

  it("enforces documented serverless entrypoint assumptions and handles HTTP preflight and redaction safely", async () => {
    const beforeSnapshot = { ...process.env };
    const beforeListeners = countProcessLifecycleListeners();

    // Even if ambient env mistakenly enables background workers or supplies a keeper secret,
    // serverless mode forces read-only API assumptions without mutating process.env.
    const derived = buildServerlessEnv(
      {
        DATABASE_URL: "postgres://user:super-secret-db-pass@127.0.0.1:5433/hyperion",
        INDEXER_ENABLED: "true",
        RAILS_ENABLED: "true",
        KEEPER_ENABLED: "true",
        KEEPER_STELLAR_SECRET: "secret-placeholder",
      },
      REPO_ROOT,
    );
    expect(derived.HYPERION_NETWORK).toBe("testnet");
    expect(derived.INDEXER_ENABLED).toBe("false");
    expect(derived.RAILS_ENABLED).toBe("false");
    expect(derived.KEEPER_ENABLED).toBe("false");
    expect(derived.KEEPER_STELLAR_SECRET).toBeUndefined();
    expect(process.env).toEqual(beforeSnapshot);

    // Test api/index.ts handler directly for OPTIONS preflight and safe 500 error redaction.
    await resetServerlessHost({
      env: {
        DATABASE_URL: "postgres://user:super-secret-db-pass@127.0.0.1:5433/hyperion",
      },
      cwd: REPO_ROOT,
      openDatabase: (connectionString, options) =>
        Database.open(connectionString, {
          ...options,
          poolFactory: (poolConfig) =>
            new PGliteBackedPool(poolConfig, pg, () => true) as unknown as Pool,
        }),
    });

    const makeMockHttpPair = (method: string, url: string) => {
      const headers = new Map<string, string>();
      let statusCode = 200;
      let body = "";
      const req = Object.assign(new Socket(), {
        method,
        url,
        headers: {},
      }) as unknown as IncomingMessage;
      const res = {
        setHeader(name: string, value: string) {
          headers.set(name.toLowerCase(), value);
        },
        writeHead(code: number, head?: Record<string, string>) {
          statusCode = code;
          if (head) {
            for (const [k, v] of Object.entries(head)) {
              headers.set(k.toLowerCase(), v);
            }
          }
          return this;
        },
        end(chunk?: string) {
          if (chunk) body += chunk;
        },
      } as unknown as ServerResponse;
      req.destroy();
      return {
        req,
        res,
        read: () => ({ statusCode, headers, body }),
      };
    };

    const preflight = makeMockHttpPair("OPTIONS", "/v1/transfers");
    await handler(preflight.req, preflight.res);
    expect(preflight.read().statusCode).toBe(204);
    expect(preflight.read().headers.get("access-control-allow-origin")).toBe("*");

    const failedGet = makeMockHttpPair("GET", "/v1/transfers");
    await handler(failedGet.req, failedGet.res);
    expect(failedGet.read().statusCode).toBe(500);
    expect(failedGet.read().body).not.toContain("super-secret-db-pass");
    expect(getServerlessHost().inspect().hasActiveRuntime).toBe(false);

    const afterListeners = countProcessLifecycleListeners();
    expect(afterListeners).toEqual(beforeListeners);
  });
});
