import { dirname, join } from "node:path";
import pino from "pino";
import { CHAINS, RAIL_CONTRACTS, RouteKind, isEvmChain } from "@hyperion/protocol";
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, hexToBytes, stringToHex, type Hex } from "viem";
import { loadConfig } from "../../src/config/config.js";
import type { Queryable, Transactional } from "../../src/db/pool.js";
import { verifyItsDelivery } from "../../src/rails/axelar/delivery.js";
import {
  ITS_ABI,
  matchingPayment,
  type DeliveryLog,
  type ExpectedDelivery,
} from "../../src/rails/axelar/events.js";
import type { PendingTransfer, RailReport } from "../../src/rails/types.js";
import { completeEnv, FIXTURES_DIR } from "../helpers.js";

const STELLAR_ONLY_DEPLOYMENTS = join(dirname(FIXTURES_DIR), "..", "deployments", "testnet.json");
const recipient = "0x1111111111111111111111111111111111111111";
const its = "0x2222222222222222222222222222222222222222";
const token = "0x3333333333333333333333333333333333333333";
const commandId: Hex = `0x${"ab".repeat(32)}`;
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

function itsJsonRpcResponse(id: unknown, result: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

function parseItsRpcBody(init?: RequestInit): { id: number; method: string } {
  const text = typeof init?.body === "string" ? init.body : "{}";
  return JSON.parse(text) as { id: number; method: string };
}

describe("verifyItsDelivery destination overrides, failover, and evidence consistency", () => {
  const senderStrkey = "GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA";
  const sourceTokenSac = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
  const txHash: Hex = `0x${"55".repeat(32)}`;
  const blockHash: Hex = `0x${"77".repeat(32)}`;
  const blockNumberHex = "0xc8"; // 200
  const headHex = "0xd2"; // 210
  const sepoliaChainId = isEvmChain(CHAINS.sepolia) ? CHAINS.sepolia.chainId : 11_155_111;
  const sepoliaIts = (RAIL_CONTRACTS.sepolia?.axelar?.interchainTokenService ??
    "0xB5FB4BE02232B1bBA4dC8f81dc24C26980dE9e3C") as Hex;

  const itsReceivedLog = {
    address: sepoliaIts,
    topics: encodeEventTopics({
      abi: ITS_ABI,
      eventName: "InterchainTransferReceived",
      args: { commandId, tokenId, destinationAddress: recipient },
    }),
    data: encodeAbiParameters(
      [{ type: "string" }, { type: "bytes" }, { type: "uint256" }, { type: "bytes32" }],
      [expected.sourceChain, stringToHex(senderStrkey), expected.amount, `0x${"0".repeat(64)}`],
    ),
    logIndex: "0x2",
    blockNumber: blockNumberHex,
    blockHash,
    transactionHash: txHash,
    transactionIndex: "0x0",
    removed: false,
  };
  const itsPaidLog = {
    address: token,
    topics: encodeEventTopics({
      abi: ITS_ABI,
      eventName: "Transfer",
      args: { from: sepoliaIts, to: recipient },
    }),
    data: encodeAbiParameters([{ type: "uint256" }], [expected.amount]),
    logIndex: "0x3",
    blockNumber: blockNumberHex,
    blockHash,
    transactionHash: txHash,
    transactionIndex: "0x0",
    removed: false,
  };

  const transfer: PendingTransfer = {
    transferId: 88n,
    route: RouteKind.AxelarIts,
    originChain: "stellar-testnet",
    destinationChain: "sepolia",
    nonce: 9n,
    originTx: "stellar-its-tx",
    status: "attested",
    checkFailures: 0,
    delivered: false,
  };
  const report: RailReport = {
    status: "attested",
    railStatus: "executed",
    reference: "axelar-msg-88",
    attestedAt: new Date("2026-10-29T11:00:00.000Z"),
    execution: { txHash, commandId },
  };

  function makeItsDb(): Transactional {
    const queryable: Queryable = {
      query(sql: string) {
        if (sql.includes("FROM outbound_transfer")) {
          return Promise.resolve({
            rows: [
              {
                sender: senderStrkey,
                token: sourceTokenSac,
                net_amount: expected.amount.toString(),
                destination: `0x${recipient.slice(2).padStart(64, "0")}`,
              },
            ],
            rowCount: 1,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    };
    return {
      query: (sql, params) => queryable.query(sql, params),
      transaction: <T>(work: (tx: Queryable) => Promise<T>) => work(queryable),
    };
  }

  function sourceView(_contract: string, method: string): Promise<unknown> {
    if (method === "token_id_for") return Promise.resolve(hexToBytes(tokenId));
    if (method === "get_config")
      return Promise.resolve({ its: "CC7LAC4S7KAPIM26WKWFSOXWLNLSG7EXTC2EVY2H2UPKSTX3Z2A7M5YP" });
    if (method === "chain_name") return Promise.resolve(expected.sourceChain);
    return Promise.reject(new Error(`unexpected soroban view ${method}`));
  }

  it("verifies ITS delivery using explicit destination overrides and recovers from primary failure", async () => {
    const primaryUrl = "https://ops:secretPass1@its-primary.example.invalid/v2/secretKey1?token=q1";
    const secondaryUrl =
      "https://ops:secretPass2@its-secondary.example.invalid/v2/secretKey2?token=q2";
    const config = loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: STELLAR_ONLY_DEPLOYMENTS,
        RAIL_DESTINATION_RPC_URLS_SEPOLIA: `${primaryUrl}, ${secondaryUrl}`,
      }),
    });
    expect(config.indexer.evm).toEqual([]);

    const rawLogs: string[] = [];
    const logger = pino({ level: "trace" }, { write: (line) => rawLogs.push(line) });

    // Primary fails on eth_call (registeredTokenAddress), secondary completes eth_call and eth_getBlockByNumber.
    const fetchFn: typeof globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = parseItsRpcBody(init);
      if (url.includes("its-primary.example.invalid") && body.method === "eth_call") {
        return Promise.reject(new Error(`timeout talking to ${primaryUrl}`));
      }
      if (body.method === "eth_chainId") {
        return itsJsonRpcResponse(body.id, `0x${sepoliaChainId.toString(16)}`);
      }
      if (body.method === "eth_getTransactionReceipt") {
        return itsJsonRpcResponse(body.id, {
          transactionHash: txHash,
          transactionIndex: "0x0",
          blockHash,
          blockNumber: blockNumberHex,
          from: recipient,
          to: sepoliaIts,
          cumulativeGasUsed: "0x5208",
          gasUsed: "0x5208",
          effectiveGasPrice: "0x3b9aca00",
          logs: [itsReceivedLog, itsPaidLog],
          logsBloom: `0x${"00".repeat(256)}`,
          status: "0x1",
          type: "0x2",
        });
      }
      if (body.method === "eth_blockNumber") {
        return itsJsonRpcResponse(body.id, headHex);
      }
      if (body.method === "eth_call") {
        return itsJsonRpcResponse(body.id, encodeAbiParameters([{ type: "address" }], [token]));
      }
      if (body.method === "eth_getBlockByNumber") {
        return itsJsonRpcResponse(body.id, {
          number: blockNumberHex,
          hash: blockHash,
          parentHash: `0x${"22".repeat(32)}`,
          timestamp: "0x6720b380",
          transactions: [],
        });
      }
      return Promise.reject(new Error(`unexpected ${body.method}`));
    };

    const verified = await verifyItsDelivery(config, makeItsDb(), transfer, report, {
      fetchFn,
      logger,
      sourceView,
    });
    expect(verified).not.toBeNull();
    expect(verified?.at.chainKey).toBe("sepolia");
    expect(verified?.row.amount).toBe(expected.amount);
    expect(verified?.row.token).toBe(token.toLowerCase());

    const logDump = rawLogs.join("\n");
    expect(logDump).toContain("https://its-primary.example.invalid");
    expect(logDump).toContain("https://its-secondary.example.invalid");
    for (const secret of ["secretPass1", "secretPass2", "secretKey1", "secretKey2", "token=q"]) {
      expect(logDump).not.toContain(secret);
    }
  });

  it("refuses wrong-network endpoints, all-endpoint failures, and inconsistent block hashes", async () => {
    const primaryUrl = "https://its-primary.example.invalid/rpc";
    const secondaryUrl = "https://its-secondary.example.invalid/rpc";
    const config = loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: STELLAR_ONLY_DEPLOYMENTS,
        RAIL_DESTINATION_RPC_URLS_SEPOLIA: `${primaryUrl}, ${secondaryUrl}`,
      }),
    });
    const db = makeItsDb();

    // 1. All endpoints fail transport
    await expect(
      verifyItsDelivery(config, db, transfer, report, {
        sourceView,
        fetchFn: () => Promise.reject(new Error("connection refused")),
      }),
    ).rejects.toThrow(/Destination RPC verification failed/);

    // 2. Wrong chain ID on both endpoints (Base Sepolia 84532 instead of Sepolia 11155111)
    await expect(
      verifyItsDelivery(config, db, transfer, report, {
        sourceView,
        fetchFn: (_input, init) => {
          const body = parseItsRpcBody(init);
          return itsJsonRpcResponse(body.id, "0x14a34");
        },
      }),
    ).rejects.toThrow(/chain mismatch/i);

    // 3. Noncanonical block hash after failover returns null instead of delivering
    const nonCanonicalFetch: typeof globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = parseItsRpcBody(init);
      if (body.method === "eth_chainId") {
        return itsJsonRpcResponse(body.id, `0x${sepoliaChainId.toString(16)}`);
      }
      if (url === primaryUrl && body.method === "eth_getTransactionReceipt") {
        return itsJsonRpcResponse(body.id, {
          transactionHash: txHash,
          transactionIndex: "0x0",
          blockHash,
          blockNumber: blockNumberHex,
          from: recipient,
          to: sepoliaIts,
          cumulativeGasUsed: "0x5208",
          gasUsed: "0x5208",
          effectiveGasPrice: "0x3b9aca00",
          logs: [itsReceivedLog, itsPaidLog],
          logsBloom: `0x${"00".repeat(256)}`,
          status: "0x1",
          type: "0x2",
        });
      }
      if (url === primaryUrl) return Promise.reject(new Error("primary dropped"));
      if (body.method === "eth_blockNumber") return itsJsonRpcResponse(body.id, headHex);
      if (body.method === "eth_call") {
        return itsJsonRpcResponse(body.id, encodeAbiParameters([{ type: "address" }], [token]));
      }
      if (body.method === "eth_getBlockByNumber") {
        return itsJsonRpcResponse(body.id, {
          number: blockNumberHex,
          hash: `0x${"ee".repeat(32)}`,
          parentHash: `0x${"22".repeat(32)}`,
          timestamp: "0x6720b380",
          transactions: [],
        });
      }
      return Promise.reject(new Error(`unexpected ${body.method}`));
    };
    expect(
      await verifyItsDelivery(config, db, transfer, report, {
        sourceView,
        fetchFn: nonCanonicalFetch,
      }),
    ).toBeNull();
  });
});
