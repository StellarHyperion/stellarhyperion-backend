import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "../../src/db/pool.js";

const connection = process.env.TEST_DATABASE_URL;
(connection ? describe : describe.skip)("public query cancellation on PostgreSQL", () => {
  let db: Database;
  beforeAll(() => {
    db = Database.open(connection ?? "", { maxConnections: 1, statementTimeoutMs: 3000 });
  });
  afterAll(() => db.close());
  it("cancels server work and reuses the same connection without cancelling its next query", async () => {
    const initial = (await db.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error("request abandoned"));
    }, 50);
    const start = performance.now();
    try {
      await expect(
        db.query("SELECT pg_sleep(2)", [], { signal: controller.signal }),
      ).rejects.toThrow("request abandoned");
    } finally {
      clearTimeout(timer);
    }
    expect(performance.now() - start).toBeLessThan(1000);
    const next = await db.query("SELECT pg_backend_pid() AS pid, 42 AS value");
    expect(next.rows[0]).toEqual({ pid: initial, value: 42 });
  });
  it("rolls back a cancelled transaction and leaves its connection usable", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error("transaction read expired"));
    }, 50);
    try {
      await expect(
        db.transaction((tx) => tx.query("SELECT pg_sleep(2)", [], { signal: controller.signal })),
      ).rejects.toThrow("transaction read expired");
    } finally {
      clearTimeout(timer);
    }
    await expect(db.query("SELECT 1 AS healthy")).resolves.toMatchObject({
      rows: [{ healthy: 1 }],
    });
  });
});
