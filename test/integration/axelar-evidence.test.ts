import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "../../src/db/pool.js";
import {
  writeAxelarDeliveryEvidence,
  writeAxelarQuarantine,
  type AxelarDeliveryEvidenceRow,
} from "../../src/chains/writers.js";
import { revalidateItsDeliveryProofs } from "../../src/rails/axelar/delivery.js";
import { loadConfig } from "../../src/config/config.js";
import { completeEnv } from "../helpers.js";
const connection = process.env.TEST_DATABASE_URL;
(connection ? describe : describe.skip)("Axelar durable evidence reconciliation", () => {
  let db: Database;
  let id: bigint;
  const txHash = `0x${"ab".repeat(32)}`;
  const blockHash = `0x${"cd".repeat(32)}`;
  beforeAll(async () => {
    db = Database.open(connection ?? "");
    await db.query("DELETE FROM outbound_transfer WHERE origin_chain = 'axelar-evidence-test'");
    const { rows } = await db.query(
      `INSERT INTO outbound_transfer(origin_chain,route,nonce,sender,token,gross_amount,fee,net_amount,destination_chain,destination,origin_block,origin_tx) VALUES ('axelar-evidence-test',1,1,'source','token',101,1,100,'sepolia','recipient',1,$1) RETURNING id`,
      [txHash],
    );
    id = BigInt(String(rows[0]?.id));
  });
  afterAll(async () => {
    await db.query("DELETE FROM inbound_delivery WHERE source_chain = 'axelar-evidence-test'");
    await db.query("DELETE FROM outbound_transfer WHERE id = $1", [id.toString()]);
    await db.close();
  });
  it("stores full command/payment identity and atomically invalidates/requeues an orphan", async () => {
    const evidence: AxelarDeliveryEvidenceRow = {
      transferId: id,
      destinationChain: "sepolia",
      commandId: txHash,
      executionTxHash: txHash,
      receiptBlock: 10n,
      receiptBlockHash: blockHash,
      itsAddress: `0x${"11".repeat(20)}`,
      tokenId: txHash,
      registeredToken: `0x${"22".repeat(20)}`,
      tokenManager: `0x${"33".repeat(20)}`,
      tokenManagerBlock: 10n,
      tokenManagerBlockHash: blockHash,
      paymentLogIndex: 3,
      paymentRecipient: `0x${"44".repeat(20)}`,
      paymentAmount: 100n,
    };
    const evidenceId = await db.transaction((tx) => writeAxelarDeliveryEvidence(tx, evidence));
    await db.query(
      `INSERT INTO inbound_delivery(destination_chain,route,source_chain,source_nonce,recipient,token,amount,delivered,destination_block,destination_tx,destination_log_index,axelar_evidence_id) VALUES ('sepolia',1,'axelar-evidence-test',1,$1,$2,100,true,10,$3,3,$4)`,
      [evidence.paymentRecipient, evidence.registeredToken, txHash, evidenceId.toString()],
    );
    await db.query(
      "INSERT INTO rail_attestation(transfer_id,route,status) VALUES ($1,1,'delivered')",
      [id.toString()],
    );
    const config = loadConfig({ env: completeEnv() });
    expect(
      await revalidateItsDeliveryProofs(config, db, 100, {
        clientForChain: () => ({
          getChainId: () => Promise.resolve(11155111),
          getBlock: () => Promise.resolve({ hash: `0x${"ef".repeat(32)}` }),
          getTransactionReceipt: async () => {
            await Promise.resolve();
            throw new Error("orphan has no canonical receipt");
          },
        }),
      }),
    ).toBe(1);
    const { rows } = await db.query(
      `SELECT e.command_id,e.status,a.status AS rail_status,a.next_attempt_at,(SELECT count(*)::integer FROM inbound_delivery WHERE axelar_evidence_id=e.id) AS arrivals FROM axelar_delivery_evidence e JOIN rail_attestation a ON a.transfer_id=e.transfer_id WHERE e.id=$1`,
      [evidenceId.toString()],
    );
    expect(rows[0]?.command_id).toBe(txHash);
    expect(rows[0]?.status).toBe("orphaned");
    expect(rows[0]?.rail_status).toBe("attested");
    expect(rows[0]?.next_attempt_at).toBeInstanceOf(Date);
    expect(rows[0]?.arrivals).toBe(0);
    await db.transaction((tx) =>
      writeAxelarDeliveryEvidence(tx, {
        ...evidence,
        receiptBlock: 11n,
        receiptBlockHash: `0x${"ef".repeat(32)}`,
        tokenManagerBlock: 11n,
        tokenManagerBlockHash: `0x${"ef".repeat(32)}`,
      }),
    );
    expect(
      (
        await db.query(
          "SELECT status,receipt_block::text FROM axelar_delivery_evidence WHERE id=$1",
          [evidenceId.toString()],
        )
      ).rows[0],
    ).toEqual({ status: "canonical", receipt_block: "11" });
  });
  it("persists sanitized bounded unsupported schemas idempotently", async () => {
    const row = {
      transferId: id,
      sourceTxHash: txHash,
      providerReference: "reference",
      schema: "unsupported_status",
      payload: {
        authorization: "never-print",
        message: "Bearer never-print",
        large: "x".repeat(50000),
      },
    };
    await db.transaction((tx) => writeAxelarQuarantine(tx, row));
    await db.transaction((tx) => writeAxelarQuarantine(tx, row));
    const { rows } = await db.query(
      "SELECT payload,replay_count FROM axelar_status_quarantine WHERE transfer_id=$1",
      [id.toString()],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.replay_count).toBe(1);
    expect(JSON.stringify(rows[0]?.payload)).not.toContain("never-print");
    expect(JSON.stringify(rows[0]?.payload).length).toBeLessThan(16384);
  });
});
