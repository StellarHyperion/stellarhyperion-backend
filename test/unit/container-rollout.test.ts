import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

import { buildIndexer } from "../../src/chains/runner.js";
import { StellarWatcher } from "../../src/chains/stellar/watcher.js";
import { loadConfig } from "../../src/config/config.js";
import type { Database, Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import {
  LeasedPass,
  PostgresRolloutLeaseStore,
  RolloutCoordinator,
  RolloutLeaseLostError,
} from "../../src/runtime/rollout.js";
import { completeEnv } from "../helpers.js";
import { FakeRpc, LIVE_ROUTER, capturingLogger } from "../stellar-fakes.js";

const BASE_MIGRATIONS = [
  "1790900000000_initial-schema.sql",
  "1791000000000_cursor-block-hash.sql",
  "1791100000000_cursor-autovacuum-tuning.sql",
] as const;

const ROLLOUT_MIGRATION = "1791200000000_indexer-rollout-leases.sql";

function readUpMigration(name: string): string {
  const full = readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8");
  const up = full.split("-- Down Migration")[0];
  if (!up) {
    throw new Error(`Migration ${name} missing up section`);
  }
  return up;
}

interface EmbeddedPostgres {
  readonly pg: PGlite;
  readonly db: Database;
}

function normalizeRows(
  fields: readonly { readonly dataTypeID: number; readonly name: string }[],
  rawRows: readonly unknown[],
): readonly Record<string, unknown>[] {
  const int8 = fields.filter((field) => field.dataTypeID === 20).map((field) => field.name);
  return rawRows.map((raw) => {
    const row = { ...(raw as Record<string, unknown>) };
    for (const column of int8) {
      const value = row[column];
      if (typeof value === "number" || typeof value === "bigint") {
        row[column] = String(value);
      }
    }
    return row;
  });
}

function openEmbeddedPostgres(): EmbeddedPostgres {
  const pg = new PGlite();
  const query = async (sql: string, params: readonly unknown[] = []): Promise<QueryResultRows> => {
    const result = await pg.query(sql, [...params]);
    const rows = normalizeRows(result.fields, result.rows);
    return { rows, rowCount: result.affectedRows ?? result.rows.length };
  };

  const transactional: Transactional & {
    ping(): Promise<void>;
    close(): Promise<void>;
  } = {
    query,
    transaction: async <T>(work: (tx: Queryable) => Promise<T>): Promise<T> => {
      return pg.transaction(async (tx) => {
        const txQueryable: Queryable = {
          query: async (sql: string, params: readonly unknown[] = []): Promise<QueryResultRows> => {
            const result = await tx.query(sql, [...params]);
            const rows = normalizeRows(result.fields, result.rows);
            return { rows, rowCount: result.affectedRows ?? result.rows.length };
          },
        };
        return work(txQueryable);
      });
    },
    ping: async () => {
      await pg.query("SELECT 1");
    },
    close: async () => {
      await pg.close();
    },
  };

  return {
    pg,
    db: transactional as unknown as Database,
  };
}

describe("container startup admission, rollout leases and graceful drain", () => {
  const openHandles: PGlite[] = [];

  afterEach(async () => {
    while (openHandles.length > 0) {
      const handle = openHandles.pop();
      if (handle) {
        await handle.close();
      }
    }
  });

  it("gates /startup and /ready on actual PostgreSQL schema admission while keeping /health 200", async () => {
    const { pg, db } = openEmbeddedPostgres();
    openHandles.push(pg);

    // Apply only baseline migrations first so indexer_rollout_lease is missing.
    for (const migration of BASE_MIGRATIONS) {
      await pg.exec(readUpMigration(migration));
    }

    const { logger } = capturingLogger();
    const config = loadConfig({
      env: completeEnv({
        NODE_ENV: "test",
        KEEPER_ENABLED: "false",
        CONTAINER_INSTANCE_ID: "container-probe-1",
      }),
    });
    const rollout = new RolloutCoordinator({
      db,
      instanceId: config.rollout.instanceId,
      leaseTtlMs: config.rollout.leaseTtlMs,
      drainGraceMs: 0,
      logger,
    });
    const app = buildServer({
      config,
      logger,
      db,
      rollout,
      readiness: [],
    });
    await app.ready();

    try {
      // Before admitSchema() has run: /startup and /ready return 503, /health returns 200.
      const preStartup = await app.inject({ method: "GET", url: "/startup" });
      expect(preStartup.statusCode).toBe(503);
      expect(preStartup.json()).toMatchObject({
        status: "starting",
        phase: "starting",
        instanceId: "container-probe-1",
      });

      const preReady = await app.inject({ method: "GET", url: "/ready" });
      expect(preReady.statusCode).toBe(503);

      const preHealth = await app.inject({ method: "GET", url: "/health" });
      expect(preHealth.statusCode).toBe(200);
      expect(preHealth.json()).toMatchObject({
        status: "ok",
        rolloutPhase: "starting",
        instanceId: "container-probe-1",
      });

      // Run schema admission before rollout migration is applied: must fail and list missing table.
      const incomplete = await rollout.admitSchema();
      expect(incomplete.admitted).toBe(false);
      expect(incomplete.missingTables).toEqual(["indexer_rollout_lease"]);

      const failedStartup = await app.inject({ method: "GET", url: "/startup" });
      expect(failedStartup.statusCode).toBe(503);
      expect(failedStartup.json()).toMatchObject({
        status: "failed",
        phase: "failed",
        missingTables: ["indexer_rollout_lease"],
      });
      expect(failedStartup.body).not.toContain("not-a-real-password");

      const failedReady = await app.inject({ method: "GET", url: "/ready" });
      expect(failedReady.statusCode).toBe(503);

      // Apply the rollout lease migration and re-run admission: /startup and /ready turn 200.
      await pg.exec(readUpMigration(ROLLOUT_MIGRATION));
      const admitted = await rollout.admitSchema();
      expect(admitted.admitted).toBe(true);
      expect(admitted.missingTables).toEqual([]);

      const okStartup = await app.inject({ method: "GET", url: "/startup" });
      expect(okStartup.statusCode).toBe(200);
      expect(okStartup.json()).toMatchObject({
        status: "admitted",
        phase: "admitted",
        missingTables: [],
      });

      const okReady = await app.inject({ method: "GET", url: "/ready" });
      expect(okReady.statusCode).toBe(200);
      expect(okReady.json()).toMatchObject({ status: "ready" });

      // Entering drain flips /ready and /startup to 503 while /health stays 200 for orchestrator liveness.
      let releaseWorkerStop: (() => void) | undefined;
      const drainPromise = rollout.drainAndRelease(
        "SIGTERM",
        () =>
          new Promise<void>((resolve) => {
            releaseWorkerStop = resolve;
          }),
      );

      const drainingReady = await app.inject({ method: "GET", url: "/ready" });
      expect(drainingReady.statusCode).toBe(503);

      const drainingHealth = await app.inject({ method: "GET", url: "/health" });
      expect(drainingHealth.statusCode).toBe(200);
      expect(drainingHealth.json()).toMatchObject({
        status: "ok",
        rolloutPhase: "draining",
      });

      releaseWorkerStop?.();
      await drainPromise;
    } finally {
      await app.close();
    }
  });

  it("prevents standby containers from polling or advancing shared cursors until the retiring peer drains", async () => {
    const { pg, db } = openEmbeddedPostgres();
    openHandles.push(pg);
    for (const migration of [...BASE_MIGRATIONS, ROLLOUT_MIGRATION]) {
      await pg.exec(readUpMigration(migration));
    }

    const time = { nowMs: 1_700_000_000_000 };
    const { logger } = capturingLogger();

    const rolloutA = new RolloutCoordinator({
      db,
      instanceId: "container-old-a",
      leaseTtlMs: 20_000,
      drainGraceMs: 0,
      logger,
      clock: () => time.nowMs,
    });
    const rolloutB = new RolloutCoordinator({
      db,
      instanceId: "container-new-b",
      leaseTtlMs: 20_000,
      drainGraceMs: 0,
      logger,
      clock: () => time.nowMs,
    });

    await rolloutA.admitSchema();
    await rolloutB.admitSchema();

    const startLedger = 4_965_951;
    const rpcA = new FakeRpc({ events: [], latestLedger: startLedger + 5_000 });
    const rpcB = new FakeRpc({ events: [], latestLedger: startLedger + 9_000 });
    const leaseKey = "watcher:stellar-testnet";

    const passA = new LeasedPass(
      leaseKey,
      rolloutA,
      (getFence) =>
        new StellarWatcher({
          chainKey: "stellar-testnet",
          router: LIVE_ROUTER,
          startLedger,
          pageSize: 200,
          rpc: rpcA,
          db: rolloutA.createFencedDb(db, leaseKey, getFence),
          logger,
        }),
      logger,
    );

    const passB = new LeasedPass(
      leaseKey,
      rolloutB,
      (getFence) =>
        new StellarWatcher({
          chainKey: "stellar-testnet",
          router: LIVE_ROUTER,
          startLedger,
          pageSize: 200,
          rpc: rpcB,
          db: rolloutB.createFencedDb(db, leaseKey, getFence),
          logger,
        }),
      logger,
    );

    // Old container A ticks first and owns the shared cursor at fence token 1.
    await passA.tick(AbortSignal.timeout(5_000));
    expect(passA.currentFenceToken).toBe(1n);
    expect(rpcA.requests.length).toBe(1);

    const cursorAfterA = await db.query(
      "SELECT last_processed FROM indexer_cursor WHERE chain_key = 'stellar-testnet'",
    );
    expect(Number(cursorAfterA.rows[0]?.last_processed)).toBe(startLedger + 5_000);

    // New container B boots during rolling deployment while A still holds the active lease.
    time.nowMs += 2_000;
    const bProgressedWhileActive = await passB.tick(AbortSignal.timeout(5_000));
    expect(bProgressedWhileActive).toBe(false);
    expect(passB.currentFenceToken).toBeNull();
    expect(rpcB.requests).toHaveLength(0);
    await expect(passB.readiness()).resolves.toMatchObject({
      name: "stellar-testnet",
      state: "ready",
      detail: "standby: shared cursor lease held by container-old-a",
    });

    // Cursor remains untouched at A's ledger.
    const cursorWhileBWaiting = await db.query(
      "SELECT last_processed FROM indexer_cursor WHERE chain_key = 'stellar-testnet'",
    );
    expect(Number(cursorWhileBWaiting.rows[0]?.last_processed)).toBe(startLedger + 5_000);

    // Old container A receives SIGTERM, drains its workers and releases its rollout lease.
    time.nowMs += 1_000;
    const releasedCount = await rolloutA.drainAndRelease("SIGTERM", () => Promise.resolve());
    expect(releasedCount).toBe(1);

    // New container B immediately acquires ownership at monotonic fence token 2 and resumes
    // from A's committed cursor boundary rather than rescanning from startLedger.
    await passB.tick(AbortSignal.timeout(5_000));
    expect(passB.currentFenceToken).toBe(2n);
    expect(rpcB.requests).toHaveLength(1);
    expect(rpcB.requests[0]?.startLedger).toBeUndefined();
    expect(rpcB.requests[0]?.cursor).toBeDefined();

    const cursorAfterB = await db.query(
      "SELECT last_processed FROM indexer_cursor WHERE chain_key = 'stellar-testnet'",
    );
    expect(Number(cursorAfterB.rows[0]?.last_processed)).toBe(startLedger + 9_000);
  });

  it("rolls back stale cursor writes when a stalled instance loses its rollout lease before commit", async () => {
    const { pg, db } = openEmbeddedPostgres();
    openHandles.push(pg);
    for (const migration of [...BASE_MIGRATIONS, ROLLOUT_MIGRATION]) {
      await pg.exec(readUpMigration(migration));
    }

    const time = { nowMs: 1_700_000_100_000 };
    const { logger } = capturingLogger();
    const leaseKey = "watcher:stellar-testnet";
    const store = new PostgresRolloutLeaseStore(db, () => time.nowMs);

    const rolloutA = new RolloutCoordinator({
      db,
      instanceId: "container-stalled-a",
      leaseTtlMs: 10_000,
      logger,
      leaseStore: store,
      clock: () => time.nowMs,
    });
    const rolloutB = new RolloutCoordinator({
      db,
      instanceId: "container-takeover-b",
      leaseTtlMs: 10_000,
      logger,
      leaseStore: store,
      clock: () => time.nowMs,
    });
    await rolloutA.admitSchema();
    await rolloutB.admitSchema();

    // Container A acquires fence token 1 before stalling.
    const acqA = await store.tryAcquireOrRenew(leaseKey, "container-stalled-a", 10_000, time.nowMs);
    expect(acqA.acquired).toBe(true);
    if (!acqA.acquired) throw new Error("expected container A lease acquisition");
    const staleFenceFromA = acqA.lease.fenceToken;
    expect(staleFenceFromA).toBe(1n);

    // Container A stalls past its 10s lease TTL; Container B takes over at fence token 2 and advances cursor.
    time.nowMs += 15_000;
    const acqB = await store.tryAcquireOrRenew(
      leaseKey,
      "container-takeover-b",
      10_000,
      time.nowMs,
    );
    expect(acqB.acquired).toBe(true);
    if (!acqB.acquired) throw new Error("expected container B takeover");
    expect(acqB.lease.fenceToken).toBe(2n);

    const fencedB = rolloutB.createFencedDb(db, leaseKey, () => acqB.lease.fenceToken);
    await fencedB.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO indexer_cursor (chain_key, family, contract, last_processed)
         VALUES ('stellar-testnet', 'stellar', $1, 5000500)`,
        [LIVE_ROUTER],
      );
    });

    // Now stalled Container A wakes up still holding fence token 1 and tries to commit an older cursor page.
    const fencedA = rolloutA.createFencedDb(db, leaseKey, () => staleFenceFromA);
    await expect(
      fencedA.transaction(async (tx) => {
        await tx.query(
          `UPDATE indexer_cursor
              SET last_processed = 4999100
            WHERE chain_key = 'stellar-testnet'`,
        );
      }),
    ).rejects.toBeInstanceOf(RolloutLeaseLostError);

    // Direct mutating SQL outside a transaction is also fenced off.
    await expect(
      fencedA.query(
        "UPDATE indexer_cursor SET last_processed = 4999100 WHERE chain_key = 'stellar-testnet'",
      ),
    ).rejects.toBeInstanceOf(RolloutLeaseLostError);

    // Container B's newer cursor row remains completely intact.
    const stored = await db.query(
      "SELECT last_processed FROM indexer_cursor WHERE chain_key = 'stellar-testnet'",
    );
    expect(Number(stored.rows[0]?.last_processed)).toBe(5_000_500);
  });

  it("blocks post-drain writes and wires rollout leases into buildIndexer", async () => {
    const { pg, db } = openEmbeddedPostgres();
    openHandles.push(pg);
    for (const migration of [...BASE_MIGRATIONS, ROLLOUT_MIGRATION]) {
      await pg.exec(readUpMigration(migration));
    }

    const { logger } = capturingLogger();
    const config = loadConfig({
      env: completeEnv({
        NODE_ENV: "test",
        KEEPER_ENABLED: "false",
        CONTAINER_INSTANCE_ID: "pod-rollout-blue",
        ROLLOUT_LEASE_TTL_MS: "15000",
        ROLLOUT_DRAIN_GRACE_MS: "10",
      }),
    });
    expect(config.rollout).toEqual({
      instanceId: "pod-rollout-blue",
      leaseTtlMs: 15_000,
      drainGraceMs: 10,
    });

    const rollout = new RolloutCoordinator({
      db,
      instanceId: config.rollout.instanceId,
      leaseTtlMs: config.rollout.leaseTtlMs,
      drainGraceMs: config.rollout.drainGraceMs,
      logger,
    });
    await rollout.admitSchema();

    const indexer = buildIndexer({ config, logger, db, rollout });
    expect(indexer.workers.map((worker) => worker.name).sort()).toEqual([
      "rail:axelar",
      "rail:cctp",
      "sepolia",
      "stellar-testnet",
    ]);

    await rollout.drainAndRelease("SIGTERM", () => indexer.stop());
    const fencedAfterDrain = rollout.createFencedDb(db, "watcher:stellar-testnet", () => 1n);
    await expect(
      fencedAfterDrain.query(
        "INSERT INTO indexer_cursor (chain_key, family, contract, last_processed) VALUES ('x', 'stellar', 'C', 1)",
      ),
    ).rejects.toBeInstanceOf(RolloutLeaseLostError);
  });
});
