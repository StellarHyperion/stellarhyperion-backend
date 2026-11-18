/**
 * The watcher's pass, driven by a fake RPC that reproduces the real one's window behaviour.
 *
 * These tests are about the cursor and the transaction, not about decoding, which has its own
 * suite. The three claims being checked are the three a restart depends on: a pass makes progress
 * even when it finds nothing, a page and the cursor advance commit together, and a cursor is never
 * reused across routers.
 */
import { describe, expect, it } from "vitest";

import { endOfLedgerCursor } from "../../src/chains/stellar/cursor.js";
import type { RawStellarEvent } from "../../src/chains/stellar/events.js";
import { planCursorRepair } from "../../src/chains/stellar/store.js";
import { StellarWatcher } from "../../src/chains/stellar/watcher.js";
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
  it("does not claim completion when retention moved past the requested range", async () => {
    // The window really does move between a response and the next request: testnet reported
    // oldestLedger 4872997 and then refused that exact ledger as outside "4873028 - 4993987" on
    // the following call. When the node serves the request anyway, the ledgers between the cursor
    // and the window edge were never read, and saying nothing would leave a hole nobody hears
    // about again.
    const { watcher, db } = harness({
      startLedger: 4_900_000,
      latestLedger: 4_994_000,
      oldestLedger: 4_980_000,
    });
    db.cursorRow = cursorRow(4_970_000);

    await expect(watcher.tick(AbortSignal.timeout(5_000))).rejects.toThrow(
      "outside provider retention",
    );

    expect(cursorWrites(db)).toEqual([]);
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

describe("scan progress journals (#37)", () => {
  it("records requested range, committed range, event counts, and null interruption on success", async () => {
    const { watcher } = harness({
      events: ROUTER_HISTORY,
      startLedger: FIRST_EVENT_LEDGER,
      latestLedger: FIRST_EVENT_LEDGER + 20_000,
    });

    await watcher.tick(AbortSignal.timeout(5_000));

    const journal = watcher.lastJournal;
    expect(journal).not.toBeNull();
    expect(journal?.chainKey).toBe(CHAIN);
    expect(journal?.requestedRange).toEqual({
      from: FIRST_EVENT_LEDGER,
      to: FIRST_EVENT_LEDGER + 9_999,
    });
    expect(journal?.committedRange).toEqual({
      from: FIRST_EVENT_LEDGER,
      to: FIRST_EVENT_LEDGER + 9_999,
    });
    const expectedInWindow = ROUTER_HISTORY.filter(
      (event) => event.ledger <= FIRST_EVENT_LEDGER + 9_999,
    ).length;
    expect(journal?.eventCounts.fetched).toBe(expectedInWindow);
    expect(journal?.eventCounts.decoded).toBeGreaterThan(0);
    expect(journal?.eventCounts.conflicts).toBe(0);
    expect(journal?.pages).toBe(1);
    expect(journal?.interruptionReason).toBeNull();
  });

  it("records interruptionReason and null committedRange when a transaction rolls back", async () => {
    const { watcher, db } = harness({
      events: ROUTER_HISTORY,
      startLedger: FIRST_EVENT_LEDGER,
    });
    db.failInTransaction = new Error("deadlock detected");

    await expect(watcher.tick(AbortSignal.timeout(5_000))).rejects.toThrow("deadlock detected");

    const journal = watcher.lastJournal;
    expect(journal?.committedRange).toBeNull();
    expect(journal?.interruptionReason).toBe("deadlock detected");
  });

  it("records max_pages_reached when a crowded ledger hits the page ceiling", async () => {
    const crowded = Array.from({ length: 4 }, (_, index) =>
      syntheticEvent({
        ledger: FIRST_EVENT_LEDGER,
        id: `${toid(FIRST_EVENT_LEDGER, 0, index).toString().padStart(19, "0")}-0000000000`,
        txHash: `tx-cap-${String(index)}`,
      }),
    );
    const { watcher } = harness({
      events: crowded,
      startLedger: FIRST_EVENT_LEDGER,
      pageSize: 1,
      maxPagesPerTick: 2,
      latestLedger: FIRST_EVENT_LEDGER,
    });

    await watcher.tick(AbortSignal.timeout(5_000));

    expect(watcher.lastJournal?.interruptionReason).toBe("max_pages_reached");
    expect(watcher.lastJournal?.pages).toBe(2);
  });
});

describe("graceful watcher draining (#38)", () => {
  it("stops new RPC requests when cancelled before or during scan", async () => {
    const { watcher, rpc } = harness({ startLedger: FIRST_EVENT_LEDGER });
    const controller = new AbortController();
    controller.abort();

    const progressed = await watcher.tick(controller.signal);

    expect(progressed).toBe(false);
    expect(rpc.requests).toHaveLength(0);
    expect(watcher.lastJournal?.interruptionReason).toBe("cancelled");
    expect(watcher.lastJournal?.committedRange).toBeNull();
  });

  it("waits for an in-flight event transaction to finish committing before drain() resolves", async () => {
    const { watcher, db, rpc } = harness({
      events: ROUTER_HISTORY,
      startLedger: FIRST_EVENT_LEDGER,
    });

    let releaseTx!: () => void;
    const txEntered = new Promise<void>((resolve) => {
      const originalTransaction = db.transaction.bind(db);
      db.transaction = async (work) => {
        return originalTransaction(async (tx) => {
          resolve();
          await new Promise<void>((done) => {
            releaseTx = done;
          });
          return work(tx);
        });
      };
    });

    const tickPromise = watcher.tick(AbortSignal.timeout(5_000));
    await txEntered;

    let drainResolved = false;
    const drainPromise = watcher.drain().then(() => {
      drainResolved = true;
    });

    await Promise.resolve();
    expect(drainResolved).toBe(false);
    expect(watcher.isDraining).toBe(true);

    releaseTx();
    await drainPromise;
    await tickPromise;

    expect(drainResolved).toBe(true);
    expect(db.commits).toEqual([1]);
    expect(cursorWrites(db)).toHaveLength(1);

    // Subsequent ticks must not issue new RPC requests once drained.
    const requestsBefore = rpc.requests.length;
    expect(await watcher.tick(AbortSignal.timeout(5_000))).toBe(false);
    expect(rpc.requests.length).toBe(requestsBefore);
  });
});

describe("event identity conflict detection (#39)", () => {
  it("treats identical replays as idempotent and detects distinct payloads for the same canonical identity", async () => {
    const queued = ROUTER_HISTORY.find((event) => event.topicJson[1]?.symbol === "queued");
    if (!queued) throw new Error("Missing captured queued event");

    const conflicting: RawStellarEvent = {
      ...queued,
      id: `${toid(queued.ledger + 1, 0, 0)
        .toString()
        .padStart(19, "0")}-0000000000`,
      ledger: queued.ledger + 1,
      txHash: "0xconflictingtxhash",
    };

    const { watcher, db, lines } = harness({
      events: [queued, conflicting],
      startLedger: queued.ledger,
      latestLedger: queued.ledger + 5,
    });

    await watcher.tick(AbortSignal.timeout(5_000));

    // Only the first payload should have been written; the conflicting one is quarantined.
    expect(db.matching("INSERT INTO admin_action")).toHaveLength(1);
    expect(watcher.conflicts).toHaveLength(1);
    expect(watcher.conflicts[0]?.identity).toMatch(/^actionQueued:/);
    expect(watcher.conflicts[0]?.differingFields).toContain("txHash");
    expect(watcher.lastJournal?.eventCounts.conflicts).toBe(1);
    expect(lines.some((line) => line.message.includes("conflicting payload detected"))).toBe(true);
  });

  it("allows identical replay of the same event without recording a conflict", async () => {
    const queued = ROUTER_HISTORY.find((event) => event.topicJson[1]?.symbol === "queued");
    if (!queued) throw new Error("Missing captured queued event");

    const { watcher, db } = harness({
      events: [queued],
      startLedger: queued.ledger,
      latestLedger: queued.ledger + 5,
    });

    await watcher.tick(AbortSignal.timeout(5_000));
    // Rewind cursor to re-read the exact same ledger and event.
    db.cursorRow = cursorRow(queued.ledger - 1);
    await watcher.tick(AbortSignal.timeout(5_000));

    expect(watcher.conflicts).toHaveLength(0);
  });
});

describe("read-only cursor repair planner (#40)", () => {
  it("generates an unsigned advance_cursor proposal from verified journal boundaries without writing to DB", async () => {
    const { watcher, db } = harness({
      events: ROUTER_HISTORY,
      startLedger: FIRST_EVENT_LEDGER,
      latestLedger: FIRST_EVENT_LEDGER + 20_000,
    });

    await watcher.tick(AbortSignal.timeout(5_000));
    const queriesBefore = db.queries.length;

    // Simulate a stale cursor row behind the verified journal boundary.
    const staleLedger = FIRST_EVENT_LEDGER + 100;
    db.cursorRow = cursorRow(staleLedger);

    const proposal = await watcher.planRepair();

    expect(proposal.unsigned).toBe(true);
    expect(proposal.readOnly).toBe(true);
    expect(proposal.action).toBe("advance_cursor");
    expect(proposal.currentPosition).toBe(String(staleLedger));
    expect(proposal.proposedPosition).toBe(String(FIRST_EVENT_LEDGER + 9_999));
    expect(proposal.proposedRpcCursor).toBe(endOfLedgerCursor(FIRST_EVENT_LEDGER + 9_999));
    expect(proposal.sql).toContain("UPDATE indexer_cursor");
    // Read durable journals, conflicts and cursor; no repair writes.
    expect(db.queries.length).toBe(queriesBefore + 3);
    expect(db.queries[db.queries.length - 1]?.text).toContain("SELECT last_processed");
  });

  it("proposes backfill_required with gap bounds when cursor fell behind retention with no verified boundary", () => {
    const proposal = planCursorRepair({
      chainKey: CHAIN,
      expectedContract: LIVE_ROUTER,
      startLedger: 4_900_000,
      currentCursor: {
        position: 4_800_000n,
        contract: LIVE_ROUTER,
        observedAt: null,
        hash: null,
      },
      retainedHistory: {
        oldestLedger: 4_950_000,
        latestLedger: 4_994_000,
        observedAt: new Date(),
      },
      verifiedBoundaries: [],
      conflicts: [],
    });

    expect(proposal.unsigned).toBe(true);
    expect(proposal.readOnly).toBe(true);
    expect(proposal.action).toBe("backfill_required");
    expect(proposal.gap).toEqual({ from: 4_800_001, to: 4_949_999 });
    expect(proposal.sql).toBeNull();
  });

  it("proposes reset_cursor on contract mismatch and flags conflicts when present", async () => {
    const queued = ROUTER_HISTORY.find((event) => event.topicJson[1]?.symbol === "queued");
    if (!queued) throw new Error("Missing captured queued event");

    const conflicting: RawStellarEvent = {
      ...queued,
      id: `${toid(queued.ledger + 1, 0, 0)
        .toString()
        .padStart(19, "0")}-0000000000`,
      ledger: queued.ledger + 1,
      txHash: "0xconflictingtxhash",
    };

    const { watcher, db } = harness({
      events: [queued, conflicting],
      startLedger: queued.ledger,
      latestLedger: queued.ledger + 5,
    });
    await watcher.tick(AbortSignal.timeout(5_000));

    db.cursorRow = cursorRow(
      queued.ledger,
      "CDIFFERENTROUTERADDRESSTHATSHARESNOHISTORYWITHOURSXXXXXXX",
    );
    const proposal = await watcher.planRepair();

    expect(proposal.action).toBe("reset_cursor");
    expect(proposal.blockedByConflicts).toBe(true);
    expect(proposal.conflictCount).toBe(1);
    expect(proposal.sql).toContain("DELETE FROM indexer_cursor");
  });
});
