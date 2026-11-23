import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/config.js";
import { startKeeperQueue } from "../../src/keeper/queue.js";
import { processTtlBump } from "../../src/keeper/jobs/ttl.js";
import type { KeeperJobResult } from "../../src/keeper/types.js";
import { WorkerPolicyStore } from "../../src/runtime/worker-policy.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger, RecordingDb } from "../stellar-fakes.js";

type Processor = (job: { name: string; id: string; data: object }) => Promise<KeeperJobResult>;
const harness = vi.hoisted(() => ({
  processors: [] as Processor[],
  concurrency: [] as number[],
  schedules: vi.fn(),
  workerClose: vi.fn(() => Promise.resolve()),
  queueClose: vi.fn(() => Promise.resolve()),
  disconnect: vi.fn(),
}));
vi.mock("bullmq", () => ({
  Queue: class {
    upsertJobScheduler = harness.schedules;
    removeJobScheduler = vi.fn(() => Promise.resolve());
    close = harness.queueClose;
  },
  Worker: class {
    constructor(_name: string, processor: Processor, options: { concurrency: number }) {
      harness.processors.push(processor);
      this.concurrency = options.concurrency;
    }
    set concurrency(value: number) {
      harness.concurrency.push(value);
    }
    on = vi.fn();
    close = harness.workerClose;
  },
}));
vi.mock("ioredis", () => ({
  Redis: class {
    connect = vi.fn(() => Promise.resolve());
    disconnect = harness.disconnect;
  },
}));
vi.mock("../../src/keeper/jobs/ttl.js", () => ({ processTtlBump: vi.fn() }));

describe("keeper queue worker policy", () => {
  it("updates BullMQ concurrency while started jobs retain their version through awaits", async () => {
    const first = loadConfig({ env: completeEnv({ KEEPER_CONCURRENCY: "1" }) });
    const second = loadConfig({ env: completeEnv({ KEEPER_CONCURRENCY: "3" }) });
    const store = new WorkerPolicyStore(first);
    let entered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const observations: number[][] = [];
    vi.mocked(processTtlBump).mockImplementation(async (ctx) => {
      const before = [ctx.config.keeper.concurrency, ctx.workerPolicy!.snapshot().version];
      if (observations.length === 0) {
        observations.push(before);
        entered();
        await gate;
      } else observations.push(before);
      observations.push([ctx.config.keeper.concurrency, ctx.workerPolicy!.snapshot().version]);
      return {
        bumpedTokens: 0,
        bumpedClaims: 0,
        bumpedTransfers: 0,
        dryRun: true,
        detail: "fixture",
        operations: [],
        targetKeys: [],
        estimatedFee: "0",
        unsigned: true,
      };
    });
    const { logger } = capturingLogger();
    const handle = await startKeeperQueue(
      { config: first, workerPolicy: store, db: new RecordingDb(), logger },
      "redis://127.0.0.1:6379",
    );
    const processor = harness.processors[0]!;
    try {
      const pending = processor({ name: "ttl-bump", id: "first", data: {} });
      await started;
      store.replace(second);
      expect(harness.concurrency.at(-1)).toBe(3);
      resume();
      await pending;
      await processor({ name: "ttl-bump", id: "second", data: {} });
      expect(observations).toEqual([
        [1, 1],
        [1, 1],
        [3, 2],
        [3, 2],
      ]);
      expect(harness.schedules).toHaveBeenCalledTimes(2);
      expect(harness.schedules.mock.calls[0]?.[1]).toEqual({ every: first.keeper.pollIntervalMs });
    } finally {
      resume();
      await handle.close();
    }
    const count = harness.concurrency.length;
    store.replace(first);
    expect(harness.concurrency).toHaveLength(count);
    expect(harness.workerClose).toHaveBeenCalledOnce();
    expect(harness.queueClose).toHaveBeenCalledOnce();
    expect(harness.disconnect).toHaveBeenCalledOnce();
  });
});
