import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAINTENANCE_JOBS,
  acquireMaintenanceLease,
  executeAttestationRetentionBatch,
  getMaintenanceLease,
  releaseMaintenanceLease,
  runAttestationRetentionJob,
  runRouteHealthRetentionJob,
  settleClaim,
  writeAction,
  writeClaim,
  writeHealthSample,
  writeInbound,
  writeOutbound,
} from "../../src/chains/writers.js";
import type { QueryResultRows, Queryable, Transactional } from "../../src/db/pool.js";
import { startMaintenanceTask } from "../../src/db/pool.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

function createPgliteTransactional(pg: PGlite): Transactional {
  const normalizeParams = (params: readonly unknown[]): unknown[] =>
    params.map((param) => (typeof param === "bigint" ? param.toString() : param));

  const mapRows = (
    fields: readonly { readonly name: string; readonly dataTypeID: number }[],
    rawRows: readonly unknown[],
  ): Record<string, unknown>[] => {
    const int8Columns = fields
      .filter((field) => field.dataTypeID === 20)
      .map((field) => field.name);
    return rawRows.map((raw) => {
      const copy = { ...(raw as Record<string, unknown>) };
      for (const column of int8Columns) {
        const value = copy[column];
        if (typeof value === "number" || typeof value === "bigint") {
          copy[column] = String(value);
        }
      }
      return copy;
    });
  };

  const query = async (sql: string, params: readonly unknown[] = []): Promise<QueryResultRows> => {
    const result = await pg.query(sql, normalizeParams(params));
    return {
      rows: mapRows(result.fields, result.rows),
      rowCount: result.affectedRows ?? result.rows.length,
    };
  };

  return {
    query,
    async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      return pg.transaction(async (pgTx) => {
        const wrappedTx: Queryable = {
          async query(sql: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
            const result = await pgTx.query(sql, normalizeParams(params));
            return {
              rows: mapRows(result.fields, result.rows),
              rowCount: result.affectedRows ?? result.rows.length,
            };
          },
        };
        return work(wrappedTx);
      });
    },
  };
}

function loadAllUpMigrations(): readonly { readonly name: string; readonly upSql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => {
      const content = readFileSync(
        fileURLToPath(new URL(`../../migrations/${name}`, import.meta.url)),
        "utf8",
      );
      return {
        name,
        upSql: content.split("-- Down Migration")[0]!,
      };
    });
}

describe("database maintenance scheduling with ownership leases", () => {
  let pg: PGlite;
  let db: Transactional;
  const baseNow = new Date("2026-06-01T12:00:00.000Z");

  beforeEach(async () => {
    pg = new PGlite();
    db = createPgliteTransactional(pg);
    for (const migration of loadAllUpMigrations()) {
      await pg.exec(migration.upSql);
    }
  });

  afterEach(async () => {
    vi.useRealTimers();
    await pg.close();
  });

  it("applies migrations cleanly without duplicating cursor autovacuum tuning", () => {
    const migrations = loadAllUpMigrations();
    const cursorMigrations = migrations.filter((entry) =>
      /ALTER\s+TABLE\s+indexer_cursor\s+SET\s*\(/i.test(entry.upSql),
    );
    expect(cursorMigrations.map((entry) => entry.name)).toEqual([
      "1791100000000_cursor-autovacuum-tuning.sql",
    ]);
  });

  it("prevents concurrent workers from acquiring or running conflicting cleanup batches", async () => {
    await db.query(
      `INSERT INTO outbound_transfer
         (id, origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
          destination_chain, destination, origin_block, origin_tx)
       VALUES (101, 'stellar-testnet', 0, 1, 'Gsender', 'USDC', 1000, 0, 1000, 'sepolia', '0xdest', 10, 'tx-101'),
              (102, 'stellar-testnet', 0, 2, 'Gsender', 'USDC', 1000, 0, 1000, 'sepolia', '0xdest', 11, 'tx-102')`,
    );
    const fortyDaysAgo = new Date(baseNow.getTime() - 40 * 86_400_000);
    await db.query(
      `INSERT INTO rail_attestation (transfer_id, route, status, updated_at, last_checked_at)
       VALUES (101, 0, 'delivered', $1, $1),
              (102, 0, 'delivered', $1, $1)`,
      [fortyDaysAgo],
    );

    const leaseA = await acquireMaintenanceLease(db, {
      jobName: MAINTENANCE_JOBS.railAttestationRetention,
      ownerId: "worker-a",
      leaseDurationMs: 60_000,
      now: baseNow,
    });
    expect(leaseA.acquired).toBe(true);
    if (!leaseA.acquired) throw new Error("worker-a failed to acquire lease");
    expect(leaseA.lease.fenceToken).toBe(1n);

    // Worker B attempts a full job run while Worker A holds the lease.
    const blockedRunB = await runAttestationRetentionJob(db, {
      ownerId: "worker-b",
      olderThanDays: 30,
      now: () => new Date(baseNow.getTime() + 5_000),
    });
    expect(blockedRunB.acquired).toBe(false);
    expect(blockedRunB.deletedCount).toBe(0);
    expect(blockedRunB.batchesRun).toBe(0);

    // Simulate Worker A stalling past lease expiry; Worker B takes over with fence token 2.
    const afterExpiry = new Date(baseNow.getTime() + 65_000);
    const leaseB = await acquireMaintenanceLease(db, {
      jobName: MAINTENANCE_JOBS.railAttestationRetention,
      ownerId: "worker-b",
      leaseDurationMs: 60_000,
      now: afterExpiry,
    });
    expect(leaseB.acquired).toBe(true);
    if (!leaseB.acquired) throw new Error("worker-b failed to acquire expired lease");
    expect(leaseB.lease.fenceToken).toBe(2n);

    // Delayed Worker A tries to execute a batch with its stale fence token 1 and is fenced off.
    const staleBatchA = await executeAttestationRetentionBatch(db, {
      jobName: MAINTENANCE_JOBS.railAttestationRetention,
      ownerId: "worker-a",
      fenceToken: leaseA.lease.fenceToken,
      olderThanDays: 30,
      batchSize: 10,
      now: new Date(afterExpiry.getTime() + 1_000),
    });
    expect(staleBatchA.leaseLost).toBe(true);
    expect(staleBatchA.deletedCount).toBe(0);

    // Stale Worker A also cannot release Worker B's active lease.
    const staleRelease = await releaseMaintenanceLease(db, {
      jobName: MAINTENANCE_JOBS.railAttestationRetention,
      ownerId: "worker-a",
      fenceToken: leaseA.lease.fenceToken,
      now: new Date(afterExpiry.getTime() + 2_000),
    });
    expect(staleRelease).toBe(false);

    // Worker B executes with fence token 2 and cleanly prunes both eligible rows.
    const validBatchB = await executeAttestationRetentionBatch(db, {
      jobName: MAINTENANCE_JOBS.railAttestationRetention,
      ownerId: "worker-b",
      fenceToken: leaseB.lease.fenceToken,
      olderThanDays: 30,
      batchSize: 10,
      now: new Date(afterExpiry.getTime() + 3_000),
    });
    expect(validBatchB.leaseLost).toBe(false);
    expect(validBatchB.deletedCount).toBe(2);
    expect(validBatchB.hasMore).toBe(false);
  });

  it("respects active transactions, unsettled claims, route readiness, and provenance tables", async () => {
    const fortyFiveDaysAgo = new Date(baseNow.getTime() - 45 * 86_400_000);
    const fiveDaysAgo = new Date(baseNow.getTime() - 5 * 86_400_000);

    // Seed 6 departures across lifecycle states.
    for (let nonce = 1n; nonce <= 6n; nonce += 1n) {
      await writeOutbound(
        db,
        {
          chainKey: "stellar-testnet",
          block: 100n + nonce,
          txHash: `origin-tx-${nonce.toString()}`,
          logIndex: null,
          observedAt: fortyFiveDaysAgo,
        },
        {
          route: 0,
          nonce,
          sender: "Gsender",
          token: "USDC",
          grossAmount: 10_000n,
          fee: 100n,
          netAmount: 9_900n,
          destinationChain: "sepolia",
          destination: "0x0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38",
          railRef: `ref-${nonce.toString()}`,
        },
      );
    }

    const { rows: transferRows } = await db.query(
      "SELECT id, nonce FROM outbound_transfer ORDER BY nonce ASC",
    );
    const idByNonce = new Map<number, number>(
      transferRows.map((row) => [Number(row.nonce), Number(row.id)]),
    );

    // Nonce 1: delivered and aged with inbound provenance -> eligible.
    await writeInbound(
      db,
      {
        chainKey: "sepolia",
        block: 501n,
        txHash: "dest-tx-1",
        logIndex: 0,
        observedAt: fortyFiveDaysAgo,
      },
      {
        route: 0,
        sourceChain: "stellar-testnet",
        sourceNonce: 1n,
        railMessageId: "0xmsg-1",
        recipient: "0x6ef8032ffe4943f27388172549f6700f18bb8b38",
        token: "0xusdc",
        amount: 9_900n,
        delivered: true,
        claimId: null,
      },
    );

    // Nonce 2: attestation marked delivered 45 days ago, but destination funds parked in unsettled claim 77 -> MUST NOT prune!
    await writeInbound(
      db,
      {
        chainKey: "sepolia",
        block: 502n,
        txHash: "dest-tx-2",
        logIndex: 0,
        observedAt: fortyFiveDaysAgo,
      },
      {
        route: 0,
        sourceChain: "stellar-testnet",
        sourceNonce: 2n,
        railMessageId: "0xmsg-2",
        recipient: "0x6ef8032ffe4943f27388172549f6700f18bb8b38",
        token: "0xusdc",
        amount: 9_900n,
        delivered: false,
        claimId: 77n,
      },
    );
    await writeClaim(
      db,
      {
        chainKey: "sepolia",
        block: 502n,
        txHash: "dest-tx-2",
        logIndex: 1,
        observedAt: fortyFiveDaysAgo,
      },
      {
        claimId: 77n,
        recipient: "0x6ef8032ffe4943f27388172549f6700f18bb8b38",
        token: "0xusdc",
        amount: 9_900n,
        route: 0,
        sourceChain: "stellar-testnet",
        sourceNonce: 2n,
        createdAt: fortyFiveDaysAgo,
      },
    );

    // Nonce 3: active pending attestation (45 days old) -> MUST NOT prune.
    // Nonce 4: active attested attestation (45 days old) -> MUST NOT prune.
    // Nonce 5: failed attestation diagnostic (45 days old) -> MUST NOT prune.
    // Nonce 6: delivered recently (5 days old) with inbound provenance -> MUST NOT prune.
    await writeInbound(
      db,
      {
        chainKey: "sepolia",
        block: 506n,
        txHash: "dest-tx-6",
        logIndex: 0,
        observedAt: fiveDaysAgo,
      },
      {
        route: 0,
        sourceChain: "stellar-testnet",
        sourceNonce: 6n,
        railMessageId: "0xmsg-6",
        recipient: "0x6ef8032ffe4943f27388172549f6700f18bb8b38",
        token: "0xusdc",
        amount: 9_900n,
        delivered: true,
        claimId: null,
      },
    );

    await db.query(
      `INSERT INTO rail_attestation (transfer_id, route, status, updated_at, last_checked_at, last_error)
       VALUES ($1, 0, 'delivered', $7, $7, NULL),
              ($2, 0, 'delivered', $7, $7, NULL),
              ($3, 0, 'pending',   $7, $7, NULL),
              ($4, 0, 'attested',  $7, $7, NULL),
              ($5, 0, 'failed',    $7, $7, 'mismatch'),
              ($6, 0, 'delivered', $8, $8, NULL)`,
      [
        idByNonce.get(1)!,
        idByNonce.get(2)!,
        idByNonce.get(3)!,
        idByNonce.get(4)!,
        idByNonce.get(5)!,
        idByNonce.get(6)!,
        fortyFiveDaysAgo,
        fiveDaysAgo,
      ],
    );

    // Seed governance provenance and route health samples.
    await writeAction(
      db,
      {
        chainKey: "stellar-testnet",
        block: 90n,
        txHash: "gov-tx-1",
        logIndex: null,
        observedAt: fortyFiveDaysAgo,
      },
      {
        actionId: 1n,
        kind: 0,
        payload: { action: "pause" },
        eta: fortyFiveDaysAgo,
        expiresAt: null,
      },
    );

    // Route A has two old samples (only the older one may be pruned; latest sample must remain).
    await writeHealthSample(
      db,
      {
        chainKey: "stellar-testnet",
        block: 80n,
        txHash: "h-1",
        logIndex: null,
        observedAt: new Date(baseNow.getTime() - 30 * 86_400_000),
      },
      {
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        route: 0,
        token: "USDC",
        available: true,
        blocker: 0,
        flowAvailable: 500_000n,
      },
    );
    await writeHealthSample(
      db,
      {
        chainKey: "stellar-testnet",
        block: 81n,
        txHash: "h-2",
        logIndex: null,
        observedAt: new Date(baseNow.getTime() - 20 * 86_400_000),
      },
      {
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        route: 0,
        token: "USDC",
        available: true,
        blocker: 0,
        flowAvailable: 600_000n,
      },
    );

    const attResult = await runAttestationRetentionJob(db, {
      ownerId: "worker-1",
      olderThanDays: 30,
      requireInboundProvenance: true,
      now: () => baseNow,
    });
    expect(attResult.deletedCount).toBe(1);
    expect(attResult.completed).toBe(true);

    const { rows: remainingAttestations } = await db.query(
      "SELECT transfer_id FROM rail_attestation ORDER BY transfer_id ASC",
    );
    expect(remainingAttestations.map((r) => Number(r.transfer_id))).toEqual([
      idByNonce.get(2)!,
      idByNonce.get(3)!,
      idByNonce.get(4)!,
      idByNonce.get(5)!,
      idByNonce.get(6)!,
    ]);

    const healthResult = await runRouteHealthRetentionJob(db, {
      ownerId: "worker-1",
      olderThanDays: 14,
      now: () => baseNow,
    });
    expect(healthResult.deletedCount).toBe(1);
    const { rows: remainingHealth } = await db.query(
      "SELECT flow_available FROM route_health ORDER BY id ASC",
    );
    expect(remainingHealth.map((r) => String(r.flow_available))).toEqual(["600000"]);

    // Verify zero provenance or monetary records were touched.
    const outboundCount = await db.query("SELECT count(*)::integer AS cnt FROM outbound_transfer");
    const inboundCount = await db.query("SELECT count(*)::integer AS cnt FROM inbound_delivery");
    const claimCount = await db.query("SELECT count(*)::integer AS cnt FROM pending_claim");
    const actionCount = await db.query("SELECT count(*)::integer AS cnt FROM admin_action");
    expect(outboundCount.rows[0]?.cnt).toBe(6);
    expect(inboundCount.rows[0]?.cnt).toBe(3);
    expect(claimCount.rows[0]?.cnt).toBe(1);
    expect(actionCount.rows[0]?.cnt).toBe(1);

    // Once claim 77 settles, nonce 2 becomes eligible when requireInboundProvenance is false.
    await settleClaim(
      db,
      {
        chainKey: "sepolia",
        block: 600n,
        txHash: "settle-tx-77",
        logIndex: 0,
        observedAt: baseNow,
      },
      77n,
      "0xkeeper",
    );
    const postSettleResult = await runAttestationRetentionJob(db, {
      ownerId: "worker-1",
      olderThanDays: 30,
      requireInboundProvenance: false,
      now: () => baseNow,
    });
    expect(postSettleResult.deletedCount).toBe(1);
  });

  it("resumes interrupted jobs from the durable batch boundary and rolls back failed batches atomically", async () => {
    const fortyDaysAgo = new Date(baseNow.getTime() - 40 * 86_400_000);
    const eligibleIds = [10, 20, 30, 40, 50, 60, 70];
    for (const id of eligibleIds) {
      await db.query(
        `INSERT INTO outbound_transfer
           (id, origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
            destination_chain, destination, origin_block, origin_tx)
         VALUES ($1::bigint, 'stellar-testnet', 0, $2::numeric, 'Gsender', 'USDC', 500, 0, 500, 'sepolia', '0xdest', $2::numeric, $3)`,
        [id, String(id), `tx-${id}`],
      );
      await db.query(
        `INSERT INTO rail_attestation (transfer_id, route, status, updated_at, last_checked_at)
         VALUES ($1, 0, 'delivered', $2, $2)`,
        [id, fortyDaysAgo],
      );
    }

    // Run 1: bounded to 2 batches of size 2 -> prunes [10, 20] and [30, 40], persists resume_cursor = 40.
    const firstRun = await runAttestationRetentionJob(db, {
      ownerId: "worker-a",
      olderThanDays: 30,
      batchSize: 2,
      maxBatches: 2,
      now: () => baseNow,
    });
    expect(firstRun.acquired).toBe(true);
    expect(firstRun.completed).toBe(false);
    expect(firstRun.interrupted).toBe(true);
    expect(firstRun.batchesRun).toBe(2);
    expect(firstRun.deletedCount).toBe(4);
    expect(firstRun.resumeCursor).toBe(40n);

    const checkpointAfterRun1 = await getMaintenanceLease(
      db,
      MAINTENANCE_JOBS.railAttestationRetention,
    );
    expect(checkpointAfterRun1?.resumeCursor).toBe(40n);
    expect(checkpointAfterRun1?.ownerId).toBeNull();
    expect(checkpointAfterRun1?.batchesCompleted).toBe(2n);
    expect(checkpointAfterRun1?.rowsPruned).toBe(4n);

    // Fault-injected Run 2: Batch 0 commits [50, 60] (cursor = 60), Batch 1 throws before commit and rolls back [70].
    await expect(
      runAttestationRetentionJob(db, {
        ownerId: "worker-b",
        olderThanDays: 30,
        batchSize: 2,
        maxBatches: 5,
        now: () => new Date(baseNow.getTime() + 1_000),
        onBeforeBatchCommit: (_tx, batchIndex) => {
          if (batchIndex === 1) {
            throw new Error("simulated connection drop before commit");
          }
        },
      }),
    ).rejects.toThrow("simulated connection drop before commit");

    const checkpointAfterCrash = await getMaintenanceLease(
      db,
      MAINTENANCE_JOBS.railAttestationRetention,
    );
    expect(checkpointAfterCrash?.resumeCursor).toBe(60n);
    expect(checkpointAfterCrash?.rowsPruned).toBe(6n);

    const { rows: afterCrashRows } = await db.query(
      "SELECT transfer_id FROM rail_attestation ORDER BY transfer_id ASC",
    );
    expect(afterCrashRows.map((r) => Number(r.transfer_id))).toEqual([70]);

    // Run 3: Worker C resumes cleanly from cursor 60, prunes [70], and resets cursor to 0.
    const finalRun = await runAttestationRetentionJob(db, {
      ownerId: "worker-c",
      olderThanDays: 30,
      batchSize: 2,
      maxBatches: 5,
      now: () => new Date(baseNow.getTime() + 2_000),
    });
    expect(finalRun.completed).toBe(true);
    expect(finalRun.interrupted).toBe(false);
    expect(finalRun.deletedCount).toBe(1);
    expect(finalRun.resumeCursor).toBe(0n);

    const completedLease = await getMaintenanceLease(db, MAINTENANCE_JOBS.railAttestationRetention);
    expect(completedLease?.resumeCursor).toBe(0n);
    expect(completedLease?.rowsPruned).toBe(7n);
    expect(completedLease?.lastCompletedAt).not.toBeNull();
  });

  it("prevents overlapping scheduled ticks and cancels cleanly via startMaintenanceTask", async () => {
    vi.useFakeTimers();
    let resolveInFlight: (() => void) | undefined;
    let calls = 0;

    const fakeDb = {
      runMaintenanceCycle: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            calls += 1;
            resolveInFlight = () => {
              resolve({
                attestations: {
                  jobName: MAINTENANCE_JOBS.railAttestationRetention,
                  ownerId: "scheduler",
                  acquired: true,
                  completed: true,
                  interrupted: false,
                  leaseLost: false,
                  fenceToken: 1n,
                  batchesRun: 1,
                  deletedCount: 2,
                  resumeCursor: 0n,
                },
                routeHealth: {
                  jobName: MAINTENANCE_JOBS.routeHealthRetention,
                  ownerId: "scheduler",
                  acquired: true,
                  completed: true,
                  interrupted: false,
                  leaseLost: false,
                  fenceToken: 1n,
                  batchesRun: 1,
                  deletedCount: 0,
                  resumeCursor: 0n,
                },
              });
            };
          }),
      ),
    };

    const infoLogs: unknown[] = [];
    const stop = startMaintenanceTask(fakeDb, {
      intervalMs: 1_000,
      olderThanDays: 30,
      batchSize: 50,
      logger: {
        info: (obj) => {
          infoLogs.push(obj);
        },
      },
    });

    await vi.advanceTimersByTimeAsync(3_500);
    // Only 1 call may be in-flight while the previous cycle has not settled.
    expect(calls).toBe(1);

    resolveInFlight?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(infoLogs).toHaveLength(1);

    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toBe(1);
  });
});
