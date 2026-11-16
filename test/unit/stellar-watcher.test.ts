/**
 * The watcher's pass, driven by a fake RPC that reproduces the real one's window behaviour.
 *
 * These tests are about the cursor and the transaction, not about decoding, which has its own
 * suite. The three claims being checked are the three a restart depends on: a pass makes progress
 * even when it finds nothing, a page and the cursor advance commit together, and a cursor is never
 * reused across routers.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { AddressKind, encodeStellarAddress } from "@hyperion/protocol";
import { describe, expect, it } from "vitest";

import { endOfLedgerCursor } from "../../src/chains/stellar/cursor.js";
import type { RawStellarEvent } from "../../src/chains/stellar/events.js";
import { StellarRpcError } from "../../src/chains/stellar/rpc.js";
import { listHistoryGaps, summarizeHistoryCoverage } from "../../src/chains/stellar/store.js";
import { StellarWatcher } from "../../src/chains/stellar/watcher.js";
import { loadConfig } from "../../src/config/config.js";
import type { Database, Queryable, Transactional } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import { completeEnv } from "../helpers.js";
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

function bridgeOutEvent(params: {
  readonly ledger: number;
  readonly nonce: bigint;
  readonly grossAmount: bigint;
  readonly fee: bigint;
  readonly netAmount: bigint;
  readonly txHash: string;
}): RawStellarEvent {
  const sender = encodeStellarAddress(AddressKind.Account, new Uint8Array(32).fill(0x21));
  const token = encodeStellarAddress(AddressKind.Contract, new Uint8Array(32).fill(0x31));
  return syntheticEvent({
    ledger: params.ledger,
    txHash: params.txHash,
    topicJson: [{ symbol: "hyperion" }, { symbol: "out" }],
    valueJson: {
      map: [
        {
          key: { symbol: "transfer" },
          val: {
            map: [
              { key: { symbol: "created_at" }, val: { u64: "1790900100" } },
              { key: { symbol: "created_ledger" }, val: { u32: params.ledger } },
              {
                key: { symbol: "destination" },
                val: {
                  bytes: "0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38",
                },
              },
              { key: { symbol: "destination_chain" }, val: { string: "sepolia" } },
              { key: { symbol: "fee" }, val: { i128: params.fee.toString() } },
              { key: { symbol: "gross_amount" }, val: { i128: params.grossAmount.toString() } },
              { key: { symbol: "net_amount" }, val: { i128: params.netAmount.toString() } },
              { key: { symbol: "nonce" }, val: { u64: params.nonce.toString() } },
              { key: { symbol: "route" }, val: { u32: 0 } },
              { key: { symbol: "sender" }, val: { address: sender } },
              { key: { symbol: "token" }, val: { address: token } },
            ],
          },
        },
      ],
    },
  });
}

async function openMigratedPglite(): Promise<{
  readonly pg: PGlite;
  readonly db: Transactional & Database;
}> {
  const pg = new PGlite();
  for (const name of [
    "1790900000000_initial-schema.sql",
    "1791000000000_cursor-block-hash.sql",
    "1791100000000_cursor-autovacuum-tuning.sql",
    "1791200000000_stellar-history-gaps.sql",
  ]) {
    const migrationPath = fileURLToPath(new URL(`../../migrations/${name}`, import.meta.url));
    const sql = readFileSync(migrationPath, "utf8").split("-- Down Migration")[0] ?? "";
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
    return { rows, rowCount: result.affectedRows ?? result.rows.length };
  };

  const db = {
    query: runQuery,
    ping: async () => {
      await pg.query("SELECT 1");
    },
    transaction: async <T>(work: (tx: Queryable) => Promise<T>): Promise<T> => {
      await pg.query("BEGIN");
      try {
        const value = await work({ query: runQuery });
        await pg.query("COMMIT");
        return value;
      } catch (error) {
        await pg.query("ROLLBACK");
        throw error;
      }
    },
  };

  return { pg, db: db as unknown as Transactional & Database };
}

describe("durable Stellar history-gap tracking and reconciliation", () => {
  it("creates an explicit bounded gap record when the RPC refuses an out-of-retention range", async () => {
    const { watcher, db } = harness({ startLedger: 4_990_000, latestLedger: 4_994_000 });
    db.cursorRow = cursorRow(4_000_000);

    await expect(watcher.tick(AbortSignal.timeout(5_000))).rejects.toThrow(/ledger range/);

    const gapInserts = db.matching("INSERT INTO stellar_history_gap");
    expect(gapInserts).toHaveLength(1);
    // FakeRpc retention is 120,960 ledgers behind 4,994,000 => oldest retained ledger is 4,873,040.
    // Bounded missing interval is [4,000,001, 4,873,039].
    expect(gapInserts[0]?.params).toEqual([
      CHAIN,
      LIVE_ROUTER,
      "4000001",
      "4873039",
      "rpc_retention_refused",
    ]);
    expect(watcher.readiness().historyComplete).toBe(false);
    expect(watcher.readiness().openHistoryGaps).toBe(1);
  });

  it("redacts RPC credentials and query tokens from StellarRpcError messages", () => {
    const err = new StellarRpcError(
      "getEvents",
      "upstream failed at https://ops:secretPass@soroban-rpc.example.invalid/v2/secretKey?token=abc Authorization: Bearer secretJwt",
      true,
    );
    expect(err.message).toContain("https://soroban-rpc.example.invalid");
    expect(err.message).not.toContain("secretPass");
    expect(err.message).not.toContain("secretKey");
    expect(err.message).not.toContain("token=abc");
    expect(err.message).not.toContain("secretJwt");
  });

  it("distinguishes caught-up cursor freshness from complete coverage and closes gaps via idempotent backfill", async () => {
    const { pg, db } = await openMigratedPglite();
    try {
      const { logger } = capturingLogger();

      // Seed cursor at ledger 4,800,000 while live RPC head is 4,994,000 (oldest retained = 4,873,040).
      await db.query(
        `INSERT INTO indexer_cursor (chain_key, family, contract, last_processed)
         VALUES ($1, 'stellar', $2, 4800000)`,
        [CHAIN, LIVE_ROUTER],
      );

      const liveTransfer = bridgeOutEvent({
        ledger: 4_993_999,
        nonce: 18_446_744_073_709_551_610n,
        grossAmount: 250_000_000_000_000_000_001n,
        fee: 1_000_000_000_000_000n,
        netAmount: 249_999_000_000_000_000_001n,
        txHash: "live-tx-hash-4993999",
      });
      const liveRpc = new FakeRpc({
        events: [liveTransfer],
        latestLedger: 4_994_000,
      });

      const watcher = new StellarWatcher({
        chainKey: CHAIN,
        router: LIVE_ROUTER,
        startLedger: 4_800_000,
        pageSize: 200,
        rpc: liveRpc,
        db,
        logger,
        advancePastRetentionGap: true,
      });

      // Catch live watcher all the way up to 4,994,000.
      while (await watcher.tick(AbortSignal.timeout(5_000))) {
        // advance windows until caught up
      }
      expect(watcher.progress?.ledger).toBe(4_994_000);
      expect(watcher.progress?.behind).toBe(0);

      // Verify explicit bounded gap [4,800,001, 4,873,039] in Postgres.
      const openGaps = await listHistoryGaps(db, { chainKey: CHAIN, contract: LIVE_ROUTER });
      expect(openGaps).toHaveLength(1);
      expect(openGaps[0]?.fromLedger).toBe(4_800_001n);
      expect(openGaps[0]?.toLedger).toBe(4_873_039n);
      expect(openGaps[0]?.status).toBe("open");

      // API readiness and /v1/metrics must distinguish caught-up cursor from incomplete history.
      const config = loadConfig({ env: completeEnv({ KEEPER_ENABLED: "false" }) });
      const app = buildServer({
        config,
        logger,
        db,
        readiness: [watcher],
        redis: { ping: () => Promise.resolve("PONG") },
      });
      await app.ready();

      try {
        const readyBefore = await app.inject("/ready");
        expect(readyBefore.statusCode).toBe(200);
        const readyCheckBefore = (readyBefore.json().checks as Record<string, unknown>[]).find(
          (check) => check.name === CHAIN,
        );
        expect(readyCheckBefore).toMatchObject({
          name: CHAIN,
          state: "degraded",
          cursorFresh: true,
          historyComplete: false,
          openHistoryGaps: 1,
        });

        const metricsBefore = await app.inject("/v1/metrics");
        expect(metricsBefore.statusCode).toBe(200);
        const metricsJsonBefore = metricsBefore.json();
        expect(metricsJsonBefore.cursors[0]).toMatchObject({
          chain: CHAIN,
          block: "4994000",
          cursorFresh: true,
          historyComplete: false,
          openHistoryGaps: 1,
          missingLedgers: "73039",
        });
        expect(metricsJsonBefore.historyCoverage.complete).toBe(false);
        expect(metricsJsonBefore.historyCoverage.openGaps).toBe(1);

        // Archive provider holds missed transfers inside [4,800,001, 4,873,039].
        const missedTransferA = bridgeOutEvent({
          ledger: 4_810_005,
          nonce: 9_007_199_254_740_993n,
          grossAmount: 50_000_000n,
          fee: 150_000n,
          netAmount: 49_850_000n,
          txHash: "archive-tx-a",
        });
        const missedTransferB = bridgeOutEvent({
          ledger: 4_873_039,
          nonce: 9_007_199_254_740_994n,
          grossAmount: 75_000_000n,
          fee: 225_000n,
          netAmount: 74_775_000n,
          txHash: "archive-tx-b",
        });
        const archiveRpc = {
          events(query: { startLedger?: number; cursor?: string; limit: number }) {
            const inner = new FakeRpc({
              events: [missedTransferA, missedTransferB, liveTransfer],
              latestLedger: 4_890_000,
            });
            return inner.events({
              contractIds: [LIVE_ROUTER],
              limit: query.limit,
              ...(query.startLedger === undefined ? {} : { startLedger: query.startLedger }),
              ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            });
          },
        };

        const reconcileResults = await watcher.reconcileHistoryGaps(
          archiveRpc,
          AbortSignal.timeout(5_000),
        );
        expect(reconcileResults).toHaveLength(1);
        expect(reconcileResults[0]?.status).toBe("closed");
        expect(reconcileResults[0]?.completedThrough).toBe(4_873_039n);
        expect(reconcileResults[0]?.decoded).toBe(2);

        // Re-running reconciliation against overlapping events produces zero duplicate rows.
        const secondPass = await watcher.reconcileHistoryGaps(
          archiveRpc,
          AbortSignal.timeout(5_000),
        );
        expect(secondPass).toEqual([]);

        const transfers = await db.query(
          "SELECT nonce::text AS nonce, net_amount::text AS net_amount FROM outbound_transfer ORDER BY origin_block",
        );
        expect(transfers.rows).toEqual([
          { nonce: "9007199254740993", net_amount: "49850000" },
          { nonce: "9007199254740994", net_amount: "74775000" },
          { nonce: "18446744073709551610", net_amount: "249999000000000000001" },
        ]);

        // Live cursor remains at 4,994,000 (not rewound by backfill).
        const cursorAfter = await db.query(
          "SELECT last_processed::text AS pos FROM indexer_cursor WHERE chain_key = $1",
          [CHAIN],
        );
        expect(cursorAfter.rows[0]?.pos).toBe("4994000");

        const summaryAfter = await summarizeHistoryCoverage(db, { chainKey: CHAIN });
        expect(summaryAfter.complete).toBe(true);
        expect(summaryAfter.openGaps).toBe(0);
        expect(summaryAfter.closedGaps).toBe(1);

        const readyAfter = await app.inject("/ready");
        const readyCheckAfter = (readyAfter.json().checks as Record<string, unknown>[]).find(
          (check) => check.name === CHAIN,
        );
        expect(readyCheckAfter).toMatchObject({
          name: CHAIN,
          state: "ready",
          cursorFresh: true,
          historyComplete: true,
          openHistoryGaps: 0,
        });

        const metricsAfter = await app.inject("/v1/metrics");
        expect(metricsAfter.json().cursors[0]).toMatchObject({
          chain: CHAIN,
          block: "4994000",
          cursorFresh: true,
          historyComplete: true,
          openHistoryGaps: 0,
          missingLedgers: "0",
        });
        expect(metricsAfter.json().historyCoverage.complete).toBe(true);
        expect(metricsAfter.json().historyCoverage.closedGaps).toBe(1);
      } finally {
        await app.close();
      }
    } finally {
      await pg.close();
    }
  });
});
