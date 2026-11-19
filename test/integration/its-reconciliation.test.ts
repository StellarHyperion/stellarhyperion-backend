import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "../../src/db/pool.js";
import {
  writeAxelarDeliveryEvidence,
  type AxelarDeliveryEvidenceRow,
} from "../../src/chains/writers.js";
import { reconcileItsTransfers } from "../../src/rails/axelar/reconcile.js";
const connection = process.env.TEST_DATABASE_URL;
(connection ? describe : describe.skip)("audited read-only ITS source-to-payment report", () => {
  let db: Database, id: bigint, evidenceId: bigint;
  const chain = "its-reconciliation-test",
    recipient = `0x${"44".repeat(20)}`,
    token = `0x${"22".repeat(20)}`,
    hash = `0x${"ab".repeat(32)}`;
  let evidence: AxelarDeliveryEvidenceRow;
  beforeAll(async () => {
    db = Database.open(connection ?? "");
    await db.query("DELETE FROM inbound_delivery WHERE source_chain=$1", [chain]);
    await db.query("DELETE FROM outbound_transfer WHERE origin_chain=$1", [chain]);
    const source = (
      await db.query(
        `INSERT INTO outbound_transfer(origin_chain,route,nonce,sender,token,gross_amount,fee,net_amount,destination_chain,destination,origin_block,origin_tx)
   VALUES($1,1,18446744073709551615,'public-source','source-token',101,1,100,'ethereum-sepolia',$2,1,$3) RETURNING id::text`,
        [chain, recipient, hash],
      )
    ).rows[0];
    id = BigInt(String(source?.id));
    evidence = {
      transferId: id,
      destinationChain: "ethereum-sepolia",
      commandId: hash,
      executionTxHash: hash,
      receiptBlock: 10n,
      receiptBlockHash: hash,
      itsAddress: `0x${"11".repeat(20)}`,
      tokenId: hash,
      registeredToken: token,
      tokenManager: `0x${"33".repeat(20)}`,
      tokenManagerBlock: 10n,
      tokenManagerBlockHash: hash,
      paymentLogIndex: 3,
      paymentRecipient: recipient,
      paymentAmount: 100n,
      sourceBinding: {
        chain,
        router: "",
        nonce: "18446744073709551615",
        transaction: hash,
        sender: "public-source",
        token: "source-token",
        amount: "100",
        destinationChain: "ethereum-sepolia",
        destination: recipient,
      },
    };
    evidenceId = await db.transaction((tx) => writeAxelarDeliveryEvidence(tx, evidence));
    await db.query(
      `INSERT INTO inbound_delivery(destination_chain,route,source_chain,source_nonce,source_transfer_id,recipient,token,amount,delivered,destination_block,destination_tx,destination_log_index,rail_message_id,axelar_evidence_id)
   VALUES('ethereum-sepolia',1,$1,18446744073709551615,$2,$3,$4,100,true,10,$5,3,$5,$6)`,
      [chain, id.toString(), recipient, token, hash, evidenceId.toString()],
    );
    await db.query(
      "INSERT INTO rail_attestation(transfer_id,route,status) VALUES($1,1,'attested')",
      [id.toString()],
    );
  });
  afterAll(async () => {
    await db.query("DELETE FROM inbound_delivery WHERE source_chain=$1", [chain]);
    await db.query("DELETE FROM outbound_transfer WHERE origin_chain=$1", [chain]);
    await db.close();
  });
  const report = () => reconcileItsTransfers(db, { transferId: id });
  it("requires a source snapshot and exact canonical payment identity", async () => {
    expect((await report()).rows[0]).toMatchObject({
      state: "reconciled",
      source: { nonce: "18446744073709551615", amount: "100" },
      destination: { token, recipient, amount: "100" },
    });
    await db.query("UPDATE outbound_transfer SET sender='changed-source' WHERE id=$1", [
      id.toString(),
    ]);
    expect((await report()).rows[0]?.state).toBe("mismatch");
    await expect(db.transaction((tx) => writeAxelarDeliveryEvidence(tx, evidence))).rejects.toThrow(
      "source binding changed",
    );
    await db.query("UPDATE outbound_transfer SET sender='public-source' WHERE id=$1", [
      id.toString(),
    ]);
  });
  it("rejects recipient, token, amount and command mismatches independently", async () => {
    for (const [column, value] of [
      ["recipient", `0x${"55".repeat(20)}`],
      ["token", `0x${"66".repeat(20)}`],
      ["amount", "99"],
      ["rail_message_id", `0x${"cd".repeat(32)}`],
    ]) {
      await db.query(`UPDATE inbound_delivery SET ${column}=$1 WHERE axelar_evidence_id=$2`, [
        value,
        evidenceId.toString(),
      ]);
      expect((await report()).rows[0]?.state).toBe("mismatch");
      await db.query(
        "UPDATE inbound_delivery SET recipient=$1,token=$2,amount=100,rail_message_id=$3 WHERE axelar_evidence_id=$4",
        [recipient, token, hash, evidenceId.toString()],
      );
    }
  });
  it("labels legacy missing bindings and missing proof without inventing reconciliation", async () => {
    await db.query("UPDATE axelar_delivery_evidence SET source_binding=NULL WHERE id=$1", [
      evidenceId.toString(),
    ]);
    expect((await report()).rows[0]?.state).toBe("missing_source_binding");
    await db.query("UPDATE axelar_delivery_evidence SET source_binding=$1::jsonb WHERE id=$2", [
      JSON.stringify(evidence.sourceBinding),
      evidenceId.toString(),
    ]);
    await db.query(
      "UPDATE inbound_delivery SET axelar_evidence_id=NULL WHERE source_transfer_id=$1",
      [id.toString()],
    );
    expect((await report()).rows[0]?.state).toBe("missing_proof");
    await db.query(
      "UPDATE inbound_delivery SET axelar_evidence_id=$1 WHERE source_transfer_id=$2",
      [evidenceId.toString(), id.toString()],
    );
  });
  it("explicitly reports missing backend history and performs no writes", async () => {
    const before = (
      await db.query(
        "SELECT source_binding,verified_at,last_revalidated_at FROM axelar_delivery_evidence WHERE id=$1",
        [evidenceId.toString()],
      )
    ).rows;
    expect(
      (await reconcileItsTransfers(db, { transferId: 9223372036854775807n })).missingBackendHistory,
    ).toBe(true);
    await report();
    expect(
      (
        await db.query(
          "SELECT source_binding,verified_at,last_revalidated_at FROM axelar_delivery_evidence WHERE id=$1",
          [evidenceId.toString()],
        )
      ).rows,
    ).toEqual(before);
  });
});
