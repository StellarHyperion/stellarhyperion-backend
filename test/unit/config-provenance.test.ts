import { fileURLToPath } from "node:url";

import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import { sanitizePublicEndpointUrl } from "../../src/config/provenance.js";
import type { Database } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import { completeEnv, TESTNET_DEPLOYMENTS } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const ACTIVE_TESTNET_DEPLOYMENT = fileURLToPath(
  new URL("../../deployments/testnet.json", import.meta.url),
);

const mockDb = {
  query: () => Promise.resolve({ rows: [], rowCount: 0 }),
  ping: () => Promise.resolve(),
} as unknown as Database;

describe("configuration provenance and effective-setting reports", () => {
  it("never emits secret values or credential-bearing URL components in reports or HTTP routes", async () => {
    const dbPassword = "db-ultra-secret-password-7741";
    const redisPassword = "redis-ultra-secret-password-8829";
    const rpcPassword = "rpc-basic-auth-secret-5510";
    const queryApiKey = "query-token-secret-9901";
    const pathInfuraKey = "9aa3d95b3bc440fa88ea12eaa4456161";
    const dynamicStellarSecret = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(11)).secret();

    const config = loadConfig({
      env: completeEnv({
        DATABASE_URL: `postgres://hyperion:${dbPassword}@db.internal:5432/hyperion`,
        REDIS_URL: `rediss://default:${redisPassword}@redis.internal:6380`,
        KEEPER_STELLAR_SECRET: dynamicStellarSecret,
        STELLAR_RPC_URL: `https://rpcuser:${rpcPassword}@soroban.example.invalid:443/v1?api_key=${queryApiKey}#frag`,
        EVM_RPC_URL_SEPOLIA: `https://sepolia.infura.example.invalid/v3/${pathInfuraKey}?token=${queryApiKey}`,
        IRIS_API_URL: `https://irisuser:${rpcPassword}@iris.example.invalid/apikey/${pathInfuraKey}`,
      }),
    });

    const serialized = JSON.stringify(config.provenance);
    expect(serialized).not.toContain(dbPassword);
    expect(serialized).not.toContain(redisPassword);
    expect(serialized).not.toContain(rpcPassword);
    expect(serialized).not.toContain(queryApiKey);
    expect(serialized).not.toContain(pathInfuraKey);
    expect(serialized).not.toContain(dynamicStellarSecret);
    expect(serialized).not.toContain("rpcuser");
    expect(serialized).not.toContain("irisuser");
    expect(serialized).not.toContain("db.internal");
    expect(serialized).not.toContain("redis.internal");

    const stellarRpc = config.provenance.settings.find(
      (entry) => entry.key === "indexer.stellar.rpcUrl",
    );
    expect(stellarRpc).toEqual({
      key: "indexer.stellar.rpcUrl",
      envVar: "STELLAR_RPC_URL",
      source: "env",
      value: "https://soroban.example.invalid/v1",
    });

    const sepoliaRpc = config.provenance.settings.find(
      (entry) => entry.key === "indexer.evm.sepolia.rpcUrls",
    );
    expect(sepoliaRpc).toEqual({
      key: "indexer.evm.sepolia.rpcUrls",
      envVar: "EVM_RPC_URL_SEPOLIA",
      source: "env",
      value: ["https://sepolia.infura.example.invalid/v3/[redacted]"],
    });

    expect(config.provenance.secrets).toEqual([
      { name: "DATABASE_URL", configured: true, source: "env" },
      { name: "REDIS_URL", configured: true, source: "env" },
      { name: "KEEPER_STELLAR_SECRET", configured: true, source: "env" },
    ]);

    const { logger } = capturingLogger();
    const app = buildServer({ config, logger, db: mockDb, readiness: [] });
    try {
      const res = await app.inject({ method: "GET", url: "/v1/config" });
      expect(res.statusCode).toBe(200);
      expect(res.payload).not.toContain(dbPassword);
      expect(res.payload).not.toContain(dynamicStellarSecret);
      expect(res.payload).not.toContain(rpcPassword);
      expect(res.json().effectiveDigest).toBe(config.provenance.effectiveDigest);

      const healthRes = await app.inject({ method: "GET", url: "/health" });
      expect(healthRes.statusCode).toBe(200);
      expect(healthRes.json().configDigest).toBe(config.provenance.effectiveDigest);
    } finally {
      await app.close();
    }

    expect(
      sanitizePublicEndpointUrl("https://u:p@rpc.example:8443/v2/supersecrettoken?key=123"),
    ).toBe("https://rpc.example:8443/v2/[redacted]");
  });

  it("attributes default, env, deployment, and registry provenance and identifies conflicting overrides", () => {
    // 1. Checked-in active testnet deployment (Stellar router only, no EVM router).
    const activeConfig = loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: ACTIVE_TESTNET_DEPLOYMENT,
        STELLAR_START_LEDGER: "5433900",
        EVM_RPC_URL_SEPOLIA: "https://sepolia-unused.example.invalid",
        RAILS_ENABLED: "false",
        RAIL_BATCH_SIZE: "45",
        KEEPER_ENABLED: "false",
        KEEPER_CONCURRENCY: "4",
      }),
    });

    expect(activeConfig.provenance.deploymentRevision).toMatchObject({
      schemaVersion: 1,
      generatedAt: "2026-10-29T10:17:56.262Z",
      network: "testnet",
      hasStellarRouter: true,
      hasEvmRouter: false,
      chains: [
        {
          chain: "stellar-testnet",
          family: "stellar",
          router: "CCXPCT3YFLVANSF3AQMYCCZVGCMLTURAYQ6O6DYGQJMTKVYQL6NTOC2V",
          commit: "b91c6ca",
          deployedHeight: "5433808",
        },
      ],
    });

    const byKey = new Map(activeConfig.provenance.settings.map((s) => [s.key, s]));
    expect(byKey.get("http.port")?.source).toBe("default");
    expect(byKey.get("indexer.stellar.routerContractId")?.source).toBe("deployment");
    expect(byKey.get("indexer.stellar.rpcUrl")?.source).toBe("registry");
    expect(byKey.get("indexer.stellar.startLedger")?.source).toBe("env");

    const overrideKinds = activeConfig.provenance.conflictingOverrides.map(
      (item) => `${item.kind}:${item.variable}`,
    );
    expect(overrideKinds).toContain("deployment_override:STELLAR_START_LEDGER");
    expect(overrideKinds).toContain("unused_chain_override:EVM_RPC_URL_SEPOLIA");
    expect(overrideKinds).toContain("inactive_subsystem_override:RAIL_BATCH_SIZE");
    expect(overrideKinds).toContain("inactive_subsystem_override:KEEPER_CONCURRENCY");

    // 2. Fixture deployment with EVM router: EVM_RPC_URLS_SEPOLIA shadows EVM_RPC_URL_SEPOLIA.
    const shadowedConfig = loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: TESTNET_DEPLOYMENTS,
        EVM_RPC_URL_SEPOLIA: "https://shadowed.example.invalid",
        EVM_RPC_URLS_SEPOLIA: "https://primary.example.invalid, https://backup.example.invalid",
        EVM_REORG_DEPTH_BLOCKS: "12",
      }),
    });

    const shadowedKinds = shadowedConfig.provenance.conflictingOverrides.map(
      (item) => `${item.kind}:${item.variable}`,
    );
    expect(shadowedKinds).toContain("shadowed_env:EVM_RPC_URL_SEPOLIA");
    expect(shadowedKinds).toContain("deployment_override:EVM_REORG_DEPTH_BLOCKS");
  });

  it("computes an identical public digest for equivalent effective configurations", () => {
    const implicitDefaults = loadConfig({
      env: completeEnv({
        DATABASE_URL: "postgres://user_a:pw_a@host-a.internal:5432/db_a",
        REDIS_URL: "redis://redis-a.internal:6379",
      }),
    });

    const explicitMatchingValues = loadConfig({
      env: {
        UNRELATED_NOISE: "ignored",
        HTTP_PORT: " 8080 ",
        HTTP_HOST: "127.0.0.1",
        NODE_ENV: "development",
        LOG_LEVEL: "info",
        INDEXER_ENABLED: "YES",
        RAILS_ENABLED: "1",
        KEEPER_ENABLED: "true",
        STELLAR_RPC_URL: "https://soroban-testnet.stellar.org:443/",
        STELLAR_START_LEDGER: "1287400",
        STELLAR_EVENT_PAGE_SIZE: "200",
        STELLAR_POLL_INTERVAL_MS: "5000",
        EVM_POLL_INTERVAL_MS: "4000",
        EVM_LOG_RANGE: "2000",
        EVM_REORG_DEPTH_BLOCKS: "3",
        RAIL_POLL_INTERVAL_MS: "15000",
        RAIL_BATCH_SIZE: "20",
        RAIL_RECHECK_AFTER_MS: "10000",
        RAIL_MAX_CHECK_FAILURES: "10",
        KEEPER_POLL_INTERVAL_MS: "30000",
        KEEPER_CONCURRENCY: "2",
        SHUTDOWN_TIMEOUT_MS: "10000",
        HYPERION_DEPLOYMENTS_FILE: TESTNET_DEPLOYMENTS,
        HYPERION_NETWORK: "testnet",
        DATABASE_URL: "postgresql://user_b:completely_different_pw@host-b.internal:5432/db_b",
        REDIS_URL: "rediss://default:other_pw@redis-b.internal:6380",
      },
    });

    expect(implicitDefaults.provenance.effectiveDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(explicitMatchingValues.provenance.effectiveDigest).toBe(
      implicitDefaults.provenance.effectiveDigest,
    );

    const changedEffectiveConfig = loadConfig({
      env: completeEnv({ RAIL_BATCH_SIZE: "25" }),
    });
    expect(changedEffectiveConfig.provenance.effectiveDigest).not.toBe(
      implicitDefaults.provenance.effectiveDigest,
    );
  });
});
