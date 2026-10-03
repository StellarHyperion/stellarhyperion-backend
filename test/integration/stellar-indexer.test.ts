/**
 * The whole Stellar path, from captured chain events to rows in a real Postgres.
 *
 * The input is not a fixture somebody wrote. It is every event the deployed router at
 * CDMOLDF4...WCWF had emitted when this was captured, seventeen of them across eleven thousand
 * ledgers, pulled with `getEvents` and `xdrFormat: "json"`. So this suite checks the decoder, the
 * upserts, the constraints and the cursor against the one input that cannot be wrong about the
 * encoding, and it is the only test here that would notice a `COMMENT ON` column rename or a check
 * constraint the writers quietly violate.
 *
 * Rows are namespaced by chain key rather than by a schema. Every natural key in the schema starts
 * with the chain, so a made up chain key isolates this suite without a `search_path` that a pooled
 * connection might not be holding when the transaction opens.
 *
 * Skipped without `TEST_DATABASE_URL`, so `npm test` on a machine with no database still runs the
 * unit suite rather than failing in a way somebody learns to ignore.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { StellarWatcher } from "../../src/chains/stellar/watcher.js";
import { Database } from "../../src/db/pool.js";
import { FakeRpc, LIVE_ROUTER, ROUTER_HISTORY, capturingLogger } from "../stellar-fakes.js";

const CONNECTION = process.env.TEST_DATABASE_URL;
const suite = CONNECTION === undefined ? describe.skip : describe;

/** Not a real chain key, so these rows cannot collide with a developer's own indexer. */
const CHAIN = "stellar-replay-test";
/** The ledger the first captured event landed in, which is before the record's deployedAt. */
const FIRST_EVENT_LEDGER = 4_965_951;
/** The head when the capture was taken. */
const HEAD = 4_994_010;

const TABLES = [
  ["admin_action", "chain"],
  ["route_health", "origin_chain"],
  ["outbound_transfer", "origin_chain"],
  ["inbound_delivery", "destination_chain"],
  ["pending_claim", "chain"],
] as const;

suite("replaying the live router's history", () => {
  let db: Database;

  const clean = async (): Promise<void> => {
    for (const [table, column] of TABLES) {
      await db.query(`DELETE FROM ${table} WHERE ${column} = $1`, [CHAIN]);
    }
    await db.query("DELETE FROM indexer_cursor WHERE chain_key = $1", [CHAIN]);
  };

  /** Run the watcher to the head, the way the poller would, and say how many passes it took. */
  const drain = async (): Promise<number> => {
    const { logger } = capturingLogger();
    const watcher = new StellarWatcher({
      chainKey: CHAIN,
      router: LIVE_ROUTER,
      startLedger: FIRST_EVENT_LEDGER,
      pageSize: 200,
      rpc: new FakeRpc({ events: ROUTER_HISTORY, latestLedger: HEAD }),
      db,
      logger,
    });
    let passes = 0;
    while (await watcher.tick(AbortSignal.timeout(20_000))) {
      passes += 1;
      if (passes > 20) throw new Error("the watcher never reported catching up");
    }
    return passes + 1;
  };

  beforeAll(async () => {
    db = Database.open(CONNECTION ?? "", { applicationName: "hyperion-stellar-replay-test" });
    // Before as well as after, so a run that crashed last time does not poison this one.
    await clean();
    await drain();
  });

  afterAll(async () => {
    await clean();
    await db.close();
  });

  it("needs more than one pass, because the history is wider than one scan window", async () => {
    // Eleven thousand ledgers of history against a ten thousand ledger window. A watcher that
    // believed one empty page meant it had caught up would stop after the first.
    await clean();
    expect(await drain()).toBeGreaterThan(1);
    await clean();
    await drain();
  });

  it("leaves the cursor at the head, naming the router it belongs to", async () => {
    const { rows } = await db.query(
      "SELECT family, contract, last_processed, last_processed_at FROM indexer_cursor WHERE chain_key = $1",
      [CHAIN],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.family).toBe("stellar");
    expect(rows[0]?.contract).toBe(LIVE_ROUTER);
    expect(Number(rows[0]?.last_processed)).toBe(HEAD);
    // The chain's own timestamp at the cursor, not ours. Lag measured against our clock would
    // hide a watcher that has stopped advancing.
    expect(rows[0]?.last_processed_at).toBeInstanceOf(Date);
  });

  it("records every queued action once, and the seven of them that the chain queued", async () => {
    const { rows } = await db.query(
      "SELECT action_id, state FROM admin_action WHERE chain = $1 ORDER BY action_id",
      [CHAIN],
    );
    expect(rows).toHaveLength(7);
  });

  it("settles each action the way the chain settled it", async () => {
    // Four executed and three cancelled, which is the deployment record's own account: it lists
    // action ids 1, 2, 3 and 7 as the ones that went through.
    const { rows } = await db.query(
      "SELECT state, count(*)::int AS n FROM admin_action WHERE chain = $1 GROUP BY state ORDER BY state",
      [CHAIN],
    );
    expect(rows).toEqual([
      { state: "cancelled", n: 3 },
      { state: "executed", n: 4 },
    ]);

    const executed = await db.query(
      "SELECT action_id FROM admin_action WHERE chain = $1 AND state = 'executed' ORDER BY action_id",
      [CHAIN],
    );
    expect(executed.rows.map((row) => Number(row.action_id))).toEqual([1, 2, 3, 7]);
  });

  it("keeps the queued payload the chain emitted rather than a decoder's summary", async () => {
    const { rows } = await db.query(
      "SELECT payload FROM admin_action WHERE chain = $1 AND action_id = 1",
      [CHAIN],
    );
    const payload = rows[0]?.payload as { variant?: unknown; action?: unknown };
    // The variant name, because the Soroban union carries no discriminant the wire exposes, plus
    // the raw ScVal so a reviewer reads what the chain said and not what this build made of it.
    expect(typeof payload.variant).toBe("string");
    expect(payload.action).toBeDefined();
  });

  it("samples route health from the token and route events", async () => {
    const { rows } = await db.query(
      "SELECT route, token, available, blocker, flow_available FROM route_health WHERE origin_chain = $1 ORDER BY id",
      [CHAIN],
    );
    expect(rows).toHaveLength(2);
    // The token registration carries the flow limit the router was configured with.
    const withFlow = rows.find((row) => row.flow_available !== null);
    expect(withFlow?.flow_available).toBe("10000000000000");
    expect(withFlow?.available).toBe(true);
    // The route event names the rail on its topic. 1 is axelar-its, which is the rail this
    // deployment enabled.
    const route = rows.find((row) => row.flow_available === null);
    expect(route?.route).toBe(1);
    expect(route?.blocker).toBe(0);
  });

  it("writes no transfer rows, because this router has not carried one yet", async () => {
    // Worth asserting rather than leaving implicit. A decoder that mapped an administrative event
    // onto a transfer would invent money moving, and this is the assertion that notices.
    for (const table of ["outbound_transfer", "inbound_delivery"] as const) {
      const column = table === "outbound_transfer" ? "origin_chain" : "destination_chain";
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`,
        [CHAIN],
      );
      expect(rows[0]?.n, table).toBe(0);
    }
  });

  it("writes no row twice when the whole history is replayed over itself", async () => {
    // The restart case, and the claim every insert being an upsert exists to support. A watcher
    // re-reading a ledger after a crash has to be a no-op rather than a duplicate or an error.
    const before = await snapshot(db);

    await db.query("DELETE FROM indexer_cursor WHERE chain_key = $1", [CHAIN]);
    const passes = await drain();

    expect(passes).toBeGreaterThan(1);
    expect(await snapshot(db)).toEqual(before);
  });

  it("appends route health samples on a replay, because that table is a time series", async () => {
    // The one table a replay is not idempotent against, and it is by design rather than by
    // oversight: route_health is append only, keyed on nothing, because the useful question is how
    // a route behaved over an hour and not what it says this second. Both copies carry the chain's
    // own timestamp, so they are the same sample twice and a median over them is unchanged. What
    // grows is the row count, which is the price of not putting a unique key on a sample.
    //
    // Pinned here rather than left to be discovered, because the obvious reading of the upsert
    // comment on every other writer is that this one dedupes too.
    const count = async (): Promise<number> => {
      const { rows } = await db.query(
        "SELECT count(*)::int AS n FROM route_health WHERE origin_chain = $1",
        [CHAIN],
      );
      return Number(rows[0]?.n);
    };
    // From a clean table, so the assertion does not depend on what the tests before it left.
    await clean();
    await drain();
    const once = await count();
    expect(once).toBeGreaterThan(0);

    await db.query("DELETE FROM indexer_cursor WHERE chain_key = $1", [CHAIN]);
    await drain();
    expect(await count()).toBe(once * 2);

    await clean();
    await drain();
  });

  it("refuses to carry the cursor over to a router at another address", async () => {
    const { logger } = capturingLogger();
    const other = new StellarWatcher({
      chainKey: CHAIN,
      router: "CBK3TPRQR5A3H2AWESOUX4MVYOP63VNQ5EYHCX26EEJUC5B5FLB4DV5O",
      startLedger: FIRST_EVENT_LEDGER,
      pageSize: 200,
      rpc: new FakeRpc({ events: ROUTER_HISTORY, latestLedger: HEAD }),
      db,
      logger,
    });

    await expect(other.tick(AbortSignal.timeout(20_000))).rejects.toThrow(
      /needs its cursor reset rather than reused/,
    );
  });
});

/** Everything this suite wrote, in a comparable shape. */
async function snapshot(db: Database): Promise<unknown> {
  const actions = await db.query(
    "SELECT action_id, state, kind, payload, actor FROM admin_action WHERE chain = $1 ORDER BY action_id",
    [CHAIN],
  );
  const claims = await db.query(
    "SELECT claim_id, settled, settled_by FROM pending_claim WHERE chain = $1 ORDER BY claim_id",
    [CHAIN],
  );
  const transfers = await db.query(
    "SELECT nonce, route, net_amount FROM outbound_transfer WHERE origin_chain = $1 ORDER BY nonce",
    [CHAIN],
  );
  // route_health is deliberately absent: it is an append only series with no natural key, and the
  // test above is the one that says so.
  return { actions: actions.rows, claims: claims.rows, transfers: transfers.rows };
}
