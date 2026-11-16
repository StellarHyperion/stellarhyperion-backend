import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { RAIL_CONTRACTS, RouteKind, fromHex } from "@hyperion/protocol";
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, stringToHex, type Hex } from "viem";
import {
  clearItsVerificationDiagnostic,
  writeInbound,
  writeOutbound,
} from "../../src/chains/writers.js";
import { loadConfig } from "../../src/config/config.js";
import type { Database, Queryable, Transactional } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import {
  inspectItsDelivery,
  verifyItsDelivery,
  type ItsDiagnosticEvmClient,
} from "../../src/rails/axelar/delivery.js";
import {
  ITS_ABI,
  MAX_DIAGNOSTIC_IDENTIFIER_LENGTH,
  boundDiagnosticIdentifier,
  evaluateItsDeliveryLogs,
  matchingPayment,
  type DeliveryLog,
  type ExpectedDelivery,
} from "../../src/rails/axelar/events.js";
import { AxelarGmpClient } from "../../src/rails/axelar/gmp.js";
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
    "1791200000000_its-verification-diagnostics.sql",
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

describe("Structured ITS verification mismatch and unavailability diagnostics", () => {
  it("classifies stable field mismatch categories deterministically", () => {
    // Missing ERC-20 payment evidence when ITS event matches
    expect(evaluateItsDeliveryLogs([received], expected)).toEqual({
      kind: "mismatch",
      category: "payment_evidence_missing",
      expectedValue: `${token}:${expected.amount.toString()}`,
      observedValue: null,
    });

    // Command mismatch (wrong commandId or missing ITS event)
    expect(evaluateItsDeliveryLogs([paid], expected)).toEqual({
      kind: "mismatch",
      category: "command_mismatch",
      expectedValue: commandId,
      observedValue: null,
    });
    expect(
      evaluateItsDeliveryLogs([received, paid], {
        ...expected,
        commandId: `0x${"11".repeat(32)}`,
      }),
    ).toEqual({
      kind: "mismatch",
      category: "command_mismatch",
      expectedValue: `0x${"11".repeat(32)}`,
      observedValue: commandId,
    });

    // Token mismatch (wrong tokenId or Transfer emitted on wrong ERC-20 contract)
    expect(
      evaluateItsDeliveryLogs([received, paid], {
        ...expected,
        tokenId: `0x${"22".repeat(32)}`,
      }),
    ).toEqual({
      kind: "mismatch",
      category: "token_mismatch",
      expectedValue: `0x${"22".repeat(32)}`,
      observedValue: tokenId,
    });
    expect(
      evaluateItsDeliveryLogs(
        [received, { ...paid, address: "0x9999999999999999999999999999999999999999" }],
        expected,
      ),
    ).toEqual({
      kind: "mismatch",
      category: "token_mismatch",
      expectedValue: token,
      observedValue: "0x9999999999999999999999999999999999999999",
    });

    // Source identity mismatch (sourceChain or sourceAddress)
    expect(
      evaluateItsDeliveryLogs([received, paid], {
        ...expected,
        sourceChain: "stellar-mainnet",
      }),
    ).toMatchObject({
      kind: "mismatch",
      category: "source_identity_mismatch",
    });
    expect(
      evaluateItsDeliveryLogs([received, paid], {
        ...expected,
        sourceAddress: stringToHex("Gother"),
      }),
    ).toMatchObject({
      kind: "mismatch",
      category: "source_identity_mismatch",
    });

    // Recipient mismatch (on ITS event or on ERC-20 Transfer)
    expect(
      evaluateItsDeliveryLogs([received, paid], {
        ...expected,
        recipient: "0x8888888888888888888888888888888888888888",
      }),
    ).toEqual({
      kind: "mismatch",
      category: "recipient_mismatch",
      expectedValue: "0x8888888888888888888888888888888888888888",
      observedValue: recipient,
    });

    // Amount mismatch (on ITS event or on ERC-20 Transfer)
    const underpaid: DeliveryLog = {
      ...paid,
      data: encodeAbiParameters([{ type: "uint256" }], [expected.amount - 10n]),
    };
    expect(evaluateItsDeliveryLogs([received, underpaid], expected)).toEqual({
      kind: "mismatch",
      category: "amount_mismatch",
      expectedValue: expected.amount.toString(),
      observedValue: (expected.amount - 10n).toString(),
    });
  });

  it("bounds diagnostic identifiers and redacts URLs or credential-bearing strings", () => {
    expect(boundDiagnosticIdentifier("https://rpc.example.com?api_key=super-secret")).toBe(
      "[redacted]",
    );
    expect(boundDiagnosticIdentifier("Bearer eyJhbGciOiJIUzI1NiJ9")).toBe("[redacted]");
    const oversized = `0x${"f".repeat(400)}`;
    const bounded = boundDiagnosticIdentifier(oversized);
    expect(bounded?.length).toBe(MAX_DIAGNOSTIC_IDENTIFIER_LENGTH);
  });

  it("distinguishes unavailable receipt evidence from invalid evidence and never marks mismatches delivered", async () => {
    const activeConfig = loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: ACTIVE_TESTNET_DEPLOYMENTS,
        KEEPER_ENABLED: "false",
      }),
    });
    const stellarDeployment = activeConfig.deployments.networks["stellar-testnet"]!;
    const stellarUsdc = (stellarDeployment.tokens.USDC as { sacId: string; decimals: number })
      .sacId;
    const senderAddress = stellarDeployment.admin;
    const sepoliaIts = RAIL_CONTRACTS.sepolia!.axelar!.interchainTokenService as Hex;
    const destinationTokenAddress: Hex = "0x5555555555555555555555555555555555555555";
    const recipientAddress: Hex = "0x6ef8032ffe4943f27388172549f6700f18bb8b38";
    const recipientWord = `0x000000000000000000000000${recipientAddress.slice(2)}`;
    const txHash: Hex = `0x${"71".repeat(32)}`;
    const blockHash: Hex = `0x${"72".repeat(32)}`;
    const blockNumber = 9_500_000n;

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
      const originTx = "e1".repeat(32);
      await writeOutbound(
        db,
        {
          chainKey: "stellar-testnet",
          block: 5_700_000n,
          txHash: originTx,
          logIndex: null,
          observedAt: new Date("2026-10-31T12:00:00Z"),
        },
        {
          route: RouteKind.AxelarIts,
          nonce: 401n,
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
      const { rows } = await db.query("SELECT id FROM outbound_transfer WHERE nonce = 401");
      const transferId = BigInt(String(rows[0]!.id));
      const pendingTransfer = {
        transferId,
        route: RouteKind.AxelarIts,
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        nonce: 401n,
        originTx,
        status: "attested" as const,
        checkFailures: 0,
        delivered: false,
      };

      const stellarView = (contract: string, method: string) => {
        if (method === "token_id_for") return Promise.resolve(fromHex(tokenId));
        if (method === "get_config") return Promise.resolve({ its: "CAXELARITSCONTRACT" });
        if (contract === "CAXELARITSCONTRACT" && method === "chain_name") {
          return Promise.resolve("stellar-2026-q1-2");
        }
        throw new Error(`unexpected stellar view ${contract}.${method}`);
      };

      const validLogs: DeliveryLog[] = [
        {
          address: sepoliaIts,
          topics: encodeEventTopics({
            abi: ITS_ABI,
            eventName: "InterchainTransferReceived",
            args: { commandId, tokenId, destinationAddress: recipientAddress },
          }) as [Hex, ...Hex[]],
          data: encodeAbiParameters(
            [{ type: "string" }, { type: "bytes" }, { type: "uint256" }, { type: "bytes32" }],
            ["stellar-2026-q1-2", stringToHex(senderAddress), 9_970_000n, `0x${"00".repeat(32)}`],
          ),
          logIndex: 1,
        },
        {
          address: destinationTokenAddress,
          topics: encodeEventTopics({
            abi: ITS_ABI,
            eventName: "Transfer",
            args: { from: "0x0000000000000000000000000000000000000000", to: recipientAddress },
          }) as [Hex, ...Hex[]],
          data: encodeAbiParameters([{ type: "uint256" }], [9_970_000n]),
          logIndex: 2,
        },
      ];

      const makeClient = (overrides: Partial<ItsDiagnosticEvmClient>): ItsDiagnosticEvmClient => ({
        getChainId: () => Promise.resolve(11155111),
        getBlockNumber: () => Promise.resolve(blockNumber + 20n),
        getTransactionReceipt: () =>
          Promise.resolve({
            status: "success",
            blockNumber,
            blockHash,
            transactionHash: txHash,
            logs: validLogs,
          }),
        getBlock: () => Promise.resolve({ hash: blockHash, timestamp: 1_790_700_000n }),
        readRegisteredToken: () => Promise.resolve(destinationTokenAddress),
        ...overrides,
      });

      // 1. GMP reports `executed` without a valid command_id -> unavailable execution_candidate_missing.
      const incompleteGmp = new AxelarGmpClient("https://testnet.api.gmp.axelarscan.io", {
        fetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                data: [
                  {
                    call: { transactionHash: originTx },
                    status: "executed",
                    executed: { transactionHash: txHash },
                  },
                ],
              }),
            ),
          ),
      });
      const gmpLookup = await incompleteGmp.look(pendingTransfer);
      expect(gmpLookup.kind).toBe("found");
      if (gmpLookup.kind !== "found") throw new Error("expected GMP row");
      expect(
        await verifyItsDelivery(activeConfig, db, pendingTransfer, gmpLookup.report, {
          stellarView,
          evmClient: makeClient({}),
          now: () => new Date("2026-10-31T12:01:00Z"),
        }),
      ).toBeNull();

      let apiRes = await app.inject("/v1/transfers/stellar-testnet/401");
      expect(apiRes.json().destination.delivered).toBe(false);
      expect(apiRes.json().verificationDiagnostic).toMatchObject({
        disposition: "unavailable",
        category: "execution_candidate_missing",
        observedValue: "missing_command_id",
        occurrences: 1,
      });

      const fullReport = {
        status: "attested" as const,
        railStatus: "executed",
        reference: "0xmsg-401",
        attestedAt: new Date("2026-10-31T12:01:00Z"),
        execution: { txHash, commandId },
      };

      // 2. Receipt not indexed yet -> unavailable receipt_unavailable (repeated twice increments occurrences).
      for (let i = 0; i < 2; i += 1) {
        expect(
          await verifyItsDelivery(activeConfig, db, pendingTransfer, fullReport, {
            stellarView,
            evmClient: makeClient({ getTransactionReceipt: () => Promise.resolve(null) }),
            now: () => new Date("2026-10-31T12:02:00Z"),
          }),
        ).toBeNull();
      }
      apiRes = await app.inject("/v1/transfers/stellar-testnet/401");
      expect(apiRes.json().verificationDiagnostic).toMatchObject({
        disposition: "unavailable",
        category: "receipt_unavailable",
        candidateTxHash: txHash,
        occurrences: 2,
      });

      // 3. Insufficient confirmations -> unavailable insufficient_confirmations.
      const unconfirmed = await inspectItsDelivery(activeConfig, db, pendingTransfer, fullReport, {
        stellarView,
        evmClient: makeClient({ getBlockNumber: () => Promise.resolve(blockNumber) }),
      });
      expect(unconfirmed).toMatchObject({
        kind: "diagnostic",
        diagnostic: {
          disposition: "unavailable",
          category: "insufficient_confirmations",
        },
      });

      // 4. Reverted receipt -> mismatch reverted_execution_receipt (never delivered).
      expect(
        await verifyItsDelivery(activeConfig, db, pendingTransfer, fullReport, {
          stellarView,
          evmClient: makeClient({
            getTransactionReceipt: () =>
              Promise.resolve({
                status: "reverted",
                blockNumber,
                blockHash,
                transactionHash: txHash,
                logs: [],
              }),
          }),
          now: () => new Date("2026-10-31T12:03:00Z"),
        }),
      ).toBeNull();
      apiRes = await app.inject("/v1/transfers/stellar-testnet/401");
      expect(apiRes.json().destination.delivered).toBe(false);
      expect(apiRes.json().verificationDiagnostic).toMatchObject({
        disposition: "mismatch",
        category: "reverted_execution_receipt",
        occurrences: 1,
      });

      // 5. Wrong amount in receipt -> mismatch amount_mismatch (never delivered).
      expect(
        await verifyItsDelivery(activeConfig, db, pendingTransfer, fullReport, {
          stellarView,
          evmClient: makeClient({
            getTransactionReceipt: () =>
              Promise.resolve({
                status: "success",
                blockNumber,
                blockHash,
                transactionHash: txHash,
                logs: [
                  validLogs[0]!,
                  {
                    ...validLogs[1]!,
                    data: encodeAbiParameters([{ type: "uint256" }], [9_000_000n]),
                  },
                ],
              }),
          }),
          now: () => new Date("2026-10-31T12:04:00Z"),
        }),
      ).toBeNull();
      apiRes = await app.inject("/v1/transfers/stellar-testnet/401");
      expect(apiRes.json().destination.delivered).toBe(false);
      expect(apiRes.json().verificationDiagnostic).toEqual({
        disposition: "mismatch",
        category: "amount_mismatch",
        candidateTxHash: txHash,
        candidateCommandId: commandId,
        candidateBlock: blockNumber.toString(),
        expectedValue: "9970000",
        observedValue: "9000000",
        occurrences: 1,
        lastObservedAt: "2026-10-31T12:04:00.000Z",
      });

      // 6. Valid confirmed proof establishes delivery and clears stale diagnostic.
      const verified = await verifyItsDelivery(activeConfig, db, pendingTransfer, fullReport, {
        stellarView,
        evmClient: makeClient({}),
      });
      expect(verified).not.toBeNull();
      await db.transaction(async (tx) => {
        await writeInbound(tx, verified!.at, verified!.row);
        await clearItsVerificationDiagnostic(tx, transferId);
      });
      apiRes = await app.inject("/v1/transfers/stellar-testnet/401");
      expect(apiRes.json().destination.delivered).toBe(true);
      expect(apiRes.json().verificationDiagnostic).toBeNull();
    } finally {
      await app.close();
      await pg.close();
    }
  });
});
