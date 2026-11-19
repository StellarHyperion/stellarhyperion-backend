import { describe, expect, it } from "vitest";
import {
  evaluateHeartbeatFreshness,
  recordWorkerHeartbeat,
  sanitizeHeartbeatMetadata,
  type WorkerHeartbeatRecord,
} from "../../src/runtime/readiness.js";
import { PolledWorker } from "../../src/chains/runner.js";
import { RecordingDb, capturingLogger } from "../stellar-fakes.js";

const now = new Date("2026-01-01T00:00:00Z");
const record: WorkerHeartbeatRecord = {
  workerName: "stellar-testnet",
  workerKind: "chain",
  chainKey: "stellar-testnet",
  state: "ready",
  detail: "current",
  lastHeartbeatAt: now,
  lastCompletedAt: now,
  lastCursorBlock: "123",
  consecutiveFailures: 0,
  lastError: null,
  metadata: {},
};

describe("durable worker freshness", () => {
  it.each([
    new Date(Number.NaN),
    new Date(now.getTime() + 60_000),
    new Date(now.getTime() - 120_001),
  ])("degrades untrustworthy timestamps %s", (at) => {
    expect(evaluateHeartbeatFreshness({ ...record, lastHeartbeatAt: at }, now).report.state).toBe(
      "degraded",
    );
  });

  it("bounds metadata and removes nested credential fields and URL/auth values", () => {
    const metadata = sanitizeHeartbeatMetadata({
      password: "private",
      label: "Bearer private",
      nested: {
        apiKey: "private",
        endpoint: "https://private@rpc.example/path",
        list: Array.from({ length: 50 }, () => "x".repeat(400)),
      },
    });
    expect(JSON.stringify(metadata)).not.toContain("private");
    expect((metadata.nested as { list: string[] }).list).toHaveLength(16);
    expect((metadata.nested as { list: string[] }).list[0]).toHaveLength(256);
  });

  it("rejects unbounded or secret-bearing worker identities before persistence", async () => {
    const db = new RecordingDb();
    for (const workerName of ["x".repeat(129), "https://private@host", "worker\npassword"]) {
      await expect(
        recordWorkerHeartbeat(db, {
          workerName,
          workerKind: "chain",
          chainKey: null,
          state: "ready",
          detail: "current",
          completed: true,
          consecutiveFailures: 0,
          lastError: null,
        }),
      ).rejects.toThrow(RangeError);
    }
    expect(db.queries).toHaveLength(0);
  });

  it("persists the just-finished cursor and actual failure before poller statistics update", async () => {
    const db = new RecordingDb();
    const { logger } = capturingLogger();
    let attempts = 0;
    const pass = {
      name: "stellar-testnet",
      progress: { ledger: 123 },
      readiness: () => ({ name: "stellar-testnet", state: "ready" as const, detail: "current" }),
      tick: () => {
        attempts++;
        if (attempts === 1) return Promise.reject(new Error("Bearer private"));
        return Promise.resolve(false);
      },
    };
    const worker = new PolledWorker(pass, 10, logger, {
      db,
      workerKind: "chain",
      chainKey: "stellar-testnet",
    });
    worker.start();
    try {
      await expect
        .poll(
          () =>
            db.queries.filter((query) =>
              query.text.includes("INSERT INTO indexer_worker_heartbeat"),
            ).length,
        )
        .toBeGreaterThanOrEqual(2);
    } finally {
      await worker.stop();
    }
    const writes = db.queries.filter((query) =>
      query.text.includes("INSERT INTO indexer_worker_heartbeat"),
    );
    expect(writes[0]?.params[6]).toBeNull();
    expect(writes[0]?.params[7]).toBe("123");
    expect(writes[0]?.params[8]).toBe(1);
    expect(writes[0]?.params[9]).toBe("Bearer [redacted]");
    expect(writes[1]?.params[6]).toBeInstanceOf(Date);
    expect(writes[1]?.params[8]).toBe(0);
    expect(writes[1]?.params[9]).toBeNull();
  });
});
