import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import { DbTelemetryCollector } from "../../src/db/telemetry.js";
import {
  generateDiagnosticsBundle,
  sanitizeUrl,
  type DiagnosticsDb,
} from "../../src/diagnostics/bundle.js";
import { completeEnv } from "../helpers.js";

describe("operational diagnostics bundle (#113)", () => {
  it("strips credentials and secret query parameters from URLs", () => {
    expect(
      sanitizeUrl("https://user:supersecret@rpc.example.com/v2?apiKey=secret123&net=test"),
    ).toBe("https://%5Bredacted%5D@rpc.example.com/v2?apiKey=%5Bredacted%5D&net=test");
  });

  it("generates a sanitized read-only bundle of config, schema, freshness and backlog", async () => {
    const secret = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const dbSecret = "postgres://admin:very-secret-pw@db.internal:5432/hyperion";
    const redisSecret = "redis://:redis-secret-pw@redis.internal:6379/0";

    const config = loadConfig({
      env: completeEnv({
        DATABASE_URL: dbSecret,
        REDIS_URL: redisSecret,
        KEEPER_STELLAR_SECRET: secret,
        STELLAR_RPC_URL: "https://soroban.example.com/rpc?token=rpc-secret",
      }),
    });

    const executedSql: string[] = [];
    const telemetry = new DbTelemetryCollector(16);
    telemetry.record("transfers", 12.5, true);

    const db: DiagnosticsDb = {
      query(text: string) {
        executedSql.push(text.trim());
        if (text.includes("pgmigrations")) {
          return Promise.resolve({
            rows: [
              {
                name: "1791500000000_stellar-revisions-and-quarantine",
                run_on: new Date("2026-11-18T00:00:00Z"),
              },
            ],
            rowCount: 1,
          });
        }
        if (text.includes("indexer_cursor")) {
          return Promise.resolve({
            rows: [
              {
                chain_key: "sepolia",
                cursor_block: "123456",
                cursor_hash: "0xabc",
                revision: "4",
                updated_at: new Date("2026-11-18T23:59:50Z"),
              },
            ],
            rowCount: 1,
          });
        }
        if (text.includes("pending_claim")) {
          return Promise.resolve({
            rows: [{ total: 3, settled: 2, unsettled: 1 }],
            rowCount: 1,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
      telemetrySnapshot() {
        return telemetry.snapshot({
          totalCount: 2,
          idleCount: 1,
          waitingCount: 0,
          maxConnections: 10,
        });
      },
    };

    const bundle = await generateDiagnosticsBundle({
      config,
      db,
      now: new Date("2026-11-19T00:00:00Z"),
    });

    // Strictly read-only SELECT queries
    expect(executedSql.length).toBeGreaterThan(0);
    for (const sql of executedSql) {
      expect(sql.toUpperCase().startsWith("SELECT")).toBe(true);
    }

    // No credentials anywhere in serialized bundle
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain("very-secret-pw");
    expect(serialized).not.toContain("redis-secret-pw");
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("rpc-secret");

    expect(bundle.metadata.readOnly).toBe(true);
    expect(bundle.schema.migrationsAvailable).toBe(true);
    expect(bundle.schema.migrations).toHaveLength(1);
    expect(bundle.workerFreshness.cursors).toHaveLength(1);
    expect(bundle.proofBacklog.claims).toEqual({ total: 3, settled: 2, unsettled: 1 });
    expect(bundle.databaseTelemetry?.pool.maxConnections).toBe(10);
  });
});
