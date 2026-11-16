import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import { Database, DatabaseSaturationError } from "../../src/db/pool.js";
import type { PoolBackendLike, PoolClientLike } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

interface DeferredGate {
  readonly promise: Promise<void>;
  release(): void;
}

function createGate(): DeferredGate {
  let resolveFn: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  return {
    promise,
    release: () => {
      resolveFn();
    },
  };
}

class ControllablePoolBackend implements PoolBackendLike {
  totalCount = 0;
  idleCount = 0;
  waitingCount = 0;
  ended = false;
  connectError: Error | null = null;

  private readonly blockPattern: string;
  private gate: DeferredGate | null = null;
  private startedBlockCount = 0;
  private startedListeners: (() => void)[] = [];

  constructor(blockPattern = "SLOW_HOLD") {
    this.blockPattern = blockPattern;
  }

  armGate(): DeferredGate {
    const g = createGate();
    this.gate = g;
    return g;
  }

  async waitForBlockedCount(expected: number): Promise<void> {
    while (this.startedBlockCount < expected) {
      await new Promise<void>((resolve) => {
        this.startedListeners.push(resolve);
      });
    }
  }

  connect(): Promise<PoolClientLike> {
    if (this.connectError !== null) {
      return Promise.reject(this.connectError);
    }
    this.totalCount += 1;
    const client: PoolClientLike = {
      query: async (sql: string) => {
        if (sql.includes(this.blockPattern) && this.gate !== null) {
          this.startedBlockCount += 1;
          const listeners = this.startedListeners.splice(0);
          for (const notify of listeners) notify();
          await this.gate.promise;
        }
        if (sql.includes("FROM rail_attestation")) {
          return { rows: [{ status: "delivered", count: 2 }], rowCount: 1 };
        }
        if (sql.includes("count(*)::int AS count")) {
          return { rows: [{ count: 5 }], rowCount: 1 };
        }
        if (sql.includes("FROM pending_claim")) {
          return { rows: [{ total: 2, settled: 1, unsettled: 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => {
        this.totalCount = Math.max(0, this.totalCount - 1);
      },
    };
    return Promise.resolve(client);
  }

  end(): Promise<void> {
    this.ended = true;
    return Promise.resolve();
  }
}

describe("database pool saturation backpressure (#58)", () => {
  const config = loadConfig({ env: completeEnv({ KEEPER_ENABLED: "false" }) });
  const { logger } = capturingLogger();

  it("returns explicit retryable 503 API errors within deadline on acquire timeout and queue overflow", async () => {
    const backend = new ControllablePoolBackend("outbound_transfer");
    const gate = backend.armGate();
    const db = Database.fromBackend(backend, {
      maxConnections: 2,
      reservedProbeConnections: 1,
      maxWorkerConcurrency: 1,
      maxWaitingRequests: 1,
      acquireTimeoutMs: 60,
      retryAfterSeconds: 2,
    });

    const app = buildServer({
      config,
      logger,
      db,
      readiness: [],
    });

    try {
      // Request 1 occupies the single non-probe API slot (`maxApiConnections = 1`).
      const heldReq = app.inject({ method: "GET", url: "/v1/transfers" });
      await backend.waitForBlockedCount(1);

      // Request 2 enters the 1-slot wait queue and must fail within the ~60ms deadline.
      const startedAt = Date.now();
      const queuedReq = app.inject({ method: "GET", url: "/v1/transfers" });

      // Yield a microtask so Request 2 occupies the single waiting slot (`maxWaitingRequests = 1`).
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(db.poolMetrics().queuedByLane.api).toBe(1);

      // Request 3 overflows `maxWaitingRequests = 1` and fails immediately with retryable 503.
      const overflowRes = await app.inject({ method: "GET", url: "/v1/transfers" });
      expect(overflowRes.statusCode).toBe(503);
      expect(overflowRes.headers["retry-after"]).toBe("2");
      expect(overflowRes.json()).toMatchObject({
        error: "service_unavailable",
        code: "database_pool_saturated",
        retryable: true,
        retryAfterSeconds: 2,
      });

      // Request 2 times out cleanly on deadline with retryable 503.
      const timedOutRes = await queuedReq;
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeLessThan(500);
      expect(timedOutRes.statusCode).toBe(503);
      expect(timedOutRes.headers["retry-after"]).toBe("2");
      expect(timedOutRes.json()).toMatchObject({
        error: "service_unavailable",
        code: "database_pool_saturated",
        retryable: true,
        retryAfterSeconds: 2,
      });

      const metricsAfter = db.poolMetrics();
      expect(metricsAfter.rejectedCount).toBe(2);
      expect(metricsAfter.timedOutCount).toBe(1);

      gate.release();
      const firstRes = await heldReq;
      expect(firstRes.statusCode).toBe(200);
    } finally {
      gate.release();
      await app.close();
      await db.close();
    }
  });

  it("prevents background workers from starving /health and /ready probes", async () => {
    const backend = new ControllablePoolBackend("WORKER_HOLD");
    const gate = backend.armGate();
    const db = Database.fromBackend(backend, {
      maxConnections: 4,
      reservedProbeConnections: 1,
      maxWorkerConcurrency: 2,
      maxWaitingWorkers: 4,
      workerAcquireTimeoutMs: 5_000,
    });

    const app = buildServer({
      config,
      logger,
      db,
      readiness: [],
    });

    try {
      const workerDb = db.forWorkers();

      // Launch 5 concurrent slow background worker tasks; 2 occupy worker slots and 3 queue.
      const workerPromises = Array.from({ length: 5 }, () =>
        workerDb.query("SELECT 'WORKER_HOLD'"),
      );
      await backend.waitForBlockedCount(2);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const snap = db.poolMetrics();
      expect(snap.activeByLane.worker).toBe(2);
      expect(snap.queuedByLane.worker).toBe(3);

      // Even while background workers have maxed out their concurrency and queued work:
      // 1. `/health` responds 200 immediately.
      const healthRes = await app.inject({ method: "GET", url: "/health" });
      expect(healthRes.statusCode).toBe(200);
      expect(healthRes.json().status).toBe("ok");

      // 2. `/ready` (`db.ping()` on probe lane) responds 200 immediately without waiting on workers.
      const readyRes = await app.inject({ method: "GET", url: "/ready" });
      expect(readyRes.statusCode).toBe(200);
      expect(readyRes.json().status).toBe("ready");

      // 3. Even if the remaining API slot (`maxApiConnections = 3`, 2 held by workers => 1 left)
      //    is ALSO held by a slow API query, `/ready` STILL succeeds using `reservedProbeConnections`!
      const slowApiPromise = db.query("SELECT 'WORKER_HOLD'");
      await backend.waitForBlockedCount(3);
      expect(db.poolMetrics().activeConnections).toBe(3);

      const readyUnderFullApiLoad = await app.inject({ method: "GET", url: "/ready" });
      expect(readyUnderFullApiLoad.statusCode).toBe(200);
      expect(readyUnderFullApiLoad.json().status).toBe("ready");

      gate.release();
      await Promise.all([...workerPromises, slowApiPromise]);
    } finally {
      gate.release();
      await app.close();
      await db.close();
    }
  });

  it("exposes queued work and active connection limits on /v1/metrics and redacts connect secrets", async () => {
    const backend = new ControllablePoolBackend("WORKER_HOLD");
    const gate = backend.armGate();
    const db = Database.fromBackend(backend, {
      maxConnections: 5,
      reservedProbeConnections: 1,
      maxWorkerConcurrency: 2,
      maxWaitingRequests: 10,
      maxWaitingWorkers: 6,
      acquireTimeoutMs: 400,
    });

    const app = buildServer({
      config,
      logger,
      db,
      readiness: [],
    });

    try {
      const workerDb = db.forWorkers();
      const tasks = [
        workerDb.query("SELECT 'WORKER_HOLD'"),
        workerDb.query("SELECT 'WORKER_HOLD'"),
        workerDb.query("SELECT 'WORKER_HOLD'"),
      ];
      await backend.waitForBlockedCount(2);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const metricsRes = await app.inject({ method: "GET", url: "/v1/metrics" });
      expect(metricsRes.statusCode).toBe(200);
      const body = metricsRes.json();
      expect(body.databasePool).toMatchObject({
        maxConnections: 5,
        reservedProbeConnections: 1,
        maxApiConnections: 4,
        maxWorkerConcurrency: 2,
        queuedRequests: 1,
        queuedByLane: {
          probe: 0,
          api: 0,
          worker: 1,
        },
        maxWaitingRequests: 10,
        maxWaitingWorkers: 6,
        acquireTimeoutMs: 400,
      });
      expect(body.databasePool.activeByLane.worker).toBe(2);

      gate.release();
      await Promise.all(tasks);

      // Verify credential redaction if backend.connect throws a message containing a DB URL
      const secretToken = ["db", "pass", "991122"].join("_");
      backend.connectError = new Error(
        `connect failed for postgresql://hyperion:${secretToken}@db.internal:5432/hyperion`,
      );
      await expect(db.query("SELECT 1")).rejects.toSatisfy((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        return !msg.includes(secretToken) && msg.includes("[REDACTED]@db.internal");
      });
      expect(db.poolMetrics().activeConnections).toBe(0);
    } finally {
      gate.release();
      backend.connectError = null;
      await app.close();
      await db.close();
    }

    // Rejects post-close calls with explicit DatabaseSaturationError
    await expect(db.query("SELECT 1")).rejects.toBeInstanceOf(DatabaseSaturationError);
  });
});
