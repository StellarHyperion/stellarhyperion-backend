import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "../../src/db/pool.js";
import { persistScanJournal } from "../../src/chains/stellar/store.js";
import { recordEvmScanProvenance } from "../../src/chains/evm/store.js";
import {
  recordWorkerRun,
  readWorkerRuns,
  withWorkerRun,
  type WorkerRunIdentity,
} from "../../src/runtime/worker-runs.js";
import { concurrencyBarrier, validateConcurrencyDatabase } from "../helpers.js";

const connection = process.env.TEST_DATABASE_URL;
(connection ? describe : describe.skip)("durable job and atomic evidence correlation", () => {
  let db: Database;
  // Two concurrent worker transactions plus the foreground capacity reserved by admission.
  const maxConnections = 3;
  const executionId = randomUUID();
  const identities: WorkerRunIdentity[] = [0, 1].map((index) => ({
    runId: randomUUID(),
    executionId,
    workerName: `correlation315-${process.pid}-${index}`,
    workerKind: "chain",
    chainKey: "sepolia",
  }));
  const chain = `correlation315-${process.pid}`;
  const originTx = `correlation315-source-${process.pid}`;
  let transferId: string;
  beforeAll(async () => {
    validateConcurrencyDatabase(connection ?? "");
    db = Database.open(connection ?? "", { maxConnections });
    const result = await db.query(
      `INSERT INTO outbound_transfer
      (origin_chain,origin_router,route,nonce,sender,token,gross_amount,fee,net_amount,destination_chain,destination,origin_block,origin_tx)
      VALUES ('sepolia',$1,1,315901,'sender','token',100,0,100,'stellar-testnet','recipient',1,$2) RETURNING id`,
      [chain, originTx],
    );
    transferId = String(result.rows[0]?.id);
  });
  afterAll(async () => {
    await db.query("DELETE FROM outbound_transfer WHERE origin_tx=$1", [originTx]);
    await db.query("DELETE FROM stellar_scan_journal WHERE chain_key=$1", [chain]);
    await db.query("DELETE FROM evm_scan_provenance WHERE chain_key=$1", [chain]);
    await db.query("DELETE FROM indexer_worker_run WHERE execution_id=$1", [executionId]);
    await db.close();
  });

  it("retains previous partial and completed jobs after reopening the database", async () => {
    const first = identities[0];
    const second = identities[1];
    if (first === undefined || second === undefined) throw new Error("missing run fixtures");
    await recordWorkerRun(db, first, "running");
    await recordWorkerRun(db, second, "running");
    await recordWorkerRun(db, second, "caught_up", true);
    await db.close();
    db = Database.open(connection ?? "", { maxConnections });
    const runs = (await readWorkerRuns(db)).filter((run) => run.executionId === executionId);
    expect(runs).toHaveLength(2);
    expect(runs.find((run) => run.runId === first.runId)).toMatchObject({
      state: "running",
      partial: true,
      successfulTicks: "0",
    });
    expect(runs.find((run) => run.runId === second.runId)).toMatchObject({
      state: "caught_up",
      partial: false,
      successfulTicks: "1",
    });
  });

  it("isolates concurrent run contexts and atomically binds source scans and verification transitions", async () => {
    const barrier = concurrencyBarrier(2);
    await Promise.all(
      identities.map((identity) =>
        withWorkerRun(identity, () =>
          db.transaction(async (tx) => {
            await barrier.wait();
            await persistScanJournal(tx, identity.runId, { chainKey: chain });
            await recordEvmScanProvenance(tx, {
              chainKey: chain,
              contract: `0x${identity.runId === identities[0]?.runId ? "aa".repeat(20) : "bb".repeat(20)}`,
              chainId: 11155111,
              fromBlock: 1n,
              toBlock: 1n,
              endBlockHash: `0x${"12".repeat(32)}`,
              headBlock: 2n,
              policy: { confirmations: 1, reorgDepth: 2 },
              logsWritten: 0,
              logsIgnored: 0,
              reorgDetected: false,
              ownerId: null,
            });
          }),
        ),
      ),
    );
    const first = identities[0];
    if (first === undefined) throw new Error("missing run fixture");
    await withWorkerRun(first, () =>
      db.transaction((tx) =>
        tx.query(
          "INSERT INTO rail_attestation(transfer_id,route,status,last_checked_at) VALUES ($1,1,'pending',now())",
          [transferId],
        ),
      ),
    );
    const journals = await db.query(
      "SELECT contract,run_id::text FROM stellar_scan_journal WHERE chain_key=$1",
      [chain],
    );
    for (const row of journals.rows) expect(row.run_id).toBe(row.contract);
    const runs = (await readWorkerRuns(db)).filter((run) => run.executionId === executionId);
    expect(runs.every((run) => run.stellarScans === 1 && run.evmScans === 1)).toBe(true);
    expect(runs.find((run) => run.runId === first.runId)?.verificationTransitions).toBe(1);
    expect(
      (await db.query("SELECT status FROM rail_attestation WHERE transfer_id=$1", [transferId]))
        .rows[0]?.status,
    ).toBe("pending");
  });

  it("rolls back evidence links and clears transaction context before the pooled connection is reused", async () => {
    const first = identities[0];
    if (first === undefined) throw new Error("missing run fixture");
    await expect(
      withWorkerRun(first, () =>
        db.transaction(async (tx) => {
          await persistScanJournal(tx, "rolled-back", { chainKey: chain });
          await tx.query("UPDATE rail_attestation SET status='attested' WHERE transfer_id=$1", [
            transferId,
          ]);
          throw new Error("rollback correlated writes");
        }),
      ),
    ).rejects.toThrow("rollback correlated writes");
    await db.transaction((tx) => persistScanJournal(tx, "outside-worker", { chainKey: chain }));
    const journals = (
      await db.query("SELECT contract,run_id FROM stellar_scan_journal WHERE chain_key=$1", [chain])
    ).rows;
    expect(journals.some((row) => row.contract === "rolled-back")).toBe(false);
    expect(journals.find((row) => row.contract === "outside-worker")?.run_id).toBeNull();
    expect(
      (await db.query("SELECT status FROM rail_attestation WHERE transfer_id=$1", [transferId]))
        .rows[0]?.status,
    ).toBe("pending");
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM rail_attestation_history WHERE transfer_id=$1",
          [transferId],
        )
      ).rows[0]?.count,
    ).toBe(1);
  });
});
