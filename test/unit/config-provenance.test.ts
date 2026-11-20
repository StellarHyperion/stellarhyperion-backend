import { describe, expect, it } from "vitest";

import {
  loadConfig,
  configProvenance,
  computeConfigDigest,
  type ConfigProvenanceEntry,
} from "../../src/config/config.js";
import { completeEnv, readFixture } from "../helpers.js";
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

    const portEntry = config.configProvenance.find((e) => e.name === "HTTP_PORT");
    expect(portEntry?.source).toBe("default");
    expect(portEntry?.value).toBe("8080");
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
        DEPLOYMENT_REVISION: "1111111111111111111111111111111111111111",
        EVM_RPC_URL_SEPOLIA: "https://sepolia.example.invalid/single",
        EVM_RPC_URLS_SEPOLIA: "https://sepolia.example.invalid/multi",
      }),
    });

    const ledgerEntry = config.configProvenance.find((e) => e.name === "STELLAR_START_LEDGER");
    expect(ledgerEntry?.source).toBe("env");
    expect(ledgerEntry?.value).toBe("1500000");
    expect(ledgerEntry?.conflict).toContain("overrides deployment record start ledger");

    const revisionEntry = config.configProvenance.find((e) => e.name === "DEPLOYMENT_REVISION");
    expect(revisionEntry?.source).toBe("deployment");
    expect(revisionEntry?.value).toBe("b302664f1d7a5c9e0348ab27dd51e6904f8c3a2b");
    expect(revisionEntry?.conflict).toContain("expectation conflicts");

    const urlsEntry = config.configProvenance.find((e) => e.name === "EVM_RPC_URLS_SEPOLIA");
    expect(urlsEntry?.source).toBe("env");
    expect(urlsEntry?.conflict).toContain("overrides EVM_RPC_URL_SEPOLIA");

    const urlEntry = config.configProvenance.find((e) => e.name === "EVM_RPC_URL_SEPOLIA");
    expect(urlEntry?.source).toBe("env");
    expect(urlEntry?.conflict).toContain("ignored because EVM_RPC_URLS_SEPOLIA is selected");
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
  it("omits credential URLs, opaque host/path/owner strings and arbitrary lane keys from /health", async () => {
    const marker = "private-credential-316";
    const url = `https://user:${marker}@provider.invalid/${marker}?api_key=${marker}#${marker}`;
    const config = loadConfig({
      env: completeEnv({
        STELLAR_RPC_URL: url,
        EVM_RPC_URL_SEPOLIA: url,
        EVM_RPC_URLS_SEPOLIA: url,
        STELLAR_HISTORICAL_RPC_URL: url,
        IRIS_API_URL: url,
        AXELAR_API_URL: url,
        HTTP_HOST: marker,
        INDEXER_LEASE_OWNER_ID: marker,
        HYPERION_DEPLOYMENTS_FILE: `/tmp/${marker}.json`,
        FRESHNESS_LANE_TARGETS: JSON.stringify({ [marker]: { maxProofBacklogCount: 2 } }),
      }),
      readFile: () => readFixture("deployments-testnet.json"),
    });
    const app = buildServer({
      config,
      logger: createLogger(config),
      db: new MockDb() as unknown as Database,
      readiness: [],
    });
    try {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(marker);
      expect(res.body).not.toContain("provider.invalid");
      expect(JSON.stringify(config.configProvenance)).not.toContain(marker);
      expect(
        config.configProvenance.find((entry) => entry.name === "EVM_RPC_URLS_SEPOLIA")?.value,
      ).toBe("omitted");
    } finally {
      await app.close();
    }
  });

  it("keeps the digest stable across equivalent defaults, paths, credentials, ignored overrides and target order", () => {
    const targets = {
      "sepolia->stellar-testnet": { maxProofBacklogCount: 3, maxProofBacklogAgeMs: 2000 },
    };
    const base = loadConfig({
      env: completeEnv({
        EVM_RPC_URLS_SEPOLIA: "https://one.invalid/key",
        FRESHNESS_LANE_TARGETS: JSON.stringify(targets),
      }),
    });
    const equivalent = loadConfig({
      env: completeEnv({
        LOG_LEVEL: "info",
        HTTP_HOST: "different-host",
        INDEXER_LEASE_OWNER_ID: "different-owner",
        HYPERION_DEPLOYMENTS_FILE: "another-record.json",
        DATABASE_URL: "postgres://other:password@127.0.0.1/db",
        STELLAR_RPC_URL: "https://other.invalid/private",
        EVM_RPC_URLS_SEPOLIA: "https://other.invalid/private",
        EVM_RPC_URL_SEPOLIA: "ignored-invalid-value",
        EVM_RPC_URL_ARC_TESTNET: "inactive-invalid-value",
        DEPLOYMENT_REVISION: "1111111111111111111111111111111111111111",
        FRESHNESS_LANE_TARGETS: JSON.stringify({
          "sepolia->stellar-testnet": { maxProofBacklogAgeMs: 2000, maxProofBacklogCount: 3 },
          "base-sepolia": { ...base.freshnessSlo.defaults },
        }),
      }),
      readFile: () => readFixture("deployments-testnet.json"),
    });
    expect(equivalent.configDigest).toBe(base.configDigest);
    expect(equivalent.configProvenance.find((entry) => entry.name === "LOG_LEVEL")?.source).toBe(
      "env",
    );
  });

  it("uses every selected deployment revision with stable ordering and detects changes beyond the first record", () => {
    const fixture = JSON.parse(readFixture("deployments-testnet.json")) as {
      networks: Record<string, { commit: string }>;
    };
    const sepolia = fixture.networks.sepolia;
    if (sepolia === undefined) throw new Error("missing deployment fixture");
    sepolia.commit = "1234567";
    const changed = loadConfig({ env: completeEnv(), readFile: () => JSON.stringify(fixture) });
    const reversed = {
      ...fixture,
      networks: Object.fromEntries(Object.entries(fixture.networks).reverse()),
    };
    const reordered = loadConfig({ env: completeEnv(), readFile: () => JSON.stringify(reversed) });
    expect(changed.configDigest).toBe(reordered.configDigest);
    expect(changed.configDigest).not.toBe(loadConfig({ env: completeEnv() }).configDigest);
    expect(
      changed.configProvenance.find((entry) => entry.name === "DEPLOYMENT_REVISION_SEPOLIA")?.value,
    ).toBe("1234567");
    expect(
      changed.configProvenance.find((entry) => entry.name === "DEPLOYMENT_REVISION")?.value,
    ).toContain("1234567");
  });

  it("rejects unsafe requested and selected revisions before a report escapes without echoing them", () => {
    const unsafe = "https://user:private-revision@host.invalid";
    expect(() => loadConfig({ env: completeEnv({ DEPLOYMENT_REVISION: unsafe }) })).toThrow(
      "hexadecimal Git commit",
    );
    try {
      loadConfig({ env: completeEnv({ DEPLOYMENT_REVISION: unsafe }) });
    } catch (error) {
      expect(String(error)).not.toContain(unsafe);
    }
    const fixture = JSON.parse(readFixture("deployments-testnet.json")) as {
      networks: Record<string, { commit: string }>;
    };
    const sepolia = fixture.networks.sepolia;
    if (sepolia === undefined) throw new Error("missing deployment fixture");
    sepolia.commit = unsafe;
    expect(() =>
      loadConfig({ env: completeEnv(), readFile: () => JSON.stringify(fixture) }),
    ).toThrow();
  });

  it("ignores worker tuning for disabled workers in the effective digest", () => {
    const disabled = {
      INDEXER_ENABLED: "false",
      RAILS_ENABLED: "false",
      KEEPER_ENABLED: "false",
      CATCH_UP_ENABLED: "false",
    };
    const base = loadConfig({ env: completeEnv(disabled) });
    const changed = loadConfig({
      env: completeEnv({
        ...disabled,
        STELLAR_EVENT_PAGE_SIZE: "50",
        EVM_LOG_RANGE: "100",
        RAIL_BATCH_SIZE: "5",
        KEEPER_CONCURRENCY: "2",
        CATCH_UP_BUDGET_MS: "1000",
      }),
    });
    expect(changed.configDigest).toBe(base.configDigest);
  });
  it("changes the digest when effective deployed token decimals change without a commit label change", () => {
    const fixture = JSON.parse(readFixture("deployments-testnet.json")) as {
      networks: { sepolia: { tokens: { USDC: { decimals: number } } } };
    };
    fixture.networks.sepolia.tokens.USDC.decimals = 18;
    const changed = loadConfig({ env: completeEnv(), readFile: () => JSON.stringify(fixture) });
    expect(changed.configDigest).not.toBe(loadConfig({ env: completeEnv() }).configDigest);
  });
});
