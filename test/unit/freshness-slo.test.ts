import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import type { Queryable } from "../../src/db/pool.js";
import { evaluateFreshnessSlo } from "../../src/runtime/freshness.js";
import { completeEnv } from "../helpers.js";

function mockDb(handlers: Record<string, readonly Record<string, unknown>[]>): Queryable {
  return {
    query(text: string) {
      for (const [key, rows] of Object.entries(handlers)) {
        if (text.includes(key)) {
          return Promise.resolve({ rows, rowCount: rows.length });
        }
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
}

describe("configurable freshness SLO evaluation (#108)", () => {
  it("cannot report met SLOs when enabled sources have no durable evidence", async () => {
    const report = await evaluateFreshnessSlo(mockDb({}), loadConfig({ env: completeEnv() }));
    expect(report.met).toBe(false);
    expect(report.status).toBe("unknown");
    expect(report.sources.every((source) => source.status === "unknown")).toBe(true);
  });

  it("distinguishes intentionally disabled watchers from missing remote API-only evidence", async () => {
    const config = loadConfig({
      env: completeEnv({
        INDEXER_ENABLED: "false",
        KEEPER_ENABLED: "false",
        RAILS_ENABLED: "false",
        DEPLOYMENT_MODE: "custom",
      }),
    });
    const disabled = await evaluateFreshnessSlo(mockDb({}), config);
    expect(disabled.sources.every((source) => source.status === "disabled")).toBe(true);
    const remote = await evaluateFreshnessSlo(mockDb({}), {
      ...config,
      deploymentMode: "api-only",
    });
    expect(remote.met).toBe(false);
    expect(
      remote.sources.every(
        (source) => source.monitoring === "remote" && source.status === "unknown",
      ),
    ).toBe(true);
  });
  it("evaluates source scan lag and destination proof backlog against per-lane targets", async () => {
    const now = new Date("2026-11-19T00:00:00.000Z");
    const config = loadConfig({
      env: completeEnv({
        INDEXER_ENABLED: "false", // works even when API runs without in-process indexer
        RAILS_ENABLED: "false",
        KEEPER_ENABLED: "false",
        FRESHNESS_MAX_SCAN_LAG_MS: "60000",
        FRESHNESS_MAX_PROOF_BACKLOG_COUNT: "5",
        FRESHNESS_MAX_PROOF_BACKLOG_AGE_MS: "300000",
        FRESHNESS_LANE_TARGETS: JSON.stringify({
          "sepolia->stellar-testnet": {
            maxProofBacklogCount: 2,
            maxProofBacklogAgeMs: 120_000,
          },
        }),
      }),
    });

    const db = mockDb({
      indexer_cursor: [
        {
          chain_key: "stellar-testnet",
          cursor_block: "500123",
          updated_at: new Date("2026-11-18T23:59:30.000Z"), // 30s lag -> ok
        },
        {
          chain_key: "sepolia",
          cursor_block: "9000100",
          updated_at: new Date("2026-11-18T23:57:00.000Z"), // 180s lag -> breached
        },
      ],
      stellar_history_gap: [{ chain_key: "stellar-testnet", status: "open", count: 1 }],
      outbound_transfer: [
        {
          origin_chain: "sepolia",
          destination_chain: "stellar-testnet",
          pending_count: 3, // > 2 per-lane override -> breached
          oldest_pending_at: new Date("2026-11-18T23:59:00.000Z"), // 60s <= 120s
        },
        {
          origin_chain: "stellar-testnet",
          destination_chain: "sepolia",
          pending_count: 1, // <= 5 default -> ok
          oldest_pending_at: new Date("2026-11-18T23:59:00.000Z"),
        },
      ],
    });

    const report = await evaluateFreshnessSlo(db, config, now);

    expect(report.status).toBe("breached");
    expect(report.met).toBe(false);
    expect(report.breaches.some((b) => b.includes("source:sepolia"))).toBe(true);
    expect(report.breaches.some((b) => b.includes("source:stellar-testnet"))).toBe(true);
    expect(report.breaches.some((b) => b.includes("lane:sepolia->stellar-testnet"))).toBe(true);

    const stellarSource = report.sources.find((s) => s.chain === "stellar-testnet");
    expect(stellarSource?.openHistoryGaps).toBe(1);
    expect(stellarSource?.status).toBe("breached");

    const okLane = report.lanes.find((l) => l.lane === "stellar-testnet->sepolia");
    expect(okLane?.status).toBe("ok");
  });

  it("reports status ok when all sources and lanes are within targets", async () => {
    const now = new Date("2026-11-19T00:00:00.000Z");
    const config = loadConfig({ env: completeEnv() });
    const db = mockDb({
      indexer_cursor: [
        {
          chain_key: "stellar-testnet",
          cursor_block: "500123",
          updated_at: new Date("2026-11-18T23:59:50.000Z"),
        },
        {
          chain_key: "sepolia",
          cursor_block: "9000100",
          updated_at: new Date("2026-11-18T23:59:45.000Z"),
        },
      ],
    });

    const report = await evaluateFreshnessSlo(db, config, now);
    expect(report.status).toBe("ok");
    expect(report.met).toBe(true);
    expect(report.breaches).toEqual([]);
  });
});
