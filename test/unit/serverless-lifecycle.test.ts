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
import { completeEnv } from "../helpers.js";

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

vi.spyOn(Database, "open").mockImplementation((_url, options) => {
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
  });

  it("limits connection pool size to max: 2 on cold start", async () => {
    const app = await initializeApp();
    expect(app).toBeDefined();
    expect(lastOpenOptions).toBeDefined();
    expect(lastOpenOptions?.max).toBe(2);
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
});
