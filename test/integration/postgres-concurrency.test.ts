/**
 * Multi-worker PostgreSQL concurrency suite against a dedicated multi-connection Postgres server.
 *
 * Requires an explicit separate database URL via `HYPERION_CONCURRENCY_TEST_DB_URL` (or
 * `TEST_DATABASE_URL` accompanied by `HYPERION_ALLOW_TEST_DATABASE_CONCURRENCY=true`) so the
 * stress runner never touches a primary or production database without explicit configuration.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "../../src/db/pool.js";
import {
  createAsyncBarrier,
  type DedicatedConcurrencyDbConfig,
  openDedicatedConcurrencyDatabase,
  PG_DEADLOCK_DETECTED,
  PG_LOCK_NOT_AVAILABLE,
  pgSqlState,
  runMultiWorkerConcurrencySuite,
  runWithConcurrencyRetry,
} from "../helpers.js";

const DEDICATED_CONCURRENCY_URL =
  process.env.HYPERION_CONCURRENCY_TEST_DB_URL ??
  (process.env.HYPERION_ALLOW_TEST_DATABASE_CONCURRENCY === "true"
    ? process.env.TEST_DATABASE_URL
    : undefined);

const suite = DEDICATED_CONCURRENCY_URL === undefined ? describe.skip : describe;

suite("multi-worker PostgreSQL concurrency against dedicated database", () => {
  let db: Database;
  let config: DedicatedConcurrencyDbConfig;

  beforeAll(async () => {
    const opened = await openDedicatedConcurrencyDatabase(process.env);
    db = opened.db;
    config = opened.config;
  });

  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${config.schemaName} CASCADE`);
    await db.close();
  });

  it("observes lease, cursor, and claim-settlement conflicts across pooled backend connections", async () => {
    const report = await runMultiWorkerConcurrencySuite(db, {
      multiSessionAdvisoryLocks: true,
    });

    expect(report.leaseConflicts).toBeGreaterThanOrEqual(2);
    expect(report.cursorConflicts).toBeGreaterThanOrEqual(1);
    expect(report.migrationWinners).toBe(1);
    expect(report.migrationLeaseSkips).toBe(2);
    expect(report.claimSettlementWinners).toBe(1);
    expect(report.claimSettlementConflicts).toBe(3);
    expect(report.finalCursorBlock).toBe("1025");
    expect(report.outboundCount).toBe(3);
    expect(report.railAttestationCount).toBe(3);
    expect(report.fakeDeliveredCount).toBe(0);
    expect(report.settledClaimCount).toBe(1);
  });

  it("recovers from live two-connection 55P03 lock-timeout and 40P01 deadlock errors cleanly", async () => {
    const now = new Date("2026-10-16T16:00:00.000Z");
    const later = new Date("2026-10-16T16:05:00.000Z");
    await db.query(
      `INSERT INTO worker_lease (lease_key, holder_id, acquired_at, expires_at)
       VALUES ('live-lock-a', 'seed', $1, $2),
              ('live-lock-b', 'seed', $1, $2)
       ON CONFLICT (lease_key) DO UPDATE SET holder_id = 'seed'`,
      [now, later],
    );

    // 1. Live 55P03 lock-timeout across two simultaneous transactions:
    const lockEntered = createAsyncBarrier(2);
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });

    const holderTask = db.transaction(async (tx) => {
      await tx.query(
        "SELECT holder_id FROM worker_lease WHERE lease_key = 'live-lock-a' FOR UPDATE",
      );
      await lockEntered.arrive();
      await holderGate;
      await tx.query(
        "UPDATE worker_lease SET holder_id = 'holder-done' WHERE lease_key = 'live-lock-a'",
      );
    });

    const contenderTask = runWithConcurrencyRetry(
      async (attempt) =>
        db.transaction(async (tx) => {
          await tx.query("SET LOCAL lock_timeout = '25ms'");
          if (attempt === 1) {
            await lockEntered.arrive();
          }
          try {
            await tx.query(
              "UPDATE worker_lease SET holder_id = 'contender-won' WHERE lease_key = 'live-lock-a'",
            );
          } catch (err) {
            if (pgSqlState(err) === PG_LOCK_NOT_AVAILABLE) {
              releaseHolder();
            }
            throw err;
          }
          return "updated-after-lock-timeout";
        }),
      { maxAttempts: 5, baseDelayMs: 15 },
    );

    const [, contenderOutcome] = await Promise.all([holderTask, contenderTask]);
    expect(contenderOutcome.telemetry.lockTimeoutsRecovered).toBeGreaterThanOrEqual(1);

    // 2. Live 40P01 deadlock across two simultaneous transactions acquiring locks in opposite order:
    const deadlockBarrier = createAsyncBarrier(2);
    const workerOne = runWithConcurrencyRetry(
      async (attempt) =>
        db.transaction(async (tx) => {
          await tx.query("SET LOCAL deadlock_timeout = '20ms'");
          await tx.query(
            "UPDATE worker_lease SET holder_id = 'w1-a' WHERE lease_key = 'live-lock-a'",
          );
          if (attempt === 1) {
            await deadlockBarrier.arrive();
          }
          await tx.query(
            "UPDATE worker_lease SET holder_id = 'w1-b' WHERE lease_key = 'live-lock-b'",
          );
        }),
      { maxAttempts: 5, baseDelayMs: 15 },
    );

    const workerTwo = runWithConcurrencyRetry(
      async (attempt) =>
        db.transaction(async (tx) => {
          await tx.query("SET LOCAL deadlock_timeout = '20ms'");
          await tx.query(
            "UPDATE worker_lease SET holder_id = 'w2-b' WHERE lease_key = 'live-lock-b'",
          );
          if (attempt === 1) {
            await deadlockBarrier.arrive();
          }
          await tx.query(
            "UPDATE worker_lease SET holder_id = 'w2-a' WHERE lease_key = 'live-lock-a'",
          );
        }),
      { maxAttempts: 5, baseDelayMs: 15 },
    );

    const [outOne, outTwo] = await Promise.all([workerOne, workerTwo]);
    const totalDeadlocks =
      outOne.telemetry.deadlocksRecovered + outTwo.telemetry.deadlocksRecovered;
    expect(totalDeadlocks).toBeGreaterThanOrEqual(1);
    expect(PG_DEADLOCK_DETECTED).toBe("40P01");

    const { rows } = await db.query(
      "SELECT lease_key, holder_id FROM worker_lease WHERE lease_key IN ('live-lock-a', 'live-lock-b') ORDER BY lease_key",
    );
    expect(rows).toHaveLength(2);
  });
});
