import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import {
  AddressKind,
  CHAINS,
  RAIL_CONTRACTS,
  RouteKind,
  encodeStellarAddress,
  isEvmChain,
  toWord,
  type Hex,
} from "@hyperion/protocol";
import { encodeAbiParameters, encodeEventTopics, stringToHex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { writeOutbound } from "../../src/chains/writers.js";
import { loadConfig, type AppConfig } from "../../src/config/config.js";
import type { Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";
import { bigintOf, text, textOrNull } from "../../src/db/rows.js";
import {
  ItsSourceLaneVerificationError,
  verifyItsDeliveryOutcome,
  type ItsEvmChainProbe,
} from "../../src/rails/axelar/delivery.js";
import { ITS_ABI, type DeliveryLog } from "../../src/rails/axelar/events.js";
import { AxelarGmpClient, classifyAxelarGmpRow, type GmpRow } from "../../src/rails/axelar/gmp.js";
import { RailPass } from "../../src/rails/pass.js";
import { outstandingForRail, pendingForRail } from "../../src/rails/queue.js";
import { completeEnv, readFixture } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function migrationUpSql(filename: string): string {
  const full = readFileSync(join(REPO_ROOT, "migrations", filename), "utf8");
  const [upPart] = full.split("-- Down Migration");
  if (upPart === undefined) {
    throw new Error(`missing -- Down Migration marker in ${filename}`);
  }
  return upPart;
}

function pgliteTransactional(pg: PGlite): Transactional {
  const toRows = (result: { rows: unknown[]; affectedRows?: number }): QueryResultRows => ({
    rows: result.rows as Record<string, unknown>[],
    rowCount: result.affectedRows ?? result.rows.length,
  });

  return {
    async query(sql: string, params?: readonly unknown[]): Promise<QueryResultRows> {
      const res = await pg.query(sql, params ? [...params] : []);
      return toRows(res);
    },
    async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      return pg.transaction(async (tx) => {
        const wrapped: Queryable = {
          async query(sql: string, params?: readonly unknown[]): Promise<QueryResultRows> {
            const res = await tx.query(sql, params ? [...params] : []);
            return toRows(res);
          },
        };
        return work(wrapped);
      });
    },
  };
}

const STELLAR_SENDER = encodeStellarAddress(AddressKind.Account, new Uint8Array(32).fill(0x31));
const STELLAR_SAC_TOKEN = encodeStellarAddress(AddressKind.Contract, new Uint8Array(32).fill(0x41));
const STELLAR_ITS_ADAPTER = encodeStellarAddress(
  AddressKind.Contract,
  new Uint8Array(32).fill(0x51),
);
const EVM_RECIPIENT: Hex = "0x1111111111111111111111111111111111111111";
const EVM_DEST_TOKEN: Hex = "0x3333333333333333333333333333333333333333";
const TOKEN_ID: Hex = `0x${"cd".repeat(32)}`;
const COMMAND_ID: Hex = `0x${"ab".repeat(32)}`;
const DEST_TX: Hex = `0x${"ef".repeat(32)}`;
const CANONICAL_BLOCK_HASH: Hex = `0x${"77".repeat(32)}`;
const ORPHAN_BLOCK_HASH: Hex = `0x${"88".repeat(32)}`;
const ORIGIN_TX = `0x${"66".repeat(32)}`;
const GROSS_U256 = 500000000000000000000000n;
const FEE_U256 = 500000000000000000000n;
const NET_U256 = GROSS_U256 - FEE_U256;
const SOURCE_CHAIN_AXELAR_NAME = "stellar-2026-q1-2";

const SEPOLIA_ITS = (RAIL_CONTRACTS.sepolia?.axelar?.interchainTokenService ??
  "0xB5FB4BE02232B1bBA4dC8f81dc24C26980dE9e3C") as Hex;
const SEPOLIA_CHAIN = CHAINS.sepolia;
if (!isEvmChain(SEPOLIA_CHAIN)) {
  throw new Error("expected sepolia to be an EVM chain");
}
const SEPOLIA_CHAIN_ID = SEPOLIA_CHAIN.chainId;
const SEPOLIA_CONFIRMATIONS = BigInt(SEPOLIA_CHAIN.confirmations);

function buildConfigWithItsAdapter(): AppConfig {
  const parsed = JSON.parse(readFixture("deployments-testnet.json")) as {
    networks: {
      "stellar-testnet": {
        adapters: Record<string, string>;
      };
    };
  };
  parsed.networks["stellar-testnet"].adapters["axelar-its"] = STELLAR_ITS_ADAPTER;
  return loadConfig({
    env: completeEnv(),
    readFile: () => JSON.stringify(parsed),
  });
}

function makeItsCommandLog(amount = NET_U256): DeliveryLog {
  return {
    address: SEPOLIA_ITS,
    topics: encodeEventTopics({
      abi: ITS_ABI,
      eventName: "InterchainTransferReceived",
      args: { commandId: COMMAND_ID, tokenId: TOKEN_ID, destinationAddress: EVM_RECIPIENT },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters(
      [{ type: "string" }, { type: "bytes" }, { type: "uint256" }, { type: "bytes32" }],
      [SOURCE_CHAIN_AXELAR_NAME, stringToHex(STELLAR_SENDER), amount, `0x${"0".repeat(64)}`],
    ),
    logIndex: 2,
  };
}

function makeErc20TransferLog(token: Hex = EVM_DEST_TOKEN, amount = NET_U256): DeliveryLog {
  return {
    address: token,
    topics: encodeEventTopics({
      abi: ITS_ABI,
      eventName: "Transfer",
      args: { from: SEPOLIA_ITS, to: EVM_RECIPIENT },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint256" }], [amount]),
    logIndex: 3,
  };
}

describe("Axelar message failure versus payment uncertainty (#83)", () => {
  let pg: PGlite;
  let db: Transactional;
  let config: AppConfig;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(migrationUpSql("1790900000000_initial-schema.sql"));
    await pg.exec(migrationUpSql("1791000000000_cursor-block-hash.sql"));
    db = pgliteTransactional(pg);
    config = buildConfigWithItsAdapter();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM inbound_delivery");
    await db.query("DELETE FROM rail_attestation");
    await db.query("DELETE FROM outbound_transfer");
  });

  afterAll(async () => {
    await pg.close();
  });

  async function seedItsTransfer(nonce = 77n): Promise<bigint> {
    await db.transaction(async (tx) => {
      await writeOutbound(
        tx,
        {
          chainKey: "stellar-testnet",
          block: 800_000n + nonce,
          txHash: ORIGIN_TX,
          logIndex: null,
          observedAt: new Date("2026-10-21T00:00:00Z"),
        },
        {
          route: RouteKind.AxelarIts,
          nonce,
          sender: STELLAR_SENDER,
          token: STELLAR_SAC_TOKEN,
          grossAmount: GROSS_U256,
          fee: FEE_U256,
          netAmount: NET_U256,
          destinationChain: "sepolia",
          destination: toWord(EVM_RECIPIENT),
          railRef: null,
        },
      );
    });
    const { rows } = await db.query(
      "SELECT id FROM outbound_transfer WHERE origin_chain = $1 AND nonce = $2",
      ["stellar-testnet", nonce.toString()],
    );
    const first = rows[0];
    if (!first) throw new Error("missing seeded transfer");
    return bigintOf(first, "id");
  }

  it("keeps recoverable gas failures pending even when Axelar status is error, while fatal errors fail", () => {
    for (const row of [
      { status: "called", is_insufficient_fee: true },
      { status: "error", is_insufficient_fee: true },
      { status: "error", is_not_enough_gas: true },
      { status: "error", not_enough_gas_to_execute: true },
      { status: "gas_unpaid" },
      { status: "error", simplified_status: "insufficient_fee" },
    ] satisfies GmpRow[]) {
      const classified = classifyAxelarGmpRow(row);
      expect(classified.status).toBe("pending");
      expect(classified.providerSignal).toBe("recoverable_gas_failure");
    }

    // Fatal validation flags outrank recoverable gas flags and mark message_failed.
    const fatalAndGas = classifyAxelarGmpRow({
      status: "called",
      is_insufficient_fee: true,
      is_invalid_destination_chain: true,
    });
    expect(fatalAndGas.status).toBe("failed");
    expect(fatalAndGas.providerSignal).toBe("message_failed");

    // Non-gas terminal error marks message_failed.
    const terminalError = classifyAxelarGmpRow({ status: "error" });
    expect(terminalError.status).toBe("failed");
    expect(terminalError.providerSignal).toBe("message_failed");

    // Candidate executed without txHash/commandId flags payout_unverified.
    const executedNoCoords = classifyAxelarGmpRow({ status: "executed" });
    expect(executedNoCoords.status).toBe("attested");
    expect(executedNoCoords.providerSignal).toBe("candidate_executed");
    expect(executedNoCoords.paymentUncertainty).toEqual({
      kind: "payout_unverified",
      reason: "missing_execution_coordinates",
    });
  });

  it("separates receipt_unavailable from payout_unverified and never lets candidate executed bypass token checks", async () => {
    const transferId = await seedItsTransfer(88n);
    const pendingList = await pendingForRail(db, {
      route: RouteKind.AxelarIts,
      limit: 10,
      notCheckedSince: new Date("2026-10-21T01:00:00Z"),
      maxCheckFailures: 5,
    });
    const transfer = pendingList[0];
    expect(transfer).toBeDefined();
    if (!transfer) return;

    const candidateReport = {
      status: "attested" as const,
      providerSignal: "candidate_executed" as const,
      railStatus: "executed/received",
      reference: "0xmsg-88",
      attestedAt: new Date("2026-10-21T00:01:00Z"),
      execution: { txHash: DEST_TX, commandId: COMMAND_ID },
    };

    const validSourceLane = () =>
      Promise.resolve({
        tokenId: TOKEN_ID,
        sourceChainName: SOURCE_CHAIN_AXELAR_NAME,
      });

    const baseProbe: ItsEvmChainProbe = {
      getChainId: () => Promise.resolve(SEPOLIA_CHAIN_ID),
      getTransactionReceipt: () =>
        Promise.resolve({
          status: "success",
          blockNumber: 1000n,
          blockHash: CANONICAL_BLOCK_HASH,
          transactionHash: DEST_TX,
          logs: [makeItsCommandLog(), makeErc20TransferLog()],
        }),
      getBlockNumber: () => Promise.resolve(1000n + SEPOLIA_CONFIRMATIONS),
      registeredTokenAddress: () => Promise.resolve(EVM_DEST_TOKEN),
      getBlock: () => Promise.resolve({ hash: CANONICAL_BLOCK_HASH, timestamp: 1_790_000_100n }),
    };

    // 1. Receipt not yet indexed on destination RPC -> receipt_unavailable
    const notFoundErr = new Error("Transaction receipt could not be found");
    notFoundErr.name = "TransactionReceiptNotFoundError";
    const missingReceiptOutcome = await verifyItsDeliveryOutcome(
      config,
      db,
      transfer,
      candidateReport,
      {
        readSourceLane: validSourceLane,
        createEvmProbe: () => ({
          ...baseProbe,
          getTransactionReceipt: () => Promise.reject(notFoundErr),
        }),
      },
    );
    expect(missingReceiptOutcome).toEqual({
      kind: "receipt_unavailable",
      reason: "receipt_not_found",
      detail: expect.stringContaining(DEST_TX) as string,
    });

    // 2. Insufficient confirmations -> receipt_unavailable
    const unconfirmedOutcome = await verifyItsDeliveryOutcome(
      config,
      db,
      transfer,
      candidateReport,
      {
        readSourceLane: validSourceLane,
        createEvmProbe: () => ({
          ...baseProbe,
          getBlockNumber: () => Promise.resolve(1000n),
        }),
      },
    );
    expect(unconfirmedOutcome.kind).toBe("receipt_unavailable");
    if (unconfirmedOutcome.kind === "receipt_unavailable") {
      expect(unconfirmedOutcome.reason).toBe("insufficient_confirmations");
    }

    // 3. Reorged / non-canonical block hash -> receipt_unavailable
    const reorgOutcome = await verifyItsDeliveryOutcome(config, db, transfer, candidateReport, {
      readSourceLane: validSourceLane,
      createEvmProbe: () => ({
        ...baseProbe,
        getBlock: () => Promise.resolve({ hash: ORPHAN_BLOCK_HASH, timestamp: 1_790_000_100n }),
      }),
    });
    expect(reorgOutcome.kind).toBe("receipt_unavailable");
    if (reorgOutcome.kind === "receipt_unavailable") {
      expect(reorgOutcome.reason).toBe("non_canonical_block");
    }

    // 4. Reverted receipt -> payout_unverified
    const revertedOutcome = await verifyItsDeliveryOutcome(config, db, transfer, candidateReport, {
      readSourceLane: validSourceLane,
      createEvmProbe: () => ({
        ...baseProbe,
        getTransactionReceipt: () =>
          Promise.resolve({
            status: "reverted",
            blockNumber: 1000n,
            blockHash: CANONICAL_BLOCK_HASH,
            transactionHash: DEST_TX,
            logs: [makeItsCommandLog(), makeErc20TransferLog()],
          }),
      }),
    });
    expect(revertedOutcome.kind).toBe("payout_unverified");
    if (revertedOutcome.kind === "payout_unverified") {
      expect(revertedOutcome.reason).toBe("receipt_reverted");
    }

    // 5. ITS command present WITHOUT ERC-20 Transfer log -> payout_unverified
    const noTokenTransferOutcome = await verifyItsDeliveryOutcome(
      config,
      db,
      transfer,
      candidateReport,
      {
        readSourceLane: validSourceLane,
        createEvmProbe: () => ({
          ...baseProbe,
          getTransactionReceipt: () =>
            Promise.resolve({
              status: "success",
              blockNumber: 1000n,
              blockHash: CANONICAL_BLOCK_HASH,
              transactionHash: DEST_TX,
              logs: [makeItsCommandLog()],
            }),
        }),
      },
    );
    expect(noTokenTransferOutcome.kind).toBe("payout_unverified");
    if (noTokenTransferOutcome.kind === "payout_unverified") {
      expect(noTokenTransferOutcome.reason).toBe("missing_erc20_transfer_event");
    }

    // 6. Source lane contract simulation rejects -> payout_unverified
    const badLaneOutcome = await verifyItsDeliveryOutcome(config, db, transfer, candidateReport, {
      readSourceLane: () =>
        Promise.reject(new ItsSourceLaneVerificationError("Source lane cannot be verified.")),
      createEvmProbe: () => baseProbe,
    });
    expect(badLaneOutcome.kind).toBe("payout_unverified");
    if (badLaneOutcome.kind === "payout_unverified") {
      expect(badLaneOutcome.reason).toBe("source_lane_unverifiable");
    }

    expect(transferId).toBeGreaterThan(0n);
  });

  it("drives deterministic RailPass state transitions across recoverable gas, uncertainty, and verified payout", async () => {
    const transferId = await seedItsTransfer(99n);
    const { logger } = capturingLogger();

    const gmpQueue: Record<string, unknown>[] = [
      // Tick 1: recoverable gas failure with status="error" must NOT discard transfer!
      {
        data: [
          {
            call: { transactionHash: ORIGIN_TX },
            status: "error",
            simplified_status: "insufficient_fee",
            is_insufficient_fee: true,
            message_id: "0xmsg-99",
          },
        ],
      },
      // Tick 2: gas topped up -> candidate executed, receipt not confirmed yet
      {
        data: [
          {
            call: { transactionHash: ORIGIN_TX },
            status: "executed",
            simplified_status: "received",
            message_id: "0xmsg-99",
            command_id: COMMAND_ID,
            executed: { transactionHash: DEST_TX, block_timestamp: 1_790_000_050 },
          },
        ],
      },
      // Tick 3: candidate executed, receipt has ITS event only (no ERC-20 payment) -> stays attested!
      {
        data: [
          {
            call: { transactionHash: ORIGIN_TX },
            status: "executed",
            simplified_status: "received",
            message_id: "0xmsg-99",
            command_id: COMMAND_ID,
            executed: { transactionHash: DEST_TX, block_timestamp: 1_790_000_050 },
          },
        ],
      },
      // Tick 4: canonical receipt + matching ITS command + ERC-20 Transfer -> delivered!
      {
        data: [
          {
            call: { transactionHash: ORIGIN_TX },
            status: "executed",
            simplified_status: "received",
            message_id: "0xmsg-99",
            command_id: COMMAND_ID,
            executed: { transactionHash: DEST_TX, block_timestamp: 1_790_000_050 },
          },
        ],
      },
    ];

    const client = new AxelarGmpClient("https://testnet.api.gmp.axelarscan.io", {
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify(gmpQueue.shift() ?? { data: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
    });

    let probeStage = 0;
    const evmProbe: ItsEvmChainProbe = {
      getChainId: () => Promise.resolve(SEPOLIA_CHAIN_ID),
      getTransactionReceipt: () => {
        if (probeStage === 1) {
          return Promise.resolve({
            status: "success",
            blockNumber: 2000n,
            blockHash: CANONICAL_BLOCK_HASH,
            transactionHash: DEST_TX,
            logs: [makeItsCommandLog(), makeErc20TransferLog()],
          });
        }
        if (probeStage === 2) {
          return Promise.resolve({
            status: "success",
            blockNumber: 2000n,
            blockHash: CANONICAL_BLOCK_HASH,
            transactionHash: DEST_TX,
            logs: [makeItsCommandLog()],
          });
        }
        return Promise.resolve({
          status: "success",
          blockNumber: 2000n,
          blockHash: CANONICAL_BLOCK_HASH,
          transactionHash: DEST_TX,
          logs: [makeItsCommandLog(), makeErc20TransferLog()],
        });
      },
      getBlockNumber: () =>
        Promise.resolve(probeStage === 1 ? 2000n : 2000n + SEPOLIA_CONFIRMATIONS),
      registeredTokenAddress: () => Promise.resolve(EVM_DEST_TOKEN),
      getBlock: () => Promise.resolve({ hash: CANONICAL_BLOCK_HASH, timestamp: 1_790_000_100n }),
    };

    let currentNow = new Date("2026-10-21T02:00:00Z");
    const pass = new RailPass({
      route: RouteKind.AxelarIts,
      client,
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 0,
      maxCheckFailures: 5,
      now: () => currentNow,
      config,
      itsDeliveryDeps: {
        readSourceLane: () =>
          Promise.resolve({ tokenId: TOKEN_ID, sourceChainName: SOURCE_CHAIN_AXELAR_NAME }),
        createEvmProbe: () => evmProbe,
      },
    });

    // Tick 1: recoverable gas failure -> stays pending and in outstanding queue
    await pass.tick(new AbortController().signal);
    const afterTick1 = (
      await db.query(
        "SELECT status, rail_status, last_error FROM rail_attestation WHERE transfer_id = $1",
        [transferId.toString()],
      )
    ).rows[0];
    expect(afterTick1).toBeDefined();
    if (!afterTick1) return;
    expect(text(afterTick1, "status")).toBe("pending");
    expect(text(afterTick1, "rail_status")).toContain("is_insufficient_fee");
    expect(await outstandingForRail(db, RouteKind.AxelarIts)).toBe(1);

    // Tick 2: candidate executed, receipt has insufficient confirmations -> stays attested
    probeStage = 1;
    currentNow = new Date("2026-10-21T02:01:00Z");
    await pass.tick(new AbortController().signal);
    const afterTick2 = (
      await db.query("SELECT status, last_error FROM rail_attestation WHERE transfer_id = $1", [
        transferId.toString(),
      ])
    ).rows[0];
    expect(afterTick2).toBeDefined();
    if (!afterTick2) return;
    expect(text(afterTick2, "status")).toBe("attested");
    expect(textOrNull(afterTick2, "last_error")).toBe(
      "receipt_unavailable:insufficient_confirmations",
    );
    expect((await db.query("SELECT id FROM inbound_delivery")).rows).toHaveLength(0);

    // Tick 3: candidate executed, receipt lacks ERC-20 Transfer -> stays attested, payout_unverified
    probeStage = 2;
    currentNow = new Date("2026-10-21T02:02:00Z");
    await pass.tick(new AbortController().signal);
    const afterTick3 = (
      await db.query("SELECT status, last_error FROM rail_attestation WHERE transfer_id = $1", [
        transferId.toString(),
      ])
    ).rows[0];
    expect(afterTick3).toBeDefined();
    if (!afterTick3) return;
    expect(text(afterTick3, "status")).toBe("attested");
    expect(textOrNull(afterTick3, "last_error")).toBe(
      "payout_unverified:missing_erc20_transfer_event",
    );
    expect((await db.query("SELECT id FROM inbound_delivery")).rows).toHaveLength(0);

    // Tick 4: canonical receipt + token payment verified -> delivered!
    probeStage = 3;
    currentNow = new Date("2026-10-21T02:03:00Z");
    await pass.tick(new AbortController().signal);
    const afterTick4 = (
      await db.query("SELECT status, last_error FROM rail_attestation WHERE transfer_id = $1", [
        transferId.toString(),
      ])
    ).rows[0];
    expect(afterTick4).toBeDefined();
    if (!afterTick4) return;
    expect(text(afterTick4, "status")).toBe("delivered");
    expect(textOrNull(afterTick4, "last_error")).toBeNull();
    expect(await outstandingForRail(db, RouteKind.AxelarIts)).toBe(0);

    const inboundRows = (await db.query("SELECT amount, delivered FROM inbound_delivery")).rows;
    expect(inboundRows).toHaveLength(1);
    expect(bigintOf(inboundRows[0] ?? {}, "amount")).toBe(NET_U256);
  });
});
