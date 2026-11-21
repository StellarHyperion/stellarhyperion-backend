/**
 * The whole EVM path, from captured chain logs to rows in a real Postgres.
 *
 * The input is not hand written. It is every log the router emitted during a full run of
 * `contracts/script/anvil-e2e.sh`: deploy, seven queued actions, the timelock refusing an early
 * execution, seven executions, and one real transfer through CCTP. Twenty nine logs, captured with
 * their real block hashes and timestamps. So this checks the ABI decoding, the mappers, the shared
 * writers and the schema's constraints against the one input that cannot be wrong about the
 * encoding.
 *
 * Rows are namespaced by chain key rather than by a schema, the same as the Stellar replay suite:
 * every natural key starts with the chain, and `SET search_path` on a pool lands on one connection
 * while `transaction()` takes a different one.
 *
 * Skipped without `TEST_DATABASE_URL`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  readEvmFinalityPolicyChanges,
  readLatestEvmScanProvenance,
} from "../../src/chains/evm/store.js";
import { EvmWatcher } from "../../src/chains/evm/watcher.js";
import { Database } from "../../src/db/pool.js";
import {
  ANVIL_CHAIN_ID,
  ANVIL_HEAD,
  ANVIL_ROUTER,
  ANVIL_START_BLOCK,
  FakeEvmClient,
} from "../evm-fakes.js";
import { capturingLogger } from "../stellar-fakes.js";

const CONNECTION = process.env.TEST_DATABASE_URL;
const suite = CONNECTION === undefined ? describe.skip : describe;

/** Not a real chain key, so these rows cannot collide with a developer's own indexer. */
const CHAIN = "evm-replay-test";

const TABLES = [
  ["admin_action", "chain"],
  ["route_health", "origin_chain"],
  ["outbound_transfer", "origin_chain"],
  ["inbound_delivery", "destination_chain"],
  ["pending_claim", "chain"],
] as const;

suite("replaying the anvil deployment's logs", () => {
  let db: Database;

  const clean = async (): Promise<void> => {
    for (const [table, column] of TABLES) {
      await db.query(`DELETE FROM ${table} WHERE ${column} = $1`, [CHAIN]);
    }
    await db.query("DELETE FROM indexer_cursor WHERE chain_key = $1", [CHAIN]);
    await db.query("DELETE FROM indexer_lease WHERE chain_key = $1", [CHAIN]);
    await db.query("DELETE FROM evm_scan_provenance WHERE chain_key = $1", [CHAIN]);
    await db.query("DELETE FROM evm_applied_event WHERE chain_key = $1", [CHAIN]);
  };

  /** Run the watcher to the confirmation line, the way the poller would. */
  const drain = async (
    logRange = 2_000,
    providerRangeLimit = Number.MAX_SAFE_INTEGER,
  ): Promise<number> => {
    const { logger } = capturingLogger();
    const client = new FakeEvmClient({ head: ANVIL_HEAD });
    const readLogs = client.logs.bind(client);
    client.logs = (query) =>
      query.toBlock - query.fromBlock + 1n > BigInt(providerRangeLimit)
        ? Promise.reject(new Error("block range is too wide"))
        : readLogs(query);
    const watcher = new EvmWatcher({
      chainKey: CHAIN,
      router: ANVIL_ROUTER,
      chainId: ANVIL_CHAIN_ID,
      startBlock: ANVIL_START_BLOCK,
      confirmations: 0,
      reorgDepth: 5,
      logRange,
      releaseLeaseOnTick: true,
      client,
      db,
      logger,
    });
    let passes = 0;
    while (await watcher.tick(AbortSignal.timeout(20_000))) {
      passes += 1;
      if (passes > 50) throw new Error("the watcher never reported catching up");
    }
    return passes + 1;
  };

  beforeAll(async () => {
    db = Database.open(CONNECTION ?? "", { applicationName: "hyperion-evm-replay-test" });
    await clean();
    await drain();
  });

  afterAll(async () => {
    await clean();
    await db.close();
  });

  it("leaves an evm cursor at the head, with the block hash that makes a reorg visible", async () => {
    const { rows } = await db.query(
      `SELECT family, contract, last_processed, last_processed_hash, last_processed_at
         FROM indexer_cursor WHERE chain_key = $1`,
      [CHAIN],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.family).toBe("evm");
    expect(rows[0]?.contract).toBe(ANVIL_ROUTER);
    expect(BigInt(String(rows[0]?.last_processed))).toBe(ANVIL_HEAD);
    // The column added for exactly this. A cursor without it cannot tell advancing from being
    // handed a different history.
    expect(rows[0]?.last_processed_hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("records the one real transfer, down to the amounts the router split", async () => {
    const { rows } = await db.query(
      `SELECT route, nonce, sender, token, gross_amount, fee, net_amount, destination_chain,
              destination, origin_tx, origin_log_index
         FROM outbound_transfer WHERE origin_chain = $1`,
      [CHAIN],
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    // 30 bps of 1000000 is 3000, and the router takes its fee on the raw amount then floors the
    // remainder, in that order.
    expect(row?.gross_amount).toBe("1000000");
    expect(row?.fee).toBe("3000");
    expect(row?.net_amount).toBe("997000");
    expect(Number(row?.nonce)).toBe(1);
    expect(row?.route).toBe(0);
    expect(row?.destination_chain).toBe("stellar-testnet");
    // A strkey as a string, because that is what this router emits. The Soroban router emits a
    // 32 byte word for the same column and neither is converted into the other.
    expect(row?.destination).toMatch(/^G[A-Z2-7]{55}$/);
    // Present here and null on every Stellar row, because Soroban orders events within a
    // transaction rather than over a block.
    expect(row?.origin_log_index).not.toBeNull();
  });

  it("lowercases addresses, so one address has one spelling", async () => {
    // viem checksums what it decodes. A checksummed row sitting next to a lowercased one is two
    // rows to any query that compares them.
    const { rows } = await db.query(
      "SELECT sender, token FROM outbound_transfer WHERE origin_chain = $1",
      [CHAIN],
    );
    expect(rows[0]?.sender).toBe(String(rows[0]?.sender).toLowerCase());
    expect(rows[0]?.token).toBe(String(rows[0]?.token).toLowerCase());
  });

  it("records all seven actions and the chain's own discriminant for each", async () => {
    const { rows } = await db.query(
      "SELECT action_id, state, kind FROM admin_action WHERE chain = $1 ORDER BY action_id",
      [CHAIN],
    );
    expect(rows).toHaveLength(7);
    expect(rows.every((row) => row.state === "executed")).toBe(true);
    // Unlike Soroban, the EVM event carries a real enum ordinal on an indexed topic, so this
    // column means something on an EVM row and is always zero on a Stellar one.
    expect(rows.some((row) => Number(row.kind) > 0)).toBe(true);
  });

  it("samples route health from the token registration and both route events", async () => {
    const { rows } = await db.query(
      `SELECT route, token, available, blocker, flow_available
         FROM route_health WHERE origin_chain = $1 ORDER BY id`,
      [CHAIN],
    );
    // One TokenRegistered plus two RouteConfigured.
    expect(rows).toHaveLength(3);
    const registration = rows.find((row) => row.flow_available !== null);
    expect(registration?.flow_available).toBe("1000000000000");
    expect(registration?.available).toBe(true);
  });

  it("writes no inbound rows, because nothing has arrived on this router yet", async () => {
    const { rows } = await db.query(
      "SELECT count(*)::int AS n FROM inbound_delivery WHERE destination_chain = $1",
      [CHAIN],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("writes no row twice when the whole history is replayed over itself", async () => {
    // The restart case. A watcher re-reading a range after a crash, or after a reorg wound the
    // cursor back, has to correct rather than duplicate.
    const before = await snapshot(db);

    await db.query("DELETE FROM indexer_cursor WHERE chain_key = $1", [CHAIN]);
    await drain();

    expect(await snapshot(db)).toEqual(before);
  });

  it("gets the same rows whether it reads one range or twenty", async () => {
    // The log range is an endpoint's limit rather than a property of the data, so the rows must
    // not depend on it. A claim paired across a range boundary would show up here.
    await clean();
    await drain(2_000);
    const wide = await snapshot(db);

    await clean();
    const passes = await drain(2);
    const narrow = await snapshot(db);

    expect(passes).toBeGreaterThan(5);
    expect(narrow).toEqual(wide);

    await clean();
    await drain();
  });

  it("recovers every block when the provider rejects the configured range", async () => {
    await clean();
    const normal = await drain();
    const expected = await snapshot(db);

    await clean();
    const splitPasses = await drain(2_000, 3);

    expect(splitPasses).toBe(normal);
    expect(await snapshot(db)).toEqual(expected);
    const { rows } = await db.query(
      "SELECT count(*)::int AS count FROM outbound_transfer WHERE origin_chain = $1",
      [CHAIN],
    );
    expect(rows[0]?.count).toBe(1);
  });

  it("records finality-policy provenance per committed scan and exposes policy changes", async () => {
    await clean();
    const { logger } = capturingLogger();
    const first = new EvmWatcher({
      chainKey: CHAIN,
      router: ANVIL_ROUTER,
      chainId: ANVIL_CHAIN_ID,
      startBlock: ANVIL_START_BLOCK,
      confirmations: 2,
      reorgDepth: 5,
      logRange: 2_000,
      ownerId: "worker-a",
      releaseLeaseOnTick: true,
      client: new FakeEvmClient({ head: ANVIL_HEAD }),
      db,
      logger,
    });
    await first.tick(AbortSignal.timeout(5_000));

    const latest = await readLatestEvmScanProvenance(db, CHAIN, ANVIL_ROUTER);
    expect(latest).not.toBeNull();
    expect(latest?.confirmations).toBe(2);
    expect(latest?.reorgDepth).toBe(5);
    expect(latest?.policyChanged).toBe(false);

    // Rewind cursor slightly and run with a changed confirmations policy
    await db.query("DELETE FROM indexer_cursor WHERE chain_key = $1", [CHAIN]);
    const second = new EvmWatcher({
      chainKey: CHAIN,
      router: ANVIL_ROUTER,
      chainId: ANVIL_CHAIN_ID,
      startBlock: ANVIL_START_BLOCK,
      confirmations: 0,
      reorgDepth: 6,
      logRange: 2_000,
      ownerId: "worker-b",
      releaseLeaseOnTick: true,
      client: new FakeEvmClient({ head: ANVIL_HEAD }),
      db,
      logger,
    });
    await second.tick(AbortSignal.timeout(5_000));

    expect(second.policyChanges).toHaveLength(1);
    const changes = await readEvmFinalityPolicyChanges(db, CHAIN, ANVIL_ROUTER);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      confirmations: 0,
      reorgDepth: 6,
      previousConfirmations: 2,
      previousReorgDepth: 5,
    });
  });

  it("coordinates multiple EVM watchers via expiring per-deployment database leases", async () => {
    await clean();
    const { logger } = capturingLogger();
    const client = new FakeEvmClient({ head: ANVIL_HEAD });

    const primary = new EvmWatcher({
      chainKey: CHAIN,
      router: ANVIL_ROUTER,
      chainId: ANVIL_CHAIN_ID,
      startBlock: ANVIL_START_BLOCK,
      confirmations: 0,
      reorgDepth: 5,
      logRange: 2,
      ownerId: "primary",
      leaseTtlMs: 30_000,
      client,
      db,
      logger,
    });
    const contender = new EvmWatcher({
      chainKey: CHAIN,
      router: ANVIL_ROUTER,
      chainId: ANVIL_CHAIN_ID,
      startBlock: ANVIL_START_BLOCK,
      confirmations: 0,
      reorgDepth: 5,
      logRange: 2,
      ownerId: "contender",
      leaseTtlMs: 30_000,
      client,
      db,
      logger,
    });

    await primary.tick(AbortSignal.timeout(5_000));
    const progressedByContender = await contender.tick(AbortSignal.timeout(5_000));
    expect(progressedByContender).toBe(false);
    expect(contender.progress).toBeNull();

    await primary.release();
    await contender.tick(AbortSignal.timeout(5_000));
    expect(contender.progress).not.toBeNull();
  });
});

/** Everything keyed, in a comparable shape. route_health is append only and deliberately absent. */
async function snapshot(db: Database): Promise<unknown> {
  const actions = await db.query(
    "SELECT action_id, state, kind, actor FROM admin_action WHERE chain = $1 ORDER BY action_id",
    [CHAIN],
  );
  const transfers = await db.query(
    `SELECT nonce, route, sender, token, gross_amount, fee, net_amount, destination,
            origin_block, origin_log_index
       FROM outbound_transfer WHERE origin_chain = $1 ORDER BY nonce`,
    [CHAIN],
  );
  const inbound = await db.query(
    `SELECT route, source_chain, source_nonce, rail_message_id, delivered, claim_id
       FROM inbound_delivery WHERE destination_chain = $1 ORDER BY source_nonce`,
    [CHAIN],
  );
  return { actions: actions.rows, transfers: transfers.rows, inbound: inbound.rows };
}
