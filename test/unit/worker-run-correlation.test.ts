import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { AddressKind, RouteKind, encodeStellarAddress } from "@hyperion/protocol";
import { Keypair } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  WorkerRunTracker,
  isSafePublicRunId,
  resolveSafeRunId,
} from "../../src/chains/run-correlation.js";
import { runCorrelatedCatchUpJob } from "../../src/chains/runner.js";
import { StellarWatcher } from "../../src/chains/stellar/watcher.js";
import { writeInbound } from "../../src/chains/writers.js";
import { loadConfig } from "../../src/config/config.js";
import type { Database, Queryable, QueryResultRows } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import { withRunCorrelation } from "../../src/logging/logger.js";
import { RailPass } from "../../src/rails/pass.js";
import type { RailClient } from "../../src/rails/types.js";
import { completeEnv } from "../helpers.js";
import { FakeRpc, capturingLogger, syntheticEvent } from "../stellar-fakes.js";

const ACTIVE_TESTNET_DEPLOYMENT = fileURLToPath(
  new URL("../../deployments/testnet.json", import.meta.url),
);

function migrationPath(name: string): string {
  return fileURLToPath(new URL(`../../migrations/${name}`, import.meta.url));
}

describe("worker run correlation across hosted catch-up jobs", () => {
  const pg = new PGlite();
  let txLock: Promise<void> = Promise.resolve();

  function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = txLock.then(fn, fn);
    txLock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  const rawQuery = async (sql: string, params?: readonly unknown[]): Promise<QueryResultRows> => {
    const result = await pg.query(sql, [...(params ?? [])]);
    const int8 = result.fields
      .filter((field) => field.dataTypeID === 20)
      .map((field) => field.name);
    const rows = result.rows.map((raw) => {
      const row = { ...(raw as Record<string, unknown>) };
      for (const column of int8) {
        const value = row[column];
        if (typeof value === "number" || typeof value === "bigint") {
          row[column] = String(value);
        }
      }
      return row;
    });
    return { rows, rowCount: result.affectedRows ?? result.rows.length };
  };

  const pgliteDb = {
    query: (sql: string, params?: readonly unknown[]) => runExclusive(() => rawQuery(sql, params)),
    ping: () =>
      runExclusive(async () => {
        await pg.query("SELECT 1");
      }),
    transaction: <T>(work: (tx: Queryable) => Promise<T>): Promise<T> =>
      runExclusive(async () => {
        await pg.exec("BEGIN");
        try {
          const val = await work({ query: rawQuery });
          await pg.exec("COMMIT");
          return val;
        } catch (error) {
          await pg.exec("ROLLBACK").catch(() => undefined);
          throw error;
        }
      }),
  } as unknown as Database;

  beforeAll(async () => {
    for (const name of [
      "1790900000000_initial-schema.sql",
      "1791000000000_cursor-block-hash.sql",
      "1791100000000_cursor-autovacuum-tuning.sql",
      "1791200000000_worker-run-correlation.sql",
    ]) {
      const sql = readFileSync(migrationPath(name), "utf8").split("-- Down Migration")[0]!;
      await pg.exec(sql);
    }
  }, 30_000);

  afterAll(async () => {
    await pg.close();
  });

  it("enforces safe public operation identifiers and never leaks credentials or signer keys", async () => {
    const dynamicSecret = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(31)).secret();
    const credentialUrl = "postgres://admin:super_secret_pw@db.internal:5432/hyperion";
    const dynamicHexKey = `0x${"ab".repeat(32)}`;

    expect(isSafePublicRunId(dynamicSecret)).toBe(false);
    expect(isSafePublicRunId(credentialUrl)).toBe(false);
    expect(isSafePublicRunId(dynamicHexKey)).toBe(false);
    expect(isSafePublicRunId("Bearer eyJhbGciOiJIUzI1NiJ9")).toBe(false);
    expect(isSafePublicRunId("job-catchup-20261116:01")).toBe(true);

    const rejected = resolveSafeRunId(credentialUrl);
    expect(rejected.rejectedCandidate).toBe(true);
    expect(rejected.runId).not.toContain("super_secret_pw");
    expect(isSafePublicRunId(rejected.runId)).toBe(true);

    const { logger, lines } = capturingLogger();
    const safeLogger = withRunCorrelation(logger, dynamicSecret);
    safeLogger.info("testing unsafe run id");
    expect(JSON.stringify(lines)).not.toContain(dynamicSecret);

    const tracker = new WorkerRunTracker({
      db: pgliteDb,
      network: "testnet",
      expectedChains: ["stellar-testnet"],
      expectedRails: [],
    });
    const started = await tracker.beginRun(dynamicSecret);
    expect(started.rejectedCandidate).toBe(true);
    expect(started.runId).not.toBe(dynamicSecret);
    await tracker.finishRun("sanitized_check");
  });

  it("distinguishes partial catch-up from completed catch-up and links scans and verification transitions", async () => {
    await pg.exec(
      "DELETE FROM worker_verification_journal; DELETE FROM worker_scan_journal; DELETE FROM worker_run; DELETE FROM indexer_cursor; DELETE FROM outbound_transfer;",
    );

    const config = loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: ACTIVE_TESTNET_DEPLOYMENT,
        KEEPER_ENABLED: "false",
      }),
    });
    const router = config.indexer.stellar!.routerContractId;
    const sender = encodeStellarAddress(AddressKind.Account, new Uint8Array(32).fill(7));
    const token = encodeStellarAddress(AddressKind.Contract, new Uint8Array(32).fill(8));

    await pgliteDb.query(
      `INSERT INTO outbound_transfer (
         origin_chain, route, nonce, sender, token,
         gross_amount, fee, net_amount, destination_chain, destination,
         origin_block, origin_tx
       ) VALUES (
         'stellar-testnet', $1, 101, $2, $3,
         50000000, 50000, 49950000, 'sepolia',
         '0x0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38',
         5433815, $4
       )`,
      [RouteKind.Cctp, sender, token, "a".repeat(64)],
    );

    const rpc = new FakeRpc({
      events: [
        syntheticEvent({
          contractId: router,
          ledger: 5_433_815,
        }),
      ],
      // More than one 10,000-ledger START_WINDOW ahead so a 1-tick budget leaves lag behind.
      latestLedger: 5_460_000,
    });

    const fakeCctpClient: RailClient = {
      rail: "cctp",
      look: () =>
        Promise.resolve({
          kind: "found",
          report: {
            status: "attested",
            railStatus: "complete",
            reference: "iris-attestation-101",
            attestedAt: new Date("2026-11-16T03:00:00Z"),
          },
        }),
    };

    const { logger } = capturingLogger();

    // Job 1: bounded to 1 tick per pass -> scans first 120-ledger window, still behind head -> PARTIAL.
    const trackerJob1 = new WorkerRunTracker({
      db: pgliteDb,
      network: config.network,
      expectedChains: ["stellar-testnet"],
      expectedRails: ["rail:cctp"],
    });
    const stellarJob1 = new StellarWatcher({
      chainKey: "stellar-testnet",
      router,
      startLedger: 5_433_810,
      pageSize: 50,
      rpc,
      db: pgliteDb,
      logger,
      runTracker: trackerJob1,
    });
    const cctpJob1 = new RailPass({
      route: RouteKind.Cctp,
      config,
      client: fakeCctpClient,
      db: pgliteDb,
      logger,
      batchSize: 20,
      recheckAfterMs: 0,
      maxCheckFailures: 5,
      runTracker: trackerJob1,
    });

    const summary1 = await runCorrelatedCatchUpJob({
      runTracker: trackerJob1,
      passes: [stellarJob1, cctpJob1],
      logger,
      requestedRunId: "job-catchup-partial-1",
      maxTicksPerPass: 1,
    });

    expect(summary1?.runId).toBe("job-catchup-partial-1");
    expect(summary1?.status).toBe("partial");
    expect(summary1?.scanWindows).toBe(1);
    expect(summary1?.verificationTransitions).toBe(1);
    // Provider status "attested" alone must NEVER count as verified destination delivery.
    expect(summary1?.verifiedDeliveries).toBe(0);

    // Job 2: catches all remaining ledgers up to head and drains rail queue -> COMPLETED.
    const trackerJob2 = new WorkerRunTracker({
      db: pgliteDb,
      network: config.network,
      expectedChains: ["stellar-testnet"],
      expectedRails: ["rail:cctp"],
    });
    const stellarJob2 = new StellarWatcher({
      chainKey: "stellar-testnet",
      router,
      startLedger: 5_433_810,
      pageSize: 50,
      rpc,
      db: pgliteDb,
      logger,
      runTracker: trackerJob2,
    });
    const settledClient: RailClient = {
      rail: "cctp",
      look: () => Promise.resolve({ kind: "missing" }),
    };
    await writeInbound(
      pgliteDb,
      {
        chainKey: "sepolia",
        block: 9001n,
        txHash: "0xdest",
        logIndex: 0,
        observedAt: new Date("2026-11-16T03:05:00Z"),
      },
      {
        route: RouteKind.Cctp,
        sourceChain: "stellar-testnet",
        sourceNonce: 101n,
        railMessageId: null,
        recipient: "0x0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38",
        token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
        amount: 49_950_000n,
        delivered: true,
        claimId: null,
      },
    );

    const cctpJob2 = new RailPass({
      route: RouteKind.Cctp,
      config,
      client: settledClient,
      db: pgliteDb,
      logger,
      batchSize: 20,
      recheckAfterMs: 0,
      maxCheckFailures: 5,
      runTracker: trackerJob2,
    });

    const summary2 = await runCorrelatedCatchUpJob({
      runTracker: trackerJob2,
      passes: [stellarJob2, cctpJob2],
      logger,
      requestedRunId: "job-catchup-complete-2",
      maxTicksPerPass: 20,
    });

    expect(summary2?.runId).toBe("job-catchup-complete-2");
    expect(summary2?.status).toBe("completed");
    expect(summary2?.caughtUpChains).toEqual(["stellar-testnet"]);
    expect(summary2?.caughtUpRails).toEqual(["rail:cctp"]);
    expect(summary2?.verifiedDeliveries).toBe(1);

    // Separate API-only server reads persisted correlation state without conflating Job 1 and Job 2.
    const apiConfig = loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: ACTIVE_TESTNET_DEPLOYMENT,
        INDEXER_ENABLED: "false",
        KEEPER_ENABLED: "false",
      }),
    });
    const app = buildServer({ config: apiConfig, logger, db: pgliteDb, readiness: [] });
    try {
      const metricsRes = await app.inject({ method: "GET", url: "/v1/metrics" });
      expect(metricsRes.statusCode).toBe(200);
      const workerRuns = metricsRes.json().workerRuns;
      expect(workerRuns.latestRun.runId).toBe("job-catchup-complete-2");
      expect(workerRuns.latestRun.status).toBe("completed");
      expect(workerRuns.latestRun.scans.length).toBeGreaterThanOrEqual(1);
      expect(workerRuns.latestRun.verifications).toEqual([
        expect.objectContaining({
          route: RouteKind.Cctp,
          previousStatus: "attested",
          nextStatus: "delivered",
          verifiedDelivery: true,
        }),
      ]);

      const runIds = workerRuns.recentRuns.map((r: { runId: string }) => r.runId);
      expect(runIds).toEqual(["job-catchup-complete-2", "job-catchup-partial-1"]);
    } finally {
      await app.close();
    }
  });

  it("closes crashed in-flight runs as partial on restart and never conflates separate jobs", async () => {
    const trackerBeforeCrash = new WorkerRunTracker({
      db: pgliteDb,
      network: "testnet",
      expectedChains: ["stellar-testnet"],
      expectedRails: [],
    });
    await trackerBeforeCrash.beginRun("job-crash-before-restart");
    await trackerBeforeCrash.recordScan({
      chainKey: "stellar-testnet",
      family: "stellar",
      fromPosition: 5_433_810n,
      toPosition: 5_433_900n,
      decodedCount: 2,
      skippedCount: 0,
      behindCount: 50,
    });
    // Simulate process crash before finishRun() is ever called.

    // Next process restarts and even accidentally receives the same env HYPERION_WORKER_RUN_ID:
    const trackerAfterRestart = new WorkerRunTracker({
      db: pgliteDb,
      network: "testnet",
      expectedChains: ["stellar-testnet"],
      expectedRails: [],
    });
    const restarted = await trackerAfterRestart.beginRun("job-crash-before-restart");
    expect(restarted.runId).not.toBe("job-crash-before-restart");
    await trackerAfterRestart.recordIdleHeadObservation("stellar-testnet", 0);
    await trackerAfterRestart.finishRun();

    const crashedRow = await pgliteDb.query(
      "SELECT status, ended_reason FROM worker_run WHERE run_id = $1",
      ["job-crash-before-restart"],
    );
    expect(crashedRow.rows[0]).toEqual({
      status: "partial",
      ended_reason: "interrupted_by_restart",
    });

    const newRow = await pgliteDb.query(
      "SELECT status, ended_reason FROM worker_run WHERE run_id = $1",
      [restarted.runId],
    );
    expect(newRow.rows[0]).toEqual({
      status: "completed",
      ended_reason: "caught_up",
    });
  });
});
