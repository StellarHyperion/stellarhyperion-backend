import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "../../src/db/pool.js";
import { acquireLease } from "../../src/chains/writers.js";
import { readCursor, writeCursor, StaleCursorError } from "../../src/chains/stellar/store.js";
import { concurrencyBarrier, runConcurrent, validateConcurrencyDatabase } from "../helpers.js";

const connection = process.env.TEST_DATABASE_URL;
(connection ? describe : describe.skip)("real concurrent worker fault boundaries", () => {
  const db = Database.open(connection ?? "", { maxConnections: 4 });
  let prepared = false;
  const chain = `concurrency-${process.pid}`;
  const table = `public.hyperion_worker_stress_${process.pid}`;
  beforeAll(async () => {
    validateConcurrencyDatabase(
      connection ?? "",
      process.env.HYPERION_ALLOW_REMOTE_CONCURRENCY_TEST_DATABASE === "true",
    );
    await db.query(`CREATE TABLE ${table} (id integer PRIMARY KEY, value integer NOT NULL)`);
    await db.query(`INSERT INTO ${table} VALUES (1,0),(2,0)`);
    prepared = true;
  });
  afterAll(async () => {
    if (!prepared) {
      await db.close();
      return;
    }
    await db.query("DELETE FROM indexer_lease WHERE chain_key=$1", [chain]);
    await db.query("DELETE FROM indexer_cursor WHERE chain_key=$1", [chain]);
    await db.query(`DROP TABLE IF EXISTS ${table}`);
    await db.close();
  });

  it("admits exactly one competing watcher lease and one full-width cursor revision", async () => {
    const start = concurrencyBarrier(2);
    const leases = await runConcurrent(2, (worker) =>
      db.transaction(async (tx) => {
        await start.wait();
        return acquireLease(tx, {
          chainKey: chain,
          contract: "CROUTER",
          ownerId: `worker-${worker}`,
          ttlMs: 30000,
        });
      }),
    );
    expect(
      leases.filter((result) => result.status === "fulfilled" && result.value !== null),
    ).toHaveLength(1);
    const cursors = concurrencyBarrier(2);
    const outcomes = await runConcurrent(2, () =>
      db.transaction(async (tx) => {
        expect(await readCursor(tx, chain)).toBeNull();
        await cursors.wait();
        await writeCursor(tx, {
          chainKey: chain,
          family: "stellar",
          contract: "CROUTER",
          position: 18446744073709551615n,
          observedAt: null,
          hash: null,
          expectedRevision: null,
        });
      }),
    );
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toBeInstanceOf(
      StaleCursorError,
    );
    expect((await readCursor(db, chain))?.position).toBe(18446744073709551615n);
  });

  it("rolls back one genuine deadlock victim and reuses the healthy pool", async () => {
    const locked = concurrencyBarrier(2);
    const outcomes = await runConcurrent(2, (worker) =>
      db.transaction(async (tx) => {
        await tx.query(`UPDATE ${table} SET value=value+1 WHERE id=$1`, [worker + 1]);
        await locked.wait();
        await tx.query(`UPDATE ${table} SET value=value+1 WHERE id=$1`, [2 - worker]);
      }),
    );
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toMatchObject({
      code: "40P01",
    });
    expect((await db.query(`SELECT value FROM ${table} ORDER BY id`)).rows).toEqual([
      { value: 1 },
      { value: 1 },
    ]);
    await db.transaction((tx) => tx.query(`UPDATE ${table} SET value=value+1`));
    expect((await db.query(`SELECT value FROM ${table} ORDER BY id`)).rows).toEqual([
      { value: 2 },
      { value: 2 },
    ]);
  });

  it("recovers a real lock timeout without a partial cursor update", async () => {
    let locked!: () => void;
    let release!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await tx.query(`SELECT id FROM ${table} WHERE id=1 FOR UPDATE`);
      locked();
      await done;
    });
    await acquired;
    try {
      await expect(
        db.transaction(async (tx) => {
          await tx.query("SET LOCAL lock_timeout='100ms'");
          await tx.query("UPDATE indexer_cursor SET last_processed=1 WHERE chain_key=$1", [chain]);
          await tx.query(`UPDATE ${table} SET value=99 WHERE id=1`);
        }),
      ).rejects.toMatchObject({
        code: "DATABASE_TIMEOUT",
        name: "DatabaseTimeoutError",
        kind: "lock",
      });
    } finally {
      release();
      await holder;
    }
    expect((await readCursor(db, chain))?.position).toBe(18446744073709551615n);
    await db.transaction((tx) => tx.query(`UPDATE ${table} SET value=value+1 WHERE id=1`));
    expect((await db.query(`SELECT value FROM ${table} WHERE id=1`)).rows[0]?.value).toBe(3);
  });
});
