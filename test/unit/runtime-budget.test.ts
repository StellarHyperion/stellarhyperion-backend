import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { RouteKind } from "@hyperion/protocol";
import { afterEach, describe, expect, it } from "vitest";

import type { EventSource, EventsPage, EventsQuery } from "../../src/chains/stellar/rpc.js";
import { StellarWatcher } from "../../src/chains/stellar/watcher.js";
import { loadConfig } from "../../src/config/config.js";
import { ConfigError } from "../../src/config/env.js";
import type { Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";
import { RailPass } from "../../src/rails/pass.js";
import type { PendingTransfer, RailClient, RailLookup } from "../../src/rails/types.js";
import { runBoundedCatchUp } from "../../src/runtime/budget.js";
import { completeEnv } from "../helpers.js";
import { FakeRpc, LIVE_ROUTER, capturingLogger } from "../stellar-fakes.js";

const MIGRATIONS = [
  "1790900000000_initial-schema.sql",
  "1791000000000_cursor-block-hash.sql",
  "1791100000000_cursor-autovacuum-tuning.sql",
] as const;

function readUpMigration(name: string): string {
  const full = readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8");
  const up = full.split("-- Down Migration")[0];
  if (!up) throw new Error(`Missing up section in ${name}`);
  return up;
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

async function openMigratedPglite(): Promise<{
  readonly pg: PGlite;
  readonly db: Transactional & { ping(): Promise<void>; close(): Promise<void> };
}> {
  const pg = new PGlite();
  for (const migration of MIGRATIONS) {
    await pg.exec(readUpMigration(migration));
  }

  const query = async (sql: string, params: readonly unknown[] = []): Promise<QueryResultRows> => {
    const result = await pg.query(sql, [...params]);
    const rows = normalizeRows(result.fields, result.rows);
    return { rows, rowCount: result.affectedRows ?? result.rows.length };
  };

  return {
    pg,
    db: {
      query,
      transaction: async <T>(work: (tx: Queryable) => Promise<T>): Promise<T> => {
        return pg.transaction(async (tx) => {
          const txQueryable: Queryable = {
            query: async (
              sql: string,
              params: readonly unknown[] = [],
            ): Promise<QueryResultRows> => {
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
    },
  };
}

function abortAwareDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

describe("bounded scheduled catch-up runtime budgeting", () => {
  const openHandles: PGlite[] = [];

  afterEach(async () => {
    while (openHandles.length > 0) {
      const pg = openHandles.pop();
      if (pg) await pg.close();
    }
  });

  it("allocates stage budgets cleanly and rejects stage sums that encroach on the drain safety margin", () => {
    const continuous = loadConfig({ env: completeEnv({ KEEPER_ENABLED: "false" }) });
    expect(continuous.catchUpBudget).toBeNull();

    const scheduled = loadConfig({
      env: completeEnv({
        KEEPER_ENABLED: "false",
        CATCHUP_RUN_BUDGET_MS: "150000",
      }),
    });
    expect(scheduled.catchUpBudget).not.toBeNull();
    if (!scheduled.catchUpBudget) throw new Error("expected catchUpBudget");

    const sum =
      scheduled.catchUpBudget.migrationBudgetMs +
      scheduled.catchUpBudget.sourceScanBudgetMs +
      scheduled.catchUpBudget.proofPollBudgetMs +
      scheduled.catchUpBudget.drainMarginMs;
    expect(sum).toBeLessThanOrEqual(150_000);
    expect(scheduled.catchUpBudget.drainMarginMs).toBeGreaterThanOrEqual(
      scheduled.shutdownTimeoutMs,
    );

    expect(() =>
      loadConfig({
        env: completeEnv({
          KEEPER_ENABLED: "false",
          CATCHUP_RUN_BUDGET_MS: "10000",
          CATCHUP_MIGRATION_BUDGET_MS: "3000",
          CATCHUP_SOURCE_SCAN_BUDGET_MS: "4000",
          CATCHUP_PROOF_POLL_BUDGET_MS: "2000",
          CATCHUP_DRAIN_MARGIN_MS: "2500",
        }),
      }),
    ).toThrow(ConfigError);
  });

  it("halts a hung migration stage at its stage ceiling so it cannot consume the shutdown safety margin", async () => {
    const { pg, db } = await openMigratedPglite();
    openHandles.push(pg);

    const { logger } = capturingLogger();
    const config = loadConfig({
      env: completeEnv({
        KEEPER_ENABLED: "false",
        CATCHUP_RUN_BUDGET_MS: "2000",
        CATCHUP_MIGRATION_BUDGET_MS: "120",
        CATCHUP_SOURCE_SCAN_BUDGET_MS: "500",
        CATCHUP_PROOF_POLL_BUDGET_MS: "500",
        CATCHUP_DRAIN_MARGIN_MS: "500",
      }),
    });
    if (!config.catchUpBudget) throw new Error("expected catchUpBudget");

    const drainState = { ran: false };
    const report = await runBoundedCatchUp({
      budget: config.catchUpBudget,
      config,
      db,
      logger,
      sourcePasses: [
        {
          name: "stellar-testnet",
          tick: () => Promise.resolve(false),
        },
      ],
      proofPasses: [],
      // Simulate a hung migration that ignores AbortSignal for 5 seconds.
      runMigrations: () => new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      drain: () => {
        drainState.ran = true;
        return Promise.resolve();
      },
    });

    expect(report.stopReason).toBe("migration_timeout");
    expect(report.stoppedStages).toEqual(["migrations"]);
    expect(report.stages.migrations.status).toBe("budget_exhausted");
    expect(report.stages.source_scans.status).toBe("skipped");
    expect(report.stages.proof_polling.status).toBe("skipped");
    expect(report.stages.graceful_drain.status).toBe("completed");
    expect(drainState.ran).toBe(true);
    // Slow migration took ~120ms out of 2000ms, leaving >1800ms (>= 500ms reserved drain margin).
    expect(report.drainSafety.remainingBeforeTotalDeadlineMs).toBeGreaterThanOrEqual(500);
    expect(report.drainSafety.drainCompletedWithinMargin).toBe(true);
  });

  it("preserves committed cursor and attestation progress across budget expiration and reports exact remaining eligible work", async () => {
    const { pg, db } = await openMigratedPglite();
    openHandles.push(pg);

    const dbSecretPassword = "catchup-secret-db-password-4567";
    const { logger } = capturingLogger();
    const config = loadConfig({
      env: completeEnv({
        DATABASE_URL: `postgres://hyperion:${dbSecretPassword}@127.0.0.1:5433/hyperion`,
        KEEPER_ENABLED: "false",
        RAIL_BATCH_SIZE: "2",
        CATCHUP_RUN_BUDGET_MS: "2200",
        CATCHUP_MIGRATION_BUDGET_MS: "200",
        CATCHUP_SOURCE_SCAN_BUDGET_MS: "160",
        CATCHUP_PROOF_POLL_BUDGET_MS: "160",
        CATCHUP_DRAIN_MARGIN_MS: "500",
      }),
    });
    if (!config.catchUpBudget) throw new Error("expected catchUpBudget");

    // Seed 3 CCTP outbound transfers and 1 unsettled claim.
    await pg.exec(`
      INSERT INTO outbound_transfer (id, origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount, destination_chain, destination, origin_block, origin_tx)
      VALUES
        (101, 'stellar-testnet', 0, 1, 'Gsender', 'USDC', 1000, 0, 1000, 'sepolia', '0x0000000000000000000000001111111111111111111111111111111111111111', 4900010, 'tx-101'),
        (102, 'stellar-testnet', 0, 2, 'Gsender', 'USDC', 2000, 0, 2000, 'sepolia', '0x0000000000000000000000001111111111111111111111111111111111111111', 4900020, 'tx-102'),
        (103, 'stellar-testnet', 0, 3, 'Gsender', 'USDC', 3000, 0, 3000, 'sepolia', '0x0000000000000000000000001111111111111111111111111111111111111111', 4900030, 'tx-103');
      INSERT INTO pending_claim (chain, claim_id, recipient, token, amount, route, source_chain, source_nonce, created_at, settled)
      VALUES
        ('stellar-testnet', 9, 'Grecipient', 'USDC', 1000, 0, 'sepolia', 88, now(), false);
    `);

    // FakeRpc has 5 catch-up windows of ~10,000 ledgers (4,900,000 -> 4,945,000).
    // Passes 1 and 2 finish fast and commit their PostgreSQL transactions; Pass 3 stalls until stage budget expires.
    const startLedger = 4_900_000;
    const baseFakeRpc = new FakeRpc({ events: [], latestLedger: 4_945_000 });
    const rpcCallCounter = { count: 0 };
    const stagedRpc: EventSource = {
      events: async (query: EventsQuery, signal?: AbortSignal): Promise<EventsPage> => {
        rpcCallCounter.count += 1;
        if (rpcCallCounter.count >= 3 && signal) {
          await abortAwareDelay(2_000, signal);
        }
        return baseFakeRpc.events(query);
      },
    };

    const stellarWatcher = new StellarWatcher({
      chainKey: "stellar-testnet",
      router: LIVE_ROUTER,
      startLedger,
      pageSize: 200,
      rpc: stagedRpc,
      db,
      logger,
    });

    // RailPass with batchSize=2: Pass 1 checks transfers 101 & 102 (marking checked_at = now()) and returns true
    // because queue.length === batchSize (2). Pass 2 stalls on transfer 103 until proof_polling stage ceiling fires!
    const railLookCounter = { count: 0 };
    const fakeIrisClient: RailClient = {
      rail: "cctp",
      look: async (transfer: PendingTransfer): Promise<RailLookup> => {
        railLookCounter.count += 1;
        if (transfer.transferId === 103n) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        return { kind: "missing" };
      },
    };

    const cctpPass = new RailPass({
      route: RouteKind.Cctp,
      config,
      client: fakeIrisClient,
      db,
      logger,
      batchSize: 2,
      recheckAfterMs: 60_000,
      maxCheckFailures: 10,
    });

    const drainState = { closed: false };
    const report = await runBoundedCatchUp({
      budget: config.catchUpBudget,
      config,
      db,
      logger,
      sourcePasses: [stellarWatcher],
      proofPasses: [cctpPass],
      drain: () => {
        drainState.closed = true;
        return Promise.resolve();
      },
    });

    // 1. Shutdown safety margin was completely preserved despite BOTH source_scans and proof_polling hitting stage ceilings!
    expect(drainState.closed).toBe(true);
    expect(report.drainSafety.remainingBeforeTotalDeadlineMs).toBeGreaterThanOrEqual(500);
    expect(report.drainSafety.drainCompletedWithinMargin).toBe(true);

    // 2. Committed progress from completed passes survived stage budget expiration in PostgreSQL!
    expect(report.stages.source_scans.completedPasses).toBe(2);
    const cursorRows = await db.query(
      "SELECT last_processed FROM indexer_cursor WHERE chain_key = 'stellar-testnet'",
    );
    // Pass 1 advanced 10,000 ledgers (4,900,000..4,909,999), Pass 2 advanced FakeRpc's cursor window to 4,919,997.
    expect(String(cursorRows.rows[0]?.last_processed)).toBe("4919997");

    const checkedAttestations = await db.query(
      "SELECT transfer_id FROM rail_attestation ORDER BY transfer_id ASC",
    );
    expect(checkedAttestations.rows.map((r) => Number(r.transfer_id))).toEqual([101, 102]);

    // 3. Report accurately explains why the run stopped and what remains eligible, with zero secrets!
    expect(report.stopReason).toBe("stage_budget_exhausted");
    expect(report.stoppedStages).toEqual(["source_scans", "proof_polling"]);
    expect(report.remainingEligibleWork.incompleteSourceChains).toEqual(["stellar-testnet"]);
    expect(report.remainingEligibleWork.storedCursors).toEqual([
      expect.objectContaining({
        chainKey: "stellar-testnet",
        lastProcessed: "4919997",
      }),
    ]);

    const cctpRemaining = report.remainingEligibleWork.eligibleRailTransfersByRoute.find(
      (r) => r.route === RouteKind.Cctp,
    );
    // Transfers 101 & 102 were just checked within recheckAfterMs (60s), so only transfer 103 is eligible right now,
    // while all 3 remain non-terminal in totalOutstanding!
    expect(cctpRemaining).toEqual({
      route: RouteKind.Cctp,
      routeName: "cctp",
      eligibleNow: 1,
      totalOutstanding: 3,
    });
    expect(report.remainingEligibleWork.unsettledClaims).toBe(1);
    expect(JSON.stringify(report)).not.toContain(dbSecretPassword);
  });

  it("reports caught_up when migrations, source scans and proof polling finish within their stage budgets", async () => {
    const { pg, db } = await openMigratedPglite();
    openHandles.push(pg);

    const { logger } = capturingLogger();
    const config = loadConfig({
      env: completeEnv({
        KEEPER_ENABLED: "false",
        CATCHUP_RUN_BUDGET_MS: "5000",
      }),
    });
    if (!config.catchUpBudget) throw new Error("expected catchUpBudget");

    const startLedger = 4_960_000;
    const rpc = new FakeRpc({ events: [], latestLedger: startLedger + 4_000 });
    const stellarWatcher = new StellarWatcher({
      chainKey: "stellar-testnet",
      router: LIVE_ROUTER,
      startLedger,
      pageSize: 200,
      rpc,
      db,
      logger,
    });

    const cctpPass = new RailPass({
      route: RouteKind.Cctp,
      config,
      client: {
        rail: "cctp",
        look: () => Promise.resolve({ kind: "missing" }),
      },
      db,
      logger,
      batchSize: 20,
      recheckAfterMs: 10_000,
      maxCheckFailures: 10,
    });

    const report = await runBoundedCatchUp({
      budget: config.catchUpBudget,
      config,
      db,
      logger,
      sourcePasses: [stellarWatcher],
      proofPasses: [cctpPass],
      drain: () => Promise.resolve(),
    });

    expect(report.stopReason).toBe("caught_up");
    expect(report.stoppedStages).toEqual([]);
    expect(report.remainingEligibleWork.incompleteSourceChains).toEqual([]);
    expect(report.remainingEligibleWork.storedCursors[0]?.lastProcessed).toBe(
      String(startLedger + 4_000),
    );
    expect(report.drainSafety.drainCompletedWithinMargin).toBe(true);
  });
});
