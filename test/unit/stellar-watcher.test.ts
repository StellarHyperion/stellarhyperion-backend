/**
 * The watcher's pass, driven by a fake RPC that reproduces the real one's window behaviour.
 *
 * These tests are about the cursor and the transaction, not about decoding, which has its own
 * suite. The three claims being checked are the three a restart depends on: a pass makes progress
 * even when it finds nothing, a page and the cursor advance commit together, and a cursor is never
 * reused across routers.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

import { endOfLedgerCursor } from "../../src/chains/stellar/cursor.js";
import type { RawStellarEvent } from "../../src/chains/stellar/events.js";
import { StellarRpcError, type EventSource } from "../../src/chains/stellar/rpc.js";
import {
  CursorRepairConflictError,
  applyStellarCursorRepair,
  readCursor,
  readStellarCursorRepairAudits,
  writeCursor,
} from "../../src/chains/stellar/store.js";
import { StellarWatcher, planStellarCursorRepair } from "../../src/chains/stellar/watcher.js";
import type { Queryable, Transactional } from "../../src/db/pool.js";
import {
  FakeRpc,
  LIVE_ROUTER,
  ROUTER_HISTORY,
  RecordingDb,
  capturingLogger,
  syntheticEvent,
  toid,
} from "../stellar-fakes.js";

const CHAIN = "stellar-testnet";
/** The ledger the live router's first event actually landed in. */
const FIRST_EVENT_LEDGER = 4_965_951;

interface Harness {
  readonly watcher: StellarWatcher;
  readonly db: RecordingDb;
  readonly rpc: FakeRpc;
  readonly lines: { readonly level: string; readonly message: string }[];
}

function harness(
  options: {
    readonly events?: readonly RawStellarEvent[];
    readonly startLedger?: number;
    readonly pageSize?: number;
    readonly latestLedger?: number;
    readonly maxPagesPerTick?: number;
    readonly oldestLedger?: number;
  } = {},
): Harness {
  const db = new RecordingDb();
  const startLedger = options.startLedger ?? FIRST_EVENT_LEDGER;
  const rpc = new FakeRpc({
    events: options.events ?? [],
    // A head far enough ahead to be plausible unless a test says otherwise, so no test is
    // accidentally about a chain whose head is behind its own router.
    latestLedger: options.latestLedger ?? startLedger + 20_000,
    ...(options.oldestLedger === undefined ? {} : { oldestLedger: options.oldestLedger }),
  });
  const { logger, lines } = capturingLogger();
  const watcher = new StellarWatcher({
    chainKey: CHAIN,
    router: LIVE_ROUTER,
    startLedger,
    pageSize: options.pageSize ?? 200,
    rpc,
    db,
    logger,
    ...(options.maxPagesPerTick === undefined ? {} : { maxPagesPerTick: options.maxPagesPerTick }),
  });
  return { watcher, db, rpc, lines };
}

/** The cursor row `readCursor` expects, as pg would hand it back. */
function cursorRow(ledger: number, contract = LIVE_ROUTER): Record<string, unknown> {
  return {
    last_processed: String(ledger),
    contract,
    last_processed_at: new Date("2026-10-01T12:00:00.000Z"),
  };
}

/** Cursor writes, read back from the parameters rather than from the watcher's own cache. */
function cursorWrites(db: RecordingDb): { ledger: number; contract: string }[] {
  // writeCursor takes (chain_key, family, contract, last_processed, last_processed_at, hash).
  return db.matching("INSERT INTO indexer_cursor").map((entry) => ({
    ledger: Number(entry.params[3]),
    contract: String(entry.params[2]),
  }));
}

describe("where a pass starts", () => {
  it("asks by start ledger when there is no cursor", async () => {
    const { watcher, rpc } = harness({ startLedger: FIRST_EVENT_LEDGER });
    await watcher.tick(AbortSignal.timeout(5_000));

    expect(rpc.requests[0]?.startLedger).toBe(FIRST_EVENT_LEDGER);
    expect(rpc.requests[0]?.cursor).toBeUndefined();
  });

  it("resumes from the boundary cursor for the stored ledger, never by start ledger again", async () => {
    // By cursor rather than by `startLedger: stored + 1`, because a cursor-resumed request and a
    // ledger-started one scan ranges that differ by one, and the returned cursor is the only
    // account of where the previous scan actually stopped.
    const { watcher, db, rpc } = harness();
    db.cursorRow = cursorRow(4_970_000);
    await watcher.tick(AbortSignal.timeout(5_000));

    expect(rpc.requests[0]?.cursor).toBe(endOfLedgerCursor(4_970_000));
    expect(rpc.requests[0]?.startLedger).toBeUndefined();
  });

  it("refuses a cursor written for a different router instead of skipping its history", async () => {
    const { watcher, db } = harness();
    db.cursorRow = cursorRow(
      4_970_000,
      "CDIFFERENTROUTERADDRESSTHATSHARESNOHISTORYWITHOURSXXXXXXX",
    );

    await expect(watcher.tick(AbortSignal.timeout(5_000))).rejects.toThrow(
      /needs its cursor reset rather than reused/,
    );
    expect(cursorWrites(db)).toEqual([]);
  });
});

describe("a window with nothing in it", () => {
  it("still advances the cursor by the window, because empty is not the same as caught up", async () => {
    // The failure this prevents: a router deployed twenty seven thousand ledgers back whose first
    // events are outside the first window. A watcher that treats an empty page as "caught up"
    // re-reads that one window forever and never arrives.
    const { watcher, db } = harness({ startLedger: 4_900_000, latestLedger: 4_994_000 });

    const progressed = await watcher.tick(AbortSignal.timeout(5_000));

    expect(progressed).toBe(true);
    expect(cursorWrites(db)).toEqual([{ ledger: 4_909_999, contract: LIVE_ROUTER }]);
  });

  it("reports caught up once the window reaches the head", async () => {
    const { watcher, db, rpc } = harness({ startLedger: 4_990_000, latestLedger: 4_994_000 });

    expect(await watcher.tick(AbortSignal.timeout(5_000))).toBe(false);
    expect(cursorWrites(db)).toEqual([{ ledger: rpc.latest, contract: LIVE_ROUTER }]);
    expect(watcher.progress?.behind).toBe(0);
  });

  it("writes no event rows for a window that held none", async () => {
    const { watcher, db } = harness({ startLedger: 4_900_000, latestLedger: 4_994_000 });
    await watcher.tick(AbortSignal.timeout(5_000));

    expect(db.matching("INSERT INTO outbound_transfer")).toEqual([]);
    expect(db.matching("INSERT INTO admin_action")).toEqual([]);
  });
});

describe("the page and the cursor as one commit", () => {
  it("writes every row and the cursor inside the same transaction", async () => {
    // The restart guarantee. Splitting these would turn every crash into either a lost page or a
    // duplicated one, and no later query could tell which.
    const { watcher, db } = harness({ events: ROUTER_HISTORY, startLedger: FIRST_EVENT_LEDGER });
    await watcher.tick(AbortSignal.timeout(5_000));

    const inserts = db.queries.filter((entry) => entry.text.includes("INSERT INTO"));
    expect(inserts.length).toBeGreaterThan(1);
    const transactions = new Set(inserts.map((entry) => entry.transaction));
    expect(transactions.size).toBe(1);
    expect([...transactions][0]).not.toBeNull();
    expect(db.commits).toEqual([1]);
  });

  it("advances no cursor when a row in the page fails to write", async () => {
    const { watcher, db } = harness({ events: ROUTER_HISTORY, startLedger: FIRST_EVENT_LEDGER });
    db.failInTransaction = new Error("deadlock detected");

    await expect(watcher.tick(AbortSignal.timeout(5_000))).rejects.toThrow("deadlock detected");
    expect(db.rollbacks).toEqual([1]);
    expect(cursorWrites(db)).toEqual([]);
    // And nothing cached, so readiness does not start claiming a position the database never took.
    expect(watcher.progress).toBeNull();
  });

  it("indexes current RPC events without the removed success flag", async () => {
    const queued = ROUTER_HISTORY.find((event) => event.topicJson[1]?.symbol === "queued");
    if (!queued) throw new Error("Missing captured queued event");
    const unflagged = { ...queued };
    delete unflagged.inSuccessfulContractCall;
    const { watcher, db } = harness({ events: [unflagged], startLedger: FIRST_EVENT_LEDGER });
    await watcher.tick(AbortSignal.timeout(5_000));
    expect(watcher.progress?.decoded).toBe(1);
    expect(db.matching("INSERT INTO admin_action")).toHaveLength(1);
  });

  it("never indexes diagnostic events even when a legacy flag is true", async () => {
    const queued = ROUTER_HISTORY.find((event) => event.topicJson[1]?.symbol === "queued");
    if (!queued) throw new Error("Missing captured queued event");
    const { watcher, db } = harness({
      events: [{ ...queued, type: "diagnostic" }],
      startLedger: FIRST_EVENT_LEDGER,
    });
    await watcher.tick(AbortSignal.timeout(5_000));
    expect(watcher.progress?.decoded).toBe(0);
    expect(db.matching("INSERT INTO admin_action")).toHaveLength(0);
  });

  it("skips an event from a reverted call rather than recording a transfer that never happened", async () => {
    const reverted = {
      ...syntheticEvent({ ledger: FIRST_EVENT_LEDGER + 1 }),
      inSuccessfulContractCall: false,
    };
    const { watcher } = harness({ events: [reverted], startLedger: FIRST_EVENT_LEDGER });

    await watcher.tick(AbortSignal.timeout(5_000));

    expect(watcher.progress?.decoded).toBe(0);
    expect(watcher.progress?.skipped).toBe(1);
  });
});

describe("a ledger a page cannot hold", () => {
  it("keeps paging inside one ledger until it has crossed it", async () => {
    // The one case a ledger based cursor cannot describe on its own. Stopping here would set the
    // cursor to the ledger before and read the same page again forever.
    const crowded = [0, 1, 2, 3].map((index) =>
      syntheticEvent({
        ledger: FIRST_EVENT_LEDGER,
        id: `${toid(FIRST_EVENT_LEDGER, 0, index).toString().padStart(19, "0")}-0000000000`,
        txHash: `tx-crowded-${String(index)}`,
      }),
    );
    const next = syntheticEvent({ ledger: FIRST_EVENT_LEDGER + 1 });
    const { watcher, db, rpc } = harness({
      events: [...crowded, next],
      startLedger: FIRST_EVENT_LEDGER,
      pageSize: 2,
      latestLedger: FIRST_EVENT_LEDGER + 1,
    });

    await watcher.tick(AbortSignal.timeout(5_000));

    // More than one request, because one page could not cross the ledger on its own.
    expect(rpc.requests.length).toBeGreaterThan(1);
    // Past the crowded ledger rather than stuck on the one before it. 4965950 is the value the
    // stalling version writes, over and over, having read the same two events every time.
    const [write] = cursorWrites(db);
    expect(write?.ledger).toBeGreaterThanOrEqual(FIRST_EVENT_LEDGER);
    // And every event in that ledger was read, which is the thing a cursor stopping short of a
    // drained ledger would have skipped on the next pass.
    expect(watcher.progress?.decoded ?? 0).toBe(0);
    expect(watcher.progress?.skipped).toBe(5);
  });

  it("says so loudly rather than stalling when the ceiling is reached", async () => {
    const crowded = Array.from({ length: 8 }, (_, index) =>
      syntheticEvent({
        ledger: FIRST_EVENT_LEDGER,
        id: `${toid(FIRST_EVENT_LEDGER, 0, index).toString().padStart(19, "0")}-0000000000`,
        txHash: `tx-${String(index)}`,
      }),
    );
    const { watcher, lines } = harness({
      events: crowded,
      startLedger: FIRST_EVENT_LEDGER,
      pageSize: 1,
      maxPagesPerTick: 2,
      latestLedger: FIRST_EVENT_LEDGER,
    });

    await watcher.tick(AbortSignal.timeout(5_000));

    expect(lines.some((line) => line.message.includes("more router events than"))).toBe(true);
  });
});

describe("what the watcher says about itself", () => {
  it("is degraded before its first pass, because nothing is indexed yet", () => {
    const { watcher } = harness();
    const report = watcher.readiness();
    expect(report.state).toBe("degraded");
    expect(report.name).toBe(CHAIN);
  });

  it("is degraded while it is behind, and says by how much", async () => {
    const { watcher } = harness({ startLedger: 4_900_000, latestLedger: 4_994_000 });
    await watcher.tick(AbortSignal.timeout(5_000));

    const report = watcher.readiness();
    expect(report.state).toBe("degraded");
    expect(report.detail).toMatch(/\d+ ledgers behind/);
  });

  it("is ready once it is current", async () => {
    const { watcher } = harness({ startLedger: 4_990_000, latestLedger: 4_994_000 });
    await watcher.tick(AbortSignal.timeout(5_000));

    expect(watcher.readiness().state).toBe("ready");
  });

  it("never reports down, because one unreachable chain is not a reason to leave rotation", async () => {
    // The ceiling is deliberate. `/ready` takes the worst report in the process, and a 503 here
    // would stop this replica answering about the chains that are fine.
    const { watcher } = harness({ startLedger: 1, latestLedger: 4_994_000 });
    await watcher.tick(AbortSignal.timeout(5_000)).catch(() => undefined);

    expect(watcher.readiness().state).not.toBe("down");
  });
});

describe("gaps it cannot close", () => {
  it("reports a gap when the window moved past the cursor mid request", async () => {
    // The window really does move between a response and the next request: testnet reported
    // oldestLedger 4872997 and then refused that exact ledger as outside "4873028 - 4993987" on
    // the following call. When the node serves the request anyway, the ledgers between the cursor
    // and the window edge were never read, and saying nothing would leave a hole nobody hears
    // about again.
    const { watcher, db, lines } = harness({
      startLedger: 4_900_000,
      latestLedger: 4_994_000,
      oldestLedger: 4_980_000,
    });
    db.cursorRow = cursorRow(4_970_000);

    await watcher.tick(AbortSignal.timeout(5_000));

    expect(lines.some((line) => line.message.includes("retention window"))).toBe(true);
  });

  it("says a refused range cannot be closed from here rather than retrying it forever", async () => {
    // The commoner half of the same problem: the cursor is below the window and the node refuses
    // outright. Retrying is pointless, so the log names the situation instead of the request.
    const { watcher, db, lines } = harness({ startLedger: 4_990_000, latestLedger: 4_994_000 });
    db.cursorRow = cursorRow(4_000_000);

    await expect(watcher.tick(AbortSignal.timeout(5_000))).rejects.toThrow(/ledger range/);
    expect(lines.some((line) => line.message.includes("cannot close this gap"))).toBe(true);
  });

  it("logs an unfamiliar event tag once rather than once per event", async () => {
    const ahead = [1, 2, 3].map((offset) =>
      syntheticEvent({
        ledger: FIRST_EVENT_LEDGER + offset,
        topicJson: [{ symbol: "hyperion" }, { symbol: "teleported" }],
      }),
    );
    const { watcher, lines } = harness({ events: ahead, startLedger: FIRST_EVENT_LEDGER });

    await watcher.tick(AbortSignal.timeout(5_000));

    const warnings = lines.filter((line) => line.message.includes("running ahead of the indexer"));
    expect(warnings).toHaveLength(1);
  });
});

async function openMigratedPgLite(): Promise<{
  readonly db: Transactional;
  readonly close: () => Promise<void>;
}> {
  const pg = new PGlite();
  const migrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));
  const migrationNames = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of migrationNames) {
    const sql = readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8").split(
      "-- Down Migration",
    )[0]!;
    await pg.exec(sql);
  }

  const queryable: Queryable = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      const result = await pg.query(sql, [...params]);
      const int8 = result.fields
        .filter((field) => field.dataTypeID === 20)
        .map((field) => field.name);
      const rows = result.rows.map((raw) => {
        const row = { ...(raw as Record<string, unknown>) };
        for (const column of int8) {
          const value = row[column];
          if (typeof value === "number" || typeof value === "bigint") row[column] = String(value);
        }
        return row;
      });
      return {
        rows,
        rowCount: result.rows.length > 0 ? result.rows.length : (result.affectedRows ?? 0),
      };
    },
  };

  const db: Transactional = {
    query: (sql, params) => queryable.query(sql, params),
    transaction: async <T>(work: (tx: Queryable) => Promise<T>): Promise<T> => {
      await pg.exec("BEGIN");
      try {
        const out = await work(queryable);
        await pg.exec("COMMIT");
        return out;
      } catch (error) {
        await pg.exec("ROLLBACK");
        throw error;
      }
    },
  };

  return { db, close: () => pg.close() };
}

describe("read-only cursor repair planner", () => {
  it("generates an unsigned proposal with before-state and justification without writing to the database", async () => {
    const { watcher, db } = harness({ startLedger: 4_990_000, latestLedger: 4_994_000 });
    db.cursorRow = {
      ...cursorRow(4_991_000),
      revision: "3",
    };

    const result = await watcher.planCursorRepair(AbortSignal.timeout(5_000));

    expect(result.kind).toBe("proposal");
    if (result.kind !== "proposal") throw new Error("expected proposal");
    expect(result.proposal.unsigned).toBe(true);
    expect(result.proposal.action).toBe("advance");
    expect(result.proposal.expectedRevision).toBe(3n);
    expect(result.proposal.beforeState).toEqual({
      exists: true,
      contract: LIVE_ROUTER,
      position: 4_991_000n,
      observedAt: new Date("2026-10-01T12:00:00.000Z"),
      revision: 3n,
    });
    expect(result.proposal.proposedPosition).toBe(4_994_000n);
    expect(result.proposal.justification).toContain("verified completed ledgers 4991001..4994000");
    expect(db.commits).toEqual([]);
    expect(db.matching("INSERT")).toEqual([]);
    expect(db.matching("UPDATE")).toEqual([]);
  });

  it("never advances a cursor across retention gaps, missing cursors, or unmaterialized events", async () => {
    const gapCase = harness({
      startLedger: 4_900_000,
      latestLedger: 4_994_000,
      oldestLedger: 4_980_000,
    });
    gapCase.db.cursorRow = cursorRow(4_970_000);
    const gapPlan = await gapCase.watcher.planCursorRepair(AbortSignal.timeout(5_000));
    expect(gapPlan).toMatchObject({ kind: "blocked", reason: "retention_gap" });

    const nullCursorRpc: EventSource = {
      events: () =>
        Promise.resolve({
          events: [],
          cursor: null,
          latestLedger: 4_994_000,
          oldestLedger: 4_900_000,
        }),
    };
    const db = new RecordingDb();
    db.cursorRow = cursorRow(4_990_000);
    const nullCursorPlan = await planStellarCursorRepair(
      {
        chainKey: CHAIN,
        router: LIVE_ROUTER,
        startLedger: 4_990_000,
        rpc: nullCursorRpc,
        db,
      },
      AbortSignal.timeout(5_000),
    );
    expect(nullCursorPlan).toMatchObject({ kind: "blocked", reason: "unverified_cursor" });

    const credentialErrorRpc: EventSource = {
      events: () =>
        Promise.reject(
          new StellarRpcError(
            "getEvents",
            "connect failed for https://svc:topsecret@rpc.example.org/v1/key123?api_key=leak999",
            true,
          ),
        ),
    };
    const credPlan = await planStellarCursorRepair(
      {
        chainKey: CHAIN,
        router: LIVE_ROUTER,
        startLedger: 4_990_000,
        rpc: credentialErrorRpc,
        db,
      },
      AbortSignal.timeout(5_000),
    );
    expect(credPlan.kind).toBe("blocked");
    if (credPlan.kind === "blocked") {
      expect(credPlan.justification).not.toContain("topsecret");
      expect(credPlan.justification).not.toContain("leak999");
      expect(credPlan.justification).not.toContain("key123");
    }

    const queuedAtBoundary = ROUTER_HISTORY.find(
      (entry) => entry.topicJson[1]?.symbol === "queued",
    );
    if (!queuedAtBoundary) throw new Error("expected queued event in fixture");
    const unmaterializedCase = harness({
      events: [
        {
          ...queuedAtBoundary,
          ledger: FIRST_EVENT_LEDGER + 5,
          id: `${toid(FIRST_EVENT_LEDGER + 5)
            .toString()
            .padStart(19, "0")}-0000000000`,
        },
      ],
      startLedger: FIRST_EVENT_LEDGER,
      latestLedger: FIRST_EVENT_LEDGER + 100,
    });
    unmaterializedCase.db.cursorRow = cursorRow(FIRST_EVENT_LEDGER);
    const clampedPlan = await unmaterializedCase.watcher.planCursorRepair(
      AbortSignal.timeout(5_000),
    );
    expect(clampedPlan.kind).toBe("proposal");
    if (clampedPlan.kind === "proposal") {
      expect(clampedPlan.proposal.proposedPosition).toBe(BigInt(FIRST_EVENT_LEDGER + 4));
      expect(clampedPlan.proposal.justification).toContain("clamped before unmaterialized event");
    }
  });

  it("enforces compare-and-swap revisions and writes an audit record when applying a reviewed repair", async () => {
    const { db, close } = await openMigratedPgLite();
    try {
      const { logger } = capturingLogger();
      const head = 4_994_010;
      const rpc = new FakeRpc({ events: ROUTER_HISTORY, latestLedger: head });
      const watcher = new StellarWatcher({
        chainKey: CHAIN,
        router: LIVE_ROUTER,
        startLedger: FIRST_EVENT_LEDGER,
        pageSize: 200,
        rpc,
        db,
        logger,
      });
      while (await watcher.tick(AbortSignal.timeout(5_000))) {
        // catch up across windows
      }

      // Simulate a cursor lagging behind already materialized events.
      await db.query("UPDATE indexer_cursor SET last_processed = $2 WHERE chain_key = $1", [
        CHAIN,
        String(FIRST_EVENT_LEDGER + 10),
      ]);
      const beforeRepair = await readCursor(db, CHAIN);
      expect(beforeRepair?.position).toBe(BigInt(FIRST_EVENT_LEDGER + 10));

      const planned = await watcher.planCursorRepair(AbortSignal.timeout(5_000));
      expect(planned.kind).toBe("proposal");
      if (planned.kind !== "proposal") throw new Error("expected repair proposal");

      // Planner remained strictly read-only.
      const stillUnchanged = await readCursor(db, CHAIN);
      expect(stillUnchanged?.position).toBe(BigInt(FIRST_EVENT_LEDGER + 10));
      expect(stillUnchanged?.revision).toBe(beforeRepair?.revision);

      // Tampered proposals are rejected.
      await expect(
        applyStellarCursorRepair(
          db,
          { ...planned.proposal, proposedPosition: BigInt(head + 1) },
          { reviewedBy: "ops-alice", reviewNote: "verified against archive" },
        ),
      ).rejects.toThrow(CursorRepairConflictError);

      // Valid reviewed application advances the cursor and records audit metadata.
      const audit = await applyStellarCursorRepair(db, planned.proposal, {
        reviewedBy: "ops-alice",
        reviewNote: "verified completed boundaries and materialized actions",
      });
      expect(audit.proposedPosition).toBe(BigInt(head));
      expect(audit.appliedRevision).toBe((beforeRepair?.revision ?? 0n) + 1n);

      const repaired = await readCursor(db, CHAIN);
      expect(repaired?.position).toBe(BigInt(head));
      expect(repaired?.revision).toBe(audit.appliedRevision);

      const audits = await readStellarCursorRepairAudits(db, CHAIN);
      expect(audits).toHaveLength(1);
      expect(audits[0]?.reviewedBy).toBe("ops-alice");
      expect(audits[0]?.proposalId).toBe(planned.proposal.proposalId);

      // Re-applying or applying after a concurrent write fails the revision check.
      await writeCursor(db, {
        chainKey: CHAIN,
        family: "stellar",
        contract: LIVE_ROUTER,
        position: BigInt(head + 1),
        observedAt: new Date(),
        hash: null,
      });
      await expect(
        applyStellarCursorRepair(db, planned.proposal, {
          reviewedBy: "ops-bob",
          reviewNote: "duplicate attempt",
        }),
      ).rejects.toThrow(CursorRepairConflictError);
    } finally {
      await close();
    }
  });
});
