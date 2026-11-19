import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Queryable, Transactional } from "../../src/db/pool.js";
import { decodeStellarEvent } from "../../src/chains/stellar/events.js";
import { endOfLedgerCursor } from "../../src/chains/stellar/cursor.js";
import {
  inspectEventConflict,
  planCursorRepair,
  readCursor,
  writeCursor,
  StaleCursorError,
  recordQuarantinedEvent,
} from "../../src/chains/stellar/store.js";
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
    "1791400000000_stellar-cursor-cas-leases-gaps.sql",
    "1791500000000_stellar-revisions-and-quarantine.sql",
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

describe("deployment and quarantine SQL safety", () => {
  it("guards replacement cursors against an earlier replica and keeps old deployment evidence", async () => {
    const base = {
      chainKey: "replacement-cas",
      family: "stellar" as const,
      contract: LIVE_ROUTER,
      position: 500n,
      observedAt: null,
      hash: null,
      deploymentRevision: 1,
    };
    await writeCursor(db, { ...base, expectedRevision: null });
    const original = (await readCursor(db, base.chainKey))!;
    await writeCursor(db, {
      ...base,
      contract: "replacement-router",
      position: 100n,
      deploymentRevision: 2,
      expectedDeploymentRevision: 1,
      expectedContract: LIVE_ROUTER,
      expectedRevision: original.revision,
    });
    await expect(
      writeCursor(db, { ...base, position: 600n, expectedRevision: original.revision }),
    ).rejects.toThrow(StaleCursorError);
    const current = (await readCursor(db, base.chainKey))!;
    expect(current.contract).toBe("replacement-router");
    expect(current.position).toBe(100n);
    expect(current.deploymentRevision).toBe(2);
  });
  it("retains conflicting natural keys across router replacements without overwriting original evidence", async () => {
    const raw = ROUTER_HISTORY.find((event) => event.topicJson[1]?.symbol === "queued")!;
    const decoded = decodeStellarEvent(raw);
    expect(
      await db.transaction((tx) => inspectEventConflict(tx, "shared-deployment", raw, decoded)),
    ).toBeNull();
    const incoming = { ...raw, contractId: "replacement-router", txHash: "new-source" };
    const conflict = await db.transaction((tx) =>
      inspectEventConflict(tx, "shared-deployment", incoming, decoded),
    );
    expect(conflict?.differingFields).toContain("contractId");
    expect(conflict?.existing.contractId).toBe(LIVE_ROUTER);
    const stored = await db.query(
      "SELECT evidence FROM stellar_event_identity WHERE chain_key = $1 AND identity LIKE 'actionQueued:%'",
      ["shared-deployment"],
    );
    expect(stored.rows).toHaveLength(1);
  });
  it("bounds and redacts quarantine metadata, preserves distinct revisions", async () => {
    const raw = { ...ROUTER_HISTORY[0]!, authorization: "do-not-store-this-secret" };
    for (const deploymentRevision of [1, 2])
      await recordQuarantinedEvent(db, {
        chainKey: "quarantine-history",
        contract: LIVE_ROUTER,
        deploymentRevision,
        raw,
        reason: "decode_error",
        tag: null,
        decodeError: "ScValError: do-not-store-this-secret",
      });
    const stored = await db.query(
      "SELECT raw_event, decode_error FROM stellar_event_quarantine WHERE chain_key = $1",
      ["quarantine-history"],
    );
    expect(stored.rows).toHaveLength(2);
    expect(JSON.stringify(stored.rows)).not.toContain("do-not-store-this-secret");
  });
});

describe("offline decoder replay", () => {
  it("applies a newly decodable quarantined event idempotently and records successful replay", async () => {
    const raw = ROUTER_HISTORY.find((event) => event.topicJson[1]?.symbol === "queued")!;
    const chainKey = "new-decoder-replay";
    await recordQuarantinedEvent(db, {
      chainKey,
      contract: LIVE_ROUTER,
      deploymentRevision: 1,
      raw,
      reason: "unknown_tag",
      tag: "queued",
      decodeError: null,
    });
    const options = {
      chainKey,
      router: LIVE_ROUTER,
      startLedger: raw.ledger,
      pageSize: 200,
      rpc: new FakeRpc({ events: [raw], latestLedger: raw.ledger + 1 }),
      db,
      logger: capturingLogger().logger,
      releaseLeaseOnTick: true,
    };
    await new StellarWatcher(options).tick(AbortSignal.timeout(5_000));
    const first = await db.query("SELECT action_id, payload FROM admin_action WHERE chain = $1", [
      chainKey,
    ]);
    expect(first.rows).toHaveLength(1);
    await db.query("DELETE FROM indexer_cursor WHERE chain_key = $1", [chainKey]);
    await new StellarWatcher(options).tick(AbortSignal.timeout(5_000));
    const replayed = await db.query(
      "SELECT action_id, payload FROM admin_action WHERE chain = $1",
      [chainKey],
    );
    expect(replayed.rows).toEqual(first.rows);
    const stored = await db.query(
      "SELECT replayed_at FROM stellar_event_quarantine WHERE chain_key = $1",
      [chainKey],
    );
    expect(stored.rows[0]?.replayed_at).not.toBeNull();
  });
});
