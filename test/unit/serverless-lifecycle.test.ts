import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import handler, {
  checkAppHealth,
  closeApp,
  getApp,
  getDb,
  initializeApp,
} from "../../api/index.js";
import { Database } from "../../src/db/pool.js";
import { checkSchemaCompatibility } from "../../src/db/schema.js";
import { checkDatabasePolicy } from "../../src/db/policy.js";
import * as serverModule from "../../src/http/server.js";
import { createApiRedis } from "../../src/http/rate-limit-redis.js";
import { completeEnv } from "../helpers.js";

vi.mock("../../src/http/rate-limit-redis.js", () => ({
  createApiRedis: vi.fn(() => ({
    ping: vi.fn().mockResolvedValue("PONG"),
    disconnect: vi.fn(),
  })),
}));

vi.mock("../../src/db/schema.js", () => ({
  checkSchemaCompatibility: vi.fn().mockResolvedValue(undefined),
  EXPECTED_SCHEMA_VERSION: "test-schema-version",
}));

vi.mock("../../src/db/policy.js", () => ({
  checkDatabasePolicy: vi.fn().mockResolvedValue(undefined),
  API_READ_TABLES: [],
}));

class FakeDb {
  public ping = vi.fn().mockResolvedValue(undefined);
  public close = vi.fn().mockResolvedValue(undefined);
  public query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  constructor(public readonly options?: unknown) {}
}

let activeDb: FakeDb | null = null;
let lastOpenOptions: Record<string, unknown> | undefined = undefined;

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

let databaseOpen = vi.spyOn(Database, "open").mockImplementation((_url, options) => {
  lastOpenOptions = options as Record<string, unknown>;
  activeDb = new FakeDb(options);
  return activeDb as unknown as Database;
});

interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  setHeader(name: string, value: string): void;
  writeHead(code: number, headers?: Record<string, string>): void;
  body: string;
  end(content?: string): void;
}

function createMockReqRes(method = "GET", url = "/") {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as unknown as { method: string; url: string; headers: Record<string, string> }).method =
    method;
  (req as unknown as { method: string; url: string; headers: Record<string, string> }).url = url;
  (req as unknown as { method: string; url: string; headers: Record<string, string> }).headers = {};

  const res: MockRes = {
    statusCode: 200,
    headers: {},
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(code: number, headers?: Record<string, string>) {
      this.statusCode = code;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          this.headers[k.toLowerCase()] = v;
        }
      }
    },
    body: "",
    end(content?: string) {
      if (content) this.body = content;
    },
  };

  return { req, res: res as unknown as ServerResponse & MockRes };
}

describe("Serverless Cold-Start Database Lifecycle", () => {
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    await closeApp();
    const env = completeEnv({
      INDEXER_ENABLED: "false",
      RAILS_ENABLED: "false",
      KEEPER_ENABLED: "false",
      HYPERION_DATABASE_ROLE: "read-only",
      VERCEL_ENV: "production",
      HYPERION_NETWORK: "testnet",
    });
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
    activeDb = null;
    lastOpenOptions = undefined;
    vi.mocked(checkSchemaCompatibility).mockResolvedValue(undefined);
    vi.mocked(checkDatabasePolicy).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await closeApp();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    vi.clearAllMocks();
    vi.restoreAllMocks();
    // Reinstall the database boundary after restoring per-test server spies.
    databaseOpen = vi.spyOn(Database, "open").mockImplementation((_url, options) => {
      lastOpenOptions = options as Record<string, unknown>;
      activeDb = new FakeDb(options);
      return activeDb as unknown as Database;
    });
  });

  it("limits connection pool size to two on cold start", async () => {
    const app = await initializeApp();
    expect(app).toBeDefined();
    expect(lastOpenOptions).toBeDefined();
    expect(lastOpenOptions?.maxConnections).toBe(2);
    expect(lastOpenOptions?.readOnly).toBe(true);
    expect(lastOpenOptions?.applicationName).toBe("hyperion-vercel-api");
  });

  it("reuses initialized app on repeated invocations (warm start)", async () => {
    const firstApp = await getApp();
    expect(firstApp).toBeDefined();
    const db1 = activeDb;
    expect(db1).not.toBeNull();

    // Second call should reuse the same app and ping the database to verify health
    const secondApp = await getApp();
    expect(secondApp).toBe(firstApp);
    expect(db1?.ping).toHaveBeenCalledTimes(1);

    // Third call should again reuse the same app
    const thirdApp = await getApp();
    expect(thirdApp).toBe(firstApp);
    expect(db1?.ping).toHaveBeenCalledTimes(2);
  });

  it("re-initializes on the next call after a simulated database failure", async () => {
    const firstApp = await getApp();
    const firstDb = activeDb;
    expect(firstDb).not.toBeNull();

    // Simulate DB failure on ping
    firstDb?.ping.mockRejectedValueOnce(new Error("Connection reset by peer"));

    // Next getApp call should detect unhealthy DB, tear down, and throw
    await expect(getApp()).rejects.toThrow("Connection reset by peer");
    expect(firstDb?.close).toHaveBeenCalled();

    // After failure recovery, the subsequent call must re-initialize a fresh app
    const recoveredApp = await getApp();
    expect(recoveredApp).toBeDefined();
    expect(recoveredApp).not.toBe(firstApp);
    expect(activeDb).not.toBe(firstDb);
  });

  it("cleans up resources and resets state when closeApp is called", async () => {
    const app = await getApp();
    expect(app).toBeDefined();
    const db = activeDb;
    expect(getDb()).not.toBeNull();

    await closeApp();
    expect(db?.close).toHaveBeenCalled();
    expect(getDb()).toBeNull();

    // Next getApp starts fresh
    const newApp = await getApp();
    expect(newApp).toBeDefined();
    expect(newApp).not.toBe(app);
  });

  it("checkAppHealth throws when called without an initialized app", async () => {
    await expect(checkAppHealth()).rejects.toThrow("Application not initialized");
  });

  it("shares one app and fixed listeners across overlapping cold and warm invocations", async () => {
    const originalBuild = serverModule.buildServer;
    const gate = deferred();
    let entered = false;
    vi.spyOn(serverModule, "buildServer").mockImplementationOnce((deps) => {
      const candidate = originalBuild(deps);
      candidate.addHook("onReady", async () => {
        entered = true;
        await gate.promise;
      });
      return candidate;
    });
    const pending = Array.from({ length: 16 }, (_, index) =>
      index % 2 === 0 ? initializeApp() : getApp(),
    );
    await vi.waitFor(() => {
      expect(entered).toBe(true);
    });
    expect(databaseOpen).toHaveBeenCalledTimes(1);
    gate.resolve();
    const apps = await Promise.all(pending);
    const app = apps[0];
    expect(app).toBeDefined();
    expect(new Set(apps).size).toBe(1);
    const listeners = app?.server.listenerCount("request");
    await Promise.all(Array.from({ length: 32 }, () => getApp()));
    expect(databaseOpen).toHaveBeenCalledTimes(1);
    expect(createApiRedis).toHaveBeenCalledTimes(1);
    expect(app?.server.listenerCount("request")).toBe(listeners);
    expect((await app?.inject({ method: "GET", url: "/health" }))?.statusCode).toBe(200);
  });

  it("waits for failed warm resources to close before creating a replacement", async () => {
    const firstApp = await getApp();
    const firstDb = activeDb;
    if (firstDb === null) throw new Error("missing fixture database");
    const ping = deferred();
    const closing = deferred();
    firstDb.ping.mockImplementationOnce(() => ping.promise);
    firstDb.close.mockImplementationOnce(() => closing.promise);
    const failure = getApp();
    const failureAssertion = expect(failure).rejects.toThrow("failed old connection");
    const replacement = getApp();
    await vi.waitFor(() => {
      expect(firstDb.ping).toHaveBeenCalledTimes(1);
    });
    ping.reject(new Error("failed old connection"));
    await vi.waitFor(() => {
      expect(firstDb.close).toHaveBeenCalledTimes(1);
    });
    expect(databaseOpen).toHaveBeenCalledTimes(1);
    closing.resolve();
    await failureAssertion;
    const secondApp = await replacement;
    expect(secondApp).not.toBe(firstApp);
    expect(databaseOpen).toHaveBeenCalledTimes(2);
    expect(activeDb).not.toBe(firstDb);
    expect(firstDb.close).toHaveBeenCalledTimes(1);
    expect(await getApp()).toBe(secondApp);
  });

  it("orders shutdown after pending initialization and closes each owned resource once", async () => {
    const schema = deferred();
    vi.mocked(checkSchemaCompatibility).mockImplementationOnce(() => schema.promise);
    const startup = getApp();
    const shutdown = closeApp();
    await vi.waitFor(() => {
      expect(databaseOpen).toHaveBeenCalledTimes(1);
    });
    const firstDb = activeDb;
    expect(getDb()).toBeNull();
    schema.resolve();
    await startup;
    await shutdown;
    expect(firstDb?.close).toHaveBeenCalledTimes(1);
    expect(getDb()).toBeNull();
    const redis = vi.mocked(createApiRedis).mock.results[0]?.value;
    expect(redis?.disconnect).toHaveBeenCalledTimes(1);
    await Promise.all([closeApp(), closeApp()]);
    expect(firstDb?.close).toHaveBeenCalledTimes(1);
    await getApp();
    expect(databaseOpen).toHaveBeenCalledTimes(2);
  });

  it("attempts all cleanup and preserves the original health failure when closers reject", async () => {
    const app = await getApp();
    const db = activeDb;
    if (db === null) throw new Error("missing fixture database");
    const failure = new Error("original database health failure");
    db.ping.mockRejectedValueOnce(failure);
    db.close.mockRejectedValueOnce(new Error("pool cleanup failed"));
    vi.spyOn(app, "close").mockRejectedValueOnce(new Error("app cleanup failed"));
    await expect(getApp()).rejects.toBe(failure);
    expect(db.close).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createApiRedis).mock.results[0]?.value.disconnect).toHaveBeenCalledTimes(1);
    expect(getDb()).toBeNull();
    expect(await getApp()).not.toBe(app);
  });

  it.each(["schema", "policy", "build", "ready"])(
    "releases a failed %s initialization and retries cleanly",
    async (stage) => {
      const error = new Error("initialization failed");
      if (stage === "schema") vi.mocked(checkSchemaCompatibility).mockRejectedValueOnce(error);
      if (stage === "policy") vi.mocked(checkDatabasePolicy).mockRejectedValueOnce(error);
      if (stage === "build")
        vi.spyOn(serverModule, "buildServer").mockImplementationOnce(() => {
          throw error;
        });
      if (stage === "ready") {
        const originalBuild = serverModule.buildServer;
        vi.spyOn(serverModule, "buildServer").mockImplementationOnce((deps) => {
          const candidate = originalBuild(deps);
          candidate.addHook("onReady", () => Promise.reject(error));
          return candidate;
        });
      }
      await expect(getApp()).rejects.toBe(error);
      const failedDb = activeDb;
      expect(failedDb?.close).toHaveBeenCalledTimes(1);
      expect(getDb()).toBeNull();
      if (stage === "build" || stage === "ready")
        expect(vi.mocked(createApiRedis).mock.results[0]?.value.disconnect).toHaveBeenCalledTimes(
          1,
        );
      await getApp();
      expect(activeDb).not.toBe(failedDb);
    },
  );

  it.each(["INDEXER_ENABLED", "RAILS_ENABLED", "KEEPER_ENABLED"])(
    "refuses serverless background writer %s before opening resources",
    async (key) => {
      const previous = process.env[key];
      process.env[key] = "true";
      try {
        await expect(getApp()).rejects.toThrow();
        expect(databaseOpen).not.toHaveBeenCalled();
        expect(createApiRedis).not.toHaveBeenCalled();
      } finally {
        process.env[key] = previous;
      }
    },
  );

  it("handles HTTP handler requests and returns 500 when database fails", async () => {
    // Warm up the app
    await getApp();
    const currentDb = activeDb;

    // OPTIONS request returns 204
    const { req: optReq, res: optRes } = createMockReqRes("OPTIONS");
    await handler(optReq, optRes);
    expect(optRes.statusCode).toBe(204);

    // Simulate DB failure
    currentDb?.ping.mockRejectedValueOnce(new Error("Connection terminated"));

    const { req: getReq, res: getRes } = createMockReqRes("GET", "/health");
    await handler(getReq, getRes);
    expect(getRes.statusCode).toBe(500);
    const body = JSON.parse(getRes.body);
    expect(body.error).toBe("internal_error");
    expect(body.message).toBe("The API is not configured or is unavailable.");
  });

  it("omits active-worker readiness claims in API-only mode", async () => {
    const app = await getApp();
    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).not.toHaveProperty("runCorrelation");
    expect(ready.json()).not.toHaveProperty("workerRuns");

    expect(ready.json().meaning).toContain("Background workers are not started or assessed");
    expect(ready.json().checks.map((check: { name: string }) => check.name)).toEqual([
      "postgres",
      "redis",
    ]);
  });
});
