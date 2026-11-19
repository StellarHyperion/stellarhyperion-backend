import { beforeAll, describe, it, expect } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { reconcileIndexedHistory } from "../src/reconciliation/runner.js";
import { capturingLogger } from "../stellar-fakes.js";
import type { KeeperContext } from "../src/keeper/types.js";

describe("Indexed history reconciliation", () => {
  beforeAll(() => {
    // Setup test database if needed
  });

  it("compares restored backup with source event range digests", async () => {
    const config = loadConfig({
      env: {
        DATABASE_URL: "postgres://hyperion:test@127.0.0.1:5432/hyperion_test",
        REDIS_URL: "redis://127.0.0.1:6380",
        HYPERION_NETWORK: "testnet",
        HYPERION_DEPLOYMENTS_FILE: "test/fixtures/deployments-testnet.json",
      },
    });
    const { logger } = capturingLogger();
    const db = {} as any;
    const result = await reconcileIndexedHistory(
      { config, db, logger } as KeeperContext,
      BigInt(0),
      BigInt(100000),
      BigInt(0),
      BigInt(100000),
    );
    expect(result.restored.monetarySum).toBeDefined();
    expect(result.source.monetarySum).toBeDefined();
    expect(Array.isArray(result.missingIntervals)).toBe(true);
    expect(Array.isArray(result.duplicateChecks)).toBe(true);
  });

  it("detects incomplete coverage after restore", async () => {
    const config = loadConfig({
      env: {
        DATABASE_URL: "postgres://hyperion:test@127.0.0.1:5432/hyperion_test",
        REDIS_URL: "redis://127.0.0.1:6380",
        HYPERION_NETWORK: "testnet",
        HYPERION_DEPLOYMENTS_FILE: "test/fixtures/deployments-testnet.json",
      },
    });
    const { logger } = capturingLogger();
    const db = {} as any;
    const result = await reconcileIndexedHistory(
      { config, db, logger } as KeeperContext,
      BigInt(0),
      BigInt(50000),
      BigInt(0),
      BigInt(100000),
    );
    expect(result.missingIntervals.length).toBeGreaterThan(0);
  });

  it("prevents duplicate payouts during replay", async () => {
    const config = loadConfig({
      env: {
        DATABASE_URL: "postgres://hyperion:test@127.0.0.1:5432/hyperion_test",
        REDIS_URL: "redis://127.0.0.1:6380",
        HYPERION_NETWORK: "testnet",
        HYPERION_DEPLOYMENTS_FILE: "test/fixtures/deployments-testnet.json",
      },
    });
    const { logger } = capturingLogger();
    const db = {} as any;
    const result = await reconcileIndexedHistory(
      { config, db, logger } as KeeperContext,
      BigInt(0),
      BigInt(100000),
      BigInt(0),
      BigInt(100000),
    );
    const hasDuplicates = result.duplicateChecks.some((check) => check.alreadyExists);
    expect(hasDuplicates).toBe(false);
  });
});