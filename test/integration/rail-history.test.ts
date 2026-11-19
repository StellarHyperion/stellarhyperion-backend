import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "../../src/db/pool.js";
import { requeueTerminalTransfer } from "../../src/rails/requeue.js";
const connection = process.env.TEST_DATABASE_URL;
(connection ? describe : describe.skip)("committed rail lifecycle history", () => {
  let db: Database;
  let ids: string[] = [];
  beforeAll(async () => {
    db = Database.open(connection ?? "");
    await db.query("DELETE FROM outbound_transfer WHERE origin_tx = 'history292-fixture'");
    const result = await db.query(`INSERT INTO outbound_transfer
      (origin_chain,origin_router,route,nonce,sender,token,gross_amount,fee,net_amount,destination_chain,destination,origin_block,origin_tx)
      VALUES ('sepolia','history-router-a',1,292901,'sender','token',100,0,100,'stellar-testnet','recipient',1,'history292-fixture'),
             ('sepolia','history-router-b',1,292901,'sender','token',100,0,100,'stellar-testnet','recipient',1,'history292-fixture') RETURNING id`);
    ids = result.rows.map((row) => String(row.id));
  });
  afterAll(async () => {
    await db.query("DELETE FROM outbound_transfer WHERE origin_tx = 'history292-fixture'");
    await db.close();
  });
  it("serializes identical concurrent observations and binds reused nonces to their exact sources", async () => {
    await Promise.all(
      [1, 2].map(() =>
        db.transaction(async (tx) => {
          await tx.query(
            `INSERT INTO rail_attestation(transfer_id,route,status,last_checked_at)
        VALUES ($1,1,'pending',now()) ON CONFLICT(transfer_id) DO UPDATE SET status=excluded.status,last_checked_at=now()`,
            [ids[0]],
          );
        }),
      ),
    );
    await db.query(
      "INSERT INTO rail_attestation(transfer_id,route,status) VALUES ($1,1,'attested')",
      [ids[1]],
    );
    const result = await db.query(
      "SELECT transfer_id,new_status FROM rail_attestation_history WHERE transfer_id = ANY($1::bigint[]) ORDER BY id",
      [ids],
    );
    expect(result.rows).toEqual([
      { transfer_id: ids[0], new_status: "pending" },
      { transfer_id: ids[1], new_status: "attested" },
    ]);
  });
  it("does not commit history when the surrounding write rolls back", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.query("UPDATE rail_attestation SET status='attested' WHERE transfer_id=$1", [
          ids[0],
        ]);
        throw new Error("rollback history");
      }),
    ).rejects.toThrow("rollback history");
    const result = await db.query(
      "SELECT new_status FROM rail_attestation_history WHERE transfer_id=$1",
      [ids[0]],
    );
    expect(result.rows).toEqual([{ new_status: "pending" }]);
  });
  it("rejects blind backward writes and retains both real cycles after reviewed requeue", async () => {
    await db.query("UPDATE rail_attestation SET status='attested' WHERE transfer_id=$1", [ids[0]]);
    await expect(
      db.query("UPDATE rail_attestation SET status='pending' WHERE transfer_id=$1", [ids[0]]),
    ).rejects.toThrow("explicit reconciliation");
    await db.query("UPDATE rail_attestation SET status='failed' WHERE transfer_id=$1", [ids[0]]);
    await requeueTerminalTransfer(db, {
      transferId: BigInt(ids[0] ?? "0"),
      reviewedBy: "history regression",
      reason: "provider independently recovered",
    });
    await db.query("UPDATE rail_attestation SET status='attested' WHERE transfer_id=$1", [ids[0]]);
    await db.query("UPDATE rail_attestation SET status='failed' WHERE transfer_id=$1", [ids[0]]);
    const result = await db.query(
      "SELECT old_status,new_status,reason FROM rail_attestation_history WHERE transfer_id=$1 ORDER BY id",
      [ids[0]],
    );
    expect(result.rows.map((row) => row.new_status)).toEqual([
      "pending",
      "attested",
      "failed",
      "pending",
      "attested",
      "failed",
    ]);
    expect(result.rows[3]?.reason).toBe("operator_requeue");
  });
  it("keeps failure details private while recording normalized reasons and public hashes", async () => {
    await db.query(
      "UPDATE rail_attestation SET retry_class='transient',last_error=$2,rail_reference=$3 WHERE transfer_id=$1",
      [
        ids[1],
        "Bearer private-key https://user:password@rpc.invalid/token",
        "0x" + "ab".repeat(32),
      ],
    );
    const result = await db.query(
      "SELECT reason,evidence_reference FROM rail_attestation_history WHERE transfer_id=$1 ORDER BY id DESC LIMIT 1",
      [ids[1]],
    );
    expect(result.rows[0]).toEqual({
      reason: "transient",
      evidence_reference: "0x" + "ab".repeat(32),
    });
  });
});
