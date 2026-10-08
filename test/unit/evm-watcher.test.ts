/**
 * The EVM watcher's pass, on a chain that can change its mind.
 *
 * The Stellar suite checks a cursor that only ever moves forward. This one checks the two things
 * that have no Stellar equivalent: the confirmation line the watcher refuses to read past, and
 * what happens when the chain reorganises past it anyway. The second is why the client is faked
 * rather than pointed at anvil, which will mine on demand but will not rewrite history underneath
 * a running watcher.
 */
import { describe, expect, it } from "vitest";

import { EvmWatcher } from "../../src/chains/evm/watcher.js";
import { viemClient, type EvmClient } from "../../src/chains/evm/client.js";
import {
  ANVIL_HISTORY,
  ANVIL_CHAIN_ID,
  ANVIL_ROUTER,
  ANVIL_START_BLOCK,
  FakeEvmClient,
  encodedLog,
} from "../evm-fakes.js";
import { RecordingDb, capturingLogger } from "../stellar-fakes.js";

const CHAIN = "sepolia";

interface Harness {
  readonly watcher: EvmWatcher;
  readonly db: RecordingDb;
  readonly client: FakeEvmClient;
  readonly lines: { readonly level: string; readonly message: string }[];
}

function harness(
  options: {
    readonly head?: bigint;
    readonly confirmations?: number;
    readonly reorgDepth?: number;
    readonly logRange?: number;
    readonly client?: FakeEvmClient;
  } = {},
): Harness {
  const db = new RecordingDb();
  const client =
    options.client ?? new FakeEvmClient(options.head === undefined ? {} : { head: options.head });
  const { logger, lines } = capturingLogger();
  const watcher = new EvmWatcher({
    chainKey: CHAIN,
    router: ANVIL_ROUTER,
    chainId: ANVIL_CHAIN_ID,
    startBlock: ANVIL_START_BLOCK,
    confirmations: options.confirmations ?? 3,
    reorgDepth: options.reorgDepth ?? 5,
    logRange: options.logRange ?? 2_000,
    client,
    db,
    logger,
  });
  return { watcher, db, client, lines };
}

/** The cursor row `readCursor` expects, as pg would hand it back. */
function cursorRow(
  block: bigint,
  hash: string | null,
  contract = ANVIL_ROUTER,
): Record<string, unknown> {
  return {
    last_processed: block.toString(),
    contract,
    last_processed_at: new Date("2026-10-01T12:00:00.000Z"),
    last_processed_hash: hash,
  };
}

/** Cursor writes, read back from the parameters rather than from the watcher's own cache. */
function cursorWrites(db: RecordingDb): { block: bigint; family: string; hash: string | null }[] {
  // writeCursor takes (chain_key, family, contract, last_processed, last_processed_at, hash).
  return db.matching("INSERT INTO indexer_cursor").map((entry) => ({
    block: BigInt(String(entry.params[3])),
    family: String(entry.params[1]),
    hash: typeof entry.params[5] === "string" ? entry.params[5] : null,
  }));
}

describe("the line it will not read past", () => {
  it("stops at the head minus this chain's confirmations", async () => {
    // One block on Arc and twelve on Ethereum are the same kind of fact, which is why the number
    // comes from the registry per chain rather than from one constant here.
    const { watcher, db } = harness({ head: 100n, confirmations: 12 });

    await watcher.tick(AbortSignal.timeout(5_000));

    expect(cursorWrites(db)).toEqual([{ block: 88n, family: "evm", hash: expect.any(String) }]);
  });

  it("asks for logs only up to the confirmed block, never to the head", async () => {
    const { watcher, client } = harness({ head: 100n, confirmations: 12 });
    await watcher.tick(AbortSignal.timeout(5_000));

    expect(client.logQueries[0]?.toBlock).toBe(88n);
    expect(client.logQueries[0]?.fromBlock).toBe(ANVIL_START_BLOCK);
  });

  it("does nothing at all when the whole chain is still inside the confirmation window", async () => {
    // A fresh chain shorter than its own confirmation depth. Reading it would mean writing rows
    // the chain has not committed to.
    const { watcher, db, client } = harness({ head: 5n, confirmations: 12 });

    expect(await watcher.tick(AbortSignal.timeout(5_000))).toBe(false);
    expect(client.logQueries).toEqual([]);
    expect(cursorWrites(db)).toEqual([]);
  });

  it("walks forward one log range at a time and says it has more to do", async () => {
    const { watcher, db } = harness({ head: 100n, confirmations: 0, logRange: 10 });

    const progressed = await watcher.tick(AbortSignal.timeout(5_000));

    expect(progressed).toBe(true);
    expect(cursorWrites(db)[0]?.block).toBe(ANVIL_START_BLOCK + 9n);
  });
});

describe("when the chain changes its mind", () => {
  it("notices the cursor block has a different hash and winds back by the reorg depth", async () => {
    const client = new FakeEvmClient({ head: 60n });
    const { watcher, db, lines } = harness({ client, confirmations: 3, reorgDepth: 5 });
    // A cursor written for a hash the chain no longer agrees with.
    db.cursorRow = cursorRow(40n, "0xdeadbeef");

    await watcher.tick(AbortSignal.timeout(5_000));

    // 40 - 5 + 1, so the five blocks around the fork are read again.
    expect(client.logQueries[0]?.fromBlock).toBe(36n);
    expect(
      lines.some(
        (line) => line.level === "50" && line.message.includes("reorg past the confirmation depth"),
      ),
    ).toBe(true);
  });

  it("treats a block the node has forgotten as a reorg rather than as an error", async () => {
    // The other way a node reports the same event: not a different hash, but no block at all.
    // Reading that as a failure would back the poller off and leave the cursor sitting on a block
    // that no longer exists.
    const client = new FakeEvmClient({ head: 60n });
    client.forget(40n);
    const { watcher, db, lines } = harness({ client, confirmations: 3, reorgDepth: 5 });
    db.cursorRow = cursorRow(40n, "0x1234");

    await watcher.tick(AbortSignal.timeout(5_000));

    expect(client.logQueries[0]?.fromBlock).toBe(36n);
    expect(lines.some((line) => line.message.includes("is gone from this node"))).toBe(true);
  });

  it("carries on quietly when the hash still matches", async () => {
    const client = new FakeEvmClient({ head: 60n });
    const { watcher, db, lines } = harness({ client, confirmations: 3 });
    db.cursorRow = cursorRow(40n, client.stampFor(40n).hash);

    await watcher.tick(AbortSignal.timeout(5_000));

    // Straight on from the next block, with no rewind and nothing logged about a reorg.
    expect(client.logQueries[0]?.fromBlock).toBe(41n);
    expect(lines.some((line) => line.message.includes("reorg"))).toBe(false);
  });

  it("never rewinds past the block the router was deployed in", async () => {
    // Winding back five from block two would ask for a negative block, and asking a node for one
    // is a different error from the one actually happening.
    const client = new FakeEvmClient({ head: 60n });
    const { watcher, db } = harness({ client, reorgDepth: 50 });
    db.cursorRow = cursorRow(ANVIL_START_BLOCK + 1n, "0xdeadbeef");

    await watcher.tick(AbortSignal.timeout(5_000));

    expect(client.logQueries[0]?.fromBlock).toBe(ANVIL_START_BLOCK);
  });

  it("writes nothing when the end of the range vanishes mid pass", async () => {
    const client = new FakeEvmClient({ head: 60n });
    const { watcher, db } = harness({ client, confirmations: 3, logRange: 2_000 });
    client.forget(57n);

    expect(await watcher.tick(AbortSignal.timeout(5_000))).toBe(false);
    expect(cursorWrites(db)).toEqual([]);
  });

  it("skips a log the node has marked as removed", async () => {
    // A log from a block that is no longer canonical. Indexing one records a transfer that is not
    // on the chain any more.
    const orphaned = ANVIL_HISTORY.map((log) => ({ ...log, removed: true }));
    const client = new FakeEvmClient({ logs: orphaned, head: 60n });
    const { watcher } = harness({ client, confirmations: 3 });

    await watcher.tick(AbortSignal.timeout(5_000));

    expect(watcher.progress?.written).toBe(0);
    expect(watcher.progress?.ignored).toBe(orphaned.length);
  });
});

describe("the range and the cursor as one commit", () => {
  it("writes every row and the cursor inside the same transaction", async () => {
    const { watcher, db } = harness({ head: 60n, confirmations: 3 });

    await watcher.tick(AbortSignal.timeout(5_000));

    const inserts = db.queries.filter((entry) => entry.text.includes("INSERT INTO"));
    expect(inserts.length).toBeGreaterThan(1);
    expect(new Set(inserts.map((entry) => entry.transaction)).size).toBe(1);
    expect(db.commits).toEqual([1]);
  });

  it("advances no cursor when a row in the range fails to write", async () => {
    const { watcher, db } = harness({ head: 60n, confirmations: 3 });
    db.failInTransaction = new Error("deadlock detected");

    await expect(watcher.tick(AbortSignal.timeout(5_000))).rejects.toThrow("deadlock detected");
    expect(db.rollbacks).toEqual([1]);
    expect(cursorWrites(db)).toEqual([]);
    expect(watcher.progress).toBeNull();
  });

  it("records the cursor as an evm row carrying a block hash", async () => {
    // The hash is the whole reason the column was added. Without it the next pass cannot tell
    // advancing from being handed a different history.
    const { watcher, db, client } = harness({ head: 60n, confirmations: 3 });

    await watcher.tick(AbortSignal.timeout(5_000));

    const [write] = cursorWrites(db);
    expect(write?.family).toBe("evm");
    expect(write?.hash).toBe(client.stampFor(57n).hash);
  });

  it("refuses an endpoint that is not the chain the record claims", async () => {
    // The EVM half of the guard the Stellar side already has on the network passphrase. A testnet
    // config pointed at a mainnet endpoint indexes real transfers into a database that says
    // testnet, and every number downstream is then confidently wrong. Thrown rather than degraded,
    // because there is no useful partial behaviour when the rows would be filed under the wrong
    // chain.
    const client = new FakeEvmClient({ head: 60n, chainId: 1 });
    const { watcher, db } = harness({ client });

    await expect(watcher.tick(AbortSignal.timeout(5_000))).rejects.toThrow(
      /reports chain id 1 and the deployment record says/,
    );
    expect(cursorWrites(db)).toEqual([]);
  });

  it("asks the node what chain it is once, not once per pass", async () => {
    // An endpoint does not change its mind about which chain it is, so a call per poll would be a
    // request a second for an answer that never moves.
    const client = new FakeEvmClient({ head: 60n });
    const { watcher } = harness({ client, confirmations: 3 });

    await watcher.tick(AbortSignal.timeout(5_000));
    await watcher.tick(AbortSignal.timeout(5_000));

    expect(client.chainIdCalls).toBe(1);
  });

  it("refuses a cursor written for a router at another address", async () => {
    const { watcher, db } = harness({ head: 60n });
    db.cursorRow = cursorRow(40n, "0xabc", "0x000000000000000000000000000000000000dead");

    await expect(watcher.tick(AbortSignal.timeout(5_000))).rejects.toThrow(
      /needs its cursor reset rather than reused/,
    );
  });
});

describe("what the watcher says about itself", () => {
  it("is degraded before its first pass", () => {
    const { watcher } = harness();
    expect(watcher.readiness()).toMatchObject({ name: CHAIN, state: "degraded" });
  });

  it("is ready when it is sitting at the confirmation line", async () => {
    // Being `confirmations` blocks behind the head is the design, so reporting it as lag would
    // leave a healthy watcher permanently degraded.
    const { watcher } = harness({ head: 60n, confirmations: 12 });
    await watcher.tick(AbortSignal.timeout(5_000));

    const report = watcher.readiness();
    expect(report.state).toBe("ready");
    expect(report.detail).toContain("12 confirmations behind");
  });

  it("is degraded while it is still catching up, and says by how much", async () => {
    const { watcher } = harness({ head: 1_000n, confirmations: 0, logRange: 10 });
    await watcher.tick(AbortSignal.timeout(5_000));

    const report = watcher.readiness();
    expect(report.state).toBe("degraded");
    expect(report.detail).toMatch(/\d+ blocks behind/);
  });

  it("never reports down, so one unreachable chain does not take the replica out of rotation", async () => {
    const { watcher } = harness({ head: 60n, confirmations: 3 });
    await watcher.tick(AbortSignal.timeout(5_000)).catch(() => undefined);
    expect(watcher.readiness().state).not.toBe("down");
  });
});

describe("an arrival, which the capture has none of", () => {
  const RECIPIENT = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
  const TOKEN = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
  const MESSAGE = `0x${"ab".repeat(32)}` as const;
  const TX = `0x${"cd".repeat(32)}` as const;

  /** The two logs the router emits for a parked delivery, in the order it emits them. */
  function parkedDelivery(block: bigint) {
    return [
      encodedLog(
        "ClaimParked",
        {
          id: 7n,
          recipient: RECIPIENT,
          token: TOKEN,
          amount: 500_000n,
          route: 0,
          sourceChain: "stellar-testnet",
          sourceNonce: 42n,
        },
        { blockNumber: block, logIndex: 0, txHash: TX },
      ),
      encodedLog(
        "BridgeIn",
        {
          route: 0,
          recipient: RECIPIENT,
          token: TOKEN,
          amount: 500_000n,
          sourceChain: "stellar-testnet",
          sourceNonce: 42n,
          messageId: MESSAGE,
        },
        { blockNumber: block, logIndex: 1, txHash: TX },
      ),
    ];
  }

  /** Parameters of the one insert into a table, so a test can read what was written. */
  function inserted(db: RecordingDb, table: string): readonly unknown[] {
    const rows = db.matching(`INSERT INTO ${table}`);
    expect(rows).toHaveLength(1);
    return rows[0]?.params ?? [];
  }

  it("records a delivery that landed as delivered, with no claim", async () => {
    // A BridgeIn on its own. The log carries no flag saying it succeeded, so "no ClaimParked in
    // this transaction" is the only evidence there is.
    const landed = encodedLog(
      "BridgeIn",
      {
        route: 0,
        recipient: RECIPIENT,
        token: TOKEN,
        amount: 500_000n,
        sourceChain: "stellar-testnet",
        sourceNonce: 42n,
        messageId: MESSAGE,
      },
      { blockNumber: 20n, logIndex: 0, txHash: TX },
    );
    const client = new FakeEvmClient({ logs: [landed], head: 60n });
    const { watcher, db } = harness({ client, confirmations: 3 });

    await watcher.tick(AbortSignal.timeout(5_000));

    // (destination_chain, route, source_chain, source_nonce, rail_message_id, recipient, token,
    //  amount, delivered, claim_id, ...)
    const params = inserted(db, "inbound_delivery");
    expect(params[8]).toBe(true);
    expect(params[9]).toBeNull();
    // The rail's own id, which the Soroban event does not carry even though its router guards
    // replay on exactly that value.
    expect(params[4]).toBe(MESSAGE);
  });

  it("pairs a parked claim with the arrival emitted after it in the same transaction", async () => {
    // The whole reason this pairing exists. Without it every parked delivery records as delivered,
    // which is wrong and also violates inbound_delivery_claim the moment a recipient is frozen.
    const client = new FakeEvmClient({ logs: parkedDelivery(20n), head: 60n });
    const { watcher, db } = harness({ client, confirmations: 3 });

    await watcher.tick(AbortSignal.timeout(5_000));

    const params = inserted(db, "inbound_delivery");
    expect(params[8]).toBe(false);
    expect(params[9]).toBe("7");

    // And the claim itself, with the block timestamp standing in for a createdAt the event does
    // not carry. The contract sets createdAt to block.timestamp, so it is the same number.
    const claim = inserted(db, "pending_claim");
    expect(claim[1]).toBe("7");
    expect(claim[8]).toBeInstanceOf(Date);
  });

  it("does not pair a claim with an arrival from a different transaction", async () => {
    // Same hop, two transactions, which a key on the hop alone would wrongly join. Only the
    // transaction can say the two logs describe one delivery.
    const [parked] = parkedDelivery(20n);
    const elsewhere = encodedLog(
      "BridgeIn",
      {
        route: 0,
        recipient: RECIPIENT,
        token: TOKEN,
        amount: 500_000n,
        sourceChain: "stellar-testnet",
        sourceNonce: 42n,
        messageId: MESSAGE,
      },
      { blockNumber: 21n, logIndex: 0, txHash: `0x${"ef".repeat(32)}` },
    );
    const client = new FakeEvmClient({ logs: [parked!, elsewhere], head: 60n });
    const { watcher, db } = harness({ client, confirmations: 3 });

    await watcher.tick(AbortSignal.timeout(5_000));

    const params = inserted(db, "inbound_delivery");
    expect(params[8]).toBe(true);
    expect(params[9]).toBeNull();
  });
});

describe("RPC endpoint failover", () => {
  it("routes requests to secondary RPC when primary returns 500 error", async () => {
    const { logger, lines } = capturingLogger();
    const failoverEvents: { failedUrl: string; fallbackUrl: string }[] = [];

    const mockFetch: typeof globalThis.fetch = (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("primary.invalid")) {
        return Promise.resolve(new Response("Internal Server Error", { status: 500 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xaa36a7" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };

    const client = viemClient(["https://primary.invalid/rpc", "https://secondary.invalid/rpc"], {
      fetchFn: mockFetch,
      logger,
      onFailover: (e) =>
        failoverEvents.push({ failedUrl: e.failedUrl, fallbackUrl: e.fallbackUrl }),
    });

    const chainId = await client.chainId();
    expect(chainId).toBe(11_155_111);
    expect(failoverEvents).toEqual([
      { failedUrl: "https://primary.invalid/rpc", fallbackUrl: "https://secondary.invalid/rpc" },
    ]);
    expect(
      lines.some(
        (l) =>
          l.level === "40" && l.message.includes("RPC endpoint failed, failing over to secondary"),
      ),
    ).toBe(true);
  });

  it("routes requests to secondary RPC when primary encounters network timeout", async () => {
    const { logger, lines } = capturingLogger();
    const failoverEvents: { failedUrl: string; fallbackUrl: string }[] = [];

    const mockFetch: typeof globalThis.fetch = (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("primary.invalid")) {
        const timeoutError = new Error("The operation was aborted due to timeout");
        timeoutError.name = "TimeoutError";
        return Promise.reject(timeoutError);
      }
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x64" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };

    const client = viemClient(["https://primary.invalid/rpc", "https://secondary.invalid/rpc"], {
      fetchFn: mockFetch,
      logger,
      onFailover: (e) =>
        failoverEvents.push({ failedUrl: e.failedUrl, fallbackUrl: e.fallbackUrl }),
    });

    const blockNumber = await client.blockNumber();
    expect(blockNumber).toBe(100n);
    expect(failoverEvents).toEqual([
      { failedUrl: "https://primary.invalid/rpc", fallbackUrl: "https://secondary.invalid/rpc" },
    ]);
    expect(lines.some((l) => l.level === "40")).toBe(true);
  });

  it("recovers without losing cursor position when primary RPC fails and secondary recovers", async () => {
    let shouldFail = true;
    const inner = new FakeEvmClient({ head: 60n });
    const client: EvmClient = {
      chainId: () => inner.chainId(),
      blockNumber: () => {
        if (shouldFail) {
          throw new Error("network timeout connecting to primary RPC");
        }
        return inner.blockNumber();
      },
      logs: (q) => inner.logs(q),
      blocks: (n) => inner.blocks(n),
    };

    const db = new RecordingDb();
    db.cursorRow = cursorRow(20n, "0x1234");
    const { logger } = capturingLogger();
    const watcher = new EvmWatcher({
      chainKey: CHAIN,
      router: ANVIL_ROUTER,
      chainId: ANVIL_CHAIN_ID,
      startBlock: ANVIL_START_BLOCK,
      confirmations: 3,
      reorgDepth: 5,
      logRange: 2_000,
      client,
      db,
      logger,
    });

    // First tick fails due to primary RPC error
    await expect(watcher.tick(AbortSignal.timeout(5_000))).rejects.toThrow(
      /network timeout connecting to primary RPC/,
    );

    // Cursor writes should be empty - cursor position was not corrupted or lost
    expect(cursorWrites(db)).toEqual([]);

    // Secondary recovers / next tick succeeds
    shouldFail = false;
    await watcher.tick(AbortSignal.timeout(5_000));

    // Cursor now advances properly from cursorRow(20n)
    expect(cursorWrites(db)).toEqual([{ block: 57n, family: "evm", hash: expect.any(String) }]);
  });
});
