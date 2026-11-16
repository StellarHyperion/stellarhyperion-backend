import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { Account, Keypair, rpc } from "@stellar/stellar-sdk";
import type { Transaction } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import type { Database, Queryable, QueryResultRows } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import { processClaimSettlement } from "../../src/keeper/jobs/claims.js";
import { processTtlBump } from "../../src/keeper/jobs/ttl.js";
import { KeeperOutcomeTracker } from "../../src/keeper/outcomes.js";
import type { StellarKeeperRpcClient } from "../../src/keeper/stellar.js";
import { KeeperWorker } from "../../src/keeper/worker.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

function migrationPath(name: string): string {
  return fileURLToPath(new URL(`../../migrations/${name}`, import.meta.url));
}

describe("keeper transaction outcome metrics", () => {
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
      "1791200000000_keeper-tx-outcomes.sql",
    ]) {
      const sql = readFileSync(migrationPath(name), "utf8").split("-- Down Migration")[0]!;
      await pg.exec(sql);
    }

    await pg.exec(`
      INSERT INTO outbound_transfer (
        origin_chain, route, nonce, sender, token,
        gross_amount, fee, net_amount, destination_chain, destination,
        origin_block, origin_tx
      ) VALUES (
        'stellar-testnet', 1, 77, 'Gsender', 'USDC',
        10000000, 30000, 9970000, 'sepolia',
        '0x0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38',
        1287410, 'source-hash-115'
      );
      INSERT INTO pending_claim (
        chain, claim_id, recipient, token, amount, route, source_chain, source_nonce, created_at
      ) VALUES (
        'stellar-testnet', 15, 'Grecipient', 'USDC', 9970000, 1, 'sepolia', 5, now()
      ), (
        'stellar-testnet', 16, 'Grecipient2', 'USDC', 5000000, 1, 'sepolia', 6, now()
      );
    `);
  }, 30_000);

  afterAll(async () => {
    await pg.close();
  });

  it("increments only simulated outcomes during dry-run work and never increments confirmed counts", async () => {
    const dryRunConfig = loadConfig({
      env: completeEnv({ KEEPER_ENABLED: "false" }),
    });
    const outcomes = new KeeperOutcomeTracker(pgliteDb);
    const { logger } = capturingLogger();

    const ttlRes = await processTtlBump({ config: dryRunConfig, db: pgliteDb, logger, outcomes });
    const claimRes = await processClaimSettlement({
      config: dryRunConfig,
      db: pgliteDb,
      logger,
      outcomes,
    });

    expect(ttlRes.dryRun).toBe(true);
    expect(claimRes.dryRun).toBe(true);

    const app = buildServer({ config: dryRunConfig, logger, db: pgliteDb, readiness: [] });
    try {
      const metricsRes = await app.inject({ method: "GET", url: "/v1/metrics" });
      expect(metricsRes.statusCode).toBe(200);
      const keeperOutcomes = metricsRes.json().keeperOutcomes;
      expect(keeperOutcomes.totals).toEqual({
        simulated: 2,
        submitted: 0,
        pending: 0,
        confirmed: 0,
        failed: 0,
      });
      expect(keeperOutcomes.byJobKind["ttl-bump"].simulated).toBe(1);
      expect(keeperOutcomes.byJobKind["ttl-bump"].confirmed).toBe(0);
      expect(keeperOutcomes.byJobKind["claim-settlement"].simulated).toBe(1);
      expect(keeperOutcomes.byJobKind["claim-settlement"].confirmed).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("persists pending submissions across shutdown/recovery and reconciles confirmed and failed hashes with bounded metric keys", async () => {
    const dynamicSecret = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(21)).secret();
    const signerConfig = loadConfig({
      env: completeEnv({ KEEPER_STELLAR_SECRET: dynamicSecret }),
    });
    const passphrase = signerConfig.indexer.stellar?.networkPassphrase ?? "";

    const txStatuses = new Map<string, string>([
      ["tx_hash_ttl_pending_115", rpc.Api.GetTransactionStatus.NOT_FOUND],
      ["tx_hash_claim_ok_115", rpc.Api.GetTransactionStatus.SUCCESS],
      ["tx_hash_claim_pending_fail_115", rpc.Api.GetTransactionStatus.NOT_FOUND],
    ]);
    const sendQueue = [
      "tx_hash_ttl_pending_115",
      "tx_hash_claim_ok_115",
      "tx_hash_claim_pending_fail_115",
    ];
    let seq = 100n;

    const fakeRpc: StellarKeeperRpcClient = {
      getNetwork: () => Promise.resolve({ passphrase }),
      getAccount: (publicKey: string) => {
        seq += 1n;
        return Promise.resolve(new Account(publicKey, seq.toString()));
      },
      prepareTransaction: (tx: Transaction) => Promise.resolve(tx),
      sendTransaction: () => {
        const nextHash = sendQueue.shift() ?? "tx_unexpected";
        return Promise.resolve({ hash: nextHash, status: "PENDING" });
      },
      getTransaction: (hash: string) =>
        Promise.resolve({
          status: txStatuses.get(hash) ?? rpc.Api.GetTransactionStatus.NOT_FOUND,
        }),
    };

    const outcomesBeforeRestart = new KeeperOutcomeTracker(pgliteDb);
    const { logger } = capturingLogger();

    // 1. TTL submission broadcasts, stays NOT_FOUND at poll cutoff, and throws pending error.
    await expect(
      processTtlBump({
        config: signerConfig,
        db: pgliteDb,
        logger,
        outcomes: outcomesBeforeRestart,
        rpcClient: fakeRpc,
        pollAttempts: 1,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow("remains pending");

    // 2. Claim settlement: first claim confirms immediately, second claim stays pending at cutoff.
    const claimResult = await processClaimSettlement({
      config: signerConfig,
      db: pgliteDb,
      logger,
      outcomes: outcomesBeforeRestart,
      rpcClient: fakeRpc,
      pollAttempts: 1,
      pollIntervalMs: 0,
    });
    expect(claimResult.settled).toBe(1);
    expect(claimResult.pending).toBe(1);

    // Simulate separate API-only replica / post-shutdown inspection reading only persisted DB state.
    const apiConfig = loadConfig({ env: completeEnv({ KEEPER_ENABLED: "false" }) });
    const apiApp = buildServer({ config: apiConfig, logger, db: pgliteDb, readiness: [] });

    try {
      const beforeRecoveryRes = await apiApp.inject({ method: "GET", url: "/v1/metrics" });
      expect(beforeRecoveryRes.statusCode).toBe(200);
      expect(beforeRecoveryRes.payload).not.toContain(dynamicSecret);

      const snapshot = beforeRecoveryRes.json().keeperOutcomes;
      expect(snapshot.totals).toEqual({
        simulated: 2,
        submitted: 3,
        pending: 2,
        confirmed: 1,
        failed: 0,
      });

      // Metric keys are strictly bounded low-cardinality dimensions (never arbitrary tx hashes).
      expect(Object.keys(snapshot.totals).sort()).toEqual([
        "confirmed",
        "failed",
        "pending",
        "simulated",
        "submitted",
      ]);
      expect(Object.keys(snapshot.byJobKind).sort()).toEqual(["claim-settlement", "ttl-bump"]);

      const pendingHashes = snapshot.pendingSubmissions.map(
        (entry: { txHash: string }) => entry.txHash,
      );
      expect(pendingHashes).toEqual(["tx_hash_ttl_pending_115", "tx_hash_claim_pending_fail_115"]);

      const readyRes = await apiApp.inject({ method: "GET", url: "/ready" });
      expect(readyRes.json().keeperPendingSubmissions).toBe(2);

      // 3. Recovery: chain settles TTL tx as SUCCESS and second claim tx as FAILED.
      txStatuses.set("tx_hash_ttl_pending_115", rpc.Api.GetTransactionStatus.SUCCESS);
      txStatuses.set("tx_hash_claim_pending_fail_115", rpc.Api.GetTransactionStatus.FAILED);

      const recoveredWorker = new KeeperWorker(signerConfig, pgliteDb, logger);
      await recoveredWorker.reconcileOnStartup(fakeRpc);
      // Re-running reconciliation is idempotent and must not double-count outcomes.
      await recoveredWorker.reconcileOnStartup(fakeRpc);

      const afterRecoveryRes = await apiApp.inject({ method: "GET", url: "/v1/metrics" });
      const afterSnapshot = afterRecoveryRes.json().keeperOutcomes;
      expect(afterSnapshot.totals).toEqual({
        simulated: 2,
        submitted: 3,
        pending: 0,
        confirmed: 2,
        failed: 1,
      });
      expect(afterSnapshot.pendingSubmissions).toEqual([]);
    } finally {
      await apiApp.close();
    }
  });
});
