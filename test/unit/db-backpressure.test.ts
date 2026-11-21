import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({ connect: vi.fn(), end: vi.fn(), on: vi.fn() }));
vi.mock("pg", () => ({
  Pool: class {
    connect = pg.connect;
    end = pg.end;
    on = pg.on;
    totalCount = 0;
    idleCount = 0;
    waitingCount = 0;
  },
  Client: vi.fn(),
}));
import { Database, DatabaseBackpressureError } from "../../src/db/pool.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function client() {
  return { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }), release: vi.fn() };
}
const databases: Database[] = [];
function open(options: Parameters<typeof Database.open>[1] = {}) {
  const db = Database.open("postgres://fixture", {
    maxConnections: 1,
    acquireTimeoutMs: 100,
    ...options,
  });
  databases.push(db);
  return db;
}
beforeEach(() => {
  vi.useFakeTimers();
  pg.connect.mockReset();
  pg.end.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
  vi.useRealTimers();
});

describe("bounded database acquisition", () => {
  it.each([0, -1, 1.5, 1001, Number.NaN])(
    "rejects invalid connection limit %s",
    (maxConnections) => {
      expect(() => Database.open("postgres://fixture", { maxConnections })).toThrow(RangeError);
    },
  );

  it("removes an aborted admission waiter immediately and preserves its reason", async () => {
    const held = deferred<ReturnType<typeof client>>();
    pg.connect.mockReturnValueOnce(held.promise);
    const db = open();
    const active = db.query("SELECT 1");
    await vi.advanceTimersByTimeAsync(0);
    const controller = new AbortController();
    const queued = db.query("SELECT 2", [], { signal: controller.signal });
    const reason = new Error("caller cancelled");
    const rejected = expect(queued).rejects.toBe(reason);
    expect(db.poolSnapshot().queuedRequests).toBe(1);
    controller.abort(reason);
    await rejected;
    expect(db.poolSnapshot().queuedRequests).toBe(0);
    expect(pg.connect).toHaveBeenCalledTimes(1);
    held.resolve(client());
    await active;
  });

  it("serves queued foreground work before an older background request", async () => {
    const held = deferred<{ rows: never[]; rowCount: number }>();
    const first = client();
    first.query.mockReturnValueOnce(held.promise);
    pg.connect.mockResolvedValueOnce(first).mockResolvedValue(client());
    const db = open();
    const active = db.query("active", [], { workload: "indexer" });
    await vi.advanceTimersByTimeAsync(0);
    const background = db.query("background", [], { workload: "indexer" });
    const foreground = db.query("foreground", [], { workload: "transfers" });
    held.resolve({ rows: [], rowCount: 0 });
    await Promise.all([active, background, foreground]);
    const second = await pg.connect.mock.results[1]?.value;
    expect(second.query.mock.calls.map((args: unknown[]) => args[0])).toEqual([
      "foreground",
      "background",
    ]);
  });

  it("rejects a full queue without creating more pg connection requests", async () => {
    const held = deferred<ReturnType<typeof client>>();
    pg.connect.mockReturnValueOnce(held.promise).mockResolvedValue(client());
    const db = open({ maxWaitingRequests: 1 });
    const active = db.query("active");
    await vi.advanceTimersByTimeAsync(0);
    const queued = db.query("queued");
    await expect(db.query("overflow")).rejects.toBeInstanceOf(DatabaseBackpressureError);
    expect(pg.connect).toHaveBeenCalledTimes(1);
    held.resolve(client());
    await Promise.all([active, queued]);
  });

  it("bounds slow connect and releases a late client before admitting another request", async () => {
    const held = deferred<ReturnType<typeof client>>();
    pg.connect.mockReturnValueOnce(held.promise).mockResolvedValue(client());
    const db = open();
    const active = db.query("active");
    const rejected = expect(active).rejects.toBeInstanceOf(DatabaseBackpressureError);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    const next = db.query("next");
    await vi.advanceTimersByTimeAsync(0);
    expect(pg.connect).toHaveBeenCalledTimes(1);
    const late = client();
    held.resolve(late);
    await next;
    expect(late.release).toHaveBeenCalledOnce();
    expect(late.query).not.toHaveBeenCalled();
    expect(pg.connect).toHaveBeenCalledTimes(2);
  });

  it("uses one absolute deadline across queue admission and connect", async () => {
    const first = client();
    const query = deferred<{ rows: never[]; rowCount: number }>();
    const connection = deferred<ReturnType<typeof client>>();
    first.query.mockReturnValueOnce(query.promise);
    pg.connect.mockResolvedValueOnce(first).mockReturnValueOnce(connection.promise);
    const db = open();
    const active = db.query("active");
    await vi.advanceTimersByTimeAsync(0);
    const queued = db.query("queued");
    const rejected = expect(queued).rejects.toBeInstanceOf(DatabaseBackpressureError);
    await vi.advanceTimersByTimeAsync(70);
    query.resolve({ rows: [], rowCount: 0 });
    await active;
    await vi.advanceTimersByTimeAsync(30);
    await rejected;
    connection.resolve(client());
    await vi.advanceTimersByTimeAsync(0);
  });

  it("rejects queued acquisition during shutdown", async () => {
    const held = deferred<ReturnType<typeof client>>();
    pg.connect.mockReturnValueOnce(held.promise);
    const db = open();
    const active = db.query("active");
    await vi.advanceTimersByTimeAsync(0);
    const queued = db.query("queued");
    const rejected = expect(queued).rejects.toBeInstanceOf(DatabaseBackpressureError);
    await db.close();
    await rejected;
    held.resolve(client());
    await active;
    expect(db.poolSnapshot().queuedRequests).toBe(0);
  });
});
