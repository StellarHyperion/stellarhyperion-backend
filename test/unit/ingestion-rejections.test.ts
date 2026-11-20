import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Queryable, Transactional } from "../../src/db/pool.js";
import { readCursor } from "../../src/chains/stellar/store.js";
import { StellarWatcher } from "../../src/chains/stellar/watcher.js";
import type { RawStellarEvent } from "../../src/chains/stellar/events.js";
import {
  IngestionRejectionLimitError,
  MAX_OPEN_INGESTION_REJECTIONS,
  boundRejectionDetail,
  pruneReconciledIngestionRejections,
  readOpenIngestionRejections,
  reconcileIngestionRejection,
  recordIngestionRejection,
  type IngestionSource,
} from "../../src/chains/writers.js";
import { FakeRpc, LIVE_ROUTER, ROUTER_HISTORY, capturingLogger } from "../stellar-fakes.js";

const pg = new PGlite();
const db: Transactional = {
  async query(sql, params = []) {
    const result = await pg.query<Record<string, unknown>>(sql, [...params]);
    const rows = result.rows.map((raw) => {
      const row = { ...raw };
      for (const field of result.fields)
        if (field.dataTypeID === 20 && row[field.name] != null)
          row[field.name] = String(row[field.name]);
      return row;
    });
    return { rows, rowCount: result.affectedRows ?? rows.length };
  },
  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    return pg.transaction(async (tx) =>
      work({
        query: async (sql: string, params: readonly unknown[] = []) => {
          const result = await tx.query<Record<string, unknown>>(sql, [...params]);
          return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
        },
      }),
    );
  },
};

beforeAll(async () => {
  for (const file of [
    "1790900000000_initial-schema.sql",
    "1791000000000_cursor-block-hash.sql",
    "1791300000000_stellar-durable-scan-evidence.sql",
    "1791400000000_stellar-cursor-cas-leases-gaps.sql",
    "1791500000000_stellar-revisions-and-quarantine.sql",
    "1793500000000_ingestion-rejections.sql",
  ])
    await pg.exec(
      readFileSync(new URL(`../../migrations/${file}`, import.meta.url), "utf8").split(
        "-- Down Migration",
      )[0]!,
    );
}, 30_000);
afterAll(async () => {
  await pg.close();
});

const queued = ROUTER_HISTORY.find((event) => event.topicJson[1]?.symbol === "queued")!;
/** The same source position with a tag this build has no decoder for. */
const unknown: RawStellarEvent = {
  ...queued,
  topicJson: [queued.topicJson[0]!, { symbol: "mystery" }, ...queued.topicJson.slice(2)],
};

function watcher(chainKey: string, events = [unknown]) {
  return new StellarWatcher({
    chainKey,
    router: LIVE_ROUTER,
    startLedger: queued.ledger,
    pageSize: 200,
    rpc: new FakeRpc({ events, latestLedger: queued.ledger + 1 }),
    db,
    logger: capturingLogger().logger,
    releaseLeaseOnTick: true,
  });
}

const source = (chainKey: string): IngestionSource => ({
  chainKey,
  family: "stellar",
  contract: LIVE_ROUTER,
  block: BigInt(queued.ledger),
  txHash: queued.txHash,
  position: queued.id,
});

describe("ingestion rejections", () => {
  it("never advances the committed boundary past a failed record without a rejection", async () => {
    const chainKey = "rejection-boundary";
    await watcher(chainKey).tick(AbortSignal.timeout(5_000));
    const cursor = await readCursor(db, chainKey);
    expect(cursor?.position).toBeGreaterThanOrEqual(BigInt(queued.ledger));
    const [open, ...rest] = await readOpenIngestionRejections(db, chainKey);
    expect(rest).toHaveLength(0);
    expect(open).toMatchObject({
      family: "stellar",
      contract: LIVE_ROUTER,
      deploymentRevision: cursor?.deploymentRevision,
      block: BigInt(queued.ledger),
      txHash: queued.txHash,
      position: queued.id,
      errorClass: "unknown_event",
      replayEligible: true,
      attempts: 1,
      reconciledAt: null,
    });
  });

  it("refuses to advance at all once the open rejection bound is reached", async () => {
    const chainKey = "rejection-limit";
    await pg.query(
      `INSERT INTO ingestion_rejection
         (chain_key, family, contract, block_number, tx_hash, source_position, error_class,
          replay_eligible)
       SELECT $1, 'stellar', 'filler', n, 'filler-tx', n::text, 'decode_error', true
         FROM generate_series(1, $2::int) AS n`,
      [chainKey, MAX_OPEN_INGESTION_REJECTIONS],
    );
    await expect(
      db.transaction((tx) =>
        recordIngestionRejection(tx, { ...source(chainKey), errorClass: "decode_error" }),
      ),
    ).rejects.toBeInstanceOf(IngestionRejectionLimitError);
    await watcher(chainKey)
      .tick(AbortSignal.timeout(5_000))
      .catch(() => undefined);
    expect(await readCursor(db, chainKey)).toBeNull();
    const stored = await db.query(
      "SELECT 1 FROM ingestion_rejection WHERE chain_key = $1 AND source_position = $2",
      [chainKey, queued.id],
    );
    expect(stored.rows).toHaveLength(0);
  });

  it("marks the rejection reconciled when replay applies the same source record", async () => {
    const chainKey = "rejection-replay";
    await watcher(chainKey).tick(AbortSignal.timeout(5_000));
    expect(await readOpenIngestionRejections(db, chainKey)).toHaveLength(1);
    // A decoder upgrade: the same source position now decodes and applies.
    await db.query("DELETE FROM indexer_cursor WHERE chain_key = $1", [chainKey]);
    await watcher(chainKey, [queued]).tick(AbortSignal.timeout(5_000));
    expect(await readOpenIngestionRejections(db, chainKey)).toHaveLength(0);
    const stored = await db.query(
      "SELECT reconciled_at, attempts FROM ingestion_rejection WHERE chain_key = $1",
      [chainKey],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.reconciled_at).toBeInstanceOf(Date);
    expect(stored.rows[0]?.attempts).toBe(1);
  });

  it("reopens a reconciled source on a repeat failure instead of adding a row", async () => {
    const chainKey = "rejection-reopen";
    await recordIngestionRejection(db, { ...source(chainKey), errorClass: "decode_error" });
    expect(await reconcileIngestionRejection(db, source(chainKey))).toBe(true);
    expect(await reconcileIngestionRejection(db, source(chainKey))).toBe(false);
    await recordIngestionRejection(db, { ...source(chainKey), errorClass: "unknown_event" });
    const [open, ...rest] = await readOpenIngestionRejections(db, chainKey);
    expect(rest).toHaveLength(0);
    expect(open).toMatchObject({ errorClass: "unknown_event", attempts: 2, reconciledAt: null });
    await recordIngestionRejection(db, {
      ...source(chainKey),
      position: "other",
      errorClass: "ordering_conflict",
    });
    expect((await readOpenIngestionRejections(db, chainKey))[1]?.replayEligible).toBe(false);
  });

  it("keeps payload and retry metadata bounded and credential-free", async () => {
    const chainKey = "rejection-bounds";
    await recordIngestionRejection(db, {
      ...source(chainKey),
      errorClass: "decode_error",
      detail:
        "ScValError at postgres://hyperion:hunter2@db.internal/hyperion password=hunter2 Bearer abc.def",
      payload: {
        apiKey: "hunter2",
        authorization: "Bearer hunter2",
        note: "token=hunter2",
        nested: { secret: "hunter2" },
        huge: "x".repeat(100_000),
        count: 3n,
      },
    });
    const [stored] = await readOpenIngestionRejections(db, chainKey);
    const serialized = JSON.stringify(stored, (_k, v: unknown) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("db.internal");
    expect(stored?.detail?.length).toBeLessThanOrEqual(256);
    expect(stored?.payload).toEqual({
      note: "[redacted credential]",
      huge: "x".repeat(256),
      count: "3",
    });
    expect(boundRejectionDetail("Bearer abc")).toBe("Bearer [redacted]");

    // The schema enforces the same bounds against any writer that bypasses the helper.
    const insert = (detail: string, payload: string, attempts = 1) =>
      pg.query(
        `INSERT INTO ingestion_rejection
           (chain_key, family, contract, block_number, tx_hash, source_position, error_class,
            replay_eligible, detail, payload, attempts)
         VALUES ('rejection-check', 'evm', '0xrouter', 1, '0xtx', '1', 'decode_error', true,
                 $1, $2::jsonb, $3)`,
        [detail, payload, attempts],
      );
    await expect(insert("see postgres://u:p@host/db", "{}")).rejects.toThrow();
    await expect(insert("password=hunter2", "{}")).rejects.toThrow();
    await expect(insert("ok", JSON.stringify({ blob: "y".repeat(5000) }))).rejects.toThrow();
    await expect(insert("ok", "{}", 0)).rejects.toThrow();
    await expect(
      pg.query(
        `INSERT INTO ingestion_rejection
           (chain_key, family, contract, block_number, tx_hash, source_position, error_class,
            replay_eligible)
         VALUES ('rejection-check', 'evm', '0xrouter', 1, '0xtx', '2', 'provider_said_so', true)`,
      ),
    ).rejects.toThrow();
  });

  it("prunes only reconciled rejections, in bounded batches", async () => {
    const chainKey = "rejection-prune";
    await recordIngestionRejection(db, { ...source(chainKey), errorClass: "decode_error" });
    await recordIngestionRejection(db, {
      ...source(chainKey),
      position: "still-open",
      errorClass: "decode_error",
    });
    await reconcileIngestionRejection(db, source(chainKey));
    const future = new Date(Date.now() + 60_000);
    // Each batch is bounded; drain until nothing reconciled remains.
    let batches = 0;
    while ((await pruneReconciledIngestionRejections(db, future, 1)) === 1) batches += 1;
    expect(batches).toBeGreaterThanOrEqual(1);
    expect(
      (await db.query("SELECT 1 FROM ingestion_rejection WHERE reconciled_at IS NOT NULL")).rows,
    ).toHaveLength(0);
    const left = await readOpenIngestionRejections(db, chainKey);
    expect(left.map((row) => row.position)).toEqual(["still-open"]);
    await expect(pruneReconciledIngestionRejections(db, future, 0)).rejects.toThrow(RangeError);
  });
});
