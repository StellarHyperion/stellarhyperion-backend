import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { CHAINS, RAIL_CONTRACTS, assetOn, isEvmChain, toHex } from "@hyperion/protocol";
import { StrKey } from "@stellar/stellar-sdk";
import { encodeAbiParameters, encodeEventTopics, hexToBytes, type Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";

import { writeOutbound } from "../../src/chains/writers.js";
import { loadConfig } from "../../src/config/config.js";
import type { Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";
import { text } from "../../src/db/rows.js";
import type { DeliveryLog } from "../../src/rails/axelar/events.js";
import {
  CCTP_RECEIPT_ABI,
  verifiedCctpMessage,
  type ExpectedCctpTransfer,
} from "../../src/rails/cctp/events.js";
import { RailPass } from "../../src/rails/pass.js";
import {
  CandidateReceiptCache,
  formatCandidateReceiptCacheKey,
  type CandidateReceiptRpcClient,
  type PendingTransfer,
  type RailClient,
  type RailLookup,
} from "../../src/rails/types.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const MIGRATIONS = [
  "1790900000000_initial-schema.sql",
  "1791000000000_cursor-block-hash.sql",
  "1791100000000_cursor-autovacuum-tuning.sql",
] as const;

interface PGliteHarness extends Transactional {
  close(): Promise<void>;
}

async function openPGlite(): Promise<PGliteHarness> {
  const pg = await PGlite.create();
  const query = async (sql: string, params: readonly unknown[] = []): Promise<QueryResultRows> => {
    const normalized = params.map((p) => (p instanceof Date ? p.toISOString() : p));
    const result =
      normalized.length === 0 && sql.includes(";")
        ? await (async () => {
            await pg.exec(sql);
            return { rows: [], fields: [], affectedRows: 0 };
          })()
        : await pg.query(sql, normalized);

    const int8Cols = result.fields.filter((f) => f.dataTypeID === 20).map((f) => f.name);
    const rows = result.rows.map((raw) => {
      const copy = { ...(raw as Record<string, unknown>) };
      for (const col of int8Cols) {
        const val = copy[col];
        if (typeof val === "number" || typeof val === "bigint") {
          copy[col] = String(val);
        }
      }
      return copy;
    });
    return { rows, rowCount: result.affectedRows ?? rows.length };
  };

  for (const file of MIGRATIONS) {
    const path = fileURLToPath(new URL(`../../migrations/${file}`, import.meta.url));
    const upSql = readFileSync(path, "utf8").split(/^--\s*Down Migration\b/m)[0] ?? "";
    await query(upSql);
  }

  return {
    query,
    async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      await pg.exec("BEGIN");
      try {
        const out = await work({ query });
        await pg.exec("COMMIT");
        return out;
      } catch (err) {
        await pg.exec("ROLLBACK");
        throw err;
      }
    },
    async close(): Promise<void> {
      await pg.close();
    },
  };
}

function padWord(address: string): Uint8Array {
  return hexToBytes(`0x${address.slice(2).padStart(64, "0")}`);
}

function buildCctpBurnFixture(args: {
  readonly expected: ExpectedCctpTransfer;
  readonly messageNonce: Hex;
  readonly receiveLogIndex: number;
  readonly mintLogIndex: number;
}): {
  readonly rawMessage: Hex;
  readonly receiveLog: DeliveryLog;
  readonly mintLog: DeliveryLog;
} {
  const raw = new Uint8Array(148 + 228);
  const view = new DataView(raw.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, 27);
  view.setUint32(8, args.expected.destinationDomain);
  raw.set(hexToBytes(args.messageNonce), 12);
  raw.set(StrKey.decodeContract(args.expected.sourceMessenger), 44);
  raw.set(padWord(args.expected.destinationMessenger), 76);
  view.setUint32(140, 2000);
  view.setUint32(144, 2000);
  view.setUint32(148, 1);
  raw.set(StrKey.decodeContract(args.expected.sourceToken), 152);
  raw.set(padWord(args.expected.recipient), 184);
  raw.set(padWord(`0x${(args.expected.sourceAmount / 10n).toString(16)}`), 216);
  raw.set(StrKey.decodeContract(args.expected.sourceAdapter), 248);
  raw.set(padWord(`0x${500000n.toString(16)}`), 280);
  raw.set(padWord(`0x${100000n.toString(16)}`), 312);

  const rawMessage = toHex(raw);
  const parsed = verifiedCctpMessage(rawMessage, args.expected);
  if (parsed === null) {
    throw new Error("Failed to construct valid CCTP message fixture");
  }

  const receiveLog: DeliveryLog = {
    address: args.expected.transmitter as Hex,
    topics: encodeEventTopics({
      abi: CCTP_RECEIPT_ABI,
      eventName: "MessageReceived",
      args: {
        caller: args.expected.recipient as Hex,
        nonce: args.messageNonce,
        finalityThresholdExecuted: 2000,
      },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters(
      [{ type: "uint32" }, { type: "bytes32" }, { type: "bytes" }],
      [27, parsed.message.sender, parsed.body],
    ),
    logIndex: args.receiveLogIndex,
  };

  const mintLog: DeliveryLog = {
    address: args.expected.token as Hex,
    topics: encodeEventTopics({
      abi: CCTP_RECEIPT_ABI,
      eventName: "Transfer",
      args: { from: `0x${"0".repeat(40)}`, to: args.expected.recipient as Hex },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint256" }], [parsed.amount]),
    logIndex: args.mintLogIndex,
  };

  return { rawMessage, receiveLog, mintLog };
}

describe("bounded candidate receipt caching (#91)", () => {
  const openDbs: PGliteHarness[] = [];

  afterEach(async () => {
    while (openDbs.length > 0) {
      const db = openDbs.pop();
      if (db !== undefined) await db.close();
    }
  });

  it("includes chain and canonical block identity in cache keys, freezes logs, and enforces bounded LRU capacity", async () => {
    const cache = new CandidateReceiptCache({ maxEntries: 2 });
    const blockHashA: Hex = `0x${"a1".repeat(32)}`;
    const blockHashB: Hex = `0x${"b2".repeat(32)}`;
    const blockHashC: Hex = `0x${"c3".repeat(32)}`;
    const txA: Hex = `0x${"11".repeat(32)}`;
    const txB: Hex = `0x${"22".repeat(32)}`;
    const txC: Hex = `0x${"33".repeat(32)}`;

    const keyA = formatCandidateReceiptCacheKey({
      chainKey: "sepolia",
      chainId: 11155111,
      blockNumber: 5000n,
      blockHash: blockHashA,
      txHash: txA,
    });
    expect(keyA).toBe(`sepolia:11155111:5000:${blockHashA}:${txA}`);

    const blockMap = new Map<bigint, Hex>([
      [5000n, blockHashA],
      [5001n, blockHashB],
      [5002n, blockHashC],
    ]);
    const txBlockMap = new Map<Hex, bigint>([
      [txA, 5000n],
      [txB, 5001n],
      [txC, 5002n],
    ]);

    let receiptFetches = 0;
    const client: CandidateReceiptRpcClient = {
      getChainId: () => Promise.resolve(11155111),
      getBlockNumber: () => Promise.resolve(5100n),
      getBlock: ({ blockNumber }) =>
        Promise.resolve({
          hash: blockMap.get(blockNumber) ?? null,
          timestamp: 1_790_000_000n + blockNumber,
        }),
      getTransactionReceipt: ({ hash }) => {
        receiptFetches += 1;
        const blk = txBlockMap.get(hash) ?? 5000n;
        const blkHash = blockMap.get(blk) ?? blockHashA;
        return Promise.resolve({
          status: "success",
          blockNumber: blk,
          blockHash: blkHash,
          transactionHash: hash,
          logs: [
            {
              address: `0x${"44".repeat(20)}`,
              topics: [`0x${"55".repeat(32)}`],
              data: "0x1234",
              logIndex: 0,
            },
          ],
        });
      },
    };

    const first = await cache.getConfirmedReceipt({
      chainKey: "sepolia",
      expectedChainId: 11155111,
      confirmations: 12,
      txHash: txA,
      client,
    });
    expect(first?.cacheKey).toBe(keyA);
    expect(cache.hasKey(keyA)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.logs)).toBe(true);
    expect(() => {
      (first?.logs as DeliveryLog[]).push({
        address: `0x${"00".repeat(20)}`,
        topics: [],
        data: "0x",
        logIndex: 99,
      });
    }).toThrow(TypeError);

    // Hit txA again -> served from cache without another RPC receipt call, refreshing LRU recency.
    const hitA = await cache.getConfirmedReceipt({
      chainKey: "sepolia",
      expectedChainId: 11155111,
      confirmations: 12,
      txHash: txA,
      client,
    });
    expect(hitA).toBe(first);
    expect(receiptFetches).toBe(1);

    // Insert txB -> size reaches maxEntries (2); access txA so txB becomes LRU; insert txC -> txB evicted!
    await cache.getConfirmedReceipt({
      chainKey: "sepolia",
      expectedChainId: 11155111,
      confirmations: 12,
      txHash: txB,
      client,
    });
    await cache.getConfirmedReceipt({
      chainKey: "sepolia",
      expectedChainId: 11155111,
      confirmations: 12,
      txHash: txA,
      client,
    });
    await cache.getConfirmedReceipt({
      chainKey: "sepolia",
      expectedChainId: 11155111,
      confirmations: 12,
      txHash: txC,
      client,
    });

    expect(cache.stats).toEqual({
      hits: 2,
      misses: 3,
      evictions: 1,
      invalidations: 0,
      size: 2,
      maxEntries: 2,
    });
    expect(cache.hasKey(keyA)).toBe(true);
    const keyB = formatCandidateReceiptCacheKey({
      chainKey: "sepolia",
      chainId: 11155111,
      blockNumber: 5001n,
      blockHash: blockHashB,
      txHash: txB,
    });
    expect(cache.hasKey(keyB)).toBe(false);
  });

  it("invalidates cached receipts on reorgs or inconsistent RPC evidence", async () => {
    const cache = new CandidateReceiptCache({ maxEntries: 8 });
    const tx1: Hex = `0x${"61".repeat(32)}`;
    const tx2: Hex = `0x${"62".repeat(32)}`;
    const txBadHash: Hex = `0x${"63".repeat(32)}`;

    let canonicalHashAt6000: Hex = `0x${"aa".repeat(32)}`;
    let receiptHashAt6000: Hex = canonicalHashAt6000;
    let receiptReadsForTx1 = 0;

    const client: CandidateReceiptRpcClient = {
      getChainId: () => Promise.resolve(11155111),
      getBlockNumber: () => Promise.resolve(6100n),
      getBlock: ({ blockNumber }) =>
        Promise.resolve({
          hash: blockNumber === 6000n ? canonicalHashAt6000 : `0x${"bb".repeat(32)}`,
          timestamp: 1_790_010_000n,
        }),
      getTransactionReceipt: ({ hash }) => {
        if (hash === tx1) receiptReadsForTx1 += 1;
        if (hash === txBadHash) {
          // RPC returns mismatched transactionHash -> inconsistent evidence!
          return Promise.resolve({
            status: "success",
            blockNumber: 6000n,
            blockHash: canonicalHashAt6000,
            transactionHash: `0x${"ff".repeat(32)}`,
            logs: [],
          });
        }
        return Promise.resolve({
          status: "success",
          blockNumber: 6000n,
          blockHash: receiptHashAt6000,
          transactionHash: hash,
          logs: [],
        });
      },
    };

    // 1. Cache tx1 under block 6000 hash 0xaa..aa.
    const initial = await cache.getConfirmedReceipt({
      chainKey: "sepolia",
      expectedChainId: 11155111,
      confirmations: 12,
      txHash: tx1,
      client,
    });
    expect(initial?.blockHash).toBe(`0x${"aa".repeat(32)}`);
    expect(receiptReadsForTx1).toBe(1);

    // 2. Inconsistent transactionHash from RPC returns null and is never cached.
    const inconsistent = await cache.getConfirmedReceipt({
      chainKey: "sepolia",
      expectedChainId: 11155111,
      confirmations: 12,
      txHash: txBadHash,
      client,
    });
    expect(inconsistent).toBeNull();

    // 3. Simulate a reorg at block 6000: block.hash is now 0xcc..cc while tx2's receipt is read at 6000.
    const reorgHash: Hex = `0x${"cc".repeat(32)}`;
    canonicalHashAt6000 = reorgHash;
    receiptHashAt6000 = reorgHash;

    const tx2AfterReorg = await cache.getConfirmedReceipt({
      chainKey: "sepolia",
      expectedChainId: 11155111,
      confirmations: 12,
      txHash: tx2,
      client,
    });
    expect(tx2AfterReorg?.blockHash).toBe(reorgHash);

    // Old tx1 entry with blockHash 0xaa..aa must have been invalidated by the reorg at height 6000!
    expect(cache.stats.invalidations).toBeGreaterThanOrEqual(1);
    const refetchedTx1 = await cache.getConfirmedReceipt({
      chainKey: "sepolia",
      expectedChainId: 11155111,
      confirmations: 12,
      txHash: tx1,
      client,
    });
    expect(receiptReadsForTx1).toBe(2);
    expect(refetchedTx1?.blockHash).toBe(reorgHash);

    // 4. Receipt/block mismatch during fetch (receipt says 0xdd..dd, getBlock says 0xcc..cc) invalidates!
    receiptHashAt6000 = `0x${"dd".repeat(32)}`;
    const mismatchDuringReorg = await cache.getConfirmedReceipt({
      chainKey: "sepolia",
      expectedChainId: 11155111,
      confirmations: 12,
      txHash: `0x${"64".repeat(32)}`,
      client,
    });
    expect(mismatchDuringReorg).toBeNull();
  });

  it("shares one candidate receipt across batched transfers in RailPass without bypassing transfer-specific payment matching", async () => {
    const db = await openPGlite();
    openDbs.push(db);
    const config = loadConfig({ env: completeEnv() });
    const { logger } = capturingLogger();

    const stellarDeploy = config.deployments.networks["stellar-testnet"];
    if (stellarDeploy?.family !== "stellar") {
      throw new Error("Expected stellar-testnet deployment in fixture");
    }
    const sacId = stellarDeploy.tokens.USDC?.sacId ?? "";
    const adapter = stellarDeploy.adapters[0] ?? "";
    const sepoliaChain = CHAINS.sepolia;
    const cctpContracts = RAIL_CONTRACTS.sepolia?.cctp;
    const sepoliaUsdc = assetOn("sepolia", "USDC");
    if (
      !isEvmChain(sepoliaChain) ||
      !cctpContracts ||
      sepoliaUsdc?.family !== "evm" ||
      sepoliaChain.cctpDomain === null
    ) {
      throw new Error("Expected sepolia CCTP contracts and USDC in protocol registry");
    }

    const recipientA = "0x1111111111111111111111111111111111111111";
    const recipientB = "0x2222222222222222222222222222222222222222";
    const recipientUnpaid = "0x9999999999999999999999999999999999999999";

    const destWord = (addr: string): string => `0x${addr.slice(2).padStart(64, "0")}`;

    const commonExpected = {
      sourceToken: sacId,
      sourceAdapter: adapter,
      sourceMessenger: "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP",
      destinationDomain: sepoliaChain.cctpDomain,
      destinationMessenger: cctpContracts.tokenMessengerV2,
      transmitter: cctpContracts.messageTransmitterV2,
      token: sepoliaUsdc.address,
    };

    const burnA = buildCctpBurnFixture({
      expected: { ...commonExpected, recipient: recipientA, sourceAmount: 50_000_000n },
      messageNonce: `0x${"71".repeat(32)}`,
      receiveLogIndex: 0,
      mintLogIndex: 1,
    });
    const burnB = buildCctpBurnFixture({
      expected: { ...commonExpected, recipient: recipientB, sourceAmount: 80_000_000n },
      messageNonce: `0x${"72".repeat(32)}`,
      receiveLogIndex: 2,
      mintLogIndex: 3,
    });
    const burnUnpaid = buildCctpBurnFixture({
      expected: { ...commonExpected, recipient: recipientUnpaid, sourceAmount: 90_000_000n },
      messageNonce: `0x${"73".repeat(32)}`,
      receiveLogIndex: 4,
      mintLogIndex: 5,
    });

    const now = new Date("2026-10-16T15:00:00.000Z");
    await db.transaction(async (tx) => {
      const seeds = [
        { nonce: 1n, dest: destWord(recipientA), net: 50_000_000n },
        { nonce: 2n, dest: destWord(recipientB), net: 80_000_000n },
        { nonce: 3n, dest: destWord(recipientUnpaid), net: 90_000_000n },
      ] as const;

      for (const s of seeds) {
        await writeOutbound(
          tx,
          {
            chainKey: "stellar-testnet",
            block: 9000n + s.nonce,
            txHash: `0x${s.nonce.toString(16).padStart(64, "0")}`,
            logIndex: null,
            observedAt: now,
          },
          {
            route: 0,
            nonce: s.nonce,
            sender: stellarDeploy.admin,
            token: sacId,
            grossAmount: s.net,
            fee: 0n,
            netAmount: s.net,
            destinationChain: "sepolia",
            destination: s.dest,
            railRef: null,
          },
        );
      }
    });

    // Shared forwarding receipt includes ONLY burnA and burnB logs (NOT burnUnpaid!).
    const sharedForwardTx: Hex = `0x${"fa".repeat(32)}`;
    const sharedBlockHash: Hex = `0x${"fb".repeat(32)}`;
    let rpcReceiptReads = 0;

    const evmClient: CandidateReceiptRpcClient = {
      getChainId: () => Promise.resolve(sepoliaChain.chainId),
      getBlockNumber: () => Promise.resolve(10_100n),
      getBlock: () =>
        Promise.resolve({
          hash: sharedBlockHash,
          timestamp: 1_790_020_000n,
        }),
      getTransactionReceipt: ({ hash }) => {
        rpcReceiptReads += 1;
        return Promise.resolve({
          status: "success",
          blockNumber: 10_000n,
          blockHash: sharedBlockHash,
          transactionHash: hash,
          logs: [burnA.receiveLog, burnA.mintLog, burnB.receiveLog, burnB.mintLog],
        });
      },
    };

    const messagesByNonce = new Map<bigint, Hex>([
      [1n, burnA.rawMessage],
      [2n, burnB.rawMessage],
      [3n, burnUnpaid.rawMessage],
    ]);

    const railClient: RailClient = {
      rail: "cctp",
      look(transfer: PendingTransfer): Promise<RailLookup> {
        return Promise.resolve({
          kind: "found",
          report: {
            status: "attested",
            railStatus: "complete",
            reference: `iris-${transfer.nonce.toString()}`,
            attestedAt: now,
            forwardTxHash: sharedForwardTx,
            messageBytes: messagesByNonce.get(transfer.nonce) ?? null,
          },
        });
      },
    };

    const pass = new RailPass({
      route: 0,
      config,
      client: railClient,
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 0,
      maxCheckFailures: 5,
      now: () => now,
      evmClientFactory: () => evmClient,
    });

    await pass.tick(new AbortController().signal);

    // Shared receipt was read from RPC only ONCE across all 3 candidate transfers (1 miss, 2 hits)!
    expect(rpcReceiptReads).toBe(1);
    expect(pass.progress?.receiptCache).toEqual({
      hits: 2,
      misses: 1,
      evictions: 0,
      invalidations: 0,
      size: 1,
      maxEntries: 128,
    });

    // Transfers 1 and 2 matched their exact payments -> delivered; Transfer 3 did NOT match -> stays attested!
    const { rows } = await db.query(
      `SELECT t.nonce::text AS nonce, a.status
         FROM outbound_transfer t
         JOIN rail_attestation a ON a.transfer_id = t.id
        ORDER BY t.nonce ASC`,
    );
    expect(rows.map((r) => ({ nonce: text(r, "nonce"), status: text(r, "status") }))).toEqual([
      { nonce: "1", status: "delivered" },
      { nonce: "2", status: "delivered" },
      { nonce: "3", status: "attested" },
    ]);

    const inboundCount = await db.query("SELECT count(*)::int AS n FROM inbound_delivery");
    expect(inboundCount.rows[0]?.n).toBe(2);
  });
});
