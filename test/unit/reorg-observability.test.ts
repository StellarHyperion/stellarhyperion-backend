import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

import { EvmWatcher } from "../../src/chains/evm/watcher.js";
import { ReorgRecoveryJournal } from "../../src/chains/reorg-journal.js";
import { writeAttestation } from "../../src/chains/writers.js";
import { loadConfig } from "../../src/config/config.js";
import type { Database, Queryable, Transactional } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import { ANVIL_CHAIN_ID, ANVIL_ROUTER, FakeEvmClient, encodedLog } from "../evm-fakes.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const SENDER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const RECIPIENT = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const TOKEN = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const MESSAGE_ID = `0x${"ab".repeat(32)}` as const;
const DEST_WORD = `0x000000000000000000000000${RECIPIENT.slice(2)}` as const;

interface PgliteHarness {
  readonly pg: PGlite;
  readonly db: Database & Transactional & { failNextTx: Error | null };
}

async function createMigratedDb(): Promise<PgliteHarness> {
  const pg = new PGlite();
  for (const name of [
    "1790900000000_initial-schema.sql",
    "1791000000000_cursor-block-hash.sql",
    "1791100000000_cursor-autovacuum-tuning.sql",
    "1791200000000_reorg-recovery-journal.sql",
  ]) {
    const sql = readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8").split(
      "-- Down Migration",
    )[0]!;
    await pg.exec(sql);
  }

  const runQuery = async (sql: string, params: readonly unknown[] = []) => {
    const normalizedParams = params.map((p) => (p instanceof Date ? p.toISOString() : p));
    const result = await pg.query(sql, normalizedParams);
    const int8 = result.fields
      .filter((field) => field.dataTypeID === 20)
      .map((field) => field.name);
    const rows = result.rows.map((raw) => {
      const row = { ...(raw as Record<string, unknown>) };
      for (const column of int8) {
        const value = row[column];
        if (typeof value === "number" || typeof value === "bigint") row[column] = String(value);
      }
      return row;
    });
    return { rows, rowCount: result.affectedRows ?? result.rows.length };
  };

  const db = {
    failNextTx: null as Error | null,
    query: runQuery,
    ping: async () => {
      await pg.query("SELECT 1");
    },
    close: async () => {
      await pg.close();
    },
    transaction: async <T>(work: (tx: Queryable) => Promise<T>): Promise<T> => {
      await pg.exec("BEGIN");
      try {
        const tx: Queryable = { query: runQuery };
        const out = await work(tx);
        if (db.failNextTx !== null) {
          const err = db.failNextTx;
          db.failNextTx = null;
          throw err;
        }
        await pg.exec("COMMIT");
        return out;
      } catch (err) {
        await pg.exec("ROLLBACK");
        throw err;
      }
    },
  };

  return { pg, db: db as unknown as Database & Transactional & { failNextTx: Error | null } };
}

function bridgeOutLog(blockNumber: bigint, nonce: bigint, txSuffix: string) {
  return encodedLog(
    "BridgeOut",
    {
      route: 0,
      nonce,
      sender: SENDER,
      token: TOKEN,
      grossAmount: 1_000_000n,
      fee: 3_000n,
      netAmount: 997_000n,
      destinationChain: "stellar-testnet",
      destination: DEST_WORD,
      railRef: MESSAGE_ID,
    },
    {
      blockNumber,
      logIndex: 0,
      txHash: `0x${txSuffix.padStart(64, "1")}`,
    },
  );
}

function parkedInboundLogs(
  blockNumber: bigint,
  claimId: bigint,
  sourceNonce: bigint,
  txSuffix: string,
) {
  const txHash = `0x${txSuffix.padStart(64, "2")}` as const;
  return [
    encodedLog(
      "ClaimParked",
      {
        id: claimId,
        recipient: RECIPIENT,
        token: TOKEN,
        amount: 500_000n,
        route: 0,
        sourceChain: "stellar-testnet",
        sourceNonce,
      },
      { blockNumber, logIndex: 0, txHash },
    ),
    encodedLog(
      "BridgeIn",
      {
        route: 0,
        recipient: RECIPIENT,
        token: TOKEN,
        amount: 500_000n,
        sourceChain: "stellar-testnet",
        sourceNonce,
        messageId: MESSAGE_ID,
      },
      { blockNumber, logIndex: 1, txHash },
    ),
  ];
}

describe("EVM reorg recovery observability", () => {
  const openHarnesses: PgliteHarness[] = [];

  afterEach(async () => {
    while (openHarnesses.length > 0) {
      const h = openHarnesses.pop()!;
      await h.pg.close();
    }
  });

  it("tracks shallow automatic recovery, affected canonical proof counts, and commits reconciled state", async () => {
    const harness = await createMigratedDb();
    openHarnesses.push(harness);

    const initialLogs = [bridgeOutLog(38n, 1n, "aa"), ...parkedInboundLogs(39n, 7n, 42n, "bb")];
    const client = new FakeEvmClient({ logs: initialLogs, head: 43n });
    const { logger } = capturingLogger();
    const journal = new ReorgRecoveryJournal(harness.db);

    const watcher = new EvmWatcher({
      chainKey: "sepolia",
      router: ANVIL_ROUTER,
      chainId: ANVIL_CHAIN_ID,
      startBlock: 35n,
      confirmations: 3,
      reorgDepth: 5,
      logRange: 2,
      client,
      db: harness.db,
      logger,
      reorgJournal: journal,
    });

    // Initial catch-up to confirmed block 40 (43 - 3)
    while (await watcher.tick(AbortSignal.timeout(5_000))) {
      // advance batches
    }
    expect(watcher.readiness().state).toBe("ready");

    // Attach a rail attestation to the outbound transfer in the reorg window
    const outRes = await harness.db.query("SELECT id FROM outbound_transfer WHERE nonce = '1'");
    const transferId = BigInt(String(outRes.rows[0]?.id));
    await writeAttestation(harness.db, {
      transferId,
      route: 0,
      status: "attested",
      railStatus: "complete",
      railReference: "iris-ref-1",
      checkedAt: new Date("2026-10-29T12:00:00Z"),
      attestedAt: new Date("2026-10-29T12:00:00Z"),
      checkFailures: 0,
      lastError: null,
    });

    // Separate API-only server reading strictly from PostgreSQL
    const config = loadConfig({
      env: completeEnv({ INDEXER_ENABLED: "false", KEEPER_ENABLED: "false" }),
    });
    const app = buildServer({
      config,
      logger,
      db: harness.db,
      readiness: [],
    });

    // Trigger shallow reorg from block 38 with re-mined canonical proofs
    const replacementLogs = [bridgeOutLog(38n, 1n, "cc"), ...parkedInboundLogs(39n, 7n, 42n, "dd")];
    client.reorg(38n, replacementLogs);
    client.advanceHeadTo(44n);

    // First wind-back batch covers 36..37 (< cursorBlock 40): still winding_back!
    await watcher.tick(AbortSignal.timeout(5_000));
    expect(watcher.readiness().state).toBe("degraded");

    const midReady = await app.inject({ method: "GET", url: "/ready" });
    expect(midReady.statusCode).toBe(200);
    expect(midReady.json().status).toBe("degraded");
    expect(midReady.json().reorgRecovery).toEqual({
      state: "degraded",
      activeCount: 1,
      rollbackFailed: 0,
      operatorInterventionRequired: 0,
    });

    const midMetrics = (await app.inject({ method: "GET", url: "/v1/metrics" })).json();
    expect(midMetrics.reorgRecovery.totals.windingBack).toBe(1);
    expect(midMetrics.reorgRecovery.activeRecoveries[0]).toMatchObject({
      chain: "sepolia",
      cursorBlock: "40",
      rewindToBlock: "36",
      reindexedThroughBlock: "37",
      detectedDepth: 5,
      rollbackBlocks: 5,
      classification: "shallow_automatic",
      reconciliationStatus: "winding_back",
      affectedProofs: {
        outboundTransfers: 1,
        inboundDeliveries: 1,
        pendingClaims: 1,
        railAttestations: 1,
      },
    });

    // Finish wind-back through 40 and catch up to 41
    while (await watcher.tick(AbortSignal.timeout(5_000))) {
      // finish batches
    }

    expect(watcher.readiness().state).toBe("ready");
    const finalMetrics = (await app.inject({ method: "GET", url: "/v1/metrics" })).json();
    expect(finalMetrics.reorgRecovery.totals).toEqual({
      detected: 1,
      shallowAutomatic: 1,
      deepOperatorRequired: 0,
      windingBack: 0,
      reconciled: 1,
      rollbackFailed: 0,
      operatorInterventionRequired: 0,
    });
    expect(finalMetrics.reorgRecovery.recentEvents[0]).toMatchObject({
      classification: "shallow_automatic",
      reconciliationStatus: "reconciled",
      rewrittenCanonicalProofs: 2,
    });
    expect(finalMetrics.reorgRecovery.activeRecoveries).toHaveLength(0);

    const finalReady = await app.inject({ method: "GET", url: "/ready" });
    expect(finalReady.json().status).toBe("ready");
    expect(finalReady.json().reorgRecovery.state).toBe("ready");
    await app.close();
  });

  it("distinguishes deep operator intervention when anchor is non-canonical or canonical proof vanishes", async () => {
    const harness = await createMigratedDb();
    openHarnesses.push(harness);

    const client = new FakeEvmClient({
      logs: [bridgeOutLog(39n, 9n, "ee")],
      head: 43n,
    });
    const { logger } = capturingLogger();
    const journal = new ReorgRecoveryJournal(harness.db);

    let anchorCanonical = true;
    const watcher = new EvmWatcher({
      chainKey: "sepolia",
      router: ANVIL_ROUTER,
      chainId: ANVIL_CHAIN_ID,
      startBlock: 30n,
      confirmations: 3,
      reorgDepth: 4,
      logRange: 50,
      client,
      db: harness.db,
      logger,
      reorgJournal: journal,
      isAnchorBlockCanonical: () => Promise.resolve(anchorCanonical),
    });

    await watcher.tick(AbortSignal.timeout(5_000));
    expect(watcher.readiness().state).toBe("ready");

    // Reorg deeper than reorgDepth=4: anchor block 36 is also non-canonical
    anchorCanonical = false;
    client.reorg(35n, []);
    await watcher.tick(AbortSignal.timeout(5_000));

    expect(watcher.readiness().state).toBe("degraded");
    expect(watcher.readiness().detail).toContain("operator intervention required");

    const config = loadConfig({
      env: completeEnv({ INDEXER_ENABLED: "false", KEEPER_ENABLED: "false" }),
    });
    const app = buildServer({ config, logger, db: harness.db, readiness: [] });

    const metrics = (await app.inject({ method: "GET", url: "/v1/metrics" })).json();
    expect(metrics.reorgRecovery.totals).toMatchObject({
      detected: 1,
      shallowAutomatic: 0,
      deepOperatorRequired: 1,
      operatorInterventionRequired: 1,
      reconciled: 0,
    });
    expect(metrics.reorgRecovery.activeRecoveries[0]).toMatchObject({
      classification: "deep_operator_required",
      reconciliationStatus: "operator_intervention_required",
      detectedDepth: 5,
      affectedProofs: {
        outboundTransfers: 1,
        inboundDeliveries: 0,
        pendingClaims: 0,
        railAttestations: 0,
      },
    });

    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.json().status).toBe("degraded");
    expect(ready.json().reorgRecovery.operatorInterventionRequired).toBe(1);
    await app.close();
  });

  it("ensures failed rollback never looks like healthy catch-up and aligns metrics with committed state", async () => {
    const harness = await createMigratedDb();
    openHarnesses.push(harness);

    const client = new FakeEvmClient({
      logs: [bridgeOutLog(38n, 2n, "99")],
      head: 43n,
    });
    const { logger } = capturingLogger();
    const journal = new ReorgRecoveryJournal(harness.db);

    const watcher = new EvmWatcher({
      chainKey: "sepolia",
      router: ANVIL_ROUTER,
      chainId: ANVIL_CHAIN_ID,
      startBlock: 35n,
      confirmations: 3,
      reorgDepth: 5,
      logRange: 50,
      client,
      db: harness.db,
      logger,
      reorgJournal: journal,
    });

    await watcher.tick(AbortSignal.timeout(5_000));
    expect(watcher.readiness().state).toBe("ready");

    // Reorg at 38 and force transaction commit failure containing a credentialed URL
    client.reorg(38n, [bridgeOutLog(38n, 2n, "77")]);
    harness.db.failNextTx = new Error(
      "serialization failure on postgresql://hyperion:topsecret@db.internal:5432/prod",
    );

    await expect(watcher.tick(AbortSignal.timeout(5_000))).rejects.toThrow("serialization failure");

    // Watcher must immediately report degraded rollback failure rather than ready
    expect(watcher.readiness().state).toBe("degraded");
    expect(watcher.readiness().detail).toContain("reorg rollback failed");
    expect(watcher.readiness().detail).not.toContain("topsecret");

    const config = loadConfig({
      env: completeEnv({ INDEXER_ENABLED: "false", KEEPER_ENABLED: "false" }),
    });
    const app = buildServer({ config, logger, db: harness.db, readiness: [] });

    const failedMetrics = (await app.inject({ method: "GET", url: "/v1/metrics" })).json();
    expect(failedMetrics.reorgRecovery.totals).toMatchObject({
      detected: 1,
      reconciled: 0,
      rollbackFailed: 1,
    });
    expect(failedMetrics.reorgRecovery.activeRecoveries[0]?.reconciliationStatus).toBe(
      "rollback_failed",
    );
    expect(failedMetrics.reorgRecovery.activeRecoveries[0]?.lastError).not.toContain("topsecret");
    expect(failedMetrics.reorgRecovery.activeRecoveries[0]?.reindexedThroughBlock).toBeNull();

    const failedReady = await app.inject({ method: "GET", url: "/ready" });
    expect(failedReady.json().status).toBe("degraded");
    expect(failedReady.json().reorgRecovery.rollbackFailed).toBe(1);

    // Next tick succeeds and reconciles the exact same journal entry without duplicating it
    await watcher.tick(AbortSignal.timeout(5_000));
    expect(watcher.readiness().state).toBe("ready");

    const recoveredMetrics = (await app.inject({ method: "GET", url: "/v1/metrics" })).json();
    expect(recoveredMetrics.reorgRecovery.totals).toMatchObject({
      detected: 1,
      reconciled: 1,
      rollbackFailed: 0,
    });
    await app.close();
  });
});
