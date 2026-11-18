import { describe, expect, it } from "vitest";

import { DbTelemetryCollector, classifySqlWorkload } from "../../src/db/telemetry.js";

describe("database pool & query latency telemetry (#110)", () => {
  it("classifies SQL statements into workloads without inspecting parameters", () => {
    expect(classifySqlWorkload("SELECT 1")).toBe("health");
    expect(classifySqlWorkload("BEGIN")).toBe("transaction");
    expect(classifySqlWorkload("SELECT * FROM indexer_cursor")).toBe("indexer");
    expect(classifySqlWorkload("SELECT * FROM outbound_transfer WHERE id = $1")).toBe("transfers");
    expect(classifySqlWorkload("SELECT * FROM pending_claim")).toBe("claims");
    expect(classifySqlWorkload("SELECT * FROM rail_attestation")).toBe("rails");
    expect(classifySqlWorkload("DELETE FROM rail_attestation WHERE status = 'delivered'")).toBe(
      "maintenance",
    );
    expect(classifySqlWorkload("SELECT * FROM route_health")).toBe("routes");
    expect(classifySqlWorkload("SELECT name FROM pgmigrations")).toBe("diagnostics");
  });

  it("keeps bounded latency samples per workload and computes percentiles", () => {
    const collector = new DbTelemetryCollector(4);
    for (let i = 1; i <= 10; i += 1) {
      collector.record("transfers", i * 10, i !== 9, 1_700_000_000_000 + i);
    }

    const snap = collector.snapshot({
      totalCount: 5,
      idleCount: 2,
      waitingCount: 0,
      maxConnections: 10,
    });

    expect(snap.pool).toEqual({
      maxConnections: 10,
      totalConnections: 5,
      idleConnections: 2,
      activeConnections: 3,
      waitingRequests: 0,
      utilizationRatio: 0.3,
      saturated: false,
    });

    const stats = snap.workloads.transfers;
    expect(stats).toBeDefined();
    expect(stats?.count).toBe(10);
    expect(stats?.errorCount).toBe(1);
    expect(stats?.sampleCount).toBe(4); // bounded to capacity 4
    // Last 4 samples are 70, 80, 90, 100
    expect(stats?.minMs).toBe(70);
    expect(stats?.maxMs).toBe(100);
    expect(stats?.avgMs).toBe(85);
    expect(stats?.p95Ms).toBe(100);
  });

  it("marks pool as saturated when waiting requests > 0 or active >= max", () => {
    const collector = new DbTelemetryCollector();
    expect(
      collector.poolSnapshot({
        totalCount: 10,
        idleCount: 0,
        waitingCount: 3,
        maxConnections: 10,
      }),
    ).toMatchObject({
      activeConnections: 10,
      waitingRequests: 3,
      utilizationRatio: 1,
      saturated: true,
    });
  });
});
