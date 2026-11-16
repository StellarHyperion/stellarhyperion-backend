import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { AddressKind, RAIL_CONTRACTS, RouteKind, encodeStellarAddress } from "@hyperion/protocol";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { RawStellarEvent } from "../../src/chains/stellar/events.js";
import { writeOutbound } from "../../src/chains/writers.js";
import type { Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";
import { bigintOf } from "../../src/db/rows.js";
import {
  AXELAR_GAS_SERVICE_ABI,
  decodeStellarAxelarGasEvent,
  gasEventsFromEvmLogs,
  ingestAxelarGasEvents,
  listTransferGasEvents,
  listUnresolvedAxelarGasEvents,
  relinkUnresolvedAxelarGasEvents,
  type DeliveryLog,
} from "../../src/rails/axelar/delivery.js";
import { AxelarGmpClient } from "../../src/rails/axelar/gmp.js";
import { RailPass } from "../../src/rails/pass.js";
import { pendingForRail } from "../../src/rails/queue.js";
import { capturingLogger } from "../stellar-fakes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

const MIGRATION_FILES = [
  "1790900000000_initial-schema.sql",
  "1791000000000_cursor-block-hash.sql",
  "1791100000000_cursor-autovacuum-tuning.sql",
  "1791200000000_axelar-gas-history.sql",
];

class PgliteDb implements Transactional {
  constructor(private readonly pg: PGlite) {}

  async query(sql: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
    const res = await this.pg.query<Record<string, unknown>>(sql, [...params]);
    return {
      rows: res.rows,
      rowCount: res.affectedRows ?? res.rows.length,
    };
  }

  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (tx) => {
      const wrapped: Queryable = {
        async query(sql: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
          const res = await tx.query<Record<string, unknown>>(sql, [...params]);
          return {
            rows: res.rows,
            rowCount: res.affectedRows ?? res.rows.length,
          };
        },
      };
      return work(wrapped);
    });
  }
}

const STELLAR_SENDER = encodeStellarAddress(AddressKind.Account, new Uint8Array(32).fill(0x12));
const STELLAR_REFUND_G = encodeStellarAddress(AddressKind.Account, new Uint8Array(32).fill(0x34));
const STELLAR_REFUND_MUXED = encodeStellarAddress(
  AddressKind.MuxedAccount,
  new Uint8Array(32).fill(0x56),
  999n,
);
const STELLAR_TOKEN = encodeStellarAddress(AddressKind.Contract, new Uint8Array(32).fill(0x78));
const STELLAR_NATIVE_SAC = encodeStellarAddress(
  AddressKind.Contract,
  new Uint8Array(32).fill(0x9a),
);
const EVM_DEST_WORD = `0x000000000000000000000000${"ab".repeat(20)}`;
const CHECKSUMMED_EVM_REFUND = "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B";

describe("Axelar gas-payment and refund history ingestion", () => {
  let pg: PGlite;
  let db: PgliteDb;

  beforeAll(async () => {
    pg = new PGlite();
    for (const file of MIGRATION_FILES) {
      const raw = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      const upSql = raw.split("-- Down Migration")[0] ?? raw;
      await pg.exec(upSql);
    }
    db = new PgliteDb(pg);
  });

  afterAll(async () => {
    await pg.close();
  });

  beforeEach(async () => {
    await pg.exec(
      "TRUNCATE axelar_gas_event, rail_attestation, inbound_delivery, pending_claim, outbound_transfer RESTART IDENTITY CASCADE",
    );
  });

  async function seedOutbound(
    chain: string,
    nonce: bigint,
    originTx: string,
    railRef: string | null = null,
  ): Promise<bigint> {
    await db.transaction(async (tx) => {
      await writeOutbound(
        tx,
        {
          chainKey: chain,
          block: 10_000n + nonce,
          txHash: originTx,
          logIndex: chain === "sepolia" ? 0 : null,
          observedAt: new Date("2026-10-15T12:00:00Z"),
        },
        {
          route: RouteKind.AxelarIts,
          nonce,
          sender: STELLAR_SENDER,
          token: STELLAR_TOKEN,
          grossAmount: 25_005_000n,
          fee: 5_000n,
          netAmount: 25_000_000n,
          destinationChain: chain === "sepolia" ? "stellar-testnet" : "sepolia",
          destination: EVM_DEST_WORD,
          railRef,
        },
      );
    });
    const { rows } = await db.query(
      "SELECT id FROM outbound_transfer WHERE origin_chain = $1 AND nonce = $2",
      [chain, nonce.toString()],
    );
    const first = rows[0];
    if (!first) throw new Error("Expected outbound_transfer row");
    return bigintOf(first, "id");
  }

  it("never lets gas payments, top-ups, or refunds advance payout lifecycle on their own", async () => {
    const { logger } = capturingLogger();
    const originTx = `0x${"1a".repeat(32)}`;
    const messageId = `${originTx}-0`;
    const transferId = await seedOutbound("stellar-testnet", 1n, originTx, messageId);

    const stellarGasService = RAIL_CONTRACTS["stellar-testnet"]?.axelar?.gasService;
    if (!stellarGasService) throw new Error("Expected stellar-testnet Axelar gasService");

    const rawPaid: RawStellarEvent = {
      type: "contract",
      ledger: 10001,
      ledgerClosedAt: "2026-10-15T12:00:05Z",
      contractId: stellarGasService,
      id: "0000042953967968256-0000000001",
      txHash: originTx,
      operationIndex: 0,
      transactionIndex: 0,
      inSuccessfulContractCall: true,
      topicJson: [{ symbol: "gas_paid" }],
      valueJson: {
        map: [
          { key: { symbol: "refund_address" }, val: { address: STELLAR_REFUND_MUXED } },
          { key: { symbol: "sender" }, val: { address: STELLAR_SENDER } },
          {
            key: { symbol: "token" },
            val: {
              map: [
                { key: { symbol: "address" }, val: { address: STELLAR_NATIVE_SAC } },
                { key: { symbol: "amount" }, val: { i128: "150000000" } },
              ],
            },
          },
        ],
      },
    };

    const rawAdded: RawStellarEvent = {
      ...rawPaid,
      ledger: 10005,
      ledgerClosedAt: "2026-10-15T12:01:00Z",
      id: "0000042971147837440-0000000002",
      txHash: `0x${"1b".repeat(32)}`,
      topicJson: [{ symbol: "gas_added" }, { string: messageId }],
      valueJson: {
        map: [
          { key: { symbol: "message_id" }, val: { string: messageId } },
          { key: { symbol: "refund_address" }, val: { address: STELLAR_REFUND_G } },
          {
            key: { symbol: "token" },
            val: {
              map: [
                { key: { symbol: "address" }, val: { address: STELLAR_NATIVE_SAC } },
                { key: { symbol: "amount" }, val: { i128: "50000000" } },
              ],
            },
          },
        ],
      },
    };

    const rawRefunded: RawStellarEvent = {
      ...rawPaid,
      ledger: 10010,
      ledgerClosedAt: "2026-10-15T12:02:00Z",
      id: "0000042992622673920-0000000000",
      txHash: `0x${"1c".repeat(32)}`,
      topicJson: [{ symbol: "gas_refunded" }, { string: messageId }],
      valueJson: {
        map: [
          { key: { symbol: "message_id" }, val: { string: messageId } },
          { key: { symbol: "receiver" }, val: { address: STELLAR_REFUND_MUXED } },
          {
            key: { symbol: "token" },
            val: {
              map: [
                { key: { symbol: "address" }, val: { address: STELLAR_NATIVE_SAC } },
                { key: { symbol: "amount" }, val: { i128: "35000000" } },
              ],
            },
          },
        ],
      },
    };

    const decodedEvents = [rawPaid, rawAdded, rawRefunded]
      .map((ev) =>
        decodeStellarAxelarGasEvent(ev, {
          chain: "stellar-testnet",
          nativeSacId: STELLAR_NATIVE_SAC,
        }),
      )
      .filter((item): item is NonNullable<typeof item> => item !== null);

    expect(decodedEvents).toHaveLength(3);

    const summary = await ingestAxelarGasEvents(db, decodedEvents);
    expect(summary).toEqual({ processed: 3, linked: 3, unresolved: 0 });

    // Inbound deliveries and rail_attestations remain completely untouched by gas ingestion.
    const inboundCount = await db.query("SELECT COUNT(*)::int AS cnt FROM inbound_delivery");
    expect(inboundCount.rows[0]?.cnt).toBe(0);
    const attBefore = await db.query("SELECT COUNT(*)::int AS cnt FROM rail_attestation");
    expect(attBefore.rows[0]?.cnt).toBe(0);

    // Even if Axelar's GMP API shows gas_paid/refunded fields while status is "called", RailPass keeps it pending.
    const fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                message_id: messageId,
                call: { transactionHash: originTx },
                status: "called",
                gas_status: "gas_paid_enough_gas",
                refunded: { amount: "35000000", receipt: { status: 1 } },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )) as typeof globalThis.fetch;

    const pass = new RailPass({
      route: RouteKind.AxelarIts,
      client: new AxelarGmpClient("https://testnet.api.gmp.axelarscan.io", { fetch }),
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 0,
      maxCheckFailures: 5,
    });
    await pass.tick(new AbortController().signal);

    const pending = await pendingForRail(db, {
      route: RouteKind.AxelarIts,
      limit: 10,
      notCheckedSince: new Date(Date.now() + 60_000),
      maxCheckFailures: 5,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe("pending");
    expect(pending[0]?.delivered).toBe(false);

    const history = await listTransferGasEvents(db, transferId);
    expect(history).toHaveLength(3);
    expect(history.map((h) => h.eventKind)).toEqual(["gas_paid", "gas_added", "refunded"]);
    expect(history[0]?.refundAddress).toBe(STELLAR_REFUND_MUXED);
    expect(history[1]?.refundAddress).toBe(STELLAR_REFUND_G);
    expect(history[2]?.refundAddress).toBe(STELLAR_REFUND_MUXED);
  });

  it("preserves exact uint256 native wei amounts, EIP-55 refund addresses, and replayable idempotency", async () => {
    const sepoliaOriginTx: Hex = `0x${"2a".repeat(32)}`;
    const topupTx: Hex = `0x${"2b".repeat(32)}`;
    const refundTx: Hex = `0x${"2c".repeat(32)}`;
    const transferId = await seedOutbound("sepolia", 77n, sepoliaOriginTx);

    const sepoliaGasService = RAIL_CONTRACTS.sepolia?.axelar?.gasService as Hex | undefined;
    if (!sepoliaGasService) throw new Error("Expected sepolia Axelar gasService");

    // Full uint256-scale native amount far above Number.MAX_SAFE_INTEGER.
    const hugeNativeTopup = 340282366920938463463374607431768211455n;
    const exactNativeRefund = 99999999999999999999999999999n;

    const topupLog: DeliveryLog = {
      address: sepoliaGasService,
      topics: encodeEventTopics({
        abi: AXELAR_GAS_SERVICE_ABI,
        eventName: "NativeGasAdded",
        args: { txHash: sepoliaOriginTx, logIndex: 0n },
      }) as [Hex, ...Hex[]],
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "address" }],
        [hugeNativeTopup, CHECKSUMMED_EVM_REFUND],
      ),
      logIndex: 3,
    };

    const refundLog: DeliveryLog = {
      address: sepoliaGasService,
      topics: encodeEventTopics({
        abi: AXELAR_GAS_SERVICE_ABI,
        eventName: "Refunded",
        args: { txHash: sepoliaOriginTx, logIndex: 0n },
      }) as [Hex, ...Hex[]],
      data: encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "uint256" }],
        [CHECKSUMMED_EVM_REFUND, "0x0000000000000000000000000000000000000000", exactNativeRefund],
      ),
      logIndex: 5,
    };

    const batch = [
      ...gasEventsFromEvmLogs({
        chain: "sepolia",
        txHash: topupTx,
        blockNumber: 20_001n,
        observedAt: new Date("2026-10-15T13:00:00Z"),
        logs: [topupLog],
      }),
      ...gasEventsFromEvmLogs({
        chain: "sepolia",
        txHash: refundTx,
        blockNumber: 20_002n,
        observedAt: new Date("2026-10-15T13:01:00Z"),
        logs: [refundLog],
      }),
    ];

    await ingestAxelarGasEvents(db, batch);
    // Re-ingesting the identical events must be idempotent without duplicating rows.
    await ingestAxelarGasEvents(db, batch);

    const history = await listTransferGasEvents(db, transferId);
    expect(history).toHaveLength(2);
    expect(history[0]?.isNative).toBe(true);
    expect(history[0]?.gasToken).toBeNull();
    expect(history[0]?.amount).toBe(hugeNativeTopup);
    expect(history[0]?.refundAddress).toBe(CHECKSUMMED_EVM_REFUND);

    expect(history[1]?.eventKind).toBe("refunded");
    expect(history[1]?.isNative).toBe(true);
    expect(history[1]?.amount).toBe(exactNativeRefund);
    expect(history[1]?.refundAddress).toBe(CHECKSUMMED_EVM_REFUND);
  });

  it("retains unsupported, ambiguous, and unindexed links as unresolved evidence and relinks when source transfers arrive", async () => {
    const delayedOriginTx = `0x${"4a".repeat(32)}`;
    const sharedBatchTx = `0x${"4b".repeat(32)}`;

    // Seed two distinct outbound transfers sharing the same batch source tx to create an ambiguous tx-only link.
    await seedOutbound("stellar-testnet", 90n, sharedBatchTx);
    await seedOutbound("stellar-testnet", 91n, sharedBatchTx);

    const gasService =
      RAIL_CONTRACTS["stellar-testnet"]?.axelar?.gasService ?? "C_FALLBACK_GAS_SERVICE";

    const ingestResult = await ingestAxelarGasEvents(db, [
      // 1. Unsupported message_id scheme
      {
        chain: "stellar-testnet",
        gasService,
        txHash: `0x${"51".repeat(32)}`,
        blockNumber: 30_001n,
        logIndex: 0,
        eventKind: "gas_added",
        isNative: true,
        gasToken: null,
        amount: 10_000_000n,
        refundAddress: STELLAR_REFUND_G,
        messageId: "cosmos-ibc://axelar-dojo-1/channel-42/seq-7",
      },
      // 2. Unsupported truncated sourceTxRef format
      {
        chain: "stellar-testnet",
        gasService,
        txHash: `0x${"52".repeat(32)}`,
        blockNumber: 30_002n,
        logIndex: 0,
        eventKind: "refunded",
        isNative: true,
        gasToken: null,
        amount: 2_500_000n,
        refundAddress: STELLAR_REFUND_MUXED,
        sourceTxRef: "0x1234abcd",
      },
      // 3. Ambiguous source transaction with two outbound transfers and no unique rail_ref
      {
        chain: "stellar-testnet",
        gasService,
        txHash: `0x${"53".repeat(32)}`,
        blockNumber: 30_003n,
        logIndex: 0,
        eventKind: "gas_added",
        isNative: true,
        gasToken: null,
        amount: 8_000_000n,
        refundAddress: STELLAR_REFUND_G,
        sourceTxRef: sharedBatchTx,
      },
      // 4. Valid sourceTxRef whose outbound_transfer has not been indexed yet
      {
        chain: "stellar-testnet",
        gasService,
        txHash: `0x${"54".repeat(32)}`,
        blockNumber: 30_004n,
        logIndex: 0,
        eventKind: "refunded",
        isNative: true,
        gasToken: null,
        amount: 4_000_000n,
        refundAddress: STELLAR_REFUND_MUXED,
        sourceTxRef: delayedOriginTx,
      },
    ]);

    expect(ingestResult).toEqual({ processed: 4, linked: 0, unresolved: 4 });

    const beforeRelink = await listUnresolvedAxelarGasEvents(db, "stellar-testnet");
    expect(beforeRelink).toHaveLength(4);
    expect(beforeRelink.map((r) => r.unresolvedReason)).toEqual([
      "unsupported_message_id_format",
      "unsupported_link_format",
      "ambiguous_source_transaction",
      "source_transfer_not_indexed",
    ]);

    // Once the delayed outbound_transfer arrives, relinkUnresolvedAxelarGasEvents links #4 while
    // preserving the 3 unsupported/ambiguous records as unresolved evidence.
    const delayedTransferId = await seedOutbound("stellar-testnet", 92n, delayedOriginTx);
    const relinkedCount = await relinkUnresolvedAxelarGasEvents(db);
    expect(relinkedCount).toBe(1);

    const linkedToDelayed = await listTransferGasEvents(db, delayedTransferId);
    expect(linkedToDelayed).toHaveLength(1);
    expect(linkedToDelayed[0]?.refundAddress).toBe(STELLAR_REFUND_MUXED);
    expect(linkedToDelayed[0]?.amount).toBe(4_000_000n);

    const remainingUnresolved = await listUnresolvedAxelarGasEvents(db, "stellar-testnet");
    expect(remainingUnresolved).toHaveLength(3);
    expect(remainingUnresolved.map((r) => r.unresolvedReason)).toEqual([
      "unsupported_message_id_format",
      "unsupported_link_format",
      "ambiguous_source_transaction",
    ]);
  });
});
