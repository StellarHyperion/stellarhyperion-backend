import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { RAIL_CONTRACTS, RouteKind } from "@hyperion/protocol";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { Database } from "../../src/db/pool.js";
import { loadConfig } from "../../src/config/config.js";
import { AXELAR_GAS_ABI, type DeliveryLog } from "../../src/rails/axelar/events.js";
import { ingestAxelarGasEvidence } from "../../src/rails/axelar/gas.js";
import { completeEnv } from "../helpers.js";

const connection = process.env.TEST_DATABASE_URL;
const gasService = RAIL_CONTRACTS["arc-testnet"]?.axelar?.gasService;
if (typeof gasService !== "string") throw new Error("arc-testnet Axelar gas service is missing");

(connection ? describe : describe.skip)("Axelar gas evidence ingestion", () => {
  const chain = "arc-testnet";
  const axelarChain = "arc-8";
  const payer = "0x7777777777777777777777777777777777777777" as Hex;
  const refund = "0x8888888888888888888888888888888888888888" as Hex;
  const receiver = "0x9999999999999999999999999999999999999999" as Hex;
  const zeroAddress = "0x0000000000000000000000000000000000000000" as Hex;
  const sourceTx = `0x${"00".repeat(31)}aa` as Hex;
  const payloadHash = `0x${"bb".repeat(32)}`;
  let db: Database;
  let transferId: bigint;

  beforeAll(async () => {
    db = Database.open(connection ?? "");
    await db.query("DELETE FROM axelar_gas_scan WHERE origin_chain = $1", [chain]);
    await db.query("DELETE FROM axelar_gas_evidence WHERE origin_chain = $1", [chain]);
    await db.query("DELETE FROM outbound_transfer WHERE origin_chain = $1", [chain]);
    const { rows } = await db.query(
      `INSERT INTO outbound_transfer
         (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
          destination_chain, destination, origin_block, origin_tx, origin_log_index, origin_router)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        chain,
        RouteKind.AxelarIts,
        "1",
        payer,
        "token",
        "101",
        "1",
        "100",
        axelarChain,
        receiver,
        "1",
        sourceTx,
        7,
        "gas-evidence-test",
      ],
    );
    transferId = BigInt(String(rows[0]?.id));
  });

  afterAll(async () => {
    await db.query("DELETE FROM axelar_gas_scan WHERE origin_chain = $1", [chain]);
    await db.query("DELETE FROM axelar_gas_evidence WHERE origin_chain = $1", [chain]);
    await db.query("DELETE FROM outbound_transfer WHERE origin_chain = $1", [chain]);
    await db.close();
  });

  it("indexes public gas events as evidence without advancing delivery and replays idempotently", async () => {
    const logs: readonly DeliveryLog[] = [
      {
        address: "0x1111111111111111111111111111111111111111",
        topics: encodeEventTopics({
          abi: AXELAR_GAS_ABI,
          eventName: "NativeGasAdded",
          args: { txHash: sourceTx, logIndex: 7n },
        }) as [Hex, ...Hex[]],
        data: encodeAbiParameters([{ type: "uint256" }, { type: "address" }], [1n, refund]),
        logIndex: 2,
      },
      {
        address: gasService as Hex,
        topics: encodeEventTopics({
          abi: AXELAR_GAS_ABI,
          eventName: "NativeGasPaidForContractCall",
          args: { sourceAddress: payer, payloadHash },
        }) as [Hex, ...Hex[]],
        data: encodeAbiParameters(
          [{ type: "string" }, { type: "string" }, { type: "uint256" }, { type: "address" }],
          [axelarChain, receiver, 123456789012345678901n, refund],
        ),
        logIndex: 3,
      },
      {
        address: gasService as Hex,
        topics: encodeEventTopics({
          abi: AXELAR_GAS_ABI,
          eventName: "NativeGasAdded",
          args: { txHash: sourceTx, logIndex: 7n },
        }) as [Hex, ...Hex[]],
        data: encodeAbiParameters([{ type: "uint256" }, { type: "address" }], [987654321n, refund]),
        logIndex: 4,
      },
      {
        address: gasService as Hex,
        topics: encodeEventTopics({
          abi: AXELAR_GAS_ABI,
          eventName: "Refunded",
          args: { txHash: sourceTx, logIndex: 7n },
        }) as [Hex, ...Hex[]],
        data: encodeAbiParameters(
          [{ type: "address" }, { type: "address" }, { type: "uint256" }],
          [receiver, zeroAddress, 55n],
        ),
        logIndex: 5,
      },
      {
        address: gasService as Hex,
        topics: [`0x${"de".repeat(32)}`],
        data: "0x",
        logIndex: 6,
      },
    ];
    let receiptCalls = 0;
    const options = {
      clientForChain: (requested: string) => {
        expect(requested).toBe(chain);
        return {
          getTransactionReceipt: ({ hash }: { readonly hash: Hex }) => {
            expect(hash).toBe(sourceTx);
            receiptCalls += 1;
            return Promise.resolve({ logs });
          },
        };
      },
    };
    const config = loadConfig({ env: completeEnv() });

    expect(await ingestAxelarGasEvidence(config, db, 1, options)).toEqual({
      scanned: 1,
      events: 4,
      unresolved: 1,
      failed: 0,
    });
    expect(receiptCalls).toBe(1);

    const { rows: evidence } = await db.query(
      `SELECT source_log_index, source_event, event_kind, status, link_basis, native, gas_token,
              amount::text AS amount, refund_address, reference_tx_hash, reference_log_index,
              candidate_count, replay_count, transfer_id::text AS transfer_id
         FROM axelar_gas_evidence
        WHERE origin_chain = $1 AND source_tx_hash = $2
        ORDER BY source_log_index`,
      [chain, sourceTx],
    );
    expect(evidence).toEqual([
      {
        source_log_index: 3,
        source_event: "NativeGasPaidForContractCall",
        event_kind: "payment",
        status: "linked",
        link_basis: "source_identity",
        native: true,
        gas_token: null,
        amount: "123456789012345678901",
        refund_address: refund,
        reference_tx_hash: sourceTx,
        reference_log_index: 3,
        candidate_count: 1,
        replay_count: 0,
        transfer_id: transferId.toString(),
      },
      {
        source_log_index: 4,
        source_event: "NativeGasAdded",
        event_kind: "topup",
        status: "linked",
        link_basis: "origin_log",
        native: true,
        gas_token: null,
        amount: "987654321",
        refund_address: refund,
        reference_tx_hash: sourceTx,
        reference_log_index: 7,
        candidate_count: 1,
        replay_count: 0,
        transfer_id: transferId.toString(),
      },
      {
        source_log_index: 5,
        source_event: "Refunded",
        event_kind: "refund",
        status: "linked",
        link_basis: "origin_log",
        native: true,
        gas_token: null,
        amount: "55",
        refund_address: receiver,
        reference_tx_hash: sourceTx,
        reference_log_index: 7,
        candidate_count: 1,
        replay_count: 0,
        transfer_id: transferId.toString(),
      },
      {
        source_log_index: 6,
        source_event: "unsupported",
        event_kind: "unsupported",
        status: "unresolved",
        link_basis: "unresolved",
        native: false,
        gas_token: null,
        amount: "0",
        refund_address: null,
        reference_tx_hash: sourceTx,
        reference_log_index: null,
        candidate_count: 0,
        replay_count: 0,
        transfer_id: null,
      },
    ]);

    const { rows: scans } = await db.query(
      "SELECT event_count, unresolved_count FROM axelar_gas_scan WHERE origin_chain = $1 AND origin_tx = $2",
      [chain, sourceTx],
    );
    expect(scans).toEqual([{ event_count: 4, unresolved_count: 1 }]);

    const { rows: lifecycle } = await db.query(
      `SELECT (SELECT count(*)::integer FROM rail_attestation WHERE transfer_id = $1) AS attestations,
              (SELECT count(*)::integer FROM inbound_delivery WHERE source_transfer_id = $1) AS arrivals`,
      [transferId.toString()],
    );
    expect(lifecycle).toEqual([{ attestations: 0, arrivals: 0 }]);

    await db.query("DELETE FROM axelar_gas_scan WHERE origin_chain = $1 AND origin_tx = $2", [
      chain,
      sourceTx,
    ]);
    expect(await ingestAxelarGasEvidence(config, db, 1, options)).toEqual({
      scanned: 1,
      events: 4,
      unresolved: 1,
      failed: 0,
    });
    expect(receiptCalls).toBe(2);
    const { rows: replayed } = await db.query(
      `SELECT count(*)::integer AS rows, max(replay_count) AS replays
         FROM axelar_gas_evidence
        WHERE origin_chain = $1 AND source_tx_hash = $2`,
      [chain, sourceTx],
    );
    expect(replayed).toEqual([{ rows: 4, replays: 1 }]);

    expect(await ingestAxelarGasEvidence(config, db, 1, options)).toEqual({
      scanned: 0,
      events: 0,
      unresolved: 0,
      failed: 0,
    });
    expect(receiptCalls).toBe(2);
  });
});
