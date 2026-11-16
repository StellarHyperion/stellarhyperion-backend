import {
  AddressKind,
  CHAINS,
  RAIL_CONTRACTS,
  RouteKind,
  encodeStellarAddress,
  isEvmChain,
} from "@hyperion/protocol";
import { nativeToScVal, rpc, type xdr } from "@stellar/stellar-sdk";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  stringToHex,
  type Hex,
} from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import type { QueryResultRows, Transactional } from "../../src/db/pool.js";
import { verifyItsDelivery } from "../../src/rails/axelar/delivery.js";
import { ITS_ABI } from "../../src/rails/axelar/events.js";
import { AxelarGmpClient } from "../../src/rails/axelar/gmp.js";
import type { PendingTransfer, RailReport } from "../../src/rails/types.js";
import { completeEnv } from "../helpers.js";

const BASE_GMP_URL = "https://testnet.api.gmp.axelarscan.io";

const TRANSFER_ALICE: PendingTransfer = {
  transferId: 11n,
  route: RouteKind.AxelarIts,
  originChain: "stellar-testnet",
  destinationChain: "sepolia",
  nonce: 11n,
  originTx: `0x${"a1".repeat(32)}`,
  status: "attested",
  checkFailures: 0,
  delivered: false,
};

const ALICE_ADDR: Hex = "0x1111111111111111111111111111111111111111";
const BOB_ADDR: Hex = "0x2222222222222222222222222222222222222222";
const ALICE_WORD = `0x000000000000000000000000${ALICE_ADDR.slice(2)}`;
const DEST_TOKEN: Hex = "0x7777777777777777777777777777777777777777";
const TOKEN_ID_BYTES = new Uint8Array(32).fill(0xcd);
const TOKEN_ID_HEX: Hex = `0x${"cd".repeat(32)}`;
const STELLAR_ITS_ID = encodeStellarAddress(AddressKind.Contract, new Uint8Array(32).fill(0x33));
const STELLAR_ADAPTER_ID = encodeStellarAddress(
  AddressKind.Contract,
  new Uint8Array(32).fill(0x44),
);

function mockStaticDb(row: Record<string, unknown>): Transactional {
  const query = (): Promise<QueryResultRows> => Promise.resolve({ rows: [row], rowCount: 1 });
  return {
    query,
    transaction: <T>(work: (tx: { query: typeof query }) => Promise<T>): Promise<T> =>
      work({ query }),
  };
}

describe("Shared destination receipt candidate resolution across AxelarGmpClient and verifyItsDelivery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deduplicates identical GMP execution rows deterministically and withholds conflicting execution claims", async () => {
    const sharedTx: Hex = `0x${"dd".repeat(32)}`;
    const cmdA: Hex = `0x${"01".repeat(32)}`;
    const cmdB: Hex = `0x${"02".repeat(32)}`;

    // 1. Exact duplicate GMP rows collapse to one unambiguous execution.
    const dupFetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                message_id: `${TRANSFER_ALICE.originTx}-1`,
                call: { transactionHash: TRANSFER_ALICE.originTx },
                status: "executed",
                command_id: cmdA,
                executed: { transactionHash: sharedTx },
              },
              {
                message_id: `${TRANSFER_ALICE.originTx}-1`,
                call: { transactionHash: TRANSFER_ALICE.originTx.toUpperCase() },
                status: "executed",
                command_id: cmdA.toUpperCase(),
                executed: { transactionHash: sharedTx.toUpperCase() },
              },
            ],
          }),
        ),
      )) as typeof globalThis.fetch;

    const dupLookup = await new AxelarGmpClient(BASE_GMP_URL, { fetch: dupFetch }).look(
      TRANSFER_ALICE,
    );
    expect(dupLookup.kind).toBe("found");
    if (dupLookup.kind === "found") {
      expect(dupLookup.report.execution).toEqual({ txHash: sharedTx, commandId: cmdA });
      expect(dupLookup.report.executions).toHaveLength(1);
    }

    // 2. Conflicting destination txHash claims for the same commandId remain unverified.
    const conflictFetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                message_id: `${TRANSFER_ALICE.originTx}-1`,
                call: { transactionHash: TRANSFER_ALICE.originTx },
                status: "executed",
                command_id: cmdA,
                executed: { transactionHash: sharedTx },
              },
              {
                message_id: `${TRANSFER_ALICE.originTx}-2`,
                call: { transactionHash: TRANSFER_ALICE.originTx },
                status: "executed",
                command_id: cmdA,
                executed: { transactionHash: `0x${"ee".repeat(32)}` },
              },
            ],
          }),
        ),
      )) as typeof globalThis.fetch;

    const conflictLookup = await new AxelarGmpClient(BASE_GMP_URL, { fetch: conflictFetch }).look(
      TRANSFER_ALICE,
    );
    expect(conflictLookup.kind).toBe("found");
    if (conflictLookup.kind === "found") {
      expect(conflictLookup.report.execution).toBeUndefined();
      expect(conflictLookup.report.executions).toBeUndefined();
    }

    // 3. Multiple distinct commands in one shared transaction surface ordered candidate executions.
    const multiFetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                message_id: `${TRANSFER_ALICE.originTx}-2`,
                call: { transactionHash: TRANSFER_ALICE.originTx },
                status: "executed",
                command_id: cmdB,
                executed: { transactionHash: sharedTx },
              },
              {
                message_id: `${TRANSFER_ALICE.originTx}-1`,
                call: { transactionHash: TRANSFER_ALICE.originTx },
                status: "executed",
                command_id: cmdA,
                executed: { transactionHash: sharedTx },
              },
            ],
          }),
        ),
      )) as typeof globalThis.fetch;

    const multiLookup = await new AxelarGmpClient(BASE_GMP_URL, { fetch: multiFetch }).look(
      TRANSFER_ALICE,
    );
    expect(multiLookup.kind).toBe("found");
    if (multiLookup.kind === "found") {
      expect(multiLookup.report.execution).toBeUndefined();
      expect(multiLookup.report.executions?.map((c) => c.commandId)).toEqual([cmdA, cmdB]);
    }
  });

  it("matches the exact ITS candidate in verifyItsDelivery for a shared receipt and rejects indistinguishable double matches", async () => {
    const baseConfig = loadConfig({ env: completeEnv({ KEEPER_ENABLED: "false" }) });
    const sepoliaChain = CHAINS.sepolia;
    if (!isEvmChain(sepoliaChain)) {
      throw new Error("Expected sepolia to be an EVM chain");
    }
    const itsAddress = RAIL_CONTRACTS.sepolia?.axelar?.interchainTokenService as Hex | undefined;
    if (!itsAddress) {
      throw new Error("Expected sepolia ITS address");
    }

    const sourceNet = baseConfig.deployments.networks["stellar-testnet"];
    if (sourceNet?.family !== "stellar" || !sourceNet.tokens.USDC) {
      throw new Error("Expected stellar-testnet USDC deployment");
    }
    const config = {
      ...baseConfig,
      deployments: {
        ...baseConfig.deployments,
        networks: {
          ...baseConfig.deployments.networks,
          "stellar-testnet": {
            ...sourceNet,
            adapters: {
              ...sourceNet.adapters,
              [RouteKind.AxelarIts]: STELLAR_ADAPTER_ID,
            },
          },
        },
      },
    };
    const sender = sourceNet.admin;
    const stellarToken = sourceNet.tokens.USDC.sacId;

    const sharedTx: Hex = `0x${"dd".repeat(32)}`;
    const blockHash: Hex = `0x${"bb".repeat(32)}`;
    const cmdAlice: Hex = `0x${"01".repeat(32)}`;
    const cmdBob: Hex = `0x${"02".repeat(32)}`;
    const cmdAliceClone: Hex = `0x${"03".repeat(32)}`;
    const aliceAmount = 9_500_000n;
    const bobAmount = 4_200_000n;

    const buildReceiptLogs = (includeCloneForAlice: boolean) => {
      const logs = [
        // Bob's transfer in the shared receipt (logIndex 0 & 1)
        {
          address: DEST_TOKEN,
          topics: encodeEventTopics({
            abi: ITS_ABI,
            eventName: "Transfer",
            args: { from: itsAddress, to: BOB_ADDR },
          }),
          data: encodeAbiParameters([{ type: "uint256" }], [bobAmount]),
          logIndex: "0x0",
          blockHash,
          blockNumber: "0x100",
          transactionHash: sharedTx,
          transactionIndex: "0x0",
          removed: false,
        },
        {
          address: itsAddress,
          topics: encodeEventTopics({
            abi: ITS_ABI,
            eventName: "InterchainTransferReceived",
            args: { commandId: cmdBob, tokenId: TOKEN_ID_HEX, destinationAddress: BOB_ADDR },
          }),
          data: encodeAbiParameters(
            [{ type: "string" }, { type: "bytes" }, { type: "uint256" }, { type: "bytes32" }],
            ["stellar-2026-q1-2", stringToHex(sender), bobAmount, `0x${"00".repeat(32)}`],
          ),
          logIndex: "0x1",
          blockHash,
          blockNumber: "0x100",
          transactionHash: sharedTx,
          transactionIndex: "0x0",
          removed: false,
        },
        // Alice's transfer in the shared receipt (logIndex 2 & 3)
        {
          address: DEST_TOKEN,
          topics: encodeEventTopics({
            abi: ITS_ABI,
            eventName: "Transfer",
            args: { from: itsAddress, to: ALICE_ADDR },
          }),
          data: encodeAbiParameters([{ type: "uint256" }], [aliceAmount]),
          logIndex: "0x2",
          blockHash,
          blockNumber: "0x100",
          transactionHash: sharedTx,
          transactionIndex: "0x0",
          removed: false,
        },
        {
          address: itsAddress,
          topics: encodeEventTopics({
            abi: ITS_ABI,
            eventName: "InterchainTransferReceived",
            args: { commandId: cmdAlice, tokenId: TOKEN_ID_HEX, destinationAddress: ALICE_ADDR },
          }),
          data: encodeAbiParameters(
            [{ type: "string" }, { type: "bytes" }, { type: "uint256" }, { type: "bytes32" }],
            ["stellar-2026-q1-2", stringToHex(sender), aliceAmount, `0x${"00".repeat(32)}`],
          ),
          logIndex: "0x3",
          blockHash,
          blockNumber: "0x100",
          transactionHash: sharedTx,
          transactionIndex: "0x0",
          removed: false,
        },
      ];

      if (includeCloneForAlice) {
        logs.push(
          {
            address: DEST_TOKEN,
            topics: encodeEventTopics({
              abi: ITS_ABI,
              eventName: "Transfer",
              args: { from: itsAddress, to: ALICE_ADDR },
            }),
            data: encodeAbiParameters([{ type: "uint256" }], [aliceAmount]),
            logIndex: "0x4",
            blockHash,
            blockNumber: "0x100",
            transactionHash: sharedTx,
            transactionIndex: "0x0",
            removed: false,
          },
          {
            address: itsAddress,
            topics: encodeEventTopics({
              abi: ITS_ABI,
              eventName: "InterchainTransferReceived",
              args: {
                commandId: cmdAliceClone,
                tokenId: TOKEN_ID_HEX,
                destinationAddress: ALICE_ADDR,
              },
            }),
            data: encodeAbiParameters(
              [{ type: "string" }, { type: "bytes" }, { type: "uint256" }, { type: "bytes32" }],
              ["stellar-2026-q1-2", stringToHex(sender), aliceAmount, `0x${"00".repeat(32)}`],
            ),
            logIndex: "0x5",
            blockHash,
            blockNumber: "0x100",
            transactionHash: sharedTx,
            transactionIndex: "0x0",
            removed: false,
          },
        );
      }
      return logs;
    };

    let includeClone = false;
    let stellarSimStep = 0;

    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(() => {
      const step = stellarSimStep % 3;
      stellarSimStep += 1;
      let retval: xdr.ScVal;
      if (step === 0) {
        retval = nativeToScVal(Buffer.from(TOKEN_ID_BYTES), { type: "bytes" });
      } else if (step === 1) {
        retval = nativeToScVal({ its: STELLAR_ITS_ID });
      } else {
        retval = nativeToScVal("stellar-2026-q1-2", { type: "string" });
      }
      return Promise.resolve({
        id: "1",
        latestLedger: 1000,
        events: [],
        transactionData: {},
        result: {
          auth: [],
          retval,
        },
        minResourceFee: "100",
        cost: { cpuInsns: "1", memBytes: "1" },
        _parsed: true,
      } as unknown as rpc.Api.SimulateTransactionResponse);
    });

    vi.spyOn(globalThis, "fetch").mockImplementation((_input: unknown, init?: RequestInit) => {
      const bodyStr = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyStr) as {
        id?: number;
        method?: string;
      };

      // EVM JSON-RPC
      let rpcResult: unknown = null;
      if (parsed.method === "eth_chainId") {
        rpcResult = `0x${sepoliaChain.chainId.toString(16)}`;
      } else if (parsed.method === "eth_blockNumber") {
        rpcResult = "0x200";
      } else if (parsed.method === "eth_call") {
        rpcResult = encodeFunctionResult({
          abi: ITS_ABI,
          functionName: "registeredTokenAddress",
          result: DEST_TOKEN,
        });
      } else if (parsed.method === "eth_getTransactionReceipt") {
        rpcResult = {
          transactionHash: sharedTx,
          transactionIndex: "0x0",
          blockHash,
          blockNumber: "0x100",
          from: itsAddress,
          to: itsAddress,
          cumulativeGasUsed: "0x5208",
          gasUsed: "0x5208",
          contractAddress: null,
          logs: buildReceiptLogs(includeClone),
          logsBloom: `0x${"00".repeat(256)}`,
          status: "0x1",
          effectiveGasPrice: "0x1",
          type: "0x2",
        };
      } else if (parsed.method === "eth_getBlockByNumber") {
        rpcResult = {
          number: "0x100",
          hash: blockHash,
          timestamp: "0x67000000",
          parentHash: `0x${"11".repeat(32)}`,
          nonce: "0x0000000000000000",
          sha3Uncles: `0x${"00".repeat(32)}`,
          logsBloom: `0x${"00".repeat(256)}`,
          transactionsRoot: `0x${"00".repeat(32)}`,
          stateRoot: `0x${"00".repeat(32)}`,
          receiptsRoot: `0x${"00".repeat(32)}`,
          miner: itsAddress,
          difficulty: "0x0",
          totalDifficulty: "0x0",
          extraData: "0x",
          size: "0x100",
          gasLimit: "0x1000000",
          gasUsed: "0x5208",
          transactions: [],
          uncles: [],
        };
      }

      return Promise.resolve(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id ?? 1,
            result: rpcResult,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });

    const db = mockStaticDb({
      sender,
      token: stellarToken,
      net_amount: aliceAmount.toString(),
      destination: ALICE_WORD,
      rail_ref: null,
    });

    const sharedReport: RailReport = {
      status: "attested",
      railStatus: "executed/received",
      reference: null,
      attestedAt: new Date("2026-10-12T00:00:00Z"),
      executions: [
        { txHash: sharedTx, commandId: cmdBob },
        { txHash: sharedTx, commandId: cmdAlice },
      ],
    };

    // Disambiguates Alice's command and exact payment (logIndex 2) from Bob's in the shared receipt.
    const verified = await verifyItsDelivery(config, db, TRANSFER_ALICE, sharedReport);
    expect(verified).not.toBeNull();
    expect(verified?.row.railMessageId).toBe(cmdAlice);
    expect(verified?.row.recipient).toBe(ALICE_ADDR.toLowerCase());
    expect(verified?.row.amount).toBe(aliceAmount);
    expect(verified?.at.logIndex).toBe(2);

    // When two candidate commands in the report both satisfy Alice's exact tuple without rail_ref
    // disambiguation, verifyItsDelivery refuses to guess and leaves the transfer unverified.
    includeClone = true;
    const ambiguousReport: RailReport = {
      ...sharedReport,
      executions: [
        { txHash: sharedTx, commandId: cmdAlice },
        { txHash: sharedTx, commandId: cmdAliceClone },
      ],
    };
    const unverified = await verifyItsDelivery(config, db, TRANSFER_ALICE, ambiguousReport);
    expect(unverified).toBeNull();
  });
});
