import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/config.js";
import { completeEnv, readFixture } from "../helpers.js";
import {
  WorkerPolicyStore,
  loadWorkerPolicyConfig,
  reloadWorkerPolicy,
  deploymentIdentity,
  workerPolicy,
} from "../../src/runtime/worker-policy.js";
import { Poller } from "../../src/runtime/poller.js";
import { RailPass } from "../../src/rails/pass.js";
import type { Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";
import { capturingLogger } from "../stellar-fakes.js";

describe("validated worker policy reload", () => {
  it("publishes a new version atomically and keeps secrets out of the policy", () => {
    const first = loadConfig({ env: completeEnv({ RAIL_POLL_INTERVAL_MS: "1000" }) });
    const second = loadConfig({ env: completeEnv({ RAIL_POLL_INTERVAL_MS: "2000" }) });
    const store = new WorkerPolicyStore(first);
    expect(store.snapshot().version).toBe(1);
    expect(store.replace(second)).toMatchObject({ version: 2, rails: { pollIntervalMs: 2000 } });
    expect(JSON.stringify(store.snapshot())).not.toContain(first.databaseUrl);
    expect(workerPolicy(second).keeper).toEqual(workerPolicy(first).keeper);
  });

  it("rejects deployment changes without changing the active policy", () => {
    const first = loadConfig({ env: completeEnv() });
    const changed = loadConfig({
      env: completeEnv({ HYPERION_DEPLOYMENTS_FILE: "./test/fixtures/deployments-testnet.json" }),
      cwd: "/tmp/hyperion",
      readFile: () => readFixture("deployments-testnet.json"),
    });
    const store = new WorkerPolicyStore(first);
    expect(deploymentIdentity(changed)).not.toBe(deploymentIdentity(first));
    expect(() => store.replace(changed)).toThrow(/deployment identity/);
    expect(store.snapshot().version).toBe(1);
  });

  it("rejects invalid limits and provider, credential or keeper schedule changes atomically", () => {
    const first = loadConfig({ env: completeEnv() });
    const store = new WorkerPolicyStore(first);
    const notify = vi.fn();
    store.subscribe(notify);
    notify.mockClear();
    const changes = [
      { ...first, rails: { ...first.rails, batchSize: 0 } },
      { ...first, rails: { ...first.rails, irisUrl: "https://changed.invalid" } },
      {
        ...first,
        destinationVerification: {
          evmRpcUrls: {
            ...first.destinationVerification.evmRpcUrls,
            sepolia: ["https://changed.invalid"],
          },
        },
      },
      { ...first, databaseUrl: "postgres://changed.invalid" },
      { ...first, keeper: { ...first.keeper, pollIntervalMs: 90000 } },
    ];
    for (const candidate of changes) expect(() => store.replace(candidate)).toThrow();
    expect(store.snapshot().version).toBe(1);
    expect(store.configuration()).toMatchObject(first);
    expect(notify).not.toHaveBeenCalled();
    expect(deploymentIdentity(first)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps real rail SQL selection and asynchronous continuations on their starting version", async () => {
    const first = loadConfig({ env: completeEnv({ RAIL_MAX_CHECK_FAILURES: "3" }) });
    const second = loadConfig({ env: completeEnv({ RAIL_MAX_CHECK_FAILURES: "7" }) });
    const store = new WorkerPolicyStore(first);
    let entered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const limits: unknown[] = [];
    const completedVersions: number[] = [];
    const db: Transactional = {
      query: async (sql: string, params: readonly unknown[] = []): Promise<QueryResultRows> => {
        if (sql.includes("COALESCE(a.check_failures")) {
          limits.push(params[1]);
          if (limits.length === 1) {
            entered();
            await gate;
          }
        }
        if (sql.includes("count(*)")) completedVersions.push(store.snapshot().version);
        return { rows: [], rowCount: 0 };
      },
      transaction: <T>(work: (tx: Queryable) => Promise<T>) => work(db),
    };
    const { logger } = capturingLogger();
    const pass = new RailPass({
      route: 0,
      client: { rail: "cctp", look: () => Promise.resolve({ kind: "missing" }) },
      db,
      logger,
      ...first.rails,
      workerPolicy: store,
    });
    const pending = pass.tick(new AbortController().signal);
    await started;
    store.replace(second);
    resume();
    await pending;
    await pass.tick(new AbortController().signal);
    expect(limits).toEqual([3, 7]);
    expect(completedVersions).toEqual([1, 2]);
  });

  it("updates future poll intervals without interrupting an in-flight tick", async () => {
    vi.useFakeTimers();
    const first = loadConfig({ env: completeEnv({ RAIL_POLL_INTERVAL_MS: "5000" }) });
    const second = loadConfig({ env: completeEnv({ RAIL_POLL_INTERVAL_MS: "1000" }) });
    const store = new WorkerPolicyStore(first);
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let ticks = 0;
    const { logger } = capturingLogger();
    const poller = new Poller({
      name: "policy",
      intervalMs: 5000,
      logger,
      tick: async () => {
        ticks++;
        if (ticks === 1) await gate;
        return false;
      },
    });
    const unsubscribe = store.subscribe((policy) => {
      poller.setIntervalMs(policy.rails.pollIntervalMs);
    });
    try {
      poller.start();
      store.replace(second);
      await vi.advanceTimersByTimeAsync(0);
      expect(ticks).toBe(1);
      resume();
      await vi.advanceTimersByTimeAsync(999);
      expect(ticks).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(ticks).toBe(2);
    } finally {
      resume();
      unsubscribe();
      await poller.stop();
      vi.useRealTimers();
    }
  });

  it("loads an operator policy file and rejects malformed, oversized or restart-only updates safely", () => {
    const directory = mkdtempSync(join(tmpdir(), "hyperion-worker-policy-"));
    const file = join(directory, "policy.json");
    const env = completeEnv();
    const store = new WorkerPolicyStore(loadConfig({ env }));
    const logger = { info: vi.fn(), warn: vi.fn() };
    try {
      writeFileSync(file, JSON.stringify({ RAIL_BATCH_SIZE: 42, KEEPER_CONCURRENCY: 3 }));
      reloadWorkerPolicy(store, () => loadWorkerPolicyConfig(file, env), logger);
      expect(store.snapshot()).toMatchObject({
        version: 2,
        rails: { batchSize: 42 },
        keeper: { concurrency: 3 },
      });
      for (const contents of [
        "{",
        " ".repeat(16385),
        JSON.stringify({ DATABASE_URL: "sensitive-value" }),
        JSON.stringify({ RAIL_BATCH_SIZE: 0 }),
      ]) {
        writeFileSync(file, contents);
        reloadWorkerPolicy(store, () => loadWorkerPolicyConfig(file, env), logger);
        expect(store.snapshot().version).toBe(2);
      }
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("sensitive-value");
      expect(logger.warn).toHaveBeenCalledTimes(4);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
