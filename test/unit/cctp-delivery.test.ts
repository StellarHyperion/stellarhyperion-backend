import { dirname, join } from "node:path";
import pino from "pino";
import { StrKey } from "@stellar/stellar-sdk";
import { CHAINS, RAIL_CONTRACTS, RouteKind, assetOn, toHex } from "@hyperion/protocol";
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, hexToBytes, type Hex } from "viem";
import { redactRpcEndpoint, sanitizeRpcErrorMessage } from "../../src/chains/evm/client.js";
import { loadConfig } from "../../src/config/config.js";
import type { Queryable, Transactional } from "../../src/db/pool.js";
import { verifyCctpDelivery } from "../../src/rails/cctp/delivery.js";
import {
  CCTP_RECEIPT_ABI,
  matchingCctpPayment,
  verifiedCctpMessage,
  type ExpectedCctpTransfer,
} from "../../src/rails/cctp/events.js";
import type { DeliveryLog } from "../../src/rails/axelar/events.js";
import { reportFor } from "../../src/rails/cctp/iris.js";
import { RailPass } from "../../src/rails/pass.js";
import type { PendingTransfer, RailClient, RailReport } from "../../src/rails/types.js";
import { completeEnv, FIXTURES_DIR } from "../helpers.js";

const STELLAR_ONLY_DEPLOYMENTS = join(dirname(FIXTURES_DIR), "..", "deployments", "testnet.json");

const expected: ExpectedCctpTransfer = {
  sourceToken: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  sourceAdapter: "CARH6IA4TA5QAJNQG4B4I7N4336JEBS3GYLPZSEBUCWSNYTDRC7L3AHT",
  sourceMessenger: "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP",
  destinationDomain: 0,
  destinationMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  transmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
  token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  recipient: "0x1111111111111111111111111111111111111111",
  sourceAmount: 997000000n,
};
const nonce: Hex = `0x${"ab".repeat(32)}`;
const word = (address: string) => hexToBytes(`0x${address.slice(2).padStart(64, "0")}`);
function message() {
  const raw = new Uint8Array(148 + 228);
  const view = new DataView(raw.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, 27);
  view.setUint32(8, expected.destinationDomain);
  raw.set(hexToBytes(nonce), 12);
  raw.set(StrKey.decodeContract(expected.sourceMessenger), 44);
  raw.set(word(expected.destinationMessenger), 76);
  view.setUint32(140, 2000);
  view.setUint32(144, 2000);
  view.setUint32(148, 1);
  raw.set(StrKey.decodeContract(expected.sourceToken), 152);
  raw.set(word(expected.recipient), 184);
  raw.set(word(`0x${(expected.sourceAmount / 10n).toString(16)}`), 216);
  raw.set(StrKey.decodeContract(expected.sourceAdapter), 248);
  raw.set(word(`0x${500000n.toString(16)}`), 280);
  raw.set(word(`0x${100000n.toString(16)}`), 312);
  return toHex(raw);
}
const raw = message();
const verified = verifiedCctpMessage(raw, expected);
if (!verified) throw new Error("Invalid test message.");
const received: DeliveryLog = {
  address: expected.transmitter as Hex,
  topics: encodeEventTopics({
    abi: CCTP_RECEIPT_ABI,
    eventName: "MessageReceived",
    args: { caller: expected.recipient as Hex, nonce, finalityThresholdExecuted: 2000 },
  }) as [Hex, ...Hex[]],
  data: encodeAbiParameters(
    [{ type: "uint32" }, { type: "bytes32" }, { type: "bytes" }],
    [27, verified.message.sender, verified.body],
  ),
  logIndex: 4,
};
const paid: DeliveryLog = {
  address: expected.token as Hex,
  topics: encodeEventTopics({
    abi: CCTP_RECEIPT_ABI,
    eventName: "Transfer",
    args: { from: `0x${"0".repeat(40)}`, to: expected.recipient as Hex },
  }) as [Hex, ...Hex[]],
  data: encodeAbiParameters([{ type: "uint256" }], [verified.amount]),
  logIndex: 3,
};
describe("CCTP forwarded destination proof", () => {
  it("requires the exact attested message and an actual native-USDC mint after fees", () => {
    expect(verified.amount).toBe(99600000n);
    expect(matchingCctpPayment([paid, received], raw, expected)).toBe(paid);
    expect(matchingCctpPayment([received], raw, expected)).toBeNull();
    expect(matchingCctpPayment([paid], raw, expected)).toBeNull();
  });
  it.each(["sourceToken", "sourceAdapter", "sourceMessenger"] as const)(
    "binds the %s to the indexed source deployment",
    (field) => {
      const replacement = field === "sourceToken" ? expected.sourceAdapter : expected.sourceToken;
      expect(verifiedCctpMessage(raw, { ...expected, [field]: replacement })).toBeNull();
    },
  );
  it.each(["destinationMessenger", "recipient"] as const)("refuses a different %s", (field) => {
    expect(verifiedCctpMessage(raw, { ...expected, [field]: expected.token })).toBeNull();
  });
  it("refuses a different domain or source amount", () => {
    expect(verifiedCctpMessage(raw, { ...expected, destinationDomain: 6 })).toBeNull();
    expect(
      verifiedCctpMessage(raw, { ...expected, sourceAmount: expected.sourceAmount + 10n }),
    ).toBeNull();
  });
  it.each(["transmitter", "token"] as const)(
    "does not trust a log from another %s contract",
    (field) => {
      expect(
        matchingCctpPayment([paid, received], raw, { ...expected, [field]: expected.recipient }),
      ).toBeNull();
    },
  );
  it("refuses an ordinary transfer, incorrect payout and a different nonce", () => {
    const ordinary = {
      ...paid,
      topics: encodeEventTopics({
        abi: CCTP_RECEIPT_ABI,
        eventName: "Transfer",
        args: { from: expected.transmitter as Hex, to: expected.recipient as Hex },
      }) as [Hex, ...Hex[]],
    };
    expect(matchingCctpPayment([ordinary, received], raw, expected)).toBeNull();
    expect(
      matchingCctpPayment(
        [
          { ...paid, data: encodeAbiParameters([{ type: "uint256" }], [verified.amount + 1n]) },
          received,
        ],
        raw,
        expected,
      ),
    ).toBeNull();
    const changed = hexToBytes(raw);
    changed[12] = 1;
    expect(matchingCctpPayment([paid, received], toHex(changed), expected)).toBeNull();
  });
  it("refuses excessive fees and insufficient finality", () => {
    const changed = hexToBytes(raw);
    changed.set(word(`0x${600000n.toString(16)}`), 312);
    expect(verifiedCctpMessage(toHex(changed), expected)).toBeNull();
    const slow = hexToBytes(raw);
    new DataView(slow.buffer).setUint32(144, 1000);
    expect(verifiedCctpMessage(toHex(slow), expected)).toBeNull();
  });
  it("treats Circle's forward hash only as a candidate, never as delivered", () => {
    const txHash = `0x${"aa".repeat(32)}`;
    expect(reportFor({ status: "complete", forwardTxHash: txHash }).forwardTxHash).toBe(txHash);
    expect(reportFor({ status: "complete", forwardTxHash: txHash }).status).toBe("attested");
    expect(
      reportFor({ status: "complete", forwardTxHash: "invalid" }).forwardTxHash,
    ).toBeUndefined();
  });
});

function buildCctpFixtureForDestination(
  destinationChain: "sepolia" | "base-sepolia" | "arc-testnet",
) {
  const dest = CHAINS[destinationChain];
  const contracts = RAIL_CONTRACTS[destinationChain]?.cctp;
  const usdc = assetOn(destinationChain, "USDC");
  if (dest.family !== "evm" || dest.cctpDomain === null || !contracts || usdc?.family !== "evm") {
    throw new Error(`invalid destination ${destinationChain}`);
  }
  const destExpected: ExpectedCctpTransfer = {
    sourceToken: expected.sourceToken,
    sourceAdapter: expected.sourceAdapter,
    sourceMessenger: expected.sourceMessenger,
    destinationDomain: dest.cctpDomain,
    destinationMessenger: contracts.tokenMessengerV2,
    transmitter: contracts.messageTransmitterV2,
    token: usdc.address,
    recipient: expected.recipient,
    sourceAmount: expected.sourceAmount,
  };
  const buf = new Uint8Array(148 + 228);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, 27);
  view.setUint32(8, destExpected.destinationDomain);
  buf.set(hexToBytes(nonce), 12);
  buf.set(StrKey.decodeContract(destExpected.sourceMessenger), 44);
  buf.set(word(destExpected.destinationMessenger), 76);
  view.setUint32(140, 2000);
  view.setUint32(144, 2000);
  view.setUint32(148, 1);
  buf.set(StrKey.decodeContract(destExpected.sourceToken), 152);
  buf.set(word(destExpected.recipient), 184);
  buf.set(word(`0x${(destExpected.sourceAmount / 10n).toString(16)}`), 216);
  buf.set(StrKey.decodeContract(destExpected.sourceAdapter), 248);
  buf.set(word(`0x${500000n.toString(16)}`), 280);
  buf.set(word(`0x${100000n.toString(16)}`), 312);
  const messageBytes = toHex(buf);
  const parsedMsg = verifiedCctpMessage(messageBytes, destExpected);
  if (!parsedMsg) throw new Error("failed to build valid CCTP message");

  const forwardTxHash: Hex = `0x${"42".repeat(32)}`;
  const blockHash: Hex = `0x${"99".repeat(32)}`;
  const blockNumberHex = "0x64"; // 100
  const headHex = "0x6e"; // 110

  const msgLog = {
    address: destExpected.transmitter,
    topics: encodeEventTopics({
      abi: CCTP_RECEIPT_ABI,
      eventName: "MessageReceived",
      args: { caller: destExpected.recipient as Hex, nonce, finalityThresholdExecuted: 2000 },
    }),
    data: encodeAbiParameters(
      [{ type: "uint32" }, { type: "bytes32" }, { type: "bytes" }],
      [27, parsedMsg.message.sender, parsedMsg.body],
    ),
    logIndex: "0x4",
    blockNumber: blockNumberHex,
    blockHash,
    transactionHash: forwardTxHash,
    transactionIndex: "0x0",
    removed: false,
  };
  const mintLog = {
    address: destExpected.token,
    topics: encodeEventTopics({
      abi: CCTP_RECEIPT_ABI,
      eventName: "Transfer",
      args: { from: `0x${"0".repeat(40)}`, to: destExpected.recipient as Hex },
    }),
    data: encodeAbiParameters([{ type: "uint256" }], [parsedMsg.amount]),
    logIndex: "0x3",
    blockNumber: blockNumberHex,
    blockHash,
    transactionHash: forwardTxHash,
    transactionIndex: "0x0",
    removed: false,
  };

  const transfer: PendingTransfer = {
    transferId: 77n,
    route: RouteKind.Cctp,
    originChain: "stellar-testnet",
    destinationChain,
    nonce: 5n,
    originTx: "stellar-burn-tx",
    status: "pending",
    checkFailures: 0,
    delivered: false,
  };
  const report: RailReport = {
    status: "attested",
    railStatus: "complete",
    reference: nonce,
    attestedAt: new Date("2026-10-29T10:00:00.000Z"),
    forwardTxHash,
    messageBytes,
  };

  return {
    dest,
    destExpected,
    parsedMsg,
    forwardTxHash,
    blockHash,
    blockNumberHex,
    headHex,
    logs: [mintLog, msgLog],
    transfer,
    report,
  };
}

function outboundDb(recipientAddress = expected.recipient): {
  db: Transactional;
  queries: { text: string; params: readonly unknown[] }[];
} {
  const queries: { text: string; params: readonly unknown[] }[] = [];
  const queryable: Queryable = {
    query(sql: string, params: readonly unknown[] = []) {
      queries.push({ text: sql, params });
      if (sql.includes("FROM outbound_transfer")) {
        return Promise.resolve({
          rows: [
            {
              token: expected.sourceToken,
              net_amount: expected.sourceAmount.toString(),
              destination: `0x${recipientAddress.slice(2).padStart(64, "0")}`,
            },
          ],
          rowCount: 1,
        });
      }
      if (sql.includes("SELECT id") && sql.includes("FROM outbound_transfer")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes("COUNT(*)::text AS total")) {
        return Promise.resolve({ rows: [{ total: "1" }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    },
  };
  return {
    queries,
    db: {
      query: (sql, params) => queryable.query(sql, params),
      transaction: <T>(work: (tx: Queryable) => Promise<T>) => work(queryable),
    },
  };
}

function jsonRpcResponse(id: unknown, result: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

function parseRpcBody(init?: RequestInit): { id: number; method: string } {
  const text = typeof init?.body === "string" ? init.body : "{}";
  return JSON.parse(text) as { id: number; method: string };
}

describe("verifyCctpDelivery destination overrides, failover, and redaction", () => {
  it.each([
    ["sepolia", "RAIL_DESTINATION_RPC_URLS_SEPOLIA"],
    ["base-sepolia", "RAIL_DESTINATION_RPC_URLS_BASE_SEPOLIA"],
    ["arc-testnet", "RAIL_DESTINATION_RPC_URLS_ARC_TESTNET"],
  ] as const)(
    "uses explicit destination overrides on %s without an EVM router deployment",
    async (chainKey, envVar) => {
      const fx = buildCctpFixtureForDestination(chainKey);
      const overrideUrl = `https://${chainKey}.override.invalid/v2/secret-key?token=topsecret`;
      const config = loadConfig({
        env: completeEnv({
          HYPERION_DEPLOYMENTS_FILE: STELLAR_ONLY_DEPLOYMENTS,
          [envVar]: overrideUrl,
        }),
      });
      expect(config.indexer.evm).toEqual([]);

      const calledUrls: string[] = [];
      const fetchFn: typeof globalThis.fetch = (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        calledUrls.push(url);
        const body = parseRpcBody(init);
        if (body.method === "eth_chainId") {
          return jsonRpcResponse(body.id, `0x${fx.dest.chainId.toString(16)}`);
        }
        if (body.method === "eth_getTransactionReceipt") {
          return jsonRpcResponse(body.id, {
            transactionHash: fx.forwardTxHash,
            transactionIndex: "0x0",
            blockHash: fx.blockHash,
            blockNumber: fx.blockNumberHex,
            from: fx.destExpected.recipient,
            to: fx.destExpected.transmitter,
            cumulativeGasUsed: "0x5208",
            gasUsed: "0x5208",
            effectiveGasPrice: "0x3b9aca00",
            logs: fx.logs,
            logsBloom: `0x${"00".repeat(256)}`,
            status: "0x1",
            type: "0x2",
          });
        }
        if (body.method === "eth_blockNumber") {
          return jsonRpcResponse(body.id, fx.headHex);
        }
        if (body.method === "eth_getBlockByNumber") {
          return jsonRpcResponse(body.id, {
            number: fx.blockNumberHex,
            hash: fx.blockHash,
            parentHash: `0x${"11".repeat(32)}`,
            timestamp: "0x6720b380",
            transactions: [],
          });
        }
        return Promise.reject(new Error(`unexpected method ${body.method}`));
      };

      const { db } = outboundDb();
      const delivery = await verifyCctpDelivery(config, db, fx.transfer, fx.report, { fetchFn });
      expect(delivery).not.toBeNull();
      expect(delivery?.at.chainKey).toBe(chainKey);
      expect(delivery?.row.amount).toBe(fx.parsedMsg.amount);
      expect(calledUrls.every((u) => u === overrideUrl)).toBe(true);
    },
  );

  it("recovers from primary failure via secondary endpoint and redacts credentials and API keys in logs", async () => {
    const fx = buildCctpFixtureForDestination("sepolia");
    const primaryUrl =
      "https://ops:my-secret-pass@primary-sep.example.invalid/v2/alchemy-secret-key?api_key=leak123";
    const secondaryUrl =
      "https://ops:backup-secret@secondary-sep.example.invalid/v3/infura-secret-key?token=leak456";
    const config = loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: STELLAR_ONLY_DEPLOYMENTS,
        RAIL_DESTINATION_RPC_URLS_SEPOLIA: `${primaryUrl}, ${secondaryUrl}`,
      }),
    });

    const rawLogLines: string[] = [];
    const logger = pino(
      { level: "trace" },
      {
        write(line: string) {
          rawLogLines.push(line);
        },
      },
    );
    const failovers: { failedEndpoint: string; fallbackEndpoint: string; reason: string }[] = [];

    // Primary serves chainId and receipt, then fails mid-verification on eth_blockNumber.
    const fetchFn: typeof globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = parseRpcBody(init);
      if (
        url.includes("primary-sep.example.invalid") &&
        (body.method === "eth_blockNumber" || body.method === "eth_getBlockByNumber")
      ) {
        return Promise.reject(
          new Error(
            `HTTP 503 upstream failure at ${primaryUrl} with Authorization: Bearer super-secret-jwt`,
          ),
        );
      }
      if (body.method === "eth_chainId") {
        return jsonRpcResponse(body.id, `0x${fx.dest.chainId.toString(16)}`);
      }
      if (body.method === "eth_getTransactionReceipt") {
        return jsonRpcResponse(body.id, {
          transactionHash: fx.forwardTxHash,
          transactionIndex: "0x0",
          blockHash: fx.blockHash,
          blockNumber: fx.blockNumberHex,
          from: fx.destExpected.recipient,
          to: fx.destExpected.transmitter,
          cumulativeGasUsed: "0x5208",
          gasUsed: "0x5208",
          effectiveGasPrice: "0x3b9aca00",
          logs: fx.logs,
          logsBloom: `0x${"00".repeat(256)}`,
          status: "0x1",
          type: "0x2",
        });
      }
      if (body.method === "eth_blockNumber") {
        return jsonRpcResponse(body.id, fx.headHex);
      }
      if (body.method === "eth_getBlockByNumber") {
        return jsonRpcResponse(body.id, {
          number: fx.blockNumberHex,
          hash: fx.blockHash,
          parentHash: `0x${"11".repeat(32)}`,
          timestamp: "0x6720b380",
          transactions: [],
        });
      }
      return Promise.reject(new Error(`unexpected method ${body.method}`));
    };

    const { db } = outboundDb();
    const delivery = await verifyCctpDelivery(config, db, fx.transfer, fx.report, {
      fetchFn,
      logger,
      onFailover: (ev) => failovers.push(ev),
    });

    expect(delivery).not.toBeNull();
    expect(failovers).toHaveLength(1);
    expect(failovers[0]?.failedEndpoint).toBe("https://primary-sep.example.invalid");
    expect(failovers[0]?.fallbackEndpoint).toBe("https://secondary-sep.example.invalid");

    const joinedLogs = rawLogLines.join("\n") + "\n" + JSON.stringify(failovers);
    for (const secret of [
      "my-secret-pass",
      "backup-secret",
      "alchemy-secret-key",
      "infura-secret-key",
      "leak123",
      "leak456",
      "super-secret-jwt",
    ]) {
      expect(joinedLogs).not.toContain(secret);
    }
    expect(redactRpcEndpoint(primaryUrl)).toBe("https://primary-sep.example.invalid");
    expect(
      sanitizeRpcErrorMessage(`Failed ${primaryUrl} Authorization: Bearer secret-bearer-token`),
    ).not.toContain("secret-bearer-token");
  });

  it("rejects wrong chain IDs, unconfirmed receipts, and inconsistent blocks across endpoints", async () => {
    const fx = buildCctpFixtureForDestination("sepolia");
    const primaryUrl = "https://primary-sep.example.invalid/rpc";
    const secondaryUrl = "https://secondary-sep.example.invalid/rpc";
    const config = loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: STELLAR_ONLY_DEPLOYMENTS,
        RAIL_DESTINATION_RPC_URLS_SEPOLIA: `${primaryUrl}, ${secondaryUrl}`,
      }),
    });
    const { db } = outboundDb();

    // 1. Primary fails on eth_getBlockByNumber, secondary reports wrong chainId (Mainnet = 0x1).
    const wrongSecondaryFetch: typeof globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = parseRpcBody(init);
      if (url === primaryUrl) {
        if (body.method === "eth_chainId")
          return jsonRpcResponse(body.id, `0x${fx.dest.chainId.toString(16)}`);
        if (body.method === "eth_getTransactionReceipt") {
          return jsonRpcResponse(body.id, {
            transactionHash: fx.forwardTxHash,
            transactionIndex: "0x0",
            blockHash: fx.blockHash,
            blockNumber: fx.blockNumberHex,
            from: fx.destExpected.recipient,
            to: fx.destExpected.transmitter,
            cumulativeGasUsed: "0x5208",
            gasUsed: "0x5208",
            effectiveGasPrice: "0x3b9aca00",
            logs: fx.logs,
            logsBloom: `0x${"00".repeat(256)}`,
            status: "0x1",
            type: "0x2",
          });
        }
        return Promise.reject(new Error("primary transport down"));
      }
      if (body.method === "eth_chainId") {
        return jsonRpcResponse(body.id, "0x1");
      }
      return Promise.reject(new Error("secondary should never be queried after chainId mismatch"));
    };
    await expect(
      verifyCctpDelivery(config, db, fx.transfer, fx.report, { fetchFn: wrongSecondaryFetch }),
    ).rejects.toThrow(/chain mismatch/i);

    // 2. Primary serves receipt with blockHash 0x99.., fails on getBlock; secondary returns block 100 with divergent hash 0x88..
    const divergentBlockFetch: typeof globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = parseRpcBody(init);
      if (body.method === "eth_chainId") {
        return jsonRpcResponse(body.id, `0x${fx.dest.chainId.toString(16)}`);
      }
      if (url === primaryUrl && body.method === "eth_getTransactionReceipt") {
        return jsonRpcResponse(body.id, {
          transactionHash: fx.forwardTxHash,
          transactionIndex: "0x0",
          blockHash: fx.blockHash,
          blockNumber: fx.blockNumberHex,
          from: fx.destExpected.recipient,
          to: fx.destExpected.transmitter,
          cumulativeGasUsed: "0x5208",
          gasUsed: "0x5208",
          effectiveGasPrice: "0x3b9aca00",
          logs: fx.logs,
          logsBloom: `0x${"00".repeat(256)}`,
          status: "0x1",
          type: "0x2",
        });
      }
      if (url === primaryUrl) return Promise.reject(new Error("primary failed before block check"));
      if (body.method === "eth_blockNumber") return jsonRpcResponse(body.id, fx.headHex);
      if (body.method === "eth_getBlockByNumber") {
        return jsonRpcResponse(body.id, {
          number: fx.blockNumberHex,
          hash: `0x${"88".repeat(32)}`,
          parentHash: `0x${"11".repeat(32)}`,
          timestamp: "0x6720b380",
          transactions: [],
        });
      }
      return Promise.reject(new Error(`unexpected ${body.method}`));
    };
    expect(
      await verifyCctpDelivery(config, db, fx.transfer, fx.report, {
        fetchFn: divergentBlockFetch,
      }),
    ).toBeNull();

    // 3. Unconfirmed receipt (head == receipt.blockNumber on Sepolia which requires 3 confirmations)
    const unconfirmedFetch: typeof globalThis.fetch = (_input, init) => {
      const body = parseRpcBody(init);
      if (body.method === "eth_chainId") {
        return jsonRpcResponse(body.id, `0x${fx.dest.chainId.toString(16)}`);
      }
      if (body.method === "eth_getTransactionReceipt") {
        return jsonRpcResponse(body.id, {
          transactionHash: fx.forwardTxHash,
          transactionIndex: "0x0",
          blockHash: fx.blockHash,
          blockNumber: fx.blockNumberHex,
          from: fx.destExpected.recipient,
          to: fx.destExpected.transmitter,
          cumulativeGasUsed: "0x5208",
          gasUsed: "0x5208",
          effectiveGasPrice: "0x3b9aca00",
          logs: fx.logs,
          logsBloom: `0x${"00".repeat(256)}`,
          status: "0x1",
          type: "0x2",
        });
      }
      if (body.method === "eth_blockNumber") return jsonRpcResponse(body.id, fx.blockNumberHex);
      return Promise.reject(new Error(`unexpected ${body.method}`));
    };
    expect(
      await verifyCctpDelivery(config, db, fx.transfer, fx.report, { fetchFn: unconfirmedFetch }),
    ).toBeNull();
  });

  it("leaves the transfer unverified and eligible for retry when all endpoints fail", async () => {
    const fx = buildCctpFixtureForDestination("sepolia");
    const secretPrimary =
      "https://user:secretA@sep1.example.invalid/v2/secretPathA?key=secretQueryA";
    const secretSecondary =
      "https://user:secretB@sep2.example.invalid/v2/secretPathB?key=secretQueryB";
    const config = loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: STELLAR_ONLY_DEPLOYMENTS,
        RAIL_DESTINATION_RPC_URLS_SEPOLIA: `${secretPrimary}, ${secretSecondary}`,
      }),
    });

    const recordedAttestations: readonly unknown[][] = [];
    const inboundWrites: readonly unknown[][] = [];
    const queryable: Queryable = {
      query(sql: string, params: readonly unknown[] = []) {
        if (
          sql.includes("FROM outbound_transfer t") &&
          sql.includes("SELECT 1 FROM inbound_delivery d")
        ) {
          return Promise.resolve({
            rows: [
              {
                id: fx.transfer.transferId.toString(),
                route: fx.transfer.route,
                origin_chain: fx.transfer.originChain,
                destination_chain: fx.transfer.destinationChain,
                nonce: fx.transfer.nonce.toString(),
                origin_tx: fx.transfer.originTx,
                status: fx.transfer.status,
                check_failures: 0,
                delivered: false,
              },
            ],
            rowCount: 1,
          });
        }
        if (sql.includes("SELECT token, net_amount, destination FROM outbound_transfer")) {
          return Promise.resolve({
            rows: [
              {
                token: expected.sourceToken,
                net_amount: expected.sourceAmount.toString(),
                destination: `0x${expected.recipient.slice(2).padStart(64, "0")}`,
              },
            ],
            rowCount: 1,
          });
        }
        if (sql.includes("INSERT INTO inbound_delivery")) {
          (inboundWrites as unknown[][]).push([...params]);
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
        if (sql.includes("INSERT INTO rail_attestation")) {
          (recordedAttestations as unknown[][]).push([...params]);
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
        if (sql.includes("SELECT count(*)::int AS n")) {
          return Promise.resolve({ rows: [{ n: 1 }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    };
    const db: Transactional = {
      query: (sql, params) => queryable.query(sql, params),
      transaction: <T>(work: (tx: Queryable) => Promise<T>) => work(queryable),
    };
    const railClient: RailClient = {
      rail: "cctp",
      look: () => Promise.resolve({ kind: "found", report: fx.report }),
    };

    const rawLines: string[] = [];
    const logger = pino({ level: "trace" }, { write: (line) => rawLines.push(line) });
    const pass = new RailPass({
      route: RouteKind.Cctp,
      client: railClient,
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 10_000,
      maxCheckFailures: 5,
      config,
      destinationClients: (input) => {
        expect(input.rpcUrls).toEqual([secretPrimary, secretSecondary]);
        return {
          getChainId: () =>
            Promise.reject(
              new Error(
                "Destination RPC verification failed at https://sep2.example.invalid: upstream 502",
              ),
            ),
          getTransactionReceipt: () => Promise.reject(new Error("unreachable")),
          getBlockNumber: () => Promise.reject(new Error("unreachable")),
          getBlock: () => Promise.reject(new Error("unreachable")),
          readContract: () => Promise.reject(new Error("unreachable")),
        };
      },
    });

    await pass.tick(AbortSignal.timeout(5_000));
    expect(inboundWrites).toEqual([]);
    expect(recordedAttestations).toHaveLength(1);
    // status stays "pending", checkFailures increments to 1 (< maxCheckFailures=5)
    expect(recordedAttestations[0]?.[2]).toBe("pending");
    expect(recordedAttestations[0]?.[7]).toBe(1);
    const rawLastError = recordedAttestations[0]?.[8];
    const persistedError = typeof rawLastError === "string" ? rawLastError : "";
    expect(persistedError).not.toContain("secretA");
    expect(persistedError).not.toContain("secretB");
    expect(persistedError).not.toContain("secretPath");
    expect(persistedError).not.toContain("secretQuery");
  });
});
