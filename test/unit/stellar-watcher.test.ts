/**
 * The watcher's pass, driven by a fake RPC that reproduces the real one's window behaviour.
 *
 * These tests are about the cursor and the transaction, not about decoding, which has its own
 * suite. The three claims being checked are the three a restart depends on: a pass makes progress
 * even when it finds nothing, a page and the cursor advance commit together, and a cursor is never
 * reused across routers.
 */
import { describe, expect, it } from "vitest";

import {
  EventCompletenessError,
  SCAN_WINDOW_LEDGERS,
  endOfLedgerCursor,
} from "../../src/chains/stellar/cursor.js";
import type { RawStellarEvent } from "../../src/chains/stellar/events.js";
import type { EventSource, EventsPage, EventsQuery } from "../../src/chains/stellar/rpc.js";
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
function cursorRow(
  ledger: number,
  contract = LIVE_ROUTER,
  deploymentRevision = 1,
): Record<string, unknown> {
  return {
    last_processed: String(ledger),
    contract,
    last_processed_at: new Date("2026-10-01T12:00:00.000Z"),
    deployment_revision: deploymentRevision,
  };
}

/** Cursor writes, read back from the parameters rather than from the watcher's own cache. */
function cursorWrites(
  db: RecordingDb,
): { ledger: number; contract: string; revision: number }[] {
  // writeCursor takes (chain_key, family, contract, last_processed, last_processed_at, hash, deployment_revision).
  return db.matching("INSERT INTO indexer_cursor").map((entry) => ({
    ledger: Number(entry.params[3]),
    contract: String(entry.params[2]),
    revision: Number(entry.params[6] ?? 1),
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

  it("starts a new watched deployment revision instead of reusing an old router's cursor", async () => {
    const previousRouter = "CDIFFERENTROUTERADDRESSTHATSHARESNOHISTORYWITHOURSXXXXXXX";
    const { watcher, db, rpc, lines } = harness({
      startLedger: FIRST_EVENT_LEDGER,
      latestLedger: FIRST_EVENT_LEDGER + 20_000,
    });
    db.cursorRow = cursorRow(4_970_000, previousRouter, 1);

    const progressed = await watcher.tick(AbortSignal.timeout(5_000));

    expect(progressed).toBe(true);
    expect(rpc.requests[0]?.startLedger).toBe(FIRST_EVENT_LEDGER);
    expect(rpc.requests[0]?.cursor).toBeUndefined();
    expect(cursorWrites(db)).toEqual([
      { ledger: FIRST_EVENT_LEDGER + 9_999, contract: LIVE_ROUTER, revision: 2 },
    ]);
    const revisions = db.matching("INSERT INTO stellar_deployment_revision");
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.params).toEqual([
      CHAIN,
      2,
      LIVE_ROUTER,
      String(FIRST_EVENT_LEDGER),
      previousRouter,
      "4970000",
    ]);
    expect(
      lines.some((line) => line.message.includes("starting new watched deployment revision")),
    ).toBe(true);
  });

  it("refuses a configured deployment revision older than the stored revision", async () => {
    const db = new RecordingDb();
    db.cursorRow = cursorRow(4_970_000, LIVE_ROUTER, 3);
    const { logger } = capturingLogger();
    const watcher = new StellarWatcher({
      chainKey: CHAIN,
      router: LIVE_ROUTER,
      startLedger: FIRST_EVENT_LEDGER,
      pageSize: 200,
      deploymentRevision: 2,
      rpc: new FakeRpc({ latestLedger: FIRST_EVENT_LEDGER + 20_000 }),
      db,
      logger,
    });

    await expect(watcher.tick(AbortSignal.timeout(5_000))).rejects.toThrow(
      /older than stored revision 3/,
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
    expect(cursorWrites(db)).toEqual([{ ledger: 4_909_999, contract: LIVE_ROUTER, revision: 1 }]);
  });

  it("reports caught up once the window reaches the head", async () => {
    const { watcher, db, rpc } = harness({ startLedger: 4_990_000, latestLedger: 4_994_000 });

    expect(await watcher.tick(AbortSignal.timeout(5_000))).toBe(false);
    expect(cursorWrites(db)).toEqual([{ ledger: rpc.latest, contract: LIVE_ROUTER, revision: 1 }]);
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

describe("quarantine for unknown and undecodable events", () => {
  it("persists unknown events in the quarantine table with their exact source position", async () => {
    const unknown = syntheticEvent({
      ledger: FIRST_EVENT_LEDGER + 2,
      id: `${toid(FIRST_EVENT_LEDGER + 2, 3, 1).toString().padStart(19, "0")}-0000000004`,
      txHash: "tx-unknown-pos",
      transactionIndex: 3,
      operationIndex: 1,
      topicJson: [{ symbol: "hyperion" }, { symbol: "future_event" }],
      valueJson: { map: [{ key: { symbol: "foo" }, val: { u32: 42 } }] },
    });
    const { watcher, db } = harness({
      events: [unknown],
      startLedger: FIRST_EVENT_LEDGER,
      latestLedger: FIRST_EVENT_LEDGER + 5,
    });

    await watcher.tick(AbortSignal.timeout(5_000));

    const quarantined = db.matching("INSERT INTO stellar_event_quarantine");
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]?.transaction).not.toBeNull();
    expect(quarantined[0]?.params.slice(0, 11)).toEqual([
      CHAIN,
      LIVE_ROUTER,
      1,
      unknown.id,
      String(unknown.ledger),
      "tx-unknown-pos",
      3,
      1,
      new Date(unknown.ledgerClosedAt),
      "unknown_tag",
      "future_event",
    ]);
    expect(quarantined[0]?.params[11]).toBeNull();
    expect(watcher.progress?.quarantined).toBe(1);
    expect(cursorWrites(db)).toEqual([
      { ledger: FIRST_EVENT_LEDGER + 5, contract: LIVE_ROUTER, revision: 1 },
    ]);
  });

  it("quarantines decode errors and bounds oversized payloads without stalling the ledger", async () => {
    const hugePadding = "x".repeat(20_000);
    const malformed = syntheticEvent({
      ledger: FIRST_EVENT_LEDGER + 1,
      id: `${toid(FIRST_EVENT_LEDGER + 1, 1, 0).toString().padStart(19, "0")}-0000000000`,
      txHash: "tx-malformed",
      transactionIndex: 1,
      operationIndex: 0,
      topicJson: [{ symbol: "hyperion" }, { symbol: "out" }],
      // Missing `transfer` map triggers ScValError, while padding exceeds 16 KiB raw limit.
      valueJson: { map: [{ key: { symbol: "junk" }, val: { string: hugePadding } }] },
    });
    const { watcher, db, lines } = harness({
      events: [malformed],
      startLedger: FIRST_EVENT_LEDGER,
      latestLedger: FIRST_EVENT_LEDGER + 2,
    });

    await watcher.tick(AbortSignal.timeout(5_000));

    const quarantined = db.matching("INSERT INTO stellar_event_quarantine");
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]?.params[9]).toBe("decode_error");
    expect(typeof quarantined[0]?.params[11]).toBe("string");
    expect(String(quarantined[0]?.params[11]).length).toBeLessThanOrEqual(1_024);

    const storedRaw = JSON.parse(String(quarantined[0]?.params[12])) as {
      truncated?: boolean;
      id?: string;
      ledger?: number;
      txHash?: string;
    };
    expect(storedRaw.truncated).toBe(true);
    expect(storedRaw.id).toBe(malformed.id);
    expect(storedRaw.ledger).toBe(malformed.ledger);
    expect(storedRaw.txHash).toBe("tx-malformed");
    expect(lines.some((line) => line.message.includes("failed to decode"))).toBe(true);
    expect(cursorWrites(db)).toEqual([
      { ledger: FIRST_EVENT_LEDGER + 2, contract: LIVE_ROUTER, revision: 1 },
    ]);
  });
});

describe("event-source completeness checks", () => {
  function singlePageWatcher(page: EventsPage): {
    watcher: StellarWatcher;
    db: RecordingDb;
  } {
    const db = new RecordingDb();
    const { logger } = capturingLogger();
    const rpc: EventSource = {
      events: (_query: EventsQuery) => Promise.resolve(page),
    };
    const watcher = new StellarWatcher({
      chainKey: CHAIN,
      router: LIVE_ROUTER,
      startLedger: FIRST_EVENT_LEDGER,
      pageSize: 50,
      rpc,
      db,
      logger,
    });
    return { watcher, db };
  }

  it("refuses an invalid provider ledger range before declaring a boundary complete", async () => {
    const { watcher, db } = singlePageWatcher({
      events: [],
      cursor: endOfLedgerCursor(FIRST_EVENT_LEDGER + 10),
      oldestLedger: FIRST_EVENT_LEDGER + 20,
      latestLedger: FIRST_EVENT_LEDGER + 10,
    });

    await expect(watcher.tick(AbortSignal.timeout(5_000))).rejects.toThrow(EventCompletenessError);
    expect(cursorWrites(db)).toEqual([]);
  });

  it("refuses out-of-order events within a page", async () => {
    const first = syntheticEvent({ ledger: FIRST_EVENT_LEDGER + 1 });
    const second = syntheticEvent({ ledger: FIRST_EVENT_LEDGER + 2 });
    const { watcher, db } = singlePageWatcher({
      events: [second, first],
      cursor: endOfLedgerCursor(FIRST_EVENT_LEDGER + 10),
      oldestLedger: FIRST_EVENT_LEDGER,
      latestLedger: FIRST_EVENT_LEDGER + 10,
    });

    await expect(watcher.tick(AbortSignal.timeout(5_000))).rejects.toThrow(/out of order/);
    expect(cursorWrites(db)).toEqual([]);
  });

  it("refuses an empty page that carries a mid-ledger cursor instead of an end marker", async () => {
    const midLedger = `${toid(FIRST_EVENT_LEDGER + 5, 0, 0).toString().padStart(19, "0")}-0000000001`;
    const { watcher, db } = singlePageWatcher({
      events: [],
      cursor: midLedger,
      oldestLedger: FIRST_EVENT_LEDGER,
      latestLedger: FIRST_EVENT_LEDGER + 10,
    });

    await expect(watcher.tick(AbortSignal.timeout(5_000))).rejects.toThrow(
      /end-of-window marker/,
    );
    expect(cursorWrites(db)).toEqual([]);
  });

  it("refuses an end marker that claims completion past latestLedger", async () => {
    const { watcher, db } = singlePageWatcher({
      events: [],
      cursor: endOfLedgerCursor(FIRST_EVENT_LEDGER + 20),
      oldestLedger: FIRST_EVENT_LEDGER,
      latestLedger: FIRST_EVENT_LEDGER + 10,
    });

    await expect(watcher.tick(AbortSignal.timeout(5_000))).rejects.toThrow(/past latestLedger/);
    expect(cursorWrites(db)).toEqual([]);
  });
});

describe("adaptive scan-window sizing", () => {
  it("shrinks and grows the requested ledger range while preserving complete-through semantics", async () => {
    const denseLedger = FIRST_EVENT_LEDGER + 10;
    const denseEvents = [0, 1, 2].map((idx) =>
      syntheticEvent({
        ledger: denseLedger + idx,
        id: `${toid(denseLedger + idx, 0, 0).toString().padStart(19, "0")}-0000000000`,
        txHash: `tx-dense-${String(idx)}`,
      }),
    );
    const rpc = new FakeRpc({
      events: denseEvents,
      latestLedger: FIRST_EVENT_LEDGER + 30_000,
    });
    const db = new RecordingDb();
    const { logger } = capturingLogger();
    const watcher = new StellarWatcher({
      chainKey: CHAIN,
      router: LIVE_ROUTER,
      startLedger: FIRST_EVENT_LEDGER,
      pageSize: 2,
      rpc,
      db,
      logger,
      adaptiveWindow: {
        minLedgers: 1_000,
        maxLedgers: SCAN_WINDOW_LEDGERS,
        targetDurationMs: 2_000,
        fastDurationMs: 500,
      },
    });

    // Tick 1: saturated page (2 events === pageSize 2, more in window) stops mid-window at
    // denseLedger + 1, so completeThrough is denseLedger, and shrinks window from 10_000 to 5_000.
    await watcher.tick(AbortSignal.timeout(5_000));
    expect(watcher.windowLedgers).toBe(5_000);
    const firstWrite = cursorWrites(db)[0];
    expect(firstWrite?.ledger).toBe(denseLedger);

    // Tick 2: resumes from cursor with endLedger bounding the shrunk 5_000-ledger window,
    // hits the remaining 2 events (saturated again), and shrinks to 2_500.
    db.cursorRow = cursorRow(firstWrite!.ledger, LIVE_ROUTER, 1);
    await watcher.tick(AbortSignal.timeout(5_000));
    expect(rpc.requests[1]?.cursor).toBe(endOfLedgerCursor(firstWrite!.ledger));
    expect(rpc.requests[1]?.endLedger).toBe(firstWrite!.ledger + 1 + 5_000);
    const secondWrite = cursorWrites(db)[1];
    expect(secondWrite?.ledger).toBe(firstWrite!.ledger + 5_000);
    expect(watcher.windowLedgers).toBe(2_500);

    // Tick 3: empty fast page in the 2_500-ledger window grows back to 5_000.
    db.cursorRow = cursorRow(secondWrite!.ledger, LIVE_ROUTER, 1);
    await watcher.tick(AbortSignal.timeout(5_000));
    expect(rpc.requests[2]?.endLedger).toBe(secondWrite!.ledger + 1 + 2_500);
    expect(cursorWrites(db)[2]?.ledger).toBe(secondWrite!.ledger + 2_500);
    expect(watcher.windowLedgers).toBe(5_000);
  });
});
