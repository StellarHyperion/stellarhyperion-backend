import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import handler, { closeApp, initializeApp } from "../../api/index.js";
import { Database } from "../../src/db/pool.js";
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

const WRITER = "postgres://hyperion_writer:writer-secret-1@127.0.0.1:5433/hyperion";
const API = "postgres://hyperion_api:api-secret-2@127.0.0.1:5433/hyperion";

class FakeDb {
  public ping = vi.fn().mockResolvedValue(undefined);
  public close = vi.fn().mockResolvedValue(undefined);
  public query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
}

const opened: { url: string; options: Record<string, unknown> }[] = [];

function respond(): Promise<{ status: number; body: string }> {
  const req = new EventEmitter() as unknown as IncomingMessage;
  Object.assign(req, { method: "GET", url: "/health", headers: {} });
  let status = 200;
  let body = "";
  const res = {
    setHeader: () => undefined,
    writeHead(code: number) {
      status = code;
    },
    end(content?: string) {
      body = content ?? "";
    },
  } as unknown as ServerResponse;
  return handler(req, res).then(() => ({ status, body }));
}

describe("API entrypoint database credential", () => {
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    await closeApp();
    opened.length = 0;
    vi.spyOn(Database, "open").mockImplementation((url, options) => {
      opened.push({ url, options: (options ?? {}) as Record<string, unknown> });
      return new FakeDb() as unknown as Database;
    });
    const env = completeEnv({
      INDEXER_ENABLED: "false",
      RAILS_ENABLED: "false",
      KEEPER_ENABLED: "false",
      VERCEL_ENV: "production",
      HYPERION_DATABASE_ENV: "production",
    });
    delete env.DATABASE_URL;
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) process.env[key] = value;
    }
    Reflect.deleteProperty(process.env, "DATABASE_URL");
    Reflect.deleteProperty(process.env, "HYPERION_DATABASE_ROLE");
  });

  afterEach(async () => {
    await closeApp();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) Reflect.deleteProperty(process.env, key);
      else process.env[key] = originalEnv[key];
    }
    vi.restoreAllMocks();
  });

  it("starts with only the read-only API credential", async () => {
    process.env.API_DATABASE_URL = API;
    await initializeApp();
    expect(opened).toHaveLength(1);
    expect(opened[0]?.url).toBe(API);
    expect(opened[0]?.options.readOnly).toBe(true);
  });

  it("never opens the writer credential when both are configured", async () => {
    process.env.API_DATABASE_URL = API;
    process.env.DATABASE_URL = WRITER;
    await initializeApp();
    expect(opened.map((entry) => entry.url)).toEqual([API]);
  });

  it("keeps credentials out of the public error response", async () => {
    process.env.API_DATABASE_URL = API;
    process.env.DATABASE_URL = WRITER;
    // A write-capable role is refused at startup; the caller sees only a generic error.
    process.env.HYPERION_DATABASE_ROLE = "read-write";
    const { status, body } = await respond();
    expect(status).toBe(500);
    expect(JSON.parse(body)).toMatchObject({ error: "internal_error" });
    for (const secret of ["writer-secret-1", "api-secret-2", "hyperion_writer", "hyperion_api"])
      expect(body).not.toContain(secret);
    expect(opened).toHaveLength(0);
  });
});
