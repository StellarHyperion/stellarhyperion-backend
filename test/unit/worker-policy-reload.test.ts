import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { StellarWatcher } from "../../src/chains/stellar/watcher.js";
import { loadConfig } from "../../src/config/config.js";
import {
  PolicyReloadError,
  createWorkerPolicyStore,
  type WorkerPolicySnapshot,
} from "../../src/config/worker-policy.js";
import { Poller } from "../../src/runtime/poller.js";
import { completeEnv, TESTNET_DEPLOYMENTS } from "../helpers.js";
import {
  FakeRpc,
  LIVE_ROUTER,
  RecordingDb,
  capturingLogger,
  syntheticEvent,
  toid,
} from "../stellar-fakes.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CHECKED_IN_DEPLOYMENTS = join(REPO_ROOT, "deployments", "testnet.json");

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let done: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    done = resolve;
  });
  return {
    promise,
    resolve: () => {
      done?.();
    },
  };
}

describe("WorkerPolicyStore hot reload", () => {
  it("atomically reloads nonsecret concurrency, scheduling and freshness limits across active testnet lanes", () => {
    const baseEnv = completeEnv({
      HYPERION_DEPLOYMENTS_FILE: CHECKED_IN_DEPLOYMENTS,
      KEEPER_ENABLED: "false",
    });
    const config = loadConfig({ env: baseEnv });
    expect(config.indexer.evm).toEqual([]);

    const observedSnapshots: WorkerPolicySnapshot[] = [];
    const store = createWorkerPolicyStore(config, { initialOptions: { env: baseEnv } });
    store.subscribe((next) => {
      observedSnapshots.push(next);
    });

    expect(store.current().version).toBe(1);
    expect(store.current().values.stellarPollIntervalMs).toBe(5000);
    expect(store.current().values.railBatchSize).toBe(20);
    expect(store.current().values.keeperConcurrency).toBe(2);

    const noOp = store.reload({ env: { ...baseEnv } });
    expect(noOp.changed).toBe(false);
    expect(noOp.snapshot.version).toBe(1);
    expect(observedSnapshots).toHaveLength(0);

    const reloaded = store.reload({
      env: {
        ...baseEnv,
        STELLAR_POLL_INTERVAL_MS: "2500",
        STELLAR_EVENT_PAGE_SIZE: "400",
        STELLAR_FRESH_WITHIN_LEDGERS: "12",
        EVM_POLL_INTERVAL_MS: "6000",
        EVM_LOG_RANGE: "1000",
        EVM_FRESH_WITHIN_BLOCKS: "4",
        RAIL_POLL_INTERVAL_MS: "20000",
        RAIL_BATCH_SIZE: "50",
        RAIL_RECHECK_AFTER_MS: "15000",
        RAIL_MAX_CHECK_FAILURES: "15",
        RAIL_FRESH_BACKLOG_MULTIPLE: "5",
        KEEPER_POLL_INTERVAL_MS: "45000",
        KEEPER_CONCURRENCY: "4",
        SHUTDOWN_TIMEOUT_MS: "20000",
      },
    });

    expect(reloaded.changed).toBe(true);
    expect(reloaded.snapshot.version).toBe(2);
    expect(reloaded.changedFields).toHaveLength(14);
    expect(store.current().values).toEqual({
      stellarPollIntervalMs: 2500,
      stellarPageSize: 400,
      stellarFreshWithinLedgers: 12,
      evmPollIntervalMs: 6000,
      evmLogRange: 1000,
      evmFreshWithinBlocks: 4,
      railPollIntervalMs: 20_000,
      railBatchSize: 50,
      railRecheckAfterMs: 15_000,
      railMaxCheckFailures: 15,
      railFreshBacklogMultiple: 5,
      keeperPollIntervalMs: 45_000,
      keeperConcurrency: 4,
      shutdownTimeoutMs: 20_000,
    });
    expect(observedSnapshots).toHaveLength(1);
  });

  it("leaves the previous valid policy active when a reload has invalid values or malformed JSON", () => {
    let policyFileContent = JSON.stringify({
      STELLAR_POLL_INTERVAL_MS: 3000,
      RAIL_BATCH_SIZE: 30,
    });
    const readFake = (path: string): string => {
      if (path.endsWith("worker-policy.json")) return policyFileContent;
      return readFileSync(path, "utf8");
    };

    const env = completeEnv({
      WORKER_POLICY_FILE: "./worker-policy.json",
    });
    const config = loadConfig({ env, readFile: readFake, cwd: REPO_ROOT });
    const store = createWorkerPolicyStore(config, {
      initialOptions: { env, readFile: readFake, cwd: REPO_ROOT },
    });

    const initialSnapshot = store.current();
    expect(initialSnapshot.version).toBe(1);
    expect(initialSnapshot.values.stellarPollIntervalMs).toBe(3000);
    expect(initialSnapshot.values.railBatchSize).toBe(30);

    // Out-of-range limits fail validation and leave v1 untouched.
    policyFileContent = JSON.stringify({
      STELLAR_POLL_INTERVAL_MS: 50,
      RAIL_BATCH_SIZE: 999,
      KEEPER_CONCURRENCY: 0,
    });
    try {
      store.reload();
      throw new Error("expected invalid policy values to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyReloadError);
      const reloadErr = error as PolicyReloadError;
      expect(reloadErr.code).toBe("invalid_policy_values");
      expect(reloadErr.activeVersion).toBe(1);
      expect(reloadErr.faults.map((f) => f.name)).toEqual([
        "RAIL_BATCH_SIZE",
        "KEEPER_CONCURRENCY",
        "STELLAR_POLL_INTERVAL_MS",
      ]);
    }
    expect(store.current()).toBe(initialSnapshot);

    // Malformed JSON fails validation and still leaves v1 active.
    policyFileContent = "{ not-json ";
    expect(() => store.reload()).toThrow(PolicyReloadError);
    expect(store.current()).toBe(initialSnapshot);

    // Subsequent valid reload advances cleanly from v1 to v2.
    policyFileContent = JSON.stringify({
      STELLAR_POLL_INTERVAL_MS: 4500,
      RAIL_BATCH_SIZE: 40,
    });
    const next = store.reload();
    expect(next.changed).toBe(true);
    expect(next.snapshot.version).toBe(2);
    expect(store.current().values.stellarPollIntervalMs).toBe(4500);
    expect(store.current().values.railBatchSize).toBe(40);
  });

  it("refuses router, deployment, provider and secret changes without leaking credentials", () => {
    const initialSecret = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(4)).secret();
    const rotatedSecret = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(8)).secret();
    const baseEnv = completeEnv({
      KEEPER_STELLAR_SECRET: initialSecret,
    });
    const deploymentJson = readFileSync(TESTNET_DEPLOYMENTS, "utf8");
    const config = loadConfig({
      env: baseEnv,
      readFile: () => deploymentJson,
    });
    const store = createWorkerPolicyStore(config, {
      initialOptions: { env: baseEnv, readFile: () => deploymentJson },
    });
    const activeBefore = store.current();

    // Provider, role and secret rotation attempts via env must require restart and redact secrets.
    try {
      store.reload({
        env: {
          ...baseEnv,
          STELLAR_RPC_URL: "https://other-soroban.example.invalid",
          EVM_RPC_URL_SEPOLIA: "https://other-sepolia.example.invalid",
          IRIS_API_URL: "https://other-iris.example.invalid",
          AXELAR_API_URL: "https://other-axelar.example.invalid",
          DATABASE_URL: "postgres://hyperion:rotated-super-secret@127.0.0.1:5433/hyperion",
          KEEPER_STELLAR_SECRET: rotatedSecret,
        },
      });
      throw new Error("expected trust-boundary reload to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyReloadError);
      const reloadErr = error as PolicyReloadError;
      expect(reloadErr.code).toBe("trust_boundary_change_requires_restart");
      expect(reloadErr.changedTrustFields).toEqual([
        "AXELAR_API_URL",
        "DATABASE_URL",
        "EVM_RPC_URL_SEPOLIA",
        "IRIS_API_URL",
        "KEEPER_STELLAR_SECRET",
        "STELLAR_RPC_URL",
      ]);
      expect(reloadErr.message).not.toContain("rotated-super-secret");
      expect(reloadErr.message).not.toContain("not-a-real-password");
      expect(reloadErr.message).not.toContain(initialSecret);
      expect(reloadErr.message).not.toContain(rotatedSecret);
    }
    expect(store.current()).toBe(activeBefore);

    // Mutating the deployment record on disk (start height or router identity) also requires restart.
    const modifiedDeployment = deploymentJson.replace('"ledger": 1287400', '"ledger": 1287500');
    try {
      store.reload({
        env: { ...baseEnv, STELLAR_POLL_INTERVAL_MS: "3000" },
        readFile: () => modifiedDeployment,
      });
      throw new Error("expected modified deployment record to fail hot reload");
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyReloadError);
      const reloadErr = error as PolicyReloadError;
      expect(reloadErr.code).toBe("trust_boundary_change_requires_restart");
      expect(reloadErr.changedTrustFields).toContain("HYPERION_DEPLOYMENTS_FILE");
    }
    expect(store.current()).toBe(activeBefore);

    // Putting trust-boundary keys inside WORKER_POLICY_FILE is likewise rejected.
    const envWithFile = completeEnv({ WORKER_POLICY_FILE: "./worker-policy.json" });
    const fileBackedConfig = loadConfig({
      env: envWithFile,
      cwd: REPO_ROOT,
      readFile: (path) =>
        path.endsWith("worker-policy.json")
          ? JSON.stringify({ STELLAR_POLL_INTERVAL_MS: 4000 })
          : readFileSync(path, "utf8"),
    });
    const fileStore = createWorkerPolicyStore(fileBackedConfig, {
      initialOptions: { env: envWithFile, cwd: REPO_ROOT },
    });
    try {
      fileStore.reload({
        readFile: (path) =>
          path.endsWith("worker-policy.json")
            ? JSON.stringify({ STELLAR_RPC_URL: "https://evil-rpc.example.invalid" })
            : readFileSync(path, "utf8"),
      });
      throw new Error("expected forbidden key in WORKER_POLICY_FILE to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyReloadError);
      const reloadErr = error as PolicyReloadError;
      expect(reloadErr.code).toBe("trust_boundary_change_requires_restart");
      expect(reloadErr.changedTrustFields).toEqual(["STELLAR_RPC_URL"]);
    }
    expect(fileStore.current().version).toBe(1);
  });

  it("preserves a strict per-tick policy-version boundary for in-flight watcher passes", async () => {
    const baseEnv = completeEnv({
      STELLAR_EVENT_PAGE_SIZE: "2",
      STELLAR_POLL_INTERVAL_MS: "60000",
      STELLAR_FRESH_WITHIN_LEDGERS: "5",
    });
    const config = loadConfig({ env: baseEnv });
    const store = createWorkerPolicyStore(config, { initialOptions: { env: baseEnv } });

    // Three events in the same ledger force `scan()` to fetch two pages when pageSize = 2.
    const ledger = 1_287_405;
    const events = [0, 1, 2].map((index) =>
      syntheticEvent({
        ledger,
        id: `${toid(ledger).toString().padStart(19, "0")}-${String(index).padStart(10, "0")}`,
      }),
    );
    const backingRpc = new FakeRpc({ events, latestLedger: ledger + 8 });

    const firstPageReached = deferred();
    const releaseFirstTick = deferred();
    let callCount = 0;

    const gatedRpc = {
      latestLedger: () => backingRpc.latestLedger(),
      events: async (query: Parameters<FakeRpc["events"]>[0]) => {
        callCount += 1;
        const page = await backingRpc.events(query);
        if (callCount === 1) {
          firstPageReached.resolve();
          await releaseFirstTick.promise;
        }
        return page;
      },
    };

    const db = new RecordingDb();
    const { logger } = capturingLogger();
    const watcher = new StellarWatcher({
      chainKey: "stellar-testnet",
      router: LIVE_ROUTER,
      startLedger: ledger,
      pageSize: config.workerPolicy.stellarPageSize,
      freshWithinLedgers: config.workerPolicy.stellarFreshWithinLedgers,
      rpc: gatedRpc,
      db,
      logger,
      policy: () => store.current(),
    });

    const poller = new Poller({
      name: watcher.name,
      intervalMs: () => store.current().values.stellarPollIntervalMs,
      logger,
      policyStore: store,
      tick: async (signal, policy) => {
        await watcher.tick(signal, policy);
        return false;
      },
    });

    poller.start();
    await firstPageReached.promise;

    // Tick 1 is mid-scan on policy v1. Reload policy to v2 while tick 1 is still in flight.
    expect(poller.stats.inFlightPolicyVersion).toBe(1);
    const reloadResult = store.reload({
      env: {
        ...baseEnv,
        STELLAR_EVENT_PAGE_SIZE: "50",
        STELLAR_POLL_INTERVAL_MS: "250",
        STELLAR_FRESH_WITHIN_LEDGERS: "10",
      },
    });
    expect(reloadResult.snapshot.version).toBe(2);
    expect(poller.stats.inFlightPolicyVersion).toBe(1);

    const originalQuery = db.query.bind(db);
    db.query = async (text: string, params?: readonly unknown[]) => {
      const boundParams = params ?? [];
      if (text.includes("INSERT INTO indexer_cursor")) {
        db.cursorRow = {
          chain_key: boundParams[0],
          family: boundParams[1],
          contract: boundParams[2],
          last_processed: String(boundParams[3]),
          last_processed_at: boundParams[4],
          last_processed_hash: boundParams[5],
        };
      }
      return originalQuery(text, boundParams);
    };

    // Release tick 1: its second page inside the same tick MUST still use v1's pageSize = 2.
    releaseFirstTick.resolve();

    await new Promise<void>((resolve) => {
      const check = () => {
        if (poller.stats.ticks >= 2) {
          resolve();
          return;
        }
        setTimeout(check, 15);
      };
      check();
    });
    await poller.stop();

    // Requests 0 and 1 belonged to tick 1 (policy v1 -> limit 2); request 2 belonged to tick 2 (policy v2 -> limit 50).
    expect(backingRpc.requests.length).toBeGreaterThanOrEqual(3);
    expect(backingRpc.requests[0]?.limit).toBe(2);
    expect(backingRpc.requests[1]?.limit).toBe(2);
    expect(backingRpc.requests[2]?.limit).toBe(50);
    expect(poller.stats.lastCompletedPolicyVersion).toBe(2);
    expect(watcher.progress?.policyVersion).toBe(2);

    // Readiness freshness threshold reflects reloaded STELLAR_FRESH_WITHIN_LEDGERS (10 vs 5).
    expect(watcher.readiness().state).toBe("ready");
  });
});
