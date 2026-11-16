/**
 * The watcher's pass, driven by a fake RPC that reproduces the real one's window behaviour.
 *
 * These tests are about the cursor and the transaction, not about decoding, which has its own
 * suite. The three claims being checked are the three a restart depends on: a pass makes progress
 * even when it finds nothing, a page and the cursor advance commit together, and a cursor is never
 * reused across routers.
 */
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

import { endOfLedgerCursor } from "../../src/chains/stellar/cursor.js";
import type { RawStellarEvent } from "../../src/chains/stellar/events.js";
import {
  StellarDeploymentConflictError,
  readCursor,
  readStellarDeploymentHistory,
} from "../../src/chains/stellar/store.js";
import { StellarWatcher } from "../../src/chains/stellar/watcher.js";
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
  readonly db: Transactional & Queryable;
  readonly close: () => Promise<void>;
}> {
  const pg = new PGlite();
  const migrationsDir = new URL("../../migrations/", import.meta.url);
  const files = readdirSync(migrationsDir)
    .filter((entry) => entry.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(new URL(file, migrationsDir), "utf8").split("-- Down Migration")[0]!;
    await pg.exec(sql);
  }

  const runQuery = async (sql: string, params: readonly unknown[] = []) => {
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
  };

  const queryable: Queryable = { query: runQuery };
  const db: Transactional & Queryable = {
    query: runQuery,
    async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
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

  return {
    db,
    close: async () => {
      await pg.close();
    },
  };
}

describe("deployment revision handling", () => {
  const SECOND_ROUTER = "CBK3TPRQR5A3H2AWESOUX4MVYOP63VNQ5EYHCX26EEJUC5B5FLB4DV5O";
  const THIRD_ROUTER = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

  it("starts a replacement router from its own startLedger without inheriting prior positions and keeps old deployment history queryable", async () => {
    const { db, close } = await openMigratedPgLite();
    try {
      const { logger } = capturingLogger();
      const firstRpc = new FakeRpc({
        events: ROUTER_HISTORY,
        latestLedger: 4_994_010,
      });
      const v1 = new StellarWatcher({
        chainKey: CHAIN,
        router: LIVE_ROUTER,
        startLedger: FIRST_EVENT_LEDGER,
        deploymentRevision: 1,
        pageSize: 200,
        rpc: firstRpc,
        db,
        logger,
      });

      while (await v1.tick(AbortSignal.timeout(5_000))) {
        // catch up v1 to 4_994_010
      }

      const v1Cursor = await readCursor(db, CHAIN);
      expect(v1Cursor?.contract).toBe(LIVE_ROUTER);
      expect(v1Cursor?.position).toBe(4_994_010n);
      expect(v1Cursor?.deploymentRevision).toBe(1);
      expect(v1Cursor?.startLedger).toBe(BigInt(FIRST_EVENT_LEDGER));

      // Replace router at an earlier startLedger than v1's cursor position to prove no position inheritance.
      const v2StartLedger = 4_980_000;
      const v2Queued = ROUTER_HISTORY.find((event) => event.topicJson[1]?.symbol === "queued");
      if (!v2Queued) throw new Error("Missing queued fixture event");
      const v2Event: RawStellarEvent = {
        ...v2Queued,
        contractId: SECOND_ROUTER,
        ledger: 4_980_005,
        id: `${toid(4_980_005, 0, 1).toString().padStart(19, "0")}-0000000000`,
        txHash: "ab".repeat(32),
        ledgerClosedAt: "2026-10-05T08:00:00Z",
      };
      const secondRpc = new FakeRpc({
        events: [v2Event],
        latestLedger: 4_995_000,
      });
      const v2 = new StellarWatcher({
        chainKey: CHAIN,
        router: SECOND_ROUTER,
        startLedger: v2StartLedger,
        deploymentRevision: 2,
        pageSize: 200,
        rpc: secondRpc,
        db,
        logger,
      });

      const firstPassProgressed = await v2.tick(AbortSignal.timeout(5_000));
      expect(firstPassProgressed).toBe(true);
      expect(secondRpc.requests[0]?.startLedger).toBe(v2StartLedger);
      expect(secondRpc.requests[0]?.cursor).toBeUndefined();

      // Second pass resumes from v2's boundary cursor rather than v1's old cursor.
      const secondPassProgressed = await v2.tick(AbortSignal.timeout(5_000));
      expect(secondPassProgressed).toBe(false);
      expect(secondRpc.requests[1]?.cursor).toBe(endOfLedgerCursor(4_989_999));

      const activeCursor = await readCursor(db, CHAIN);
      expect(activeCursor?.contract).toBe(SECOND_ROUTER);
      expect(activeCursor?.deploymentRevision).toBe(2);
      expect(activeCursor?.startLedger).toBe(BigInt(v2StartLedger));
      expect(activeCursor?.position).toBe(4_995_000n);
      expect(activeCursor?.observedAt?.toISOString()).toBe("2026-10-05T08:00:00.000Z");

      const history = await readStellarDeploymentHistory(db, CHAIN);
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({
        chainKey: CHAIN,
        deploymentRevision: 1,
        contract: LIVE_ROUTER,
        startLedger: BigInt(FIRST_EVENT_LEDGER),
        lastProcessed: 4_994_010n,
        status: "superseded",
      });
      expect(history[0]?.supersededAt).toBeInstanceOf(Date);
      expect(history[1]).toMatchObject({
        chainKey: CHAIN,
        deploymentRevision: 2,
        contract: SECOND_ROUTER,
        startLedger: BigInt(v2StartLedger),
        lastProcessed: 4_995_000n,
        status: "active",
        supersededAt: null,
      });

      // Historical rows emitted by v1 remain intact and queryable in materialized tables.
      const actions = await db.query(
        "SELECT count(*)::int AS n FROM admin_action WHERE chain = $1",
        [CHAIN],
      );
      expect(Number(actions.rows[0]?.n)).toBe(7);
    } finally {
      await close();
    }
  });

  it("raises StellarDeploymentConflictError with explicit operator diagnostics on conflicting revisions or routers", async () => {
    const { db, close } = await openMigratedPgLite();
    try {
      const { logger } = capturingLogger();
      const rpc = new FakeRpc({ events: [], latestLedger: 4_994_010 });

      const v1 = new StellarWatcher({
        chainKey: CHAIN,
        router: LIVE_ROUTER,
        startLedger: FIRST_EVENT_LEDGER,
        deploymentRevision: 1,
        pageSize: 200,
        rpc,
        db,
        logger,
      });
      await v1.tick(AbortSignal.timeout(5_000));

      // 1. Different router without incrementing deploymentRevision.
      const unincremented = new StellarWatcher({
        chainKey: CHAIN,
        router: SECOND_ROUTER,
        startLedger: 4_990_000,
        deploymentRevision: 1,
        pageSize: 200,
        rpc,
        db,
        logger,
      });
      await expect(unincremented.tick(AbortSignal.timeout(5_000))).rejects.toThrow(
        StellarDeploymentConflictError,
      );
      await expect(unincremented.tick(AbortSignal.timeout(5_000))).rejects.toThrow(
        /increment deploymentRevision/,
      );

      // 2. Same router with mismatched deploymentRevision.
      const bumpedSameRouter = new StellarWatcher({
        chainKey: CHAIN,
        router: LIVE_ROUTER,
        startLedger: FIRST_EVENT_LEDGER,
        deploymentRevision: 2,
        pageSize: 200,
        rpc,
        db,
        logger,
      });
      await expect(bumpedSameRouter.tick(AbortSignal.timeout(5_000))).rejects.toThrow(
        StellarDeploymentConflictError,
      );

      // 3. Same router and revision with conflicting startLedger.
      const changedStartLedger = new StellarWatcher({
        chainKey: CHAIN,
        router: LIVE_ROUTER,
        startLedger: FIRST_EVENT_LEDGER + 500,
        deploymentRevision: 1,
        pageSize: 200,
        rpc,
        db,
        logger,
      });
      await expect(changedStartLedger.tick(AbortSignal.timeout(5_000))).rejects.toThrow(
        /conflicting with configured startLedger/,
      );

      // 4. Valid advance to revision 2, followed by illegal regression to revision 1 or reuse of superseded router.
      const v2 = new StellarWatcher({
        chainKey: CHAIN,
        router: SECOND_ROUTER,
        startLedger: 4_990_000,
        deploymentRevision: 2,
        pageSize: 200,
        rpc,
        db,
        logger,
      });
      await v2.tick(AbortSignal.timeout(5_000));

      const regressed = new StellarWatcher({
        chainKey: CHAIN,
        router: THIRD_ROUTER,
        startLedger: 4_991_000,
        deploymentRevision: 1,
        pageSize: 200,
        rpc,
        db,
        logger,
      });
      await expect(regressed.tick(AbortSignal.timeout(5_000))).rejects.toThrow(
        /regresses below recorded deployment revision/,
      );

      const reactivateSuperseded = new StellarWatcher({
        chainKey: CHAIN,
        router: LIVE_ROUTER,
        startLedger: FIRST_EVENT_LEDGER,
        deploymentRevision: 3,
        pageSize: 200,
        rpc,
        db,
        logger,
      });
      await expect(reactivateSuperseded.tick(AbortSignal.timeout(5_000))).rejects.toThrow(
        /superseded deployment revision/,
      );

      // Invalid non-positive revision diagnostic.
      const invalidRev = new StellarWatcher({
        chainKey: CHAIN,
        router: THIRD_ROUTER,
        startLedger: 4_991_000,
        deploymentRevision: 0,
        pageSize: 200,
        rpc,
        db,
        logger,
      });
      await expect(invalidRev.tick(AbortSignal.timeout(5_000))).rejects.toThrow(/positive integer/);
    } finally {
      await close();
    }
  });
});
