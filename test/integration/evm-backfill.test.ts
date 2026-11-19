import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Database, type Transactional } from "../../src/db/pool.js";
import { EvmBackfillManager } from "../../src/chains/evm/backfill.js";
import { EvmWatcher } from "../../src/chains/evm/watcher.js";
import type { EvmWatchConfig } from "../../src/config/config.js";
import {
  ANVIL_CHAIN_ID,
  ANVIL_ROUTER,
  ANVIL_START_BLOCK,
  ANVIL_HEAD,
  FakeEvmClient,
} from "../evm-fakes.js";
import { capturingLogger } from "../stellar-fakes.js";
import { buildServer } from "../../src/http/server.js";
import { loadConfig } from "../../src/config/config.js";
import { completeEnv } from "../helpers.js";

const connection = process.env.TEST_DATABASE_URL;
const suite = connection ? describe : describe.skip;
suite("durable bounded EVM historical jobs", () => {
  let db: Database;
  const config: EvmWatchConfig = {
    chain: "arc-testnet",
    chainId: ANVIL_CHAIN_ID,
    rpcUrl: "https://provider.invalid",
    rpcUrls: ["https://provider.invalid"],
    routerAddress: ANVIL_ROUTER,
    startBlock: ANVIL_START_BLOCK,
    confirmations: 0,
    reorgDepth: 5,
    logRange: 2000,
    pollIntervalMs: 1000,
  };
  const logger = capturingLogger().logger;
  const manager = (client = new FakeEvmClient({ head: 1000n }), options = config) =>
    new EvmBackfillManager([options], db, logger, () => client);
  const clean = async () => {
    await db.query("DELETE FROM evm_backfill_job WHERE chain_key = $1", [config.chain]);
    await db.query("DELETE FROM evm_applied_event WHERE chain_key = $1", [config.chain]);
    await db.query("DELETE FROM outbound_transfer WHERE origin_chain = $1", [config.chain]);
    await db.query("DELETE FROM route_health WHERE origin_chain = $1", [config.chain]);
    await db.query("DELETE FROM admin_action WHERE chain = $1", [config.chain]);
    await db.query("DELETE FROM pending_claim WHERE chain = $1", [config.chain]);
    await db.query("DELETE FROM inbound_delivery WHERE destination_chain = $1", [config.chain]);
    await db.query("DELETE FROM indexer_cursor WHERE chain_key = $1", [config.chain]);
  };
  beforeAll(() => {
    db = Database.open(connection ?? "");
  });
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await db.close();
  });
  it("persists a cancelled boundary across manager recreation", async () => {
    const first = manager();
    const job = await first.start("operator", config.chain, ANVIL_START_BLOCK, ANVIL_HEAD);
    await first.cancel(job.id, "operator");
    const restored = await manager().get(job.id);
    expect(restored).toMatchObject({ state: "cancelled", next: ANVIL_START_BLOCK.toString() });
  });
  it("rolls back an interrupted page and resumes from the last committed boundary", async () => {
    const pageConfig = { ...config, logRange: 2 };
    const client = new FakeEvmClient({ head: 1000n, logs: [] });
    const original = client.logs.bind(client);
    client.logs = async (query) => {
      if (query.fromBlock > ANVIL_START_BLOCK)
        throw new Error("provider credential details must remain private");
      return original(query);
    };
    const first = manager(client, pageConfig);
    const job = await first.start(
      "operator",
      config.chain,
      ANVIL_START_BLOCK,
      ANVIL_START_BLOCK + 3n,
    );
    const failed = await first.run(job.id, "operator", new AbortController().signal);
    expect(failed).toMatchObject({ state: "failed", next: (ANVIL_START_BLOCK + 2n).toString() });
    expect(failed.error).not.toContain("credential");
    const restarted = manager(new FakeEvmClient({ head: 1000n, logs: [] }), pageConfig);
    expect(await restarted.resume(job.id, "operator", new AbortController().signal)).toMatchObject({
      state: "completed",
      next: (ANVIL_START_BLOCK + 4n).toString(),
    });
  });
  it("refuses unconfirmed history without advancing its progress", async () => {
    const worker = manager(new FakeEvmClient({ head: ANVIL_START_BLOCK + 5n, logs: [] }), {
      ...config,
      confirmations: 3,
    });
    const job = await worker.start(
      "operator",
      config.chain,
      ANVIL_START_BLOCK,
      ANVIL_START_BLOCK + 4n,
    );
    expect(await worker.run(job.id, "operator", new AbortController().signal)).toMatchObject({
      state: "failed",
      next: ANVIL_START_BLOCK.toString(),
    });
  });
  it("shares exactly-once materialization with live ingestion and preserves the live cursor", async () => {
    const client = new FakeEvmClient({ head: ANVIL_HEAD });
    const live = new EvmWatcher({
      chainKey: config.chain,
      router: config.routerAddress,
      chainId: config.chainId,
      startBlock: config.startBlock,
      confirmations: 0,
      reorgDepth: 5,
      logRange: 2000,
      client,
      db,
      logger,
    });
    await live.tick(new AbortController().signal);
    const cursor = await db.query(
      "SELECT last_processed FROM indexer_cursor WHERE chain_key = $1",
      [config.chain],
    );
    const before = await db.query(
      "SELECT count(*)::integer AS count FROM route_health WHERE origin_chain = $1",
      [config.chain],
    );
    const worker = manager(client);
    const job = await worker.start("operator", config.chain, ANVIL_START_BLOCK, ANVIL_HEAD);
    expect((await worker.run(job.id, "operator", new AbortController().signal)).state).toBe(
      "completed",
    );
    expect(
      await db.query("SELECT last_processed FROM indexer_cursor WHERE chain_key = $1", [
        config.chain,
      ]),
    ).toEqual(cursor);
    expect(
      await db.query(
        "SELECT count(*)::integer AS count FROM route_health WHERE origin_chain = $1",
        [config.chain],
      ),
    ).toEqual(before);
  });
  it("rolls back event writes when saving the page boundary fails", async () => {
    const failingDb: Transactional = {
      query: db.query.bind(db),
      transaction: (work) =>
        db.transaction((tx) =>
          work({
            query: async (query, params) => {
              if (query.startsWith("UPDATE evm_backfill_job SET next_block"))
                throw new Error("interrupted boundary write");
              return tx.query(query, params);
            },
          }),
        ),
    };
    const worker = new EvmBackfillManager(
      [config],
      failingDb,
      logger,
      () => new FakeEvmClient({ head: ANVIL_HEAD }),
    );
    const job = await worker.start("operator", config.chain, ANVIL_START_BLOCK, ANVIL_HEAD);
    expect(await worker.run(job.id, "operator", new AbortController().signal)).toMatchObject({
      state: "failed",
      next: ANVIL_START_BLOCK.toString(),
    });
    const { rows } = await db.query(
      "SELECT count(*)::integer AS count FROM evm_applied_event WHERE chain_key = $1",
      [config.chain],
    );
    expect(rows[0]?.count).toBe(0);
    expect(
      (
        await manager(new FakeEvmClient({ head: ANVIL_HEAD })).resume(
          job.id,
          "operator",
          new AbortController().signal,
        )
      ).state,
    ).toBe("completed");
  });
  it("does not let a second replica alter a range another worker owns", async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = new FakeEvmClient({ head: 1000n, logs: [] });
    const original = client.logs.bind(client);
    client.logs = async (query) => {
      entered();
      await gate;
      return original(query);
    };
    const first = manager(client);
    const job = await first.start("operator", config.chain, ANVIL_START_BLOCK, ANVIL_START_BLOCK);
    const active = first.run(job.id, "operator", new AbortController().signal);
    await started;
    try {
      await expect(manager().run(job.id, "operator", new AbortController().signal)).rejects.toThrow(
        "another worker",
      );
      expect((await manager().get(job.id))?.state).toBe("queued");
    } finally {
      release();
    }
    expect((await active).state).toBe("completed");
  });
  it("exposes no public start or cancellation endpoint", async () => {
    const app = buildServer({
      config: loadConfig({ env: completeEnv({ KEEPER_ENABLED: "false" }) }),
      logger,
      db,
      readiness: [],
      redis: { ping: () => Promise.resolve("PONG") },
    });
    try {
      expect(
        (await app.inject({ method: "POST", url: "/v1/evm/backfills", payload: {} })).statusCode,
      ).toBe(404);
      expect(
        (await app.inject({ method: "POST", url: "/v1/evm/backfills/id/cancel", payload: {} }))
          .statusCode,
      ).toBe(404);
      expect((await app.inject("/v1/evm/backfills")).headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });
});
