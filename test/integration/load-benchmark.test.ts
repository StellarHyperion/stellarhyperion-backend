import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database, type Queryable } from "../../src/db/pool.js";
import { writeInbound, writeOutbound } from "../../src/chains/writers.js";
import { pendingForRail } from "../../src/rails/queue.js";

const connection = process.env.TEST_DATABASE_URL;
const suite = connection === undefined ? describe.skip : describe;
suite("deterministic ingestion and proof backlog benchmark", () => {
  let db: Database;
  const chain = "benchmark-298";
  beforeAll(() => {
    db = Database.open(connection!, {
      applicationName: "hyperion-benchmark-298",
      statementTimeoutMs: 10_000,
    });
  });
  afterAll(async () => {
    await db.close();
  });
  it.each([32, 512])(
    "measures %i constrained transfers with real writer replay and query plans",
    async (scale) => {
      await db.transaction(async (tx) => {
        await tx.query("DELETE FROM inbound_delivery WHERE source_chain = $1", [chain]);
        await tx.query(
          "DELETE FROM rail_attestation WHERE transfer_id IN (SELECT id FROM outbound_transfer WHERE origin_chain = $1)",
          [chain],
        );
        await tx.query("DELETE FROM outbound_transfer WHERE origin_chain = $1", [chain]);
      });
      const started = performance.now();
      const observedAt = new Date("2026-01-01T00:00:00Z");
      const position = (index: number) => ({
        chainKey: chain,
        router: "benchmark-router",
        block: BigInt(100 + index),
        txHash: `0x${index.toString(16).padStart(64, "0")}`,
        logIndex: index,
        observedAt,
      });
      const outbound = (index: number) => ({
        route: 0,
        nonce: (1n << 63n) + BigInt(index),
        sender: "benchmark-sender",
        token: "benchmark-token",
        grossAmount: (1n << 64n) + BigInt(index),
        fee: 100n,
        netAmount: (1n << 64n) + BigInt(index) - 100n,
        destinationChain: "sepolia",
        destination: "0x1111111111111111111111111111111111111111",
        railRef: null,
      });
      await db.transaction(async (tx) => {
        for (let index = 0; index < scale; index++) {
          await writeOutbound(tx, position(index), outbound(index));
          if (index % 2 === 0)
            await writeInbound(
              tx,
              { ...position(index), chainKey: "sepolia" },
              {
                route: 0,
                sourceChain: chain,
                sourceNonce: outbound(index).nonce,
                railMessageId: `message-${index}`,
                recipient: outbound(index).destination,
                token: "destination-token",
                amount: outbound(index).netAmount,
                delivered: true,
                claimId: null,
              },
            );
          if (index % 2 === 1)
            await tx.query(
              `INSERT INTO rail_attestation (transfer_id, route, status, check_failures, retry_attempts, next_attempt_at)
               SELECT id, route, $3, 0, 1, $4 FROM outbound_transfer WHERE origin_chain = $1 AND nonce = $2`,
              [
                chain,
                outbound(index).nonce.toString(),
                index % 4 === 1 ? "attested" : "pending",
                observedAt,
              ],
            );
        }
        // The same canonical ingestion must not multiply history.
        await writeOutbound(tx, position(0), outbound(0));
      });
      const ingestionMs = performance.now() - started;
      const stored = await db.query(
        "SELECT count(*)::text AS count, min(nonce)::text AS min_nonce, min(net_amount)::text AS min_amount FROM outbound_transfer WHERE origin_chain = $1",
        [chain],
      );
      expect(stored.rows[0]?.count).toBe(String(scale));
      expect(stored.rows[0]?.min_nonce).toBe((1n << 63n).toString());
      expect(stored.rows[0]?.min_amount).toBe(((1n << 64n) - 100n).toString());
      await db.query("ANALYZE outbound_transfer");
      await db.query("ANALYZE inbound_delivery");
      await db.query("ANALYZE rail_attestation");
      let sql = "",
        params: readonly unknown[] = [];
      const recording: Queryable = {
        query: (text, values = []) => {
          sql = text;
          params = values;
          return db.query(text, values);
        },
      };
      const scanStart = performance.now();
      const selected = await pendingForRail(recording, {
        route: 0,
        limit: 64,
        now: new Date("2026-01-02T00:00:00Z"),
        notCheckedSince: new Date("2026-01-02T00:00:00Z"),
        maxCheckFailures: 5,
      });
      const scanMs = performance.now() - scanStart;
      expect(selected.length).toBeLessThanOrEqual(64);
      expect(selected.some((row) => row.originChain === chain && row.delivered)).toBe(true);
      const explain = await db.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, params);
      const plan = (
        explain.rows[0]?.["QUERY PLAN"] as {
          Plan: Record<string, unknown>;
          "Execution Time": number;
          "Planning Time": number;
        }[]
      )[0]!;
      const planNodes = (node: Record<string, unknown>): Record<string, unknown>[] => [
        {
          type: node["Node Type"],
          relation: node["Relation Name"],
          index: node["Index Name"],
          rows: node["Actual Rows"],
        },
        ...(Array.isArray(node.Plans)
          ? (node.Plans as Record<string, unknown>[]).flatMap(planNodes)
          : []),
      ];
      const report = {
        scale,
        ingestionMs,
        scanMs,
        planningMs: plan["Planning Time"],
        executionMs: plan["Execution Time"],
        totalCost: plan.Plan["Total Cost"],
        sharedHitBlocks: plan.Plan["Shared Hit Blocks"],
        sharedReadBlocks: plan.Plan["Shared Read Blocks"],
        plan: planNodes(plan.Plan),
      };
      console.info("HYPERION_DATABASE_BENCHMARK " + JSON.stringify(report));
      expect(ingestionMs, JSON.stringify(report)).toBeLessThan(20_000);
      expect(scanMs, JSON.stringify(report)).toBeLessThan(5_000);
      expect(plan["Execution Time"], JSON.stringify(report)).toBeLessThan(5_000);
      expect(plan.Plan["Node Type"]).toBe("Limit");
      expect(Number(plan.Plan["Actual Rows"])).toBeLessThanOrEqual(64);
      expect(Number(plan.Plan["Total Cost"])).toBeLessThan(100_000);
      await db.transaction(async (tx) => {
        await tx.query("DELETE FROM inbound_delivery WHERE source_chain = $1", [chain]);
        await tx.query(
          "DELETE FROM rail_attestation WHERE transfer_id IN (SELECT id FROM outbound_transfer WHERE origin_chain = $1)",
          [chain],
        );
        await tx.query("DELETE FROM outbound_transfer WHERE origin_chain = $1", [chain]);
      });
    },
  );
});
