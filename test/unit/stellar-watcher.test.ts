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
import { StellarRpcError, type EventsQuery } from "../../src/chains/stellar/rpc.js";
import { readBackfillJob, readCursor } from "../../src/chains/stellar/store.js";
import { StellarBackfillRunner, StellarWatcher } from "../../src/chains/stellar/watcher.js";
import { loadConfig } from "../../src/config/config.js";
import type { Queryable, Transactional } from "../../src/db/pool.js";
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
  const sender = encodeStellarAddress(AddressKind.Account, new Uint8Array(32).fill(0x22));
  const token = encodeStellarAddress(AddressKind.Contract, new Uint8Array(32).fill(0x33));
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

async function openBackfillPglite(): Promise<{
  readonly pg: PGlite;
  readonly db: Transactional;
}> {
  const pg = new PGlite();
  for (const name of [
    "1790900000000_initial-schema.sql",
    "1791000000000_cursor-block-hash.sql",
    "1791100000000_cursor-autovacuum-tuning.sql",
    "1791200000000_stellar-backfill-jobs.sql",
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

  const db: Transactional = {
    query: runQuery,
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

  return { pg, db };
}

describe("Stellar historical-provider backfill jobs", () => {
  it("parses explicit STELLAR_HISTORICAL_RPC_URL without defaulting to STELLAR_RPC_URL", () => {
    const defaultCfg = loadConfig({ env: completeEnv({ KEEPER_ENABLED: "false" }) });
    expect(defaultCfg.indexer.stellar?.historicalRpcUrl).toBeNull();
    expect(defaultCfg.indexer.stellar?.backfillMaxLedgers).toBe(10_000);

    const configured = loadConfig({
      env: completeEnv({
        KEEPER_ENABLED: "false",
        STELLAR_HISTORICAL_RPC_URL: "https://archive.soroban-testnet.example.org",
        STELLAR_BACKFILL_MAX_LEDGERS: "25000",
      }),
    });
    expect(configured.indexer.stellar?.historicalRpcUrl).toBe(
      "https://archive.soroban-testnet.example.org",
    );
    expect(configured.indexer.stellar?.backfillMaxLedgers).toBe(25_000);
  });

  it("preserves live cursor progress and exact event identities during bounded historical backfill", async () => {
    const { pg, db } = await openBackfillPglite();
    try {
      const { logger } = capturingLogger();

      // Seed live cursor far ahead at ledger 4,995,000.
      await db.query(
        `INSERT INTO indexer_cursor (chain_key, family, contract, last_processed)
         VALUES ($1, 'stellar', $2, 4995000)`,
        [CHAIN, LIVE_ROUTER],
      );

      const historicalEventA = bridgeOutEvent({
        ledger: 4_800_010,
        nonce: 18_446_744_073_709_551_601n,
        grossAmount: 999_000_000_000_000_000_123n,
        fee: 1_000_000_000_000_000n,
        netAmount: 998_999_000_000_000_000_123n,
        txHash: "hist-tx-4800010",
      });
      const historicalEventB = bridgeOutEvent({
        ledger: 4_804_999,
        nonce: 18_446_744_073_709_551_602n,
        grossAmount: 500_000_000n,
        fee: 1_500_000n,
        netAmount: 498_500_000n,
        txHash: "hist-tx-4804999",
      });

      const archiveRpc = new FakeRpc({
        events: [historicalEventA, historicalEventB],
        latestLedger: 4_850_000,
      });

      const runner = new StellarBackfillRunner({
        chainKey: CHAIN,
        router: LIVE_ROUTER,
        historicalRpc: archiveRpc,
        db,
        logger,
        maxLedgersPerPass: 5_000,
      });

      const job = await runner.enqueue(4_800_000n, 4_805_000n);
      // Pass 1 covers [4,800,000, 4,804,999] (5,000 ledgers) -> status 'running'.
      expect(await runner.tick(AbortSignal.timeout(5_000))).toBe(true);
      const midState = await readBackfillJob(db, job.id);
      expect(midState?.status).toBe("running");
      expect(midState?.completedLedger).toBe(4_804_999n);
      expect(midState?.resumeCursor).toBe(endOfLedgerCursor(4_804_999));

      // Pass 2 covers [4,805,000, 4,805,000] -> status 'completed'.
      expect(await runner.tick(AbortSignal.timeout(5_000))).toBe(false);
      const finalState = await readBackfillJob(db, job.id);
      expect(finalState?.status).toBe("completed");
      expect(finalState?.completedLedger).toBe(4_805_000n);

      // Live cursor was never touched or rewound.
      const liveCursor = await readCursor(db, CHAIN);
      expect(liveCursor?.position).toBe(4_995_000n);

      // Event identities (block, txHash, full-width u64 nonces, i128 integer-string amounts) preserved.
      const rows = await db.query(
        `SELECT nonce::text AS nonce, net_amount::text AS net_amount,
                origin_block::text AS origin_block, origin_tx
           FROM outbound_transfer
          ORDER BY origin_block`,
      );
      expect(rows.rows).toEqual([
        {
          nonce: "18446744073709551601",
          net_amount: "998999000000000000123",
          origin_block: "4800010",
          origin_tx: "hist-tx-4800010",
        },
        {
          nonce: "18446744073709551602",
          net_amount: "498500000",
          origin_block: "4804999",
          origin_tx: "hist-tx-4804999",
        },
      ]);
    } finally {
      await pg.close();
    }
  });

  it("leaves backfill jobs unresolved for unconfigured providers, unsupported RPCs, and unverifiable ranges without leaking credentials", async () => {
    const { pg, db } = await openBackfillPglite();
    try {
      const { logger, lines } = capturingLogger();

      // 1. Unconfigured historical provider (historicalRpc = null).
      const unconfiguredRunner = new StellarBackfillRunner({
        chainKey: CHAIN,
        router: LIVE_ROUTER,
        historicalRpc: null,
        db,
        logger,
      });
      const job1 = await unconfiguredRunner.enqueue(4_700_000n, 4_700_500n);
      await unconfiguredRunner.tick(AbortSignal.timeout(5_000));
      const state1 = await readBackfillJob(db, job1.id);
      expect(state1?.status).toBe("unresolved");
      expect(state1?.completedLedger).toBeNull();
      expect(unconfiguredRunner.readiness().state).toBe("degraded");

      // 2. Provider whose oldestLedger is ahead of the requested range (pruned node).
      const prunedRpc = new FakeRpc({
        latestLedger: 4_994_000,
        oldestLedger: 4_880_000,
      });
      const prunedRunner = new StellarBackfillRunner({
        chainKey: CHAIN,
        router: LIVE_ROUTER,
        historicalRpc: prunedRpc,
        db,
        logger,
      });
      const job2 = await prunedRunner.enqueue(4_875_000n, 4_885_000n);
      const res2 = await prunedRunner.runJob(job2.id, AbortSignal.timeout(5_000));
      expect(res2.status).toBe("unresolved");
      expect(res2.reason).toMatch(/oldestLedger/);

      // 3. Unsupported provider error carrying URL credentials + bearer token -> redacted in DB and logs.
      const unsupportedRpc = {
        events(): Promise<never> {
          return Promise.reject(
            new StellarRpcError(
              "getEvents",
              "method unsupported at https://ops:topSecret@archive-rpc.example.invalid/v2/apiKey123?secret=xyz Authorization: Bearer superSecretJwt",
              false,
            ),
          );
        },
      };
      const unsupportedRunner = new StellarBackfillRunner({
        chainKey: CHAIN,
        router: LIVE_ROUTER,
        historicalRpc: unsupportedRpc,
        db,
        logger,
      });
      const job3 = await unsupportedRunner.enqueue(4_600_000n, 4_600_100n);
      const res3 = await unsupportedRunner.runJob(job3.id, AbortSignal.timeout(5_000));
      expect(res3.status).toBe("unresolved");
      const state3 = await readBackfillJob(db, job3.id);
      expect(state3?.status).toBe("unresolved");
      const combined =
        `${state3?.lastError ?? ""}\n` + lines.map((entry) => entry.message).join("\n");
      expect(combined).toContain("https://archive-rpc.example.invalid");
      expect(combined).not.toContain("topSecret");
      expect(combined).not.toContain("apiKey123");
      expect(combined).not.toContain("secret=xyz");
      expect(combined).not.toContain("superSecretJwt");
    } finally {
      await pg.close();
    }
  });

  it("resumes interrupted backfill jobs from the durable completed ledger boundary", async () => {
    const { pg, db } = await openBackfillPglite();
    try {
      const { logger } = capturingLogger();
      const firstWindowEvent = bridgeOutEvent({
        ledger: 4_802_000,
        nonce: 701n,
        grossAmount: 10_000_000n,
        fee: 30_000n,
        netAmount: 9_970_000n,
        txHash: "window-1-tx",
      });
      const secondWindowEvent = bridgeOutEvent({
        ledger: 4_812_000,
        nonce: 702n,
        grossAmount: 20_000_000n,
        fee: 60_000n,
        netAmount: 19_940_000n,
        txHash: "window-2-tx",
      });

      const baseArchive = new FakeRpc({
        events: [firstWindowEvent, secondWindowEvent],
        latestLedger: 4_850_000,
      });
      const observedQueries: EventsQuery[] = [];
      let failSecondWindowOnce = true;

      const flakyHistoricalRpc = {
        events(query: EventsQuery) {
          observedQueries.push(query);
          if (query.cursor !== undefined && failSecondWindowOnce) {
            failSecondWindowOnce = false;
            return Promise.reject(
              new StellarRpcError("getEvents", "http 503 upstream timeout", true),
            );
          }
          return baseArchive.events(query);
        },
      };

      const runner = new StellarBackfillRunner({
        chainKey: CHAIN,
        router: LIVE_ROUTER,
        historicalRpc: flakyHistoricalRpc,
        db,
        logger,
        maxLedgersPerPass: 20_000,
      });

      const job = await runner.enqueue(4_800_000n, 4_815_000n);

      // First run commits window [4,800,000, 4,809,999], then fails transiently on window 2.
      await expect(runner.runJob(job.id, AbortSignal.timeout(5_000))).rejects.toThrow(/http 503/);

      const afterInterrupt = await readBackfillJob(db, job.id);
      expect(afterInterrupt?.status).toBe("running");
      expect(afterInterrupt?.completedLedger).toBe(4_809_999n);
      expect(afterInterrupt?.resumeCursor).toBe(endOfLedgerCursor(4_809_999));

      // Resume: must start from endOfLedgerCursor(4_809_999) rather than re-reading from 4,800,000.
      observedQueries.length = 0;
      const resumed = await runner.runJob(job.id, AbortSignal.timeout(5_000));
      expect(resumed.status).toBe("completed");
      expect(resumed.completedLedger).toBe(4_815_000n);
      expect(observedQueries[0]?.cursor).toBe(endOfLedgerCursor(4_809_999));
      expect(observedQueries[0]?.startLedger).toBeUndefined();

      const rows = await db.query(
        "SELECT nonce::text AS nonce FROM outbound_transfer ORDER BY origin_block",
      );
      expect(rows.rows).toEqual([{ nonce: "701" }, { nonce: "702" }]);
    } finally {
      await pg.close();
    }
  });
});
