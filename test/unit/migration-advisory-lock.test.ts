import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import {
  MigrationLockInterruptedError,
  MigrationLockTimeoutError,
  ReadOnlyInstanceMigrationError,
  deriveMigrationAdvisoryLockKeys,
  inspectMigrationStatusReadOnly,
  loadSqlMigrationSteps,
  redactMigrationSecretText,
  runMigrationCli,
  runSerializedMigrations,
  withMigrationAdvisoryLock,
} from "../../src/db/migration-lock.js";
import type {
  AdvisoryLockSessionClient,
  AdvisoryLockSessionSource,
  MigrationFileStep,
} from "../../src/db/migration-lock.js";
import { Database, ReadOnlyDatabaseError } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

/**
 * Multi-session PostgreSQL test harness backed by PGlite SQL execution plus authentic per-session
 * advisory lock ownership (`sessionId -> lockKey`), reproducing multi-process PostgreSQL session
 * semantics including automatic lock release when a session disconnects/destroys.
 */
class MultiSessionPgliteCluster implements AdvisoryLockSessionSource {
  private nextSessionId = 1;
  private readonly owners = new Map<string, number>();
  private execQueue: Promise<void> = Promise.resolve();
  readonly stepExecutions: string[] = [];
  failUnlockForSession = false;

  constructor(private readonly pg: PGlite) {}

  activeLockOwnerCount(): number {
    return this.owners.size;
  }

  private enqueueSql<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.execQueue.then(fn, fn);
    this.execQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  connect(): Promise<AdvisoryLockSessionClient> {
    const sessionId = this.nextSessionId++;
    let closed = false;

    const releaseAllForSession = (): void => {
      for (const [key, owner] of this.owners.entries()) {
        if (owner === sessionId) {
          this.owners.delete(key);
        }
      }
    };

    const client: AdvisoryLockSessionClient = {
      query: async (sql: string, params: readonly unknown[] = []) => {
        if (closed) {
          throw new Error("session already closed");
        }

        if (sql.includes("pg_try_advisory_lock")) {
          const key = `${String(params[0])}:${String(params[1])}`;
          const currentOwner = this.owners.get(key);
          if (currentOwner === undefined || currentOwner === sessionId) {
            this.owners.set(key, sessionId);
            return { rows: [{ locked: true }], rowCount: 1 };
          }
          return { rows: [{ locked: false }], rowCount: 1 };
        }

        if (sql.includes("pg_advisory_unlock")) {
          if (this.failUnlockForSession) {
            throw new Error("socket closed before explicit unlock");
          }
          const key = `${String(params[0])}:${String(params[1])}`;
          if (this.owners.get(key) === sessionId) {
            this.owners.delete(key);
            return { rows: [{ unlocked: true }], rowCount: 1 };
          }
          return { rows: [{ unlocked: false }], rowCount: 1 };
        }

        return this.enqueueSql(async () => {
          const trimmed = sql.trim();
          const hasParams = params.length > 0;
          if (!hasParams && trimmed.includes(";") && !trimmed.toUpperCase().startsWith("SELECT")) {
            await this.pg.exec(trimmed);
            return { rows: [], rowCount: 0 };
          }
          const res = await this.pg.query(trimmed, [...params]);
          return {
            rows: res.rows as Record<string, unknown>[],
            rowCount: res.affectedRows ?? res.rows.length,
          };
        });
      },
      close: () => {
        closed = true;
        // Closing a PostgreSQL backend session always releases all session-level advisory locks.
        releaseAllForSession();
        return Promise.resolve();
      },
    };

    return Promise.resolve(client);
  }
}

describe("database migration advisory locking (#55)", () => {
  let pg: PGlite;
  let cluster: MultiSessionPgliteCluster;

  beforeAll(() => {
    pg = new PGlite();
  });

  beforeEach(() => {
    cluster = new MultiSessionPgliteCluster(pg);
  });

  afterAll(async () => {
    await pg.close();
  });

  it("ensures two concurrent migration runners never apply the same step twice", async () => {
    const repoSteps = loadSqlMigrationSteps();
    const stepHookLog: string[] = [];

    // Launch two concurrent runners simultaneously against the same uninitialized database.
    // `beforeStep` introduces an async yield inside the migration loop so any broken locking
    // implementation would interleave and attempt duplicate DDL.
    const [resA, resB] = await Promise.all([
      runSerializedMigrations(cluster, {
        steps: repoSteps,
        pollIntervalMs: 10,
        lockTimeoutMs: 20_000,
        beforeStep: async (stepName) => {
          stepHookLog.push(`A:${stepName}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        },
      }),
      runSerializedMigrations(cluster, {
        steps: repoSteps,
        pollIntervalMs: 10,
        lockTimeoutMs: 20_000,
        beforeStep: async (stepName) => {
          stepHookLog.push(`B:${stepName}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        },
      }),
    ]);

    // Exactly one runner applies the 3 migrations; the second wakes after lock release, re-reads
    // `pgmigrations`, sees all 3 applied, and applies 0 steps!
    const totalApplied = resA.appliedSteps.length + resB.appliedSteps.length;
    expect(totalApplied).toBe(repoSteps.length);
    expect([resA.appliedSteps.length, resB.appliedSteps.length].sort((a, b) => a - b)).toEqual([
      0,
      repoSteps.length,
    ]);
    expect(stepHookLog).toHaveLength(repoSteps.length);
    expect(cluster.activeLockOwnerCount()).toBe(0);

    const status = await inspectMigrationStatusReadOnly(
      {
        query: async (sql, params) => {
          const r = await pg.query(sql, [...(params ?? [])]);
          return { rows: r.rows as Record<string, unknown>[], rowCount: r.rows.length };
        },
      },
      { steps: repoSteps },
    );
    expect(status.upToDate).toBe(true);
    expect(status.appliedMigrations).toEqual(repoSteps.map((s) => s.name));
  });

  it("releases lock ownership on failed runs, broken unlock sockets, timeouts, and AbortSignal interruptions", async () => {
    const brokenSteps: readonly MigrationFileStep[] = [
      {
        name: "1790900000000_valid-step",
        filename: "1790900000000_valid-step.sql",
        upSql: "CREATE TABLE lock_probe_one (id integer PRIMARY KEY);",
        downSql: "DROP TABLE IF EXISTS lock_probe_one;",
      },
      {
        name: "1791000000000_broken-step",
        filename: "1791000000000_broken-step.sql",
        upSql:
          "CREATE TABLE lock_probe_two (amount integer CHECK (amount > 0)); INSERT INTO lock_probe_two VALUES (-5);",
        downSql: "DROP TABLE IF EXISTS lock_probe_two;",
      },
    ];

    // 1. Failed migration step rolls back step 2 and releases advisory lock ownership
    await expect(
      runSerializedMigrations(cluster, {
        migrationsTable: "pgmigrations_fail_test",
        steps: brokenSteps,
        pollIntervalMs: 10,
      }),
    ).rejects.toThrow();
    expect(cluster.activeLockOwnerCount()).toBe(0);

    // 2. Even if explicit `pg_advisory_unlock` throws due to a dropped socket, session close
    //    releases lock ownership so the next runner succeeds immediately!
    cluster.failUnlockForSession = true;
    await expect(
      withMigrationAdvisoryLock(cluster, () => Promise.reject(new Error("boom")), {
        pollIntervalMs: 10,
      }),
    ).rejects.toThrow("boom");
    expect(cluster.activeLockOwnerCount()).toBe(0);
    cluster.failUnlockForSession = false;

    // 3. Interrupted run via AbortSignal while holding lock & while waiting for lock
    let releaseHolder: () => void = () => undefined;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });

    const holderPromise = withMigrationAdvisoryLock(
      cluster,
      async () => {
        await holderGate;
        return "held";
      },
      { pollIntervalMs: 10 },
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cluster.activeLockOwnerCount()).toBe(1);

    // Waiter times out cleanly when lock is held past deadline
    await expect(
      withMigrationAdvisoryLock(cluster, () => Promise.resolve("never"), {
        lockTimeoutMs: 35,
        pollIntervalMs: 10,
      }),
    ).rejects.toBeInstanceOf(MigrationLockTimeoutError);

    // Waiter interrupted via AbortSignal exits immediately without stealing or leaking lock
    const waiterAbort = new AbortController();
    setTimeout(() => {
      waiterAbort.abort();
    }, 15);
    await expect(
      withMigrationAdvisoryLock(cluster, () => Promise.resolve("never"), {
        lockTimeoutMs: 5_000,
        pollIntervalMs: 50,
        signal: waiterAbort.signal,
      }),
    ).rejects.toBeInstanceOf(MigrationLockInterruptedError);

    releaseHolder();
    await expect(holderPromise).resolves.toBe("held");
    expect(cluster.activeLockOwnerCount()).toBe(0);

    // Subsequent valid migration run acquires the lock cleanly and finishes remaining work
    const fixedSteps: readonly MigrationFileStep[] = [
      brokenSteps[0] ?? {
        name: "1790900000000_valid-step",
        filename: "1790900000000_valid-step.sql",
        upSql: "SELECT 1;",
        downSql: "SELECT 1;",
      },
      {
        name: "1791000000000_fixed-step",
        filename: "1791000000000_fixed-step.sql",
        upSql:
          "CREATE TABLE lock_probe_two (amount integer CHECK (amount > 0)); INSERT INTO lock_probe_two VALUES (10);",
        downSql: "DROP TABLE IF EXISTS lock_probe_two;",
      },
    ];
    const recovered = await runSerializedMigrations(cluster, {
      migrationsTable: "pgmigrations_fail_test",
      steps: fixedSteps,
      pollIntervalMs: 10,
    });
    expect(recovered.skippedCount).toBe(1);
    expect(recovered.appliedSteps).toEqual(["1791000000000_fixed-step"]);
    expect(cluster.activeLockOwnerCount()).toBe(0);
  });

  it("ensures read-only API instances never perform implicit migrations or DDL writes", async () => {
    const executedSql: string[] = [];
    const fakePool = {
      query: (sql: string) => {
        executedSql.push(sql);
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
      connect: () => Promise.reject(new Error("read-only API must not open write transactions")),
      end: () => Promise.resolve(),
    } as unknown as Pool;

    const readOnlyDb = Database.wrapPool(fakePool, { readOnly: true });
    expect(readOnlyDb.isReadOnly).toBe(true);

    const config = loadConfig({ env: completeEnv({ KEEPER_ENABLED: "false" }) });
    const { logger } = capturingLogger();
    const app = buildServer({
      config,
      logger,
      db: readOnlyDb,
      readiness: [],
    });

    try {
      const healthRes = await app.inject({ method: "GET", url: "/health" });
      expect(healthRes.statusCode).toBe(200);

      const readyRes = await app.inject({ method: "GET", url: "/ready" });
      expect(readyRes.statusCode).toBe(200);

      const transfersRes = await app.inject({ method: "GET", url: "/v1/transfers" });
      expect(transfersRes.statusCode).toBe(200);

      // Verify zero implicit migrations, zero advisory locks, and zero DDL statements ran!
      for (const sql of executedSql) {
        expect(sql).not.toMatch(/pgmigrations|pg_try_advisory_lock|CREATE\s+TABLE|ALTER\s+TABLE/i);
      }

      // Direct write / transaction / migration attempts on a read-only handle fail immediately
      await expect(readOnlyDb.query("CREATE TABLE bad_implicit (id int)")).rejects.toBeInstanceOf(
        ReadOnlyDatabaseError,
      );
      await expect(readOnlyDb.transaction((tx) => tx.query("SELECT 1"))).rejects.toBeInstanceOf(
        ReadOnlyDatabaseError,
      );
      await expect(readOnlyDb.pruneCompletedAttestations()).rejects.toBeInstanceOf(
        ReadOnlyDatabaseError,
      );
      await expect(
        runSerializedMigrations(cluster, { readOnlyInstance: true }),
      ).rejects.toBeInstanceOf(ReadOnlyInstanceMigrationError);

      const cliErrors: string[] = [];
      const cliCode = await runMigrationCli(["up"], { HYPERION_READ_ONLY_API: "true" }, (line) =>
        cliErrors.push(line),
      );
      expect(cliCode).toBe(2);
      expect(cliErrors[0]).toContain("HYPERION_READ_ONLY_API=true");
    } finally {
      await app.close();
      await readOnlyDb.close();
    }

    const keys1 = deriveMigrationAdvisoryLockKeys(
      "hyperion-schema-migrations",
      "public",
      "pgmigrations",
    );
    const keys2 = deriveMigrationAdvisoryLockKeys(
      "hyperion-schema-migrations",
      "public",
      "pgmigrations",
    );
    expect(keys1).toEqual(keys2);

    const secret = ["mig", "pw", "554433"].join("_");
    expect(
      redactMigrationSecretText(`postgres://admin:${secret}@db.example.org:5432/hyperion`),
    ).toContain("postgres://admin:[REDACTED]@db.example.org:5432/hyperion");
  });
});
