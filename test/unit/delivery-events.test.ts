import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { RAIL_CONTRACTS, RouteKind, fromHex } from "@hyperion/protocol";
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, stringToHex, type Hex } from "viem";
import { writeOutbound } from "../../src/chains/writers.js";
import { loadConfig } from "../../src/config/config.js";
import type { Database, Queryable, Transactional } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import { verifyItsDelivery, type ItsEvmClient } from "../../src/rails/axelar/delivery.js";
import {
  ITS_ABI,
  matchItsDelivery,
  matchingPayment,
  type DeliveryLog,
  type ExpectedDelivery,
} from "../../src/rails/axelar/events.js";
import { AxelarGmpClient } from "../../src/rails/axelar/gmp.js";
import { RailPass } from "../../src/rails/pass.js";
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
const tokenId: Hex = `0x${"cd".repeat(32)}`;
const dataHash: Hex = `0x${"ef".repeat(32)}`;
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
    [expected.sourceChain, source, expected.amount, dataHash],
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
    "1791200000000_axelar-its-provenance.sql",
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

    const full = matchItsDelivery([received, paid], expected);
    expect(full).not.toBeNull();
    expect(full?.commandId).toBe(commandId);
    expect(full?.tokenId).toBe(tokenId);
    expect(full?.dataHash).toBe(dataHash);
    expect(full?.paymentFrom.toLowerCase()).toBe(its.toLowerCase());
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

describe("Axelar command and token-manager provenance", () => {
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
  const tokenManagerAddress: Hex = "0x4444444444444444444444444444444444444444";
  const destinationTokenAddress: Hex = "0x5555555555555555555555555555555555555555";
  const recipientAddress: Hex = "0x6ef8032ffe4943f27388172549f6700f18bb8b38";
  const recipientWord = `0x000000000000000000000000${recipientAddress.slice(2)}`;
  const executionTxHash: Hex = `0x${"91".repeat(32)}`;
  const proofBlockNumber = 8_123_456n;
  const proofBlockHash: Hex = `0x${"7e".repeat(32)}`;

  function makeReceiptLogs(amount: bigint): DeliveryLog[] {
    const itsReceived: DeliveryLog = {
      address: sepoliaIts,
      topics: encodeEventTopics({
        abi: ITS_ABI,
        eventName: "InterchainTransferReceived",
        args: { commandId, tokenId, destinationAddress: recipientAddress },
      }) as [Hex, ...Hex[]],
      data: encodeAbiParameters(
        [{ type: "string" }, { type: "bytes" }, { type: "uint256" }, { type: "bytes32" }],
        ["stellar-2026-q1-2", stringToHex(senderAddress), amount, dataHash],
      ),
      logIndex: 4,
    };
    const tokenPaid: DeliveryLog = {
      address: destinationTokenAddress,
      topics: encodeEventTopics({
        abi: ITS_ABI,
        eventName: "Transfer",
        args: { from: "0x0000000000000000000000000000000000000000", to: recipientAddress },
      }) as [Hex, ...Hex[]],
      data: encodeAbiParameters([{ type: "uint256" }], [amount]),
      logIndex: 5,
    };
    return [itsReceived, tokenPaid];
  }

  function mockStellarView() {
    return (contract: string, method: string) => {
      if (method === "token_id_for") return Promise.resolve(fromHex(tokenId));
      if (method === "get_config") return Promise.resolve({ its: "CAXELARITSCONTRACT" });
      if (contract === "CAXELARITSCONTRACT" && method === "chain_name") {
        return Promise.resolve("stellar-2026-q1-2");
      }
      throw new Error(`unexpected stellar view ${contract}.${method}`);
    };
  }

  function mockEvmClient(overrides: Partial<ItsEvmClient> = {}): {
    client: ItsEvmClient;
    observedBlocks: { op: string; blockNumber: bigint }[];
  } {
    const observedBlocks: { op: string; blockNumber: bigint }[] = [];
    const client: ItsEvmClient = {
      getChainId: () => Promise.resolve(11155111),
      getBlockNumber: () => Promise.resolve(proofBlockNumber + 12n),
      getTransactionReceipt: () =>
        Promise.resolve({
          status: "success",
          blockNumber: proofBlockNumber,
          blockHash: proofBlockHash,
          transactionHash: executionTxHash,
          logs: makeReceiptLogs(9_970_000n),
        }),
      getBlock: ({ blockNumber }) => {
        observedBlocks.push({ op: "getBlock", blockNumber });
        return Promise.resolve({ hash: proofBlockHash, timestamp: 1_790_500_000n });
      },
      readRegisteredToken: (_its, _tokenId, blockNumber) => {
        observedBlocks.push({ op: "readRegisteredToken", blockNumber });
        return Promise.resolve(destinationTokenAddress);
      },
      readDeployedTokenManager: (_its, _tokenId, blockNumber) => {
        observedBlocks.push({ op: "readDeployedTokenManager", blockNumber });
        return Promise.resolve(tokenManagerAddress);
      },
      readManagerTokenAddress: (_manager, blockNumber) => {
        observedBlocks.push({ op: "readManagerTokenAddress", blockNumber });
        return Promise.resolve(destinationTokenAddress);
      },
      readManagerImplementationType: (_manager, blockNumber) => {
        observedBlocks.push({ op: "readManagerImplementationType", blockNumber });
        return Promise.resolve(4n);
      },
      ...overrides,
    };
    return { client, observedBlocks };
  }

  it("scopes token-manager observations to the proof block and rejects token-manager mismatches", async () => {
    const { pg, db } = await openMigratedDb();
    try {
      await writeOutbound(
        db,
        {
          chainKey: "stellar-testnet",
          block: 5_500_001n,
          txHash: "a1".repeat(32),
          logIndex: null,
          observedAt: new Date("2026-10-29T12:00:00Z"),
        },
        {
          route: RouteKind.AxelarIts,
          nonce: 101n,
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
      const { rows } = await db.query("SELECT id FROM outbound_transfer WHERE nonce = 101");
      const transferId = BigInt(String(rows[0]!.id));
      const transfer = {
        transferId,
        route: RouteKind.AxelarIts,
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        nonce: 101n,
        originTx: "a1".repeat(32),
        status: null,
        checkFailures: 0,
        delivered: false,
      };
      const report = {
        status: "attested" as const,
        railStatus: "executed",
        reference: `0x${"34".repeat(32)}-9`,
        attestedAt: new Date("2026-10-29T12:01:00Z"),
        execution: { txHash: executionTxHash, commandId },
        commandProvenance: {
          commandId,
          txHash: executionTxHash,
          messageId: `0x${"34".repeat(32)}-9`,
          parentMessageId: `${"a1".repeat(32)}-2`,
        },
      };

      // Mismatched token-manager -> tokenAddress refuses payout even when GMP says executed.
      const mismatched = mockEvmClient({
        readManagerTokenAddress: () =>
          Promise.resolve("0x9999999999999999999999999999999999999999"),
      });
      const rejected = await verifyItsDelivery(activeConfig, db, transfer, report, {
        stellarView: mockStellarView(),
        evmClient: mismatched.client,
      });
      expect(rejected).toBeNull();

      // Zero deployed token manager refuses payout.
      const zeroManager = mockEvmClient({
        readDeployedTokenManager: () =>
          Promise.resolve("0x0000000000000000000000000000000000000000"),
      });
      expect(
        await verifyItsDelivery(activeConfig, db, transfer, report, {
          stellarView: mockStellarView(),
          evmClient: zeroManager.client,
        }),
      ).toBeNull();

      // Matching token-manager observation at the exact proof block establishes delivery + provenance.
      const { client, observedBlocks } = mockEvmClient();
      const verified = await verifyItsDelivery(activeConfig, db, transfer, report, {
        stellarView: mockStellarView(),
        evmClient: client,
        now: () => new Date("2026-10-29T12:02:00Z"),
      });
      expect(verified).not.toBeNull();
      expect(observedBlocks).toEqual([
        { op: "getBlock", blockNumber: proofBlockNumber },
        { op: "readRegisteredToken", blockNumber: proofBlockNumber },
        { op: "readDeployedTokenManager", blockNumber: proofBlockNumber },
        { op: "readManagerTokenAddress", blockNumber: proofBlockNumber },
        { op: "readManagerImplementationType", blockNumber: proofBlockNumber },
      ]);
      expect(verified?.itsProvenance).toEqual({
        destinationChain: "sepolia",
        route: RouteKind.AxelarIts,
        sourceChain: "stellar-testnet",
        sourceNonce: 101n,
        commandId: commandId.toLowerCase(),
        gmpMessageId: `0x${"34".repeat(32)}-9`,
        parentMessageId: `${"a1".repeat(32)}-2`,
        axelarSourceChain: "stellar-2026-q1-2",
        sourceAddressHex: stringToHex(senderAddress).toLowerCase(),
        dataHash: dataHash.toLowerCase(),
        executionTx: executionTxHash.toLowerCase(),
        itsLogIndex: 4,
        proofBlock: proofBlockNumber,
        proofBlockHash: proofBlockHash.toLowerCase(),
        interchainTokenService: sepoliaIts.toLowerCase(),
        tokenId: tokenId.toLowerCase(),
        tokenManager: tokenManagerAddress.toLowerCase(),
        tokenManagerType: 4,
        registeredToken: destinationTokenAddress.toLowerCase(),
        paymentFrom: "0x0000000000000000000000000000000000000000",
        paymentLogIndex: 5,
        verifiedAt: new Date("2026-10-29T12:02:00Z"),
      });
    } finally {
      await pg.close();
    }
  });

  it("persists full command identity across database and API serialization and marks historical rows unavailable", async () => {
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
      const originTx = "b2".repeat(32);
      const parentMsgId = `0x${originTx}-1`;
      const childTx = `0x${"c3".repeat(32)}`;
      const childMsgId = `${childTx}-77`;

      // 1. Outbound transfer that will be verified with full hub-linked command + token-manager provenance.
      await writeOutbound(
        db,
        {
          chainKey: "stellar-testnet",
          block: 5_600_010n,
          txHash: originTx,
          logIndex: null,
          observedAt: new Date("2026-10-29T13:00:00Z"),
        },
        {
          route: RouteKind.AxelarIts,
          nonce: 202n,
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

      // Before payout, provenance is explicitly pending even if queried immediately.
      const pendingRes = await app.inject("/v1/transfers/stellar-testnet/202");
      expect(pendingRes.statusCode).toBe(200);
      expect(pendingRes.json().provenance).toEqual({
        status: "pending",
        unavailableReason: null,
        command: null,
        tokenManager: null,
        verifiedAt: null,
      });

      // Extract full commandProvenance via AxelarGmpClient across parent -> hub child messages.
      const gmpResponses = [
        {
          data: [
            {
              id: parentMsgId,
              call: { transactionHash: originTx },
              status: "executed",
              executed: { childMessageIDs: [childMsgId] },
            },
          ],
        },
        {
          data: [
            {
              id: childMsgId,
              message_id: childMsgId,
              call: { parentMessageID: parentMsgId },
              status: "executed",
              command_id: commandId,
              executed: { transactionHash: executionTxHash, block_timestamp: 1_790_500_000 },
            },
          ],
        },
      ];
      const gmpClient = new AxelarGmpClient("https://testnet.api.gmp.axelarscan.io", {
        fetch: () => Promise.resolve(new Response(JSON.stringify(gmpResponses.shift()))),
      });

      const { rows: transferRows } = await db.query(
        "SELECT id FROM outbound_transfer WHERE nonce = 202",
      );
      const transferId = BigInt(String(transferRows[0]!.id));
      const pendingTransfer = {
        transferId,
        route: RouteKind.AxelarIts,
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        nonce: 202n,
        originTx,
        status: null,
        checkFailures: 0,
        delivered: false,
      };

      const lookup = await gmpClient.look(pendingTransfer);
      expect(lookup.kind).toBe("found");
      if (lookup.kind !== "found") throw new Error("expected GMP match");
      // Provider status alone stays attested, never delivered.
      expect(lookup.report.status).toBe("attested");
      expect(lookup.report.commandProvenance).toEqual({
        commandId,
        txHash: executionTxHash,
        messageId: childMsgId,
        parentMessageId: parentMsgId,
      });

      const { client } = mockEvmClient();
      const verified = await verifyItsDelivery(activeConfig, db, pendingTransfer, lookup.report, {
        stellarView: mockStellarView(),
        evmClient: client,
        now: () => new Date("2026-10-29T13:05:00Z"),
      });
      expect(verified).not.toBeNull();

      // Persist atomically through RailPass-compatible writers and replay a second time to verify idempotency.
      const passClient = {
        rail: "axelar",
        look: () => Promise.resolve(lookup),
      };
      const pass = new RailPass({
        route: RouteKind.AxelarIts,
        client: passClient,
        db,
        logger,
        batchSize: 10,
        recheckAfterMs: 1_000,
        maxCheckFailures: 5,
      });
      // Without config/chain receipt verification, RailPass records attested, NOT delivered!
      await pass.tick(new AbortController().signal);
      const attestedOnlyRes = await app.inject("/v1/transfers/stellar-testnet/202");
      expect(attestedOnlyRes.json().stage).toBe("delivering");
      expect(attestedOnlyRes.json().destination.delivered).toBe(false);
      expect(attestedOnlyRes.json().provenance.status).toBe("pending");

      // Now write the verified inbound + provenance atomically (and replay it twice).
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await db.transaction(async (tx) => {
          const { writeInbound, writeItsProvenance } = await import("../../src/chains/writers.js");
          await writeInbound(tx, verified!.at, verified!.row);
          await writeItsProvenance(tx, verified!.itsProvenance!);
        });
      }

      const deliveredRes = await app.inject("/v1/transfers/stellar-testnet/202");
      expect(deliveredRes.statusCode).toBe(200);
      const body = deliveredRes.json();
      expect(body.stage).toBe("delivered");
      expect(body.destination.delivered).toBe(true);
      expect(body.destination.amount).toBe("9970000");
      expect(body.provenance).toEqual({
        status: "verified",
        unavailableReason: null,
        command: {
          commandId: commandId.toLowerCase(),
          messageId: childMsgId,
          parentMessageId: parentMsgId,
          sourceChain: "stellar-2026-q1-2",
          sourceAddress: stringToHex(senderAddress).toLowerCase(),
          dataHash: dataHash.toLowerCase(),
          executionTxHash: executionTxHash.toLowerCase(),
          itsLogIndex: 4,
        },
        tokenManager: {
          chain: "sepolia",
          proofBlock: proofBlockNumber.toString(),
          proofBlockHash: proofBlockHash.toLowerCase(),
          interchainTokenService: sepoliaIts.toLowerCase(),
          tokenId: tokenId.toLowerCase(),
          tokenManager: tokenManagerAddress.toLowerCase(),
          implementationType: 4,
          registeredToken: destinationTokenAddress.toLowerCase(),
          paymentFrom: "0x0000000000000000000000000000000000000000",
          paymentLogIndex: 5,
        },
        verifiedAt: "2026-10-29T13:05:00.000Z",
      });

      // 2. Historical ITS inbound_delivery row recorded without axelar_its_provenance marks unavailable explicitly.
      const legacyCommandId = `0x${"56".repeat(32)}`;
      await writeOutbound(
        db,
        {
          chainKey: "stellar-testnet",
          block: 5_400_000n,
          txHash: "d4".repeat(32),
          logIndex: null,
          observedAt: new Date("2026-10-01T10:00:00Z"),
        },
        {
          route: RouteKind.AxelarIts,
          nonce: 203n,
          sender: senderAddress,
          token: stellarUsdc,
          grossAmount: 5_000_000n,
          fee: 15_000n,
          netAmount: 4_985_000n,
          destinationChain: "sepolia",
          destination: recipientWord,
          railRef: null,
        },
      );
      await pg.query(
        `INSERT INTO inbound_delivery
           (destination_chain, route, source_chain, source_nonce, rail_message_id, recipient,
            token, amount, delivered, destination_block, destination_tx)
         VALUES ('sepolia', 1, 'stellar-testnet', 203, $1, $2, $3, 4985000, true, 7900000, $4)`,
        [
          legacyCommandId,
          recipientAddress,
          destinationTokenAddress.toLowerCase(),
          `0x${"78".repeat(32)}`,
        ],
      );

      const legacyRes = await app.inject("/v1/transfers/stellar-testnet/203");
      expect(legacyRes.statusCode).toBe(200);
      expect(legacyRes.json().stage).toBe("delivered");
      expect(legacyRes.json().provenance).toEqual({
        status: "unavailable",
        unavailableReason: "historical_record_missing_provenance",
        command: {
          commandId: legacyCommandId,
          messageId: null,
          parentMessageId: null,
          sourceChain: null,
          sourceAddress: null,
          dataHash: null,
          executionTxHash: `0x${"78".repeat(32)}`,
          itsLogIndex: null,
        },
        tokenManager: null,
        verifiedAt: null,
      });
    } finally {
      await app.close();
      await pg.close();
    }
  });
});
