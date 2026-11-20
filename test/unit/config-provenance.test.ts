import { describe, expect, it } from "vitest";

import {
  loadConfig,
  configProvenance,
  computeConfigDigest,
  type ConfigProvenanceEntry,
} from "../../src/config/config.js";
import { completeEnv } from "../helpers.js";
import { buildServer } from "../../src/http/server.js";
import { createLogger } from "../../src/logging/logger.js";
import type { Database } from "../../src/db/pool.js";

class MockDb {
  async ping(): Promise<void> {
    await Promise.resolve();
  }

  async query(): Promise<{ rows: unknown[] }> {
    await Promise.resolve();
    return { rows: [] };
  }
}

describe("configuration provenance and effective-setting reports", () => {
  it("never includes secrets or credentials in provenance reports or digest", () => {
    const rawSecret = "super-secret-password-12345";
    const rawStellarSecret = "SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    const rawHistoricalRpc = "https://user:pass@historical-rpc.stellar.org/secret-token";
    const rawRedisUrl = "redis://:super-redis-password@127.0.0.1:6380";

    const env = completeEnv({
      DATABASE_URL: `postgres://hyperion:${rawSecret}@127.0.0.1:5433/hyperion`,
      REDIS_URL: rawRedisUrl,
      KEEPER_STELLAR_SECRET: rawStellarSecret,
      STELLAR_HISTORICAL_RPC_URL: rawHistoricalRpc,
    });

    const config = loadConfig({ env });
    const provenance = config.configProvenance;
    const names = provenance.map((entry) => entry.name);

    expect(names).not.toContain("DATABASE_URL");
    expect(names).not.toContain("REDIS_URL");
    expect(names).not.toContain("KEEPER_STELLAR_SECRET");
    expect(names).not.toContain("STELLAR_HISTORICAL_RPC_URL");

    const serialized = JSON.stringify(provenance);
    expect(serialized).not.toContain(rawSecret);
    expect(serialized).not.toContain(rawStellarSecret);
    expect(serialized).not.toContain(rawHistoricalRpc);
    expect(serialized).not.toContain(rawRedisUrl);

    // Verify configDigest does not contain plaintext secret
    expect(config.configDigest).not.toContain(rawSecret);
  });

  it("produces a stable, deterministic public digest for equivalent configs", () => {
    const config1 = loadConfig({ env: completeEnv() });
    const config2 = loadConfig({ env: completeEnv() });

    expect(config1.configDigest).toBe(config2.configDigest);
    expect(config1.configDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(computeConfigDigest(config1.configProvenance)).toBe(config1.configDigest);

    // Changing an effective nonsecret setting changes the digest
    const configModified = loadConfig({
      env: completeEnv({ HTTP_PORT: "9090" }),
    });
    expect(configModified.configDigest).not.toBe(config1.configDigest);
    expect(configModified.configDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("marks settings from defaults with source 'default'", () => {
    const config = loadConfig({ env: completeEnv() });
    const logLevelEntry = config.configProvenance.find((e) => e.name === "LOG_LEVEL");
    expect(logLevelEntry).toBeDefined();
    expect(logLevelEntry?.source).toBe("default");
    expect(logLevelEntry?.value).toBe("info");

    const hostEntry = config.configProvenance.find((e) => e.name === "HTTP_HOST");
    expect(hostEntry?.source).toBe("default");
    expect(hostEntry?.value).toBe("127.0.0.1");
  });

  it("marks settings from environment overrides with source 'env'", () => {
    const config = loadConfig({
      env: completeEnv({
        LOG_LEVEL: "warn",
        HTTP_PORT: "9000",
      }),
    });

    const logLevelEntry = config.configProvenance.find((e) => e.name === "LOG_LEVEL");
    expect(logLevelEntry?.source).toBe("env");
    expect(logLevelEntry?.value).toBe("warn");

    const portEntry = config.configProvenance.find((e) => e.name === "HTTP_PORT");
    expect(portEntry?.source).toBe("env");
    expect(portEntry?.value).toBe("9000");
  });

  it("marks settings and revisions from deployment records with source 'deployment'", () => {
    const config = loadConfig({ env: completeEnv() });

    const ledgerEntry = config.configProvenance.find((e) => e.name === "STELLAR_START_LEDGER");
    expect(ledgerEntry?.source).toBe("deployment");
    expect(ledgerEntry?.value).toBe("1287400");

    const revisionEntry = config.configProvenance.find((e) => e.name === "DEPLOYMENT_REVISION");
    expect(revisionEntry?.source).toBe("deployment");
    expect(revisionEntry?.value).toBe("b302664f1d7a5c9e0348ab27dd51e6904f8c3a2b");
  });

  it("identifies conflicting overrides", () => {
    const config = loadConfig({
      env: completeEnv({
        STELLAR_START_LEDGER: "1500000",
        DEPLOYMENT_REVISION: "custom-rev-1",
        EVM_RPC_URL_SEPOLIA: "https://sepolia.example.invalid/single",
        EVM_RPC_URLS_SEPOLIA: "https://sepolia.example.invalid/multi",
      }),
    });

    const ledgerEntry = config.configProvenance.find((e) => e.name === "STELLAR_START_LEDGER");
    expect(ledgerEntry?.source).toBe("env");
    expect(ledgerEntry?.value).toBe("1500000");
    expect(ledgerEntry?.conflict).toContain("overrides deployment record start ledger");

    const revisionEntry = config.configProvenance.find((e) => e.name === "DEPLOYMENT_REVISION");
    expect(revisionEntry?.source).toBe("env");
    expect(revisionEntry?.value).toBe("custom-rev-1");
    expect(revisionEntry?.conflict).toContain("overrides deployment record revision");

    const urlsEntry = config.configProvenance.find((e) => e.name === "EVM_RPC_URLS_SEPOLIA");
    expect(urlsEntry?.source).toBe("env");
    expect(urlsEntry?.conflict).toContain("overrides EVM_RPC_URL_SEPOLIA");

    const urlEntry = config.configProvenance.find((e) => e.name === "EVM_RPC_URL_SEPOLIA");
    expect(urlEntry?.source).toBe("env");
    expect(urlEntry?.conflict).toContain("overridden by EVM_RPC_URLS_SEPOLIA");
  });

  it("exports configProvenance helper accepting config or options", () => {
    const config = loadConfig({ env: completeEnv() });
    const fromConfig = configProvenance(config);
    expect(Array.isArray(fromConfig)).toBe(true);
    expect(fromConfig.digest).toBe(config.configDigest);

    const fromOptions = configProvenance({ env: completeEnv() });
    expect(Array.isArray(fromOptions)).toBe(true);
    expect(fromOptions.digest).toBe(config.configDigest);
  });

  it("exposes configDigest and configProvenance on /health endpoint", async () => {
    const config = loadConfig({ env: completeEnv() });
    const logger = createLogger(config);
    const db = new MockDb();

    const app = buildServer({
      config,
      logger,
      db: db as unknown as Database,
      readiness: [],
    });

    const res = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      status: string;
      configDigest: string;
      configProvenance: ConfigProvenanceEntry[];
    }>();

    expect(body.status).toBe("ok");
    expect(body.configDigest).toBe(config.configDigest);
    expect(Array.isArray(body.configProvenance)).toBe(true);
    expect(body.configProvenance.length).toBeGreaterThan(0);

    // Ensure secrets are absent from /health payload
    const serializedHealth = JSON.stringify(body);
    expect(serializedHealth).not.toContain("DATABASE_URL");
    expect(serializedHealth).not.toContain("REDIS_URL");
    expect(serializedHealth).not.toContain("KEEPER_STELLAR_SECRET");
    expect(serializedHealth).not.toContain("STELLAR_HISTORICAL_RPC_URL");

    await app.close();
  });
});
