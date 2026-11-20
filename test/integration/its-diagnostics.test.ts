import { readProofRejectionMetrics } from "../../src/http/proof-rejection-metrics.js";
import { inspectPayment, type VerificationDiagnostic } from "../../src/rails/axelar/events.js";
import { itsProofFixture } from "../tooling/proof-fixtures.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Database } from "../../src/db/pool.js";
import { writeAttestation } from "../../src/chains/writers.js";
const connection = process.env.TEST_DATABASE_URL;
(connection ? describe : describe.skip)("durable bounded ITS verification diagnostics", () => {
  let db: Database, id: bigint;
  const router = "its-diagnostics-test";
  beforeAll(async () => {
    db = Database.open(connection ?? "");
    await db.query("DELETE FROM outbound_transfer WHERE origin_router=$1", [router]);
    const result = await db.query(
      `INSERT INTO outbound_transfer(origin_chain,origin_router,route,nonce,sender,token,gross_amount,fee,net_amount,destination_chain,destination,origin_block,origin_tx) VALUES('stellar-testnet',$1,1,18446744073709551615,'public-source','public-token',101,1,100,'ethereum-sepolia','public-recipient',1,'public-source-transaction') RETURNING id::text`,
      [router],
    );
    id = BigInt(String(result.rows[0]?.id));
  });
  afterAll(async () => {
    await db.query("DELETE FROM outbound_transfer WHERE origin_router=$1", [router]);
    await db.close();
  });
  const write = (
    state: "receipt_unavailable" | "payout_unverified" | "verified" | null,
    diagnostics: readonly VerificationDiagnostic[] = [],
  ) =>
    writeAttestation(db, {
      transferId: id,
      route: 1,
      status: "attested",
      railStatus: "executed",
      railReference: null,
      attestedAt: null,
      checkedAt: new Date(),
      checkFailures: 0,
      lastError: null,
      retryAttempts: 0,
      nextAttemptAt: new Date(),
      retryClass: null,
      itsVerificationState: state,
      diagnostics,
    });
  const read = async () =>
    (
      await db.query(
        "SELECT status,its_verification_state,diagnostics FROM rail_attestation WHERE transfer_id=$1",
        [id.toString()],
      )
    ).rows[0];
  it("distinguishes unavailable evidence from mismatch and retains only bounded public identifiers", async () => {
    await write("receipt_unavailable");
    expect(await read()).toMatchObject({
      status: "attested",
      its_verification_state: "receipt_unavailable",
      diagnostics: [],
    });
    await write("payout_unverified", [
      {
        category: "recipient",
        expected: "public-recipient",
        observed: "https://user:password@provider/?token=private-value",
      },
    ]);
    const mismatch = await read();
    expect(mismatch).toMatchObject({
      status: "attested",
      its_verification_state: "payout_unverified",
      diagnostics: [{ category: "recipient", expected: "public-recipient" }],
    });
    expect(JSON.stringify(mismatch)).not.toMatch(/password|private-value/);
    await write(null);
    expect(await read()).toEqual(mismatch);
    await write("verified");
    expect(await read()).toMatchObject({
      status: "attested",
      its_verification_state: "verified",
      diagnostics: [],
    });
  });
  it("counts ITS mismatches once per category without accepting provider success as delivery", async () => {
    const fixture = itsProofFixture();
    const provider = {
      getTransactionReceipt: vi
        .fn()
        .mockResolvedValue({ status: "success", logs: [fixture.received, fixture.paid] }),
    };
    const receipt = await provider.getTransactionReceipt();
    const inspection = inspectPayment(receipt.logs, {
      ...fixture.expected,
      recipient: "0x5555555555555555555555555555555555555555",
    });
    expect(inspection.payment).toBeNull();
    const baseline = await readProofRejectionMetrics(db);
    await write("payout_unverified", [...inspection.diagnostics, ...inspection.diagnostics]);
    const failed = await readProofRejectionMetrics(db);
    expect(failed.byRail.its.recipient).toBe(baseline.byRail.its.recipient + 1);
    expect(failed.byRail.its.provider_inconsistency).toBe(
      baseline.byRail.its.provider_inconsistency + 1,
    );
    expect((await read())?.status).toBe("attested");
    expect(JSON.stringify(failed)).not.toContain(fixture.expected.commandId);
    await write("verified");
    expect((await readProofRejectionMetrics(db)).byRail.its).toEqual(baseline.byRail.its);
  });
  it("enforces diagnostic size and shape in PostgreSQL", async () => {
    for (const value of [
      {},
      Array(7).fill({ category: "recipient" }),
      [{ category: "recipient", observed: "x".repeat(4096) }],
    ]) {
      await expect(
        db.query("UPDATE rail_attestation SET diagnostics=$1::jsonb WHERE transfer_id=$2", [
          JSON.stringify(value),
          id.toString(),
        ]),
      ).rejects.toThrow();
    }
  });
});
