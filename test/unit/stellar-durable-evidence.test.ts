import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Queryable, Transactional } from "../../src/db/pool.js";
import { decodeStellarEvent } from "../../src/chains/stellar/events.js";
import { endOfLedgerCursor } from "../../src/chains/stellar/cursor.js";
import { inspectEventConflict, planCursorRepair } from "../../src/chains/stellar/store.js";
import { StellarWatcher } from "../../src/chains/stellar/watcher.js";
import { FakeRpc, LIVE_ROUTER, ROUTER_HISTORY, capturingLogger } from "../stellar-fakes.js";

const pg = new PGlite();
const db: Transactional = {
  async query(sql, params = []) {
    const result = await pg.query<Record<string, unknown>>(sql, [...params]);
    const rows = result.rows.map((raw) => {
      const row = { ...raw };
      for (const field of result.fields) {
        if (field.dataTypeID === 20 && row[field.name] != null)
          row[field.name] = String(row[field.name]);
      }
      return row;
    });
    return { rows, rowCount: result.affectedRows ?? rows.length };
  },
  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    return pg.transaction(async (tx) => {
      const scoped = {
        query: async (sql: string, params: readonly unknown[] = []) => {
          const result = await tx.query<Record<string, unknown>>(sql, [...params]);
          return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
        },
      };
      return work(scoped);
    });
  },
};

beforeAll(async () => {
  for (const file of [
    "1790900000000_initial-schema.sql",
    "1791000000000_cursor-block-hash.sql",
    "1791300000000_stellar-durable-scan-evidence.sql",
  ]) {
    await pg.exec(
      readFileSync(new URL(`../../migrations/${file}`, import.meta.url), "utf8").split(
        "-- Down Migration",
      )[0]!,
    );
  }
}, 30_000);
afterAll(async () => {
  await pg.close();
});

describe("durable Stellar evidence", () => {
  it("retains conflicts across watcher restart without replacing the first event", async () => {
    const raw = ROUTER_HISTORY.find((event) => event.topicJson[1]?.symbol === "queued")!;
    const decoded = decodeStellarEvent(raw);
    expect(
      await db.transaction((tx) => inspectEventConflict(tx, "durable-conflict", raw, decoded)),
    ).toBeNull();
    expect(
      await db.transaction((tx) => inspectEventConflict(tx, "durable-conflict", raw, decoded)),
    ).toBeNull();
    const changed = { ...raw, txHash: "conflicting-source" };
    const conflict = await db.transaction((tx) =>
      inspectEventConflict(tx, "durable-conflict", changed, decoded),
    );
    expect(conflict?.differingFields).toContain("txHash");
    const stored = await db.query(
      "SELECT evidence FROM stellar_event_conflict WHERE chain_key = $1",
      ["durable-conflict"],
    );
    expect(stored.rows).toHaveLength(1);
    expect(JSON.stringify(stored.rows)).not.toContain("valueJson");
    const restarted = new StellarWatcher({
      chainKey: "durable-conflict",
      router: LIVE_ROUTER,
      startLedger: raw.ledger,
      pageSize: 200,
      rpc: new FakeRpc(),
      db,
      logger: capturingLogger().logger,
    });
    expect((await restarted.planRepair()).blockedByConflicts).toBe(true);
  });

  it("rolls back identity evidence with the event transaction", async () => {
    const raw = ROUTER_HISTORY[0]!;
    await expect(
      db.transaction(async (tx) => {
        await inspectEventConflict(tx, "rolled-back", raw, decodeStellarEvent(raw));
        throw new Error("crash before commit");
      }),
    ).rejects.toThrow("crash before commit");
    expect(
      (
        await db.query("SELECT evidence FROM stellar_event_identity WHERE chain_key = $1", [
          "rolled-back",
        ])
      ).rows,
    ).toHaveLength(0);
    const changed = { ...raw, txHash: "next-attempt" };
    expect(
      await db.transaction((tx) =>
        inspectEventConflict(tx, "rolled-back", changed, decodeStellarEvent(changed)),
      ),
    ).toBeNull();
  });

  it("recovers a committed range from the database after discarding the watcher", async () => {
    const start = 4_965_951;
    const options = {
      chainKey: "durable-journal",
      router: LIVE_ROUTER,
      startLedger: start,
      pageSize: 200,
      rpc: new FakeRpc({ latestLedger: start + 100 }),
      db,
      logger: capturingLogger().logger,
    };
    await new StellarWatcher(options).tick(AbortSignal.timeout(5_000));
    await db.query("UPDATE indexer_cursor SET last_processed = $1 WHERE chain_key = $2", [
      String(start - 1),
      options.chainKey,
    ]);
    const repaired = await new StellarWatcher(options).planRepair();
    expect(repaired.action).toBe("advance_cursor");
    expect(repaired.proposedPosition).toBe(String(start + 100));
  });

  it("does not bridge a missing earlier range from a later terminal marker", () => {
    const proposal = planCursorRepair({
      chainKey: "gap",
      expectedContract: LIVE_ROUTER,
      startLedger: 10,
      currentCursor: null,
      retainedHistory: { oldestLedger: 100, latestLedger: 200, observedAt: new Date() },
      verifiedBoundaries: [
        { from: 100, ledger: 200, cursor: endOfLedgerCursor(200), source: "journal" },
      ],
      conflicts: [],
    });
    expect(proposal.action).toBe("backfill_required");
    expect(proposal.sql).toBeNull();
  });
});
