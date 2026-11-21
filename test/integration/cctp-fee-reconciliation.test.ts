import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "../../src/db/pool.js";
import { writeInbound } from "../../src/chains/writers.js";
import type { CctpFeeReconciliation } from "../../src/rails/types.js";

const connection = process.env.TEST_DATABASE_URL;
(connection ? describe : describe.skip)("canonical CCTP fee accounting against PostgreSQL", () => {
  let db: Database;
  let id: bigint;
  const observedAt = new Date("2026-11-20T01:00:00Z");
  const accounting: CctpFeeReconciliation = {
    burnedAmountSourceUnits: 997000000n,
    forwardingBudgetDestinationUnits: 500000n,
    executedDeductionDestinationUnits: 100000n,
    actualPayoutDestinationUnits: 99600000n,
  };
  const clean = async () => {
    await db.query("DELETE FROM inbound_delivery WHERE source_chain='cctp-fee-test'");
    await db.query("DELETE FROM outbound_transfer WHERE origin_chain='cctp-fee-test'");
  };
  beforeAll(async () => {
    db = Database.open(connection ?? "");
    await clean();
    const result = await db.query(`INSERT INTO outbound_transfer
      (origin_chain,route,nonce,sender,token,gross_amount,fee,net_amount,destination_chain,destination,origin_block,origin_tx)
      VALUES ('cctp-fee-test',0,31801,'sender','USDC',1000000000,3000000,997000000,'sepolia','recipient',1,'source') RETURNING id`);
    id = BigInt(String(result.rows[0]!.id));
  });
  afterAll(async () => {
    await clean();
    await db.close();
  });
  const write = (
    fee?: CctpFeeReconciliation,
    amount = 99600000n,
    txHash = "canonical",
    at = observedAt,
  ) =>
    writeInbound(
      db,
      { chainKey: "sepolia", block: 100n, txHash, logIndex: 4, observedAt: at },
      {
        sourceTransferId: id,
        route: 0,
        sourceChain: "cctp-fee-test",
        sourceNonce: 31801n,
        railMessageId: "full-message",
        recipient: "recipient",
        token: "USDC",
        amount,
        delivered: true,
        claimId: null,
        ...(fee === undefined ? {} : { cctpFeeReconciliation: fee }),
      },
    );
  it("enriches replayed delivery and preserves first observation, then clears stale accounting on replacement", async () => {
    await write();
    await write(accounting, 99600000n, "canonical", new Date(observedAt.getTime() + 1000));
    const first = await db.query(
      "SELECT observed_at,cctp_burned_amount_source_units::text AS burn,cctp_actual_payout_destination_units::text AS payout FROM inbound_delivery WHERE source_transfer_id=$1",
      [id.toString()],
    );
    expect(first.rows).toEqual([
      { observed_at: observedAt, burn: "997000000", payout: "99600000" },
    ]);
    await write(undefined, 99500000n, "replacement");
    const replacement = await db.query(
      "SELECT observed_at,amount::text AS amount,destination_tx,cctp_burned_amount_source_units AS burn FROM inbound_delivery WHERE source_transfer_id=$1",
      [id.toString()],
    );
    expect(replacement.rows).toEqual([
      { observed_at: observedAt, amount: "99500000", destination_tx: "replacement", burn: null },
    ]);
  });
  it.each([
    { ...accounting, burnedAmountSourceUnits: 997000001n },
    { ...accounting, forwardingBudgetDestinationUnits: 99700000n },
    { ...accounting, executedDeductionDestinationUnits: 500001n },
    { ...accounting, actualPayoutDestinationUnits: 99600001n },
  ])(
    "rejects inconsistent canonical accounting without corrupting the existing row",
    async (invalid) => {
      const before = await db.query("SELECT * FROM inbound_delivery WHERE source_transfer_id=$1", [
        id.toString(),
      ]);
      await expect(write(invalid)).rejects.toMatchObject({ code: "23514" });
      const after = await db.query("SELECT * FROM inbound_delivery WHERE source_transfer_id=$1", [
        id.toString(),
      ]);
      expect(after.rows).toEqual(before.rows);
    },
  );
});
