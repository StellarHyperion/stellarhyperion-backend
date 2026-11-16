import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { RAIL_CONTRACTS, RouteKind, fromHex } from "@hyperion/protocol";
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, stringToHex, type Hex } from "viem";
import {
  writeAttestation,
  writeInbound,
  writeItsPaymentProof,
  writeOutbound,
} from "../../src/chains/writers.js";
import { loadConfig } from "../../src/config/config.js";
import type { Database, Queryable, Transactional } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import {
  revalidateItsDeliveryProofs,
  verifyItsDelivery,
  type ItsBlock,
  type ItsReadOnlyEvmClient,
  type ItsReceipt,
} from "../../src/rails/axelar/delivery.js";
import {
  ITS_ABI,
  matchingPayment,
  type DeliveryLog,
  type ExpectedDelivery,
} from "../../src/rails/axelar/events.js";
import { AxelarGmpClient } from "../../src/rails/axelar/gmp.js";
import { pendingForRail } from "../../src/rails/queue.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const ACTIVE_TESTNET_DEPLOYMENTS = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../deployments/testnet.json",
);

const recipient = "0x1111111111111111111111111111111111111111";
const its = "0x2222222222222222222222222222222222222222";
const token = "0x3333333333333333333333333333333333333333";
const commandId: Hex = `0x${"ab".repeat(32)}`;
const replacementCommandId: Hex = `0x${"bc".repeat(32)}`;
const tokenId: Hex = `0x${"cd".repeat(32)}`;
const source = stringToHex("Gsource");
const expected: ExpectedDelivery = {
  its,
  token,
  commandId,
  tokenId,
  sourceChain: "stellar-2026-q1-2",
  sourceAddress: source,
  recipient,
  amount: 9970009n,
};
const received: DeliveryLog = {
  address: its,
  topics: encodeEventTopics({
    abi: ITS_ABI,
    eventName: "InterchainTransferReceived",
    args: { commandId, tokenId, destinationAddress: recipient },
  }) as [Hex, ...Hex[]],
  data: encodeAbiParameters(
    [{ type: "string" }, { type: "bytes" }, { type: "uint256" }, { type: "bytes32" }],
    [expected.sourceChain, source, expected.amount, `0x${"0".repeat(64)}`],
  ),
  logIndex: 2,
};
const paid: DeliveryLog = {
  address: token,
  topics: encodeEventTopics({
    abi: ITS_ABI,
    eventName: "Transfer",
    args: { from: its, to: recipient },
  }) as [Hex, ...Hex[]],
  data: encodeAbiParameters([{ type: "uint256" }], [expected.amount]),
  logIndex: 3,
};

async function openMigratedDb(): Promise<{
  pg: PGlite;
  db: Transactional & Database;
}> {
  const pg = new PGlite();
  for (const name of [
    "1790900000000_initial-schema.sql",
    "1791000000000_cursor-block-hash.sql",
    "1791100000000_cursor-autovacuum-tuning.sql",
    "1791200000000_its-payment-proof-revalidation.sql",
  ]) {
    const sql = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), `../../migrations/${name}`),
      "utf8",
    ).split("-- Down Migration")[0]!;
    await pg.exec(sql);
  }

  const wrap = (target: {
    query: (
      sql: string,
      params?: unknown[],
    ) => Promise<{
      rows: unknown[];
      fields: { dataTypeID: number; name: string }[];
      affectedRows?: number;
    }>;
  }): Queryable => ({
    query: async (sql: string, params: readonly unknown[] = []) => {
      const result = await target.query(sql, [...params]);
      const int8 = result.fields
        .filter((field) => field.dataTypeID === 20)
        .map((field) => field.name);
      const rows = result.rows.map((raw) => {
        const row = { ...(raw as Record<string, unknown>) };
        for (const column of int8) {
          const value = row[column];
          if (typeof value === "number" || typeof value === "bigint") {
            row[column] = String(value);
          }
        }
        return row;
      });
      return { rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  });

  const root = wrap(pg);
  const db = {
    query: (sql: string, params?: readonly unknown[]) => root.query(sql, params),
    transaction: async <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> =>
      pg.transaction(async (tx) => fn(wrap(tx))),
    ping: async () => {
      await pg.query("SELECT 1");
    },
  } as unknown as Transactional & Database;

  return { pg, db };
}

describe("Destination delivery evidence", () => {
  it("requires both the exact ITS event and actual token payment", () => {
    expect(matchingPayment([received, paid], expected)).toBe(paid);
    expect(matchingPayment([received], expected)).toBeNull();
    expect(matchingPayment([paid], expected)).toBeNull();
  });
  it.each([
    "its",
    "token",
    "commandId",
    "tokenId",
    "sourceChain",
    "sourceAddress",
    "recipient",
  ] as const)("rejects mismatched %s", (key) => {
    expect(matchingPayment([received, paid], { ...expected, [key]: "different" })).toBeNull();
  });
  it("rejects a payment of the wrong amount", () => {
    expect(
      matchingPayment([received, paid], { ...expected, amount: expected.amount + 1n }),
    ).toBeNull();
  });
  it("does not lose a matching receipt event when another transfer shares the transaction", () => {
    const unrelated = { ...received, address: token as Hex };
    expect(matchingPayment([received, unrelated, paid], expected)).toBe(paid);
  });
});

describe("ITS payment proof revalidation after destination reorgs", () => {
  const activeConfig = loadConfig({
    env: completeEnv({
      HYPERION_DEPLOYMENTS_FILE: ACTIVE_TESTNET_DEPLOYMENTS,
      KEEPER_ENABLED: "false",
    }),
  });
  const stellarDeployment = activeConfig.deployments.networks["stellar-testnet"]!;
  const stellarUsdc = (stellarDeployment.tokens.USDC as { sacId: string; decimals: number }).sacId;
  const senderAddress = stellarDeployment.admin;
  const sepoliaIts = RAIL_CONTRACTS.sepolia!.axelar!.interchainTokenService as Hex;
  const destinationTokenAddress: Hex = "0x5555555555555555555555555555555555555555";
  const recipientAddress: Hex = "0x6ef8032ffe4943f27388172549f6700f18bb8b38";
  const recipientWord = `0x000000000000000000000000${recipientAddress.slice(2)}`;

  const originalBlock = 9_100_000n;
  const originalBlockHash: Hex = `0x${"aa".repeat(32)}`;
  const reorgedBlockHash: Hex = `0x${"bb".repeat(32)}`;
  const replacementBlock = 9_100_004n;
  const replacementBlockHash: Hex = `0x${"cc".repeat(32)}`;
  const originalTxHash: Hex = `0x${"11".repeat(32)}`;
  const replacementTxHash: Hex = `0x${"22".repeat(32)}`;

  function makeLogs(opts: {
    cmdId?: Hex;
    sender?: string;
    destRecipient?: Hex;
    amount?: bigint;
    destToken?: Hex;
  }): DeliveryLog[] {
    const cmdId = opts.cmdId ?? commandId;
    const senderStr = opts.sender ?? senderAddress;
    const destRecipient = opts.destRecipient ?? recipientAddress;
    const amt = opts.amount ?? 9_970_000n;
    const destToken = opts.destToken ?? destinationTokenAddress;
    return [
      {
        address: sepoliaIts,
        topics: encodeEventTopics({
          abi: ITS_ABI,
          eventName: "InterchainTransferReceived",
          args: { commandId: cmdId, tokenId, destinationAddress: destRecipient },
        }) as [Hex, ...Hex[]],
        data: encodeAbiParameters(
          [{ type: "string" }, { type: "bytes" }, { type: "uint256" }, { type: "bytes32" }],
          ["stellar-2026-q1-2", stringToHex(senderStr), amt, `0x${"00".repeat(32)}`],
        ),
        logIndex: 4,
      },
      {
        address: destToken,
        topics: encodeEventTopics({
          abi: ITS_ABI,
          eventName: "Transfer",
          args: { from: "0x0000000000000000000000000000000000000000", to: destRecipient },
        }) as [Hex, ...Hex[]],
        data: encodeAbiParameters([{ type: "uint256" }], [amt]),
        logIndex: 5,
      },
    ];
  }

  function mockStellarView(rpcCalls: string[]) {
    return (contract: string, method: string) => {
      rpcCalls.push(`stellar.view:${method}`);
      if (method === "token_id_for") return Promise.resolve(fromHex(tokenId));
      if (method === "get_config") return Promise.resolve({ its: "CAXELARITSCONTRACT" });
      if (contract === "CAXELARITSCONTRACT" && method === "chain_name") {
        return Promise.resolve("stellar-2026-q1-2");
      }
      throw new Error(`unexpected stellar view ${contract}.${method}`);
    };
  }

  function createChainStateClient(state: {
    head: bigint;
    blocks: Map<bigint, ItsBlock>;
    receipts: Map<string, ItsReceipt>;
    rpcCalls: string[];
  }): ItsReadOnlyEvmClient {
    return {
      getChainId: () => {
        state.rpcCalls.push("evm.getChainId");
        return Promise.resolve(11155111);
      },
      getBlockNumber: () => {
        state.rpcCalls.push("evm.getBlockNumber");
        return Promise.resolve(state.head);
      },
      getTransactionReceipt: ({ hash }) => {
        state.rpcCalls.push(`evm.getTransactionReceipt:${hash.toLowerCase()}`);
        return Promise.resolve(state.receipts.get(hash.toLowerCase()) ?? null);
      },
      getBlock: ({ blockNumber }) => {
        state.rpcCalls.push(`evm.getBlock:${blockNumber.toString()}`);
        return Promise.resolve(state.blocks.get(blockNumber) ?? null);
      },
      readRegisteredToken: (_its, _tokenId, blockNumber) => {
        state.rpcCalls.push(`evm.readRegisteredToken:${blockNumber.toString()}`);
        return Promise.resolve(destinationTokenAddress);
      },
    };
  }

  it("invalidates orphaned token payments so they cannot remain permanently confirmed and never signs or broadcasts", async () => {
    const { pg, db } = await openMigratedDb();
    const { logger } = capturingLogger();
    const app = buildServer({
      config: activeConfig,
      logger,
      db,
      readiness: [],
      redis: { ping: () => Promise.resolve("PONG") },
    });
    await app.ready();

    try {
      const originTx = "a1".repeat(32);
      await writeOutbound(
        db,
        {
          chainKey: "stellar-testnet",
          block: 5_500_000n,
          txHash: originTx,
          logIndex: null,
          observedAt: new Date("2026-10-30T10:00:00Z"),
        },
        {
          route: RouteKind.AxelarIts,
          nonce: 301n,
          sender: senderAddress,
          token: stellarUsdc,
          grossAmount: 10_000_000n,
          fee: 30_000n,
          netAmount: 9_970_000n,
          destinationChain: "sepolia",
          destination: recipientWord,
          railRef: null,
        },
      );
      const { rows } = await db.query("SELECT id FROM outbound_transfer WHERE nonce = 301");
      const transferId = BigInt(String(rows[0]!.id));

      const rpcCalls: string[] = [];
      const blocks = new Map<bigint, ItsBlock>([
        [originalBlock, { hash: originalBlockHash, timestamp: 1_790_600_000n }],
      ]);
      const receipts = new Map<string, ItsReceipt>([
        [
          originalTxHash.toLowerCase(),
          {
            status: "success",
            blockNumber: originalBlock,
            blockHash: originalBlockHash,
            transactionHash: originalTxHash,
            logs: makeLogs({}),
          },
        ],
      ]);
      const evmClient = createChainStateClient({
        head: originalBlock + 15n,
        blocks,
        receipts,
        rpcCalls,
      });

      const initial = await verifyItsDelivery(
        activeConfig,
        db,
        {
          transferId,
          route: RouteKind.AxelarIts,
          originChain: "stellar-testnet",
          destinationChain: "sepolia",
          nonce: 301n,
          originTx,
          status: "attested",
          checkFailures: 0,
          delivered: false,
        },
        {
          status: "attested",
          railStatus: "executed",
          reference: "0xmsg-301",
          attestedAt: new Date("2026-10-30T10:01:00Z"),
          execution: { txHash: originalTxHash, commandId },
        },
        {
          stellarView: mockStellarView(rpcCalls),
          evmClient,
          now: () => new Date("2026-10-30T10:02:00Z"),
        },
      );
      expect(initial?.itsPaymentProof).toBeDefined();

      await db.transaction(async (tx) => {
        await writeInbound(tx, initial!.at, initial!.row);
        await writeItsPaymentProof(tx, initial!.itsPaymentProof!);
        await writeAttestation(tx, {
          transferId,
          route: RouteKind.AxelarIts,
          status: "delivered",
          railStatus: "executed",
          railReference: "0xmsg-301",
          attestedAt: new Date("2026-10-30T10:01:00Z"),
          checkedAt: new Date("2026-10-30T10:02:00Z"),
          checkFailures: 0,
          lastError: null,
        });
      });

      // Initially canonical: revalidation keeps the confirmed payout intact.
      const healthySummary = await revalidateItsDeliveryProofs(activeConfig, db, {
        stellarView: mockStellarView(rpcCalls),
        evmClient,
        now: () => new Date("2026-10-30T10:03:00Z"),
      });
      expect(healthySummary).toEqual({ checked: 1, valid: 1, reconciled: 0, invalidated: 0 });
      const beforeReorgRes = await app.inject("/v1/transfers/stellar-testnet/301");
      expect(beforeReorgRes.json().stage).toBe("delivered");
      expect(beforeReorgRes.json().destination.delivered).toBe(true);

      // Simulate destination chain reorg: block 9,100,000 now has a different canonical hash and originalTx disappeared.
      blocks.set(originalBlock, { hash: reorgedBlockHash, timestamp: 1_790_600_010n });
      receipts.delete(originalTxHash.toLowerCase());
      rpcCalls.length = 0;

      // Even if GMP still claims `executed` on the orphaned txHash, revalidation invalidates the orphaned proof.
      const staleGmp = new AxelarGmpClient("https://testnet.api.gmp.axelarscan.io", {
        fetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                data: [
                  {
                    call: { transactionHash: originTx },
                    status: "executed",
                    command_id: commandId,
                    executed: { transactionHash: originalTxHash },
                  },
                ],
              }),
            ),
          ),
      });

      const reorgSummary = await revalidateItsDeliveryProofs(activeConfig, db, {
        stellarView: mockStellarView(rpcCalls),
        evmClient,
        gmpClient: staleGmp,
        now: () => new Date("2026-10-30T10:05:00Z"),
      });
      expect(reorgSummary).toEqual({ checked: 1, valid: 0, reconciled: 0, invalidated: 1 });

      // Transfer is no longer confirmed in inbound_delivery or the HTTP API, and returns to the rail poll queue.
      const afterReorgRes = await app.inject("/v1/transfers/stellar-testnet/301");
      expect(afterReorgRes.json().stage).toBe("delivering");
      expect(afterReorgRes.json().destination.delivered).toBe(false);
      expect(afterReorgRes.json().rail.lastError).toBe("its_proof_orphaned_by_reorg");

      const { rows: proofRows } = await db.query(
        "SELECT proof_state, orphaned_block_hash, orphaned_tx FROM its_payment_proof WHERE transfer_id = $1",
        [transferId.toString()],
      );
      expect(proofRows[0]).toEqual({
        proof_state: "orphaned",
        orphaned_block_hash: originalBlockHash.toLowerCase(),
        orphaned_tx: originalTxHash.toLowerCase(),
      });

      const requeued = await pendingForRail(db, {
        route: RouteKind.AxelarIts,
        limit: 10,
        notCheckedSince: new Date("2026-10-30T10:10:00Z"),
        maxCheckFailures: 5,
      });
      expect(requeued.map((t) => t.nonce)).toContain(301n);
      expect(requeued[0]?.delivered).toBe(false);

      // Revalidation performed strictly read-only calls (zero send/write/broadcast calls).
      for (const call of rpcCalls) {
        expect(call).toMatch(/^(stellar\.view:|evm\.(get|read))/);
      }
    } finally {
      await app.close();
      await pg.close();
    }
  });

  it("reconciles orphaned proofs only when a replacement proof matches the original source transfer intent", async () => {
    const { pg, db } = await openMigratedDb();
    try {
      const originTx = "b2".repeat(32);
      await writeOutbound(
        db,
        {
          chainKey: "stellar-testnet",
          block: 5_500_010n,
          txHash: originTx,
          logIndex: null,
          observedAt: new Date("2026-10-30T11:00:00Z"),
        },
        {
          route: RouteKind.AxelarIts,
          nonce: 302n,
          sender: senderAddress,
          token: stellarUsdc,
          grossAmount: 10_000_000n,
          fee: 30_000n,
          netAmount: 9_970_000n,
          destinationChain: "sepolia",
          destination: recipientWord,
          railRef: null,
        },
      );
      const { rows } = await db.query("SELECT id FROM outbound_transfer WHERE nonce = 302");
      const transferId = BigInt(String(rows[0]!.id));

      await db.transaction(async (tx) => {
        await writeInbound(
          tx,
          {
            chainKey: "sepolia",
            block: originalBlock,
            txHash: originalTxHash,
            logIndex: 5,
            observedAt: new Date("2026-10-30T11:01:00Z"),
          },
          {
            route: RouteKind.AxelarIts,
            sourceChain: "stellar-testnet",
            sourceNonce: 302n,
            railMessageId: commandId,
            recipient: recipientAddress.toLowerCase(),
            token: destinationTokenAddress.toLowerCase(),
            amount: 9_970_000n,
            delivered: true,
            claimId: null,
          },
        );
        await writeItsPaymentProof(tx, {
          transferId,
          destinationChain: "sepolia",
          route: RouteKind.AxelarIts,
          sourceChain: "stellar-testnet",
          sourceNonce: 302n,
          commandId: commandId.toLowerCase(),
          tokenId: tokenId.toLowerCase(),
          token: destinationTokenAddress.toLowerCase(),
          recipient: recipientAddress.toLowerCase(),
          amount: 9_970_000n,
          proofBlock: originalBlock,
          proofBlockHash: originalBlockHash.toLowerCase(),
          proofTx: originalTxHash.toLowerCase(),
          proofLogIndex: 5,
          verifiedAt: new Date("2026-10-30T11:01:00Z"),
        });
      });

      const rpcCalls: string[] = [];
      const blocks = new Map<bigint, ItsBlock>([
        [originalBlock, { hash: reorgedBlockHash, timestamp: 1_790_600_100n }],
        [replacementBlock, { hash: replacementBlockHash, timestamp: 1_790_600_200n }],
      ]);

      // 1. Replacement receipt with mismatched recipient or amount MUST NOT reconcile the orphaned proof.
      const wrongAmountReceipts = new Map<string, ItsReceipt>([
        [
          replacementTxHash.toLowerCase(),
          {
            status: "success",
            blockNumber: replacementBlock,
            blockHash: replacementBlockHash,
            transactionHash: replacementTxHash,
            logs: makeLogs({ cmdId: replacementCommandId, amount: 9_969_999n }),
          },
        ],
      ]);
      const gmpWithBothCandidates = () =>
        new AxelarGmpClient("https://testnet.api.gmp.axelarscan.io", {
          fetch: () =>
            Promise.resolve(
              new Response(
                JSON.stringify({
                  data: [
                    {
                      call: { transactionHash: originTx },
                      status: "executed",
                      command_id: commandId,
                      executed: { transactionHash: originalTxHash },
                    },
                    {
                      call: { transactionHash: originTx },
                      status: "executed",
                      command_id: replacementCommandId,
                      executed: { transactionHash: replacementTxHash },
                    },
                  ],
                }),
              ),
            ),
        });

      const rejectedSummary = await revalidateItsDeliveryProofs(activeConfig, db, {
        stellarView: mockStellarView(rpcCalls),
        evmClient: createChainStateClient({
          head: replacementBlock + 15n,
          blocks,
          receipts: wrongAmountReceipts,
          rpcCalls,
        }),
        gmpClient: gmpWithBothCandidates(),
        now: () => new Date("2026-10-30T11:05:00Z"),
      });
      expect(rejectedSummary).toEqual({ checked: 1, valid: 0, reconciled: 0, invalidated: 1 });
      const { rows: inboundAfterReject } = await db.query(
        "SELECT 1 FROM inbound_delivery WHERE source_nonce = 302",
      );
      expect(inboundAfterReject).toHaveLength(0);

      // Reset to canonical at originalBlock to test successful reconciliation when replacement matches exact intent.
      await db.transaction(async (tx) => {
        await writeInbound(
          tx,
          {
            chainKey: "sepolia",
            block: originalBlock,
            txHash: originalTxHash,
            logIndex: 5,
            observedAt: new Date("2026-10-30T11:01:00Z"),
          },
          {
            route: RouteKind.AxelarIts,
            sourceChain: "stellar-testnet",
            sourceNonce: 302n,
            railMessageId: commandId,
            recipient: recipientAddress.toLowerCase(),
            token: destinationTokenAddress.toLowerCase(),
            amount: 9_970_000n,
            delivered: true,
            claimId: null,
          },
        );
        await writeItsPaymentProof(tx, {
          transferId,
          destinationChain: "sepolia",
          route: RouteKind.AxelarIts,
          sourceChain: "stellar-testnet",
          sourceNonce: 302n,
          commandId: commandId.toLowerCase(),
          tokenId: tokenId.toLowerCase(),
          token: destinationTokenAddress.toLowerCase(),
          recipient: recipientAddress.toLowerCase(),
          amount: 9_970_000n,
          proofBlock: originalBlock,
          proofBlockHash: originalBlockHash.toLowerCase(),
          proofTx: originalTxHash.toLowerCase(),
          proofLogIndex: 5,
          verifiedAt: new Date("2026-10-30T11:01:00Z"),
        });
      });

      // 2. Matching replacement candidate reconciles inbound_delivery + its_payment_proof to the new canonical block.
      const validReplacementReceipts = new Map<string, ItsReceipt>([
        [
          replacementTxHash.toLowerCase(),
          {
            status: "success",
            blockNumber: replacementBlock,
            blockHash: replacementBlockHash,
            transactionHash: replacementTxHash,
            logs: makeLogs({ cmdId: replacementCommandId, amount: 9_970_000n }),
          },
        ],
      ]);

      const reconciledSummary = await revalidateItsDeliveryProofs(activeConfig, db, {
        stellarView: mockStellarView(rpcCalls),
        evmClient: createChainStateClient({
          head: replacementBlock + 15n,
          blocks,
          receipts: validReplacementReceipts,
          rpcCalls,
        }),
        gmpClient: gmpWithBothCandidates(),
        now: () => new Date("2026-10-30T11:08:00Z"),
      });
      expect(reconciledSummary).toEqual({ checked: 1, valid: 0, reconciled: 1, invalidated: 0 });

      const { rows: inboundAfterReconcile } = await db.query(
        "SELECT destination_block, destination_tx, rail_message_id, amount, delivered FROM inbound_delivery WHERE source_nonce = 302",
      );
      expect(inboundAfterReconcile[0]).toEqual({
        destination_block: replacementBlock.toString(),
        destination_tx: replacementTxHash,
        rail_message_id: replacementCommandId,
        amount: "9970000",
        delivered: true,
      });

      const { rows: proofAfterReconcile } = await db.query(
        "SELECT proof_state, proof_block, proof_block_hash, proof_tx, orphaned_block_hash, orphaned_tx FROM its_payment_proof WHERE transfer_id = $1",
        [transferId.toString()],
      );
      expect(proofAfterReconcile[0]).toEqual({
        proof_state: "canonical",
        proof_block: replacementBlock.toString(),
        proof_block_hash: replacementBlockHash.toLowerCase(),
        proof_tx: replacementTxHash.toLowerCase(),
        orphaned_block_hash: originalBlockHash.toLowerCase(),
        orphaned_tx: originalTxHash.toLowerCase(),
      });
    } finally {
      await pg.close();
    }
  });
});
