import { describe, expect, it } from "vitest";
import { PolledWorker } from "../../src/chains/runner.js";
import { loadConfig } from "../../src/config/config.js";
import type { Database } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import { readWorkerRuns } from "../../src/runtime/worker-runs.js";
import {
  readWorkerHeartbeats,
  recordWorkerHeartbeat,
  type WorkerHeartbeatInput,
} from "../../src/runtime/readiness.js";
import { completeEnv } from "../helpers.js";
import { RecordingDb, capturingLogger } from "../stellar-fakes.js";

describe("worker run correlation across catch-up jobs (#114)", () => {
  const config = loadConfig({
    env: completeEnv({ RAILS_ENABLED: "false", KEEPER_ENABLED: "false" }),
  });
  const { logger } = capturingLogger();

  it("records an in-progress run before a blocked tick and treats shutdown during it as partial", async () => {
    const db = new RecordingDb();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const worker = new PolledWorker(
      {
        name: "stellar-testnet",
        readiness: () => ({ name: "stellar-testnet", state: "ready", detail: "current" }),
        tick: async () => {
          entered = true;
          await gate;
          return false;
        },
      },
      10,
      logger,
      { db, workerKind: "chain", chainKey: "stellar-testnet" },
    );
    worker.start();
    try {
      await expect.poll(() => entered).toBe(true);
      expect(await readWorkerRuns(db)).toMatchObject([
        { runId: worker.runId, state: "running", partial: true, successfulTicks: "0" },
      ]);
      const stopping = worker.stop();
      release();
      await stopping;
      expect(await readWorkerRuns(db)).toMatchObject([
        { runId: worker.runId, state: "stopped", partial: true },
      ]);
    } finally {
      release();
      await worker.stop();
    }
  });

  it("never uses an unsafe legacy metadata run ID as a public fallback", async () => {
    const db = new RecordingDb();
    await recordWorkerHeartbeat(db, {
      workerName: "stellar-testnet",
      workerKind: "chain",
      chainKey: "stellar-testnet",
      state: "ready",
      detail: "legacy",
      completed: true,
      consecutiveFailures: 0,
      lastError: null,
    });
    const row = db.heartbeatRows[0];
    if (row === undefined) throw new Error("missing heartbeat fixture");
    row.metadata = { runId: "https://user:private@rpc.invalid/key", completed: true };
    const app = buildServer({
      config,
      logger,
      db: db as unknown as Database,
      readiness: [],
      redis: { ping: () => Promise.resolve("PONG") },
    });
    try {
      const response = await app.inject({ method: "GET", url: "/ready" });
      expect(response.statusCode).toBe(200);
      expect(response.json().runCorrelation).toEqual([
        { workerName: "stellar-testnet", runId: null, partial: true },
      ]);
      expect(response.body).not.toContain("private");
      expect(response.body).not.toContain("rpc.invalid");
    } finally {
      await app.close();
    }
  });

  it("generates a UUID runId per PolledWorker instance that persists across ticks and changes on restart", async () => {
    const db = new RecordingDb();
    let tickCount = 0;
    const pass = {
      name: "stellar-testnet",
      progress: { ledger: 100 },
      readiness: () => ({ name: "stellar-testnet", state: "ready" as const, detail: "current" }),
      tick: () => {
        tickCount++;
        return Promise.resolve(false);
      },
    };

    const worker1 = new PolledWorker(pass, 10, logger, {
      db,
      workerKind: "chain",
      chainKey: "stellar-testnet",
    });

    const runId1 = worker1.runId;
    expect(runId1).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    // Simulate tick through poller
    worker1.start();
    await expect.poll(() => tickCount).toBeGreaterThanOrEqual(2);
    await worker1.stop();

    // Verify all heartbeats from worker1 used runId1
    const heartbeatWrites = db.queries.filter((q) =>
      q.text.includes("INSERT INTO indexer_worker_heartbeat"),
    );
    expect(heartbeatWrites.length).toBeGreaterThanOrEqual(2);
    for (const write of heartbeatWrites) {
      const meta = JSON.parse(write.params[10] as string) as Record<string, unknown>;
      expect(meta.runId).toBe(runId1);
    }

    // Simulate process restart: create a new PolledWorker instance
    const worker2 = new PolledWorker(pass, 10, logger, {
      db,
      workerKind: "chain",
      chainKey: "stellar-testnet",
    });
    const runId2 = worker2.runId;
    expect(runId2).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(runId2).not.toBe(runId1);
  });

  it("persists runId and completed status in metadata column and exposes them in readWorkerHeartbeats", async () => {
    const db = new RecordingDb();
    const testRunId = "a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d";

    const input: WorkerHeartbeatInput = {
      workerName: "sepolia",
      workerKind: "chain",
      chainKey: "sepolia",
      state: "ready",
      detail: "caught up to block 500",
      completed: true,
      consecutiveFailures: 0,
      lastError: null,
      runId: testRunId,
      metadata: { ticks: 5, running: true },
    };

    await recordWorkerHeartbeat(db, input);

    const [record] = await readWorkerHeartbeats(db);
    expect(record).toBeDefined();
    expect(record?.workerName).toBe("sepolia");
    expect(record?.runId).toBe(testRunId);
    expect(record?.metadata.runId).toBe(testRunId);
    expect(record?.metadata.completed).toBe(true);
    expect(record?.metadata.ticks).toBe(5);
  });

  it("rejects unsafe or credential-bearing run identifiers", async () => {
    const db = new RecordingDb();
    const unsafeIdentities = [
      "https://user:password@rpc.example.com",
      "run; DROP TABLE users; --",
      "x".repeat(129),
      "run\nid",
      "Bearer secret-token",
    ];

    for (const invalidRunId of unsafeIdentities) {
      await expect(
        recordWorkerHeartbeat(db, {
          workerName: "stellar-testnet",
          workerKind: "chain",
          chainKey: "stellar-testnet",
          state: "ready",
          detail: "testing",
          completed: true,
          consecutiveFailures: 0,
          lastError: null,
          runId: invalidRunId,
        }),
      ).rejects.toThrow(RangeError);
    }
  });

  it("exposes runId and completedTicks in GET /v1/metrics per worker", async () => {
    const db = new RecordingDb();
    const runIdStellar = "11111111-2222-4333-8444-555555555555";
    const runIdSepolia = "66666666-7777-4888-9999-000000000000";

    await recordWorkerHeartbeat(db, {
      workerName: "stellar-testnet",
      workerKind: "chain",
      chainKey: "stellar-testnet",
      state: "ready",
      detail: "ledger 100",
      completed: true,
      consecutiveFailures: 0,
      lastError: null,
      runId: runIdStellar,
      metadata: { ticks: 12 },
    });

    await recordWorkerHeartbeat(db, {
      workerName: "sepolia",
      workerKind: "chain",
      chainKey: "sepolia",
      state: "ready",
      detail: "block 200",
      completed: false,
      consecutiveFailures: 1,
      lastError: "rpc temporary timeout",
      runId: runIdSepolia,
      metadata: { ticks: 3 },
    });

    const app = buildServer({
      config,
      logger,
      db: db as unknown as Database,
      readiness: [],
      redis: { ping: () => Promise.resolve("PONG") },
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/metrics",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.workers).toHaveLength(2);

    const stellar = body.workers.find((w: { name: string }) => w.name === "stellar-testnet");
    expect(stellar).toBeDefined();
    expect(stellar.runId).toBe(runIdStellar);
    expect(stellar.completedTicks).toBe(12);

    const sepolia = body.workers.find((w: { name: string }) => w.name === "sepolia");
    expect(sepolia).toBeDefined();
    expect(sepolia.runId).toBe(runIdSepolia);
    expect(sepolia.completedTicks).toBe(3);

    await app.close();
  });

  it("distinguishes completed vs partial runs in /ready runCorrelation", async () => {
    const db = new RecordingDb();
    const completedRunId = "c0c0c0c0-1111-4222-8333-444444444444";
    const partialRunId = "a0a0a0a0-5555-4666-8777-888888888888";

    // Completed worker: completed = true
    await recordWorkerHeartbeat(db, {
      workerName: "stellar-testnet",
      workerKind: "chain",
      chainKey: "stellar-testnet",
      state: "ready",
      detail: "completed catch-up",
      completed: true,
      consecutiveFailures: 0,
      lastError: null,
      runId: completedRunId,
      metadata: { ticks: 10, caughtUp: true },
    });

    // Partial worker: completed = false (e.g. tick threw or stopped mid-job)
    await recordWorkerHeartbeat(db, {
      workerName: "sepolia",
      workerKind: "chain",
      chainKey: "sepolia",
      state: "degraded",
      detail: "poll failed: rpc error",
      completed: false,
      consecutiveFailures: 1,
      lastError: "rpc error",
      runId: partialRunId,
      metadata: { ticks: 2 },
    });

    const app = buildServer({
      config,
      logger,
      db: db as unknown as Database,
      readiness: [],
      redis: { ping: () => Promise.resolve("PONG") },
    });

    const res = await app.inject({
      method: "GET",
      url: "/ready",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.runCorrelation).toBeDefined();
    expect(Array.isArray(body.runCorrelation)).toBe(true);

    const stellarCorrelation = body.runCorrelation.find(
      (c: { workerName: string }) => c.workerName === "stellar-testnet",
    );
    expect(stellarCorrelation).toEqual({
      workerName: "stellar-testnet",
      runId: completedRunId,
      partial: false,
    });

    const sepoliaCorrelation = body.runCorrelation.find(
      (c: { workerName: string }) => c.workerName === "sepolia",
    );
    expect(sepoliaCorrelation).toEqual({
      workerName: "sepolia",
      runId: partialRunId,
      partial: true,
    });

    await app.close();
  });
});
