import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RawEvmLog } from "../../src/chains/evm/client.js";
import { decodeRouterLog } from "../../src/chains/evm/logs.js";
import { quarantineEvmLog, readQuarantinedEvmLogs } from "../../src/chains/evm/store.js";
import { EvmWatcher } from "../../src/chains/evm/watcher.js";
import { Database } from "../../src/db/pool.js";
import {
  ANVIL_CHAIN_ID,
  ANVIL_HEAD,
  ANVIL_HISTORY,
  ANVIL_ROUTER,
  ANVIL_START_BLOCK,
  encodedLog,
  evmLog,
  FakeEvmClient,
} from "../evm-fakes.js";
import { capturingLogger } from "../stellar-fakes.js";

const connection = process.env.TEST_DATABASE_URL;
(connection ? describe : describe.skip)("canonical raw quarantine replay in PostgreSQL", () => {
  let db: Database;
  const chain = "quarantine-raw-replay-test";
  const bridge = ANVIL_HISTORY.find((log) => decodeRouterLog(log)?.name === "BridgeOut");
  if (!bridge) throw new Error("Captured deployment must include BridgeOut");
  const clean = async () => {
    for (const [table, column] of [
      ["outbound_transfer", "origin_chain"],
      ["inbound_delivery", "destination_chain"],
      ["pending_claim", "chain"],
      ["indexer_cursor", "chain_key"],
      ["indexer_lease", "chain_key"],
      ["evm_scan_provenance", "chain_key"],
      ["evm_applied_event", "chain_key"],
      ["evm_log_quarantine", "chain_key"],
    ])
      await db.query(`DELETE FROM ${table} WHERE ${column} = $1`, [chain]);
  };
  const watcher = (client: FakeEvmClient, router = ANVIL_ROUTER) =>
    new EvmWatcher({
      chainKey: chain,
      chainId: ANVIL_CHAIN_ID,
      router,
      startBlock: ANVIL_START_BLOCK,
      confirmations: 0,
      reorgDepth: 5,
      logRange: 2000,
      releaseLeaseOnTick: true,
      client,
      db,
      logger: capturingLogger().logger,
    });
  const retain = async (
    log: RawEvmLog,
    client: FakeEvmClient,
    reason = "unsupported_signature_or_payload",
  ) => {
    await db.transaction((tx) =>
      quarantineEvmLog(
        tx,
        {
          chainKey: chain,
          block: log.blockNumber,
          txHash: log.transactionHash,
          logIndex: log.logIndex,
          eventName: "retained-event",
          reason,
          raw: log,
          blockHash: client.stampFor(log.blockNumber).hash,
        },
        new Date(1700000000000),
      ),
    );
  };
  beforeAll(async () => {
    db = Database.open(connection ?? "");
  });
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await db.close();
  });

  it("quarantines an unknown signature with canonical raw evidence and no fabricated transfer", async () => {
    const unknown = evmLog({
      blockNumber: ANVIL_START_BLOCK,
      topics: [`0x${"ff".repeat(32)}`],
      data: "0x1234",
    });
    const client = new FakeEvmClient({ logs: [unknown], head: ANVIL_HEAD });
    await watcher(client).tick(AbortSignal.timeout(5000));
    const retained = await readQuarantinedEvmLogs(db, chain, ANVIL_ROUTER);
    expect(retained).toEqual([
      { log: unknown, blockHash: client.stampFor(unknown.blockNumber).hash },
    ]);
    expect(
      (await db.query("SELECT id FROM outbound_transfer WHERE origin_chain=$1", [chain])).rows,
    ).toEqual([]);
  });
  it("replays retained previously unsupported BridgeOut through actual writers exactly once", async () => {
    const client = new FakeEvmClient({ head: ANVIL_HEAD });
    await retain(bridge, client);
    expect(await watcher(client).replayQuarantined(AbortSignal.timeout(5000))).toEqual({
      written: 1,
      ignored: 0,
    });
    expect(await watcher(client).replayQuarantined(AbortSignal.timeout(5000))).toEqual({
      written: 0,
      ignored: 1,
    });
    const rows = (
      await db.query(
        "SELECT gross_amount,fee,net_amount FROM outbound_transfer WHERE origin_chain=$1",
        [chain],
      )
    ).rows;
    expect(rows).toEqual([{ gross_amount: "1000000", fee: "3000", net_amount: "997000" }]);
  });
  it("rejects a retained hash after a reorg without materializing any transfer", async () => {
    const client = new FakeEvmClient({ head: ANVIL_HEAD });
    await retain(bridge, client);
    client.reorg(bridge.blockNumber);
    await expect(watcher(client).replayQuarantined(AbortSignal.timeout(5000))).rejects.toThrow(
      "confirmed canonical deployment",
    );
    expect(
      (await db.query("SELECT id FROM outbound_transfer WHERE origin_chain=$1", [chain])).rows,
    ).toEqual([]);
  });
  it("rejects unconfirmed retained evidence", async () => {
    const client = new FakeEvmClient({ head: ANVIL_HEAD });
    await retain(bridge, client);
    client.advanceHeadTo(bridge.blockNumber - 1n);
    await expect(watcher(client).replayQuarantined(AbortSignal.timeout(5000))).rejects.toThrow(
      "confirmed canonical deployment",
    );
  });
  it("keeps metadata and the first observation when oversized raw evidence is omitted", async () => {
    const client = new FakeEvmClient({ head: ANVIL_HEAD });
    const oversized: RawEvmLog = { ...bridge, data: `0x${"ab".repeat(65537)}` };
    await retain(oversized, client);
    await db.transaction((tx) =>
      quarantineEvmLog(
        tx,
        {
          chainKey: chain,
          block: oversized.blockNumber,
          txHash: oversized.transactionHash,
          logIndex: oversized.logIndex,
          eventName: "retained-event",
          reason: "unsupported_signature_or_payload",
          raw: oversized,
          blockHash: client.stampFor(oversized.blockNumber).hash,
        },
        new Date(1800000000000),
      ),
    );
    const row = (
      await db.query(
        "SELECT data,topics,signature,contract,block_hash,observed_at FROM evm_log_quarantine WHERE chain_key=$1",
        [chain],
      )
    ).rows[0];
    expect(row).toMatchObject({
      data: null,
      topics: bridge.topics,
      signature: bridge.topics[0],
      contract: bridge.address,
      block_hash: client.stampFor(bridge.blockNumber).hash,
      observed_at: new Date(1700000000000),
    });
    expect(await readQuarantinedEvmLogs(db, chain, ANVIL_ROUTER)).toEqual([]);
  });
  it("rejects excessive limits and isolates the configured router", async () => {
    const client = new FakeEvmClient({ head: ANVIL_HEAD });
    await retain(bridge, client);
    await expect(readQuarantinedEvmLogs(db, chain, ANVIL_ROUTER, 101)).rejects.toThrow("1 to 100");
    const other = `0x${"11".repeat(20)}` as const;
    expect(await watcher(client, other).replayQuarantined(AbortSignal.timeout(5000))).toEqual({
      written: 0,
      ignored: 0,
    });
  });
  it("reconstructs a parked claim when only its BridgeIn is quarantined", async () => {
    const position = {
      blockNumber: ANVIL_START_BLOCK,
      logIndex: 0,
      txHash: `0x${"cd".repeat(32)}` as const,
    };
    const common = {
      recipient: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
      token: String(decodeRouterLog(bridge)?.args.token),
      amount: 500000n,
      route: 0,
      sourceChain: "stellar-testnet",
      sourceNonce: 42n,
    };
    const parked = encodedLog("ClaimParked", { ...common, id: 7n }, position);
    const inbound = encodedLog(
      "BridgeIn",
      { ...common, messageId: `0x${"ab".repeat(32)}` },
      { ...position, logIndex: 1 },
    );
    const client = new FakeEvmClient({ logs: [parked, inbound], head: ANVIL_HEAD });
    await retain(inbound, client);
    const missing = new FakeEvmClient({ logs: [], head: ANVIL_HEAD });
    await expect(watcher(missing).replayQuarantined(AbortSignal.timeout(5000), 1)).rejects.toThrow(
      "transaction context is missing or unsupported",
    );
    const reversed = new FakeEvmClient({
      logs: [{ ...parked, logIndex: 2 }, inbound],
      head: ANVIL_HEAD,
    });
    expect(await watcher(reversed).replayQuarantined(AbortSignal.timeout(5000), 1)).toEqual({
      written: 0,
      ignored: 1,
    });
    expect(
      (await db.query("SELECT delivered FROM inbound_delivery WHERE destination_chain=$1", [chain]))
        .rows,
    ).toEqual([]);
    const oversized = new FakeEvmClient({
      logs: Array.from({ length: 1001 }, () => inbound),
      head: ANVIL_HEAD,
    });
    await expect(
      watcher(oversized).replayQuarantined(AbortSignal.timeout(5000), 1),
    ).rejects.toThrow("log budget");
    expect(await watcher(client).replayQuarantined(AbortSignal.timeout(5000), 1)).toEqual({
      written: 1,
      ignored: 0,
    });
    const rows = (
      await db.query("SELECT delivered,claim_id FROM inbound_delivery WHERE destination_chain=$1", [
        chain,
      ])
    ).rows;
    expect(rows).toEqual([{ delivered: false, claim_id: "7" }]);
    expect(await watcher(client).replayQuarantined(AbortSignal.timeout(5000), 1)).toEqual({
      written: 0,
      ignored: 1,
    });
  });
});
