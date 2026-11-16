import { afterEach, describe, expect, it } from "vitest";

import type { Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";
import {
  advanceCursorMonotonically,
  ConcurrencySafetyError,
  createAsyncBarrier,
  createDedicatedConcurrencyPGliteDb,
  createPgStateError,
  type DedicatedConcurrencyPGliteDb,
  PG_DEADLOCK_DETECTED,
  PG_LOCK_NOT_AVAILABLE,
  PG_SERIALIZATION_FAILURE,
  pgSqlState,
  resolveDedicatedConcurrencyDbConfig,
  runMultiWorkerConcurrencySuite,
  runWithConcurrencyRetry,
  tryAcquireTransactionalLease,
  verifyDeadlockAndLockTimeoutRecovery,
} from "../helpers.js";

/**
 * Multi-session transactional coordinator that keeps multiple transactions genuinely open at the
 * same wall-clock instant so advisory locks, lease rows, and monotonic cursor CAS clauses are
 * exercised while peer transactions have not yet committed.
 */
class OverlappingSessionPool implements Transactional {
  private readonly activeAdvisoryLocks = new Map<number, number>();
  private readonly leases = new Map<
    string,
    { holderId: string; acquiredAt: number; expiresAt: number; lockedByTx: number | null }
  >();
  private readonly cursors = new Map<
    string,
    { contract: string; lastProcessed: bigint; blockHash: string | null }
  >();
  private nextTxId = 1;

  query(text: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
    return this.executeInSession(0, text, params, false);
  }

  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    const txId = this.nextTxId;
    this.nextTxId += 1;

    const stagedLeases = new Map<
      string,
      { holderId: string; acquiredAt: number; expiresAt: number }
    >();
    const stagedCursors = new Map<
      string,
      { contract: string; lastProcessed: bigint; blockHash: string | null }
    >();
    const heldAdvisoryKeys = new Set<number>();

    const tx: Queryable = {
      query: (text: string, params: readonly unknown[] = []): Promise<QueryResultRows> => {
        if (text.includes("pg_try_advisory_xact_lock")) {
          const lockKey = Number(params[0]);
          const holder = this.activeAdvisoryLocks.get(lockKey);
          if (holder !== undefined && holder !== txId) {
            return Promise.resolve({ rows: [{ locked: false }], rowCount: 1 });
          }
          this.activeAdvisoryLocks.set(lockKey, txId);
          heldAdvisoryKeys.add(lockKey);
          return Promise.resolve({ rows: [{ locked: true }], rowCount: 1 });
        }

        if (text.includes("INSERT INTO worker_lease")) {
          const leaseKey = String(params[0]);
          const holderId = String(params[1]);
          const nowDate = params[2] instanceof Date ? params[2] : new Date(String(params[2]));
          const expDate = params[3] instanceof Date ? params[3] : new Date(String(params[3]));
          const current = this.leases.get(leaseKey);

          if (
            current?.lockedByTx !== null &&
            current !== undefined &&
            current.lockedByTx !== txId
          ) {
            throw createPgStateError(
              PG_LOCK_NOT_AVAILABLE,
              "could not obtain lock on row in relation worker_lease",
            );
          }

          if (
            current === undefined ||
            current.expiresAt <= nowDate.getTime() ||
            current.holderId === holderId
          ) {
            this.leases.set(leaseKey, {
              holderId: current?.holderId ?? holderId,
              acquiredAt: current?.acquiredAt ?? nowDate.getTime(),
              expiresAt: current?.expiresAt ?? expDate.getTime(),
              lockedByTx: txId,
            });
            stagedLeases.set(leaseKey, {
              holderId,
              acquiredAt: nowDate.getTime(),
              expiresAt: expDate.getTime(),
            });
            return Promise.resolve({ rows: [], rowCount: 1 });
          }
          return Promise.resolve({ rows: [], rowCount: 0 });
        }

        if (text.includes("INSERT INTO indexer_cursor")) {
          const chainKey = String(params[0]);
          const contract = String(params[2]);
          const nextBlock = BigInt(String(params[3]));
          const blockHash = typeof params[4] === "string" ? params[4] : null;
          const existing = stagedCursors.get(chainKey) ?? this.cursors.get(chainKey);

          if (existing === undefined) {
            stagedCursors.set(chainKey, { contract, lastProcessed: nextBlock, blockHash });
            return Promise.resolve({ rows: [], rowCount: 1 });
          }
          if (existing.contract === contract && existing.lastProcessed < nextBlock) {
            stagedCursors.set(chainKey, { contract, lastProcessed: nextBlock, blockHash });
            return Promise.resolve({ rows: [], rowCount: 1 });
          }
          return Promise.resolve({ rows: [], rowCount: 0 });
        }

        return this.executeInSession(txId, text, params, true);
      },
    };

    try {
      const value = await work(tx);
      for (const [key, lease] of stagedLeases.entries()) {
        this.leases.set(key, { ...lease, lockedByTx: null });
      }
      for (const [chainKey, cursor] of stagedCursors.entries()) {
        const latestCommitted = this.cursors.get(chainKey);
        if (latestCommitted === undefined || latestCommitted.lastProcessed < cursor.lastProcessed) {
          this.cursors.set(chainKey, cursor);
        }
      }
      return value;
    } catch (err) {
      for (const [key] of stagedLeases.entries()) {
        const entry = this.leases.get(key);
        if (entry?.lockedByTx === txId) {
          this.leases.delete(key);
        }
      }
      throw err;
    } finally {
      for (const key of heldAdvisoryKeys) {
        if (this.activeAdvisoryLocks.get(key) === txId) {
          this.activeAdvisoryLocks.delete(key);
        }
      }
    }
  }

  readCursor(chainKey: string): bigint | undefined {
    return this.cursors.get(chainKey)?.lastProcessed;
  }

  private executeInSession(
    _txId: number,
    _text: string,
    _params: readonly unknown[],
    _inTx: boolean,
  ): Promise<QueryResultRows> {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
}

describe("multi-worker PostgreSQL concurrency test runner", () => {
  const openDbs: DedicatedConcurrencyPGliteDb[] = [];

  afterEach(async () => {
    while (openDbs.length > 0) {
      const handle = openDbs.pop();
      if (handle !== undefined) {
        await handle.close();
      }
    }
  });

  it("observes lease and monotonic cursor conflicts across genuinely overlapping open transactions", async () => {
    const pool = new OverlappingSessionPool();
    const leaseBarrier = createAsyncBarrier(2);
    const now = new Date("2026-10-16T14:00:00.000Z");

    const [workerALeased, workerBLeased] = await Promise.all([
      pool.transaction(async (tx) => {
        const won = await tryAcquireTransactionalLease(
          tx,
          "watcher:sepolia",
          "worker-a",
          now,
          30_000,
          {
            useAdvisoryLockKey: 138_002,
          },
        );
        // Hold transaction open until worker-b has also entered its transaction and attempted the lock.
        await leaseBarrier.arrive();
        return won;
      }),
      pool.transaction(async (tx) => {
        const won = await tryAcquireTransactionalLease(
          tx,
          "watcher:sepolia",
          "worker-b",
          now,
          30_000,
          {
            useAdvisoryLockKey: 138_002,
          },
        );
        await leaseBarrier.arrive();
        return won;
      }),
    ]);

    expect([workerALeased, workerBLeased].filter(Boolean)).toHaveLength(1);
    expect([workerALeased, workerBLeased].filter((x) => !x)).toHaveLength(1);

    // Seed cursor at block 1050, then open two concurrent transactions where one tries a stale block 1040
    // and one advances to block 1060 while both transactions overlap at an async barrier.
    await pool.transaction(async (tx) => {
      const seeded = await advanceCursorMonotonically(tx, {
        chainKey: "sepolia",
        family: "evm",
        contract: "0x1111111111111111111111111111111111111111",
        nextBlock: 1050n,
        blockHash: "0xaaaa",
        processedAt: now,
      });
      expect(seeded.advanced).toBe(true);
    });

    const cursorBarrier = createAsyncBarrier(2);
    const [freshAdvance, staleAdvance] = await Promise.all([
      pool.transaction(async (tx) => {
        await cursorBarrier.arrive();
        return advanceCursorMonotonically(tx, {
          chainKey: "sepolia",
          family: "evm",
          contract: "0x1111111111111111111111111111111111111111",
          nextBlock: 1060n,
          blockHash: "0xbbbb",
          processedAt: new Date(now.getTime() + 5_000),
        });
      }),
      pool.transaction(async (tx) => {
        await cursorBarrier.arrive();
        return advanceCursorMonotonically(tx, {
          chainKey: "sepolia",
          family: "evm",
          contract: "0x1111111111111111111111111111111111111111",
          nextBlock: 1040n,
          blockHash: "0xcccc",
          processedAt: new Date(now.getTime() + 1_000),
        });
      }),
    ]);

    expect(freshAdvance.advanced).toBe(true);
    expect(staleAdvance.advanced).toBe(false);
    expect(pool.readCursor("sepolia")).toBe(1060n);
  });

  it("exercises competing watcher, rail, claim-settlement, and migration workers against a real PostgreSQL engine", async () => {
    const db = await createDedicatedConcurrencyPGliteDb();
    openDbs.push(db);

    const report = await runMultiWorkerConcurrencySuite(db);

    // 3 migration workers + 2 lease-acquiring watcher workers => 2 + 1 = 3 lease conflicts.
    expect(report.leaseConflicts).toBe(3);
    expect(report.migrationWinners).toBe(1);
    expect(report.migrationLeaseSkips).toBe(2);

    // Watchers attempt blocks 1020, 1015, 1020, 1025 => 1015 and duplicate 1020 fail monotonic CAS.
    expect(report.cursorConflicts).toBe(2);
    expect(report.finalCursorBlock).toBe("1025");

    // 4 competing watcher writes include duplicate (route=1, nonce=1) => replayable ingestion yields 3 unique transfers.
    expect(report.outboundCount).toBe(3);

    // 4 competing keeper claim-settlement workers race on claim #501 => exactly 1 winner and 3 conflicts.
    expect(report.claimSettlementWinners).toBe(1);
    expect(report.claimSettlementConflicts).toBe(3);
    expect(report.settledClaimCount).toBe(1);

    // 3 competing RailPass workers poll route=1 => 3 rail_attestation rows, ZERO marked 'delivered' from provider status alone.
    expect(report.railAttestationCount).toBe(3);
    expect(report.fakeDeliveredCount).toBe(0);

    // Verify integer-string precision and full-width Stellar destination strkey integrity.
    const { rows } = await db.query(
      "SELECT gross_amount::text AS gross, net_amount::text AS net, destination FROM outbound_transfer ORDER BY nonce ASC",
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]?.gross).toBe("10010000");
    expect(rows[0]?.net).toBe("10000000");
    expect(String(rows[0]?.destination)).toMatch(/^G[A-Z2-7]{55}$/);
  });

  it("recovers from 40P01 deadlock, 55P03 lock-timeout, and 40001 serialization failures with clean rollback", async () => {
    const db = await createDedicatedConcurrencyPGliteDb();
    openDbs.push(db);

    const recovery = await verifyDeadlockAndLockTimeoutRecovery(db);
    expect(recovery.deadlocksRecovered).toBe(1);
    expect(recovery.lockTimeoutsRecovered).toBe(2);
    expect(recovery.leakedDirtyRows).toBe(0);
    expect(recovery.finalTransferGross).toBe("75075000");
    expect(recovery.finalTransferNet).toBe("75000000");
    expect(PG_DEADLOCK_DETECTED).toBe("40P01");

    // Also check 40001 serialization retry, non-retryable pass-through, and maxAttempts exhaustion.
    let serCount = 0;
    const serResult = await runWithConcurrencyRetry(
      (attempt) => {
        serCount += 1;
        if (attempt === 1) {
          return Promise.reject(
            createPgStateError(
              PG_SERIALIZATION_FAILURE,
              "could not serialize access due to concurrent update",
            ),
          );
        }
        return Promise.resolve("ok-serialized");
      },
      { baseDelayMs: 0 },
    );
    expect(serCount).toBe(2);
    expect(serResult.result).toBe("ok-serialized");
    expect(serResult.telemetry.serializationFailuresRecovered).toBe(1);

    // Non-retryable SQL state (23514 check violation) must fail immediately on attempt 1.
    let checkAttempts = 0;
    await expect(
      runWithConcurrencyRetry(
        () => {
          checkAttempts += 1;
          return Promise.reject(createPgStateError("23514", "new row violates check constraint"));
        },
        { baseDelayMs: 0 },
      ),
    ).rejects.toSatisfy((err: unknown) => pgSqlState(err) === "23514");
    expect(checkAttempts).toBe(1);

    // Persistent lock-timeout exhausts maxAttempts cleanly.
    let lockAttempts = 0;
    await expect(
      runWithConcurrencyRetry(
        () => {
          lockAttempts += 1;
          return Promise.reject(createPgStateError(PG_LOCK_NOT_AVAILABLE, "lock timeout"));
        },
        { maxAttempts: 3, baseDelayMs: 0 },
      ),
    ).rejects.toSatisfy((err: unknown) => pgSqlState(err) === PG_LOCK_NOT_AVAILABLE);
    expect(lockAttempts).toBe(3);
  });

  it("refuses production or shared primary database targets without explicit separate test configuration and redacts credentials", () => {
    const primaryUrl = [
      "postgres",
      "://",
      "app_user",
      ":",
      "app_pw_placeholder",
      "@127.0.0.1:5432/hyperion",
    ].join("");
    const sameTargetImplicitPort = [
      "postgresql",
      "://",
      "runner",
      ":",
      "runner_pw_placeholder",
      "@127.0.0.1/hyperion",
    ].join("");
    const prodHostUrl = [
      "postgres",
      "://",
      "admin_role",
      ":",
      "sensitive_secret_token",
      "@cluster.rds.amazonaws.com:5432/hyperion_test",
    ].join("");
    const nonTestDbNameUrl = [
      "postgres",
      "://",
      "admin_role",
      ":",
      "sensitive_secret_token",
      "@127.0.0.1:5433/hyperion_core",
    ].join("");
    const validDedicatedTestUrl = [
      "postgres",
      "://",
      "tester",
      ":",
      "ephemeral_pw",
      "@127.0.0.1:5433/hyperion_concurrency_test",
    ].join("");

    // 1. Never falls back to DATABASE_URL or unapproved TEST_DATABASE_URL.
    expect(() =>
      resolveDedicatedConcurrencyDbConfig({
        NODE_ENV: "test",
        DATABASE_URL: primaryUrl,
        TEST_DATABASE_URL: validDedicatedTestUrl,
      }),
    ).toThrow(ConcurrencySafetyError);

    // 2. Blocks NODE_ENV=production and HYPERION_NETWORK=mainnet by default.
    expect(() =>
      resolveDedicatedConcurrencyDbConfig({
        NODE_ENV: "production",
        HYPERION_CONCURRENCY_TEST_DB_URL: validDedicatedTestUrl,
      }),
    ).toThrow(/NODE_ENV=production/);

    expect(() =>
      resolveDedicatedConcurrencyDbConfig({
        NODE_ENV: "test",
        HYPERION_NETWORK: "mainnet",
        HYPERION_CONCURRENCY_TEST_DB_URL: validDedicatedTestUrl,
      }),
    ).toThrow(/HYPERION_NETWORK=mainnet/);

    // 3. Blocks pointing HYPERION_CONCURRENCY_TEST_DB_URL at the same host:port/db as DATABASE_URL.
    expect(() =>
      resolveDedicatedConcurrencyDbConfig({
        NODE_ENV: "test",
        DATABASE_URL: primaryUrl,
        HYPERION_CONCURRENCY_TEST_DB_URL: sameTargetImplicitPort,
      }),
    ).toThrow(/same database as DATABASE_URL/);

    // 4. Blocks production-shaped hosts (RDS, Neon, Supabase, *.prod.*) and non-test DB names by default,
    //    and redacts embedded credentials in error output.
    let thrownMessage = "";
    try {
      resolveDedicatedConcurrencyDbConfig({
        NODE_ENV: "test",
        DATABASE_URL: primaryUrl,
        HYPERION_CONCURRENCY_TEST_DB_URL: prodHostUrl,
      });
    } catch (err) {
      thrownMessage = err instanceof Error ? err.message : String(err);
    }
    expect(thrownMessage).toContain("HYPERION_CONCURRENCY_CONFIRM_EXTERNAL_TEST_DB=true");
    expect(thrownMessage).not.toContain("sensitive_secret_token");
    expect(thrownMessage).not.toContain("admin_role");
    expect(thrownMessage).toContain("%5Bredacted%5D");

    expect(() =>
      resolveDedicatedConcurrencyDbConfig({
        NODE_ENV: "test",
        DATABASE_URL: primaryUrl,
        HYPERION_CONCURRENCY_TEST_DB_URL: nonTestDbNameUrl,
      }),
    ).toThrow(/HYPERION_CONCURRENCY_CONFIRM_EXTERNAL_TEST_DB=true/);

    // 5. Rejects invalid SQL schema names and unsupported protocols.
    expect(() =>
      resolveDedicatedConcurrencyDbConfig({
        NODE_ENV: "test",
        HYPERION_CONCURRENCY_TEST_DB_URL: validDedicatedTestUrl,
        HYPERION_CONCURRENCY_SCHEMA: "bad-schema; DROP TABLE outbound_transfer",
      }),
    ).toThrow(/Invalid PostgreSQL schema identifier/);

    expect(() =>
      resolveDedicatedConcurrencyDbConfig({
        NODE_ENV: "test",
        HYPERION_CONCURRENCY_TEST_DB_URL: "http://127.0.0.1:5433/hyperion_test",
      }),
    ).toThrow(/Unsupported database protocol/);

    // 6. Accepts an explicit separate dedicated test database configuration and redacts sanitizedTarget.
    const resolved = resolveDedicatedConcurrencyDbConfig({
      NODE_ENV: "test",
      HYPERION_NETWORK: "testnet",
      DATABASE_URL: primaryUrl,
      HYPERION_CONCURRENCY_TEST_DB_URL: validDedicatedTestUrl,
    });
    expect(resolved.connectionString).toBe(validDedicatedTestUrl);
    expect(resolved.schemaName).toBe("hyperion_concurrency_test");
    expect(resolved.sanitizedTarget).not.toContain("ephemeral_pw");
    expect(resolved.sanitizedTarget).toContain("127.0.0.1:5433/hyperion_concurrency_test");
  });
});
