import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { AddressKind, encodeStellarAddress } from "@hyperion/protocol";
import {
  Account,
  Keypair,
  SorobanDataBuilder,
  StrKey,
  Transaction,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/config.js";
import type { Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";
import { processClaimSettlement } from "../../src/keeper/jobs/claims.js";
import { processTtlBump } from "../../src/keeper/jobs/ttl.js";
import {
  claimRestoreScopeKey,
  PostgresRestoreCheckpointStore,
  UncertainRestoreError,
} from "../../src/keeper/restore.js";
import { submitStellar } from "../../src/keeper/stellar.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

class PGliteDatabase implements Transactional {
  constructor(readonly pg: PGlite) {}

  async query(text: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
    const res = await this.pg.query(text, params as unknown[]);
    return {
      rows: res.rows as Record<string, unknown>[],
      rowCount: res.affectedRows ?? res.rows.length,
    };
  }

  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (tx) => {
      const wrapped: Queryable = {
        async query(text: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
          const res = await tx.query(text, params as unknown[]);
          return {
            rows: res.rows as Record<string, unknown>[],
            rowCount: res.affectedRows ?? res.rows.length,
          };
        },
      };
      return work(wrapped);
    });
  }
}

async function openMigratedDb(): Promise<{ db: PGliteDatabase; close: () => Promise<void> }> {
  const pg = new PGlite();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const raw = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const [upBlock] = raw.split("-- Down Migration");
    if (upBlock) {
      await pg.exec(upBlock);
    }
  }
  return {
    db: new PGliteDatabase(pg),
    close: async () => {
      await pg.close();
    },
  };
}

function buildArchivedKey(contractId: string, claimId: bigint): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: xdr.ScAddress.scAddressTypeContract(
        new xdr.ContractId(StrKey.decodeContract(contractId)),
      ),
      key: xdr.ScVal.scvU64(claimId),
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
}

function makeSimulationSuccess(
  ledgerKey: xdr.LedgerKey,
  minResourceFee = "35000",
): rpc.Api.SimulateTransactionSuccessResponse {
  const builder = new SorobanDataBuilder()
    .setFootprint([], [ledgerKey])
    .setResources(800_000, 4_096, 2_048)
    .setResourceFee(minResourceFee);
  return {
    id: "sim-ok",
    latestLedger: 5_500_000,
    events: [],
    _parsed: true,
    transactionData: builder,
    minResourceFee,
    result: {
      auth: [],
      retval: xdr.ScVal.scvVoid(),
    },
  };
}

function makeSimulationRestore(
  ledgerKey: xdr.LedgerKey,
  restoreFee = "55000",
): rpc.Api.SimulateTransactionRestoreResponse {
  const invokeData = new SorobanDataBuilder()
    .setFootprint([], [ledgerKey])
    .setResources(900_000, 4_096, 2_048)
    .setResourceFee("40000");
  const restoreData = new SorobanDataBuilder()
    .setFootprint([], [ledgerKey])
    .setResources(250_000, 2_048, 2_048)
    .setResourceFee(restoreFee);
  return {
    id: "sim-restore",
    latestLedger: 5_500_000,
    events: [],
    _parsed: true,
    transactionData: invokeData,
    minResourceFee: "40000",
    result: {
      auth: [],
      retval: xdr.ScVal.scvVoid(),
    },
    restorePreamble: {
      minResourceFee: restoreFee,
      transactionData: restoreData,
    },
  };
}

function txInfo(status: rpc.Api.GetTransactionStatus): rpc.Api.GetTransactionResponse {
  return { status } as rpc.Api.GetTransactionResponse;
}

describe("Keeper archived Soroban entry reconciliation", () => {
  let closeDb: (() => Promise<void>) | null = null;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    if (closeDb) {
      await closeDb();
      closeDb = null;
    }
  });

  it("restores archived claim entries via RestoreFootprintOp without treating them as absent or altering recipient and amount", async () => {
    const { db, close } = await openMigratedDb();
    closeDb = close;
    const restoreStore = new PostgresRestoreCheckpointStore(db);

    const signer = Keypair.random();
    const config = loadConfig({
      env: completeEnv({ KEEPER_STELLAR_SECRET: signer.secret() }),
    });
    const chain = config.indexer.stellar;
    if (!chain) throw new Error("Expected Stellar config");

    const muxedRecipient = encodeStellarAddress(
      AddressKind.MuxedAccount,
      new Uint8Array(32).fill(0x44),
      987654321n,
    );
    const exactAmount = "99999999999999999999999999999999999999";
    await db.query(
      `INSERT INTO pending_claim
         (chain, claim_id, recipient, token, amount, route, source_chain, source_nonce, created_at)
       VALUES ($1, $2, $3, $4, $5, 0, 'sepolia', 101, now())`,
      [
        chain.chain,
        "77",
        muxedRecipient,
        "CD5IB466XCQIUDYWV22PUMJTF6EE3KPXBDGLLBSKAPNE6QPXVUZLXJGA",
        exactAmount,
      ],
    );

    const archivedKey = buildArchivedKey(chain.routerContractId, 77n);
    let currentSequence = 500n;
    const sentTransactions: Transaction[] = [];

    vi.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({
      passphrase: chain.networkPassphrase,
      protocolVersion: "22",
    });
    vi.spyOn(rpc.Server.prototype, "getAccount").mockImplementation(() =>
      Promise.resolve(new Account(signer.publicKey(), String(currentSequence))),
    );

    let simulateCalls = 0;
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(() => {
      simulateCalls += 1;
      if (simulateCalls === 1) {
        return Promise.resolve(makeSimulationRestore(archivedKey));
      }
      return Promise.resolve(makeSimulationSuccess(archivedKey));
    });

    vi.spyOn(rpc.Server.prototype, "sendTransaction").mockImplementation((tx) => {
      if (tx instanceof Transaction) {
        sentTransactions.push(tx);
      }
      currentSequence += 1n;
      const hash = Buffer.from(tx.hash()).toString("hex");
      return Promise.resolve({
        status: "PENDING",
        hash,
        latestLedger: 5_500_001,
        latestLedgerCloseTime: 1_700_000_000,
      });
    });

    vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue(
      txInfo(rpc.Api.GetTransactionStatus.SUCCESS),
    );

    const { logger, lines } = capturingLogger();
    const result = await processClaimSettlement({
      config,
      db,
      logger,
      restoreStore,
      pollIntervalMs: 0,
    });

    expect(result.settled).toBe(1);
    expect(result.attempted).toBe(1);
    expect(result.pending).toBe(0);
    expect(result.restoredClaims).toEqual(["77"]);
    expect(result.archivedPendingClaims).toEqual([]);

    // First transaction is an explicit RestoreFootprintOp; second is settle_claim(sender, 77).
    expect(sentTransactions).toHaveLength(2);
    const [restoreTx, settleTx] = sentTransactions;
    expect(restoreTx?.operations[0]?.type).toBe("restoreFootprint");
    expect(settleTx?.operations[0]?.type).toBe("invokeHostFunction");
    expect(BigInt(settleTx?.sequence ?? "0")).toBe(BigInt(restoreTx?.sequence ?? "0") + 1n);

    // Recorded pending_claim recipient and exact integer-string amount remain untouched.
    const claimCheck = await db.query(
      "SELECT recipient, amount, settled FROM pending_claim WHERE chain = $1 AND claim_id = 77",
      [chain.chain],
    );
    expect(claimCheck.rows[0]?.recipient).toBe(muxedRecipient);
    expect(String(claimCheck.rows[0]?.amount)).toBe(exactAmount);
    expect(claimCheck.rows[0]?.settled).toBe(false);

    // Durable checkpoint was marked confirmed with snapshots intact and zero secret material logged.
    const checkpointRows = await db.query(
      "SELECT status, recipient_snapshot, amount_snapshot FROM keeper_restore_checkpoint WHERE scope_key = $1",
      [claimRestoreScopeKey(chain.chain, 77n)],
    );
    expect(checkpointRows.rows[0]?.status).toBe("confirmed");
    expect(checkpointRows.rows[0]?.recipient_snapshot).toBe(muxedRecipient);
    expect(String(checkpointRows.rows[0]?.amount_snapshot)).toBe(exactAmount);
    expect(JSON.stringify(lines)).not.toContain(signer.secret());
  });

  it("persists uncertain restore hashes durably, prevents blind duplicate submissions, and reconciles before settling", async () => {
    const { db, close } = await openMigratedDb();
    closeDb = close;
    const restoreStore = new PostgresRestoreCheckpointStore(db);

    const signer = Keypair.random();
    const config = loadConfig({
      env: completeEnv({ KEEPER_STELLAR_SECRET: signer.secret() }),
    });
    const chain = config.indexer.stellar;
    if (!chain) throw new Error("Expected Stellar config");

    const accountRecipient = encodeStellarAddress(
      AddressKind.Account,
      new Uint8Array(32).fill(0x21),
    );
    await db.query(
      `INSERT INTO pending_claim
         (chain, claim_id, recipient, token, amount, route, source_chain, source_nonce, created_at)
       VALUES ($1, 88, $2, $3, '250000000', 0, 'sepolia', 202, now())`,
      [chain.chain, accountRecipient, "CD5IB466XCQIUDYWV22PUMJTF6EE3KPXBDGLLBSKAPNE6QPXVUZLXJGA"],
    );

    const archivedKey = buildArchivedKey(chain.routerContractId, 88n);
    let currentSequence = 900n;
    let savedRestoreHash = "";
    let sendCalls = 0;

    vi.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({
      passphrase: chain.networkPassphrase,
      protocolVersion: "22",
    });
    vi.spyOn(rpc.Server.prototype, "getAccount").mockImplementation(() =>
      Promise.resolve(new Account(signer.publicKey(), String(currentSequence))),
    );

    let restoredOnChain = false;
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(() => {
      if (!restoredOnChain) {
        return Promise.resolve(makeSimulationRestore(archivedKey));
      }
      return Promise.resolve(makeSimulationSuccess(archivedKey));
    });

    // Pass 1: sendTransaction throws a network timeout AFTER restoreTx was signed and checkpointed.
    const sendSpy = vi.spyOn(rpc.Server.prototype, "sendTransaction").mockImplementation((tx) => {
      sendCalls += 1;
      savedRestoreHash = Buffer.from(tx.hash()).toString("hex");
      return Promise.reject(new Error("socket hang up after broadcast"));
    });

    const { logger } = capturingLogger();
    const pass1 = await processClaimSettlement({ config, db, logger, restoreStore });
    expect(pass1.settled).toBe(0);
    expect(pass1.pending).toBe(1);
    expect(pass1.archivedPendingClaims).toEqual(["88"]);
    expect(sendCalls).toBe(1);

    const pendingRecord = await restoreStore.getUnresolved(claimRestoreScopeKey(chain.chain, 88n));
    expect(pendingRecord?.restoreTxHash).toBe(savedRestoreHash);
    expect(pendingRecord?.status).toBe("uncertain");

    // Pass 2: RPC still reports NOT_FOUND for savedRestoreHash -> must NOT broadcast a second tx!
    const getTxSpy = vi
      .spyOn(rpc.Server.prototype, "getTransaction")
      .mockResolvedValue(txInfo(rpc.Api.GetTransactionStatus.NOT_FOUND));

    const pass2 = await processClaimSettlement({ config, db, logger, restoreStore });
    expect(pass2.settled).toBe(0);
    expect(pass2.pending).toBe(1);
    expect(pass2.archivedPendingClaims).toEqual(["88"]);
    expect(sendCalls).toBe(1);

    // Pass 3: Saved restore hash lands on-chain -> reconciles checkpoint to confirmed and settles claim once!
    restoredOnChain = true;
    currentSequence = 901n;
    getTxSpy.mockImplementation((hash: string) => {
      if (hash === savedRestoreHash) {
        return Promise.resolve(txInfo(rpc.Api.GetTransactionStatus.SUCCESS));
      }
      return Promise.resolve(txInfo(rpc.Api.GetTransactionStatus.SUCCESS));
    });
    sendSpy.mockImplementation((tx) => {
      sendCalls += 1;
      currentSequence += 1n;
      return Promise.resolve({
        status: "PENDING",
        hash: Buffer.from(tx.hash()).toString("hex"),
        latestLedger: 5_500_010,
        latestLedgerCloseTime: 1_700_000_050,
      });
    });

    const pass3 = await processClaimSettlement({
      config,
      db,
      logger,
      restoreStore,
      pollIntervalMs: 0,
    });

    expect(pass3.settled).toBe(1);
    expect(pass3.pending).toBe(0);
    expect(pass3.restoredClaims).toEqual(["88"]);
    // Only 1 additional sendTransaction call (the post-restore settle_claim itself, zero duplicate restores!).
    expect(sendCalls).toBe(2);
    expect(await restoreStore.getUnresolved(claimRestoreScopeKey(chain.chain, 88n))).toBeNull();
  });

  it("restores archived router footprints before TTL keep_alive and surfaces uncertain restore errors cleanly", async () => {
    const { db, close } = await openMigratedDb();
    closeDb = close;
    const restoreStore = new PostgresRestoreCheckpointStore(db);

    const signer = Keypair.random();
    const config = loadConfig({
      env: completeEnv({ KEEPER_STELLAR_SECRET: signer.secret() }),
    });
    const chain = config.indexer.stellar;
    if (!chain) throw new Error("Expected Stellar config");

    const archivedKey = buildArchivedKey(chain.routerContractId, 1n);
    let currentSequence = 100n;
    let simCount = 0;

    vi.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({
      passphrase: chain.networkPassphrase,
      protocolVersion: "22",
    });
    vi.spyOn(rpc.Server.prototype, "getAccount").mockImplementation(() =>
      Promise.resolve(new Account(signer.publicKey(), String(currentSequence))),
    );
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(() => {
      simCount += 1;
      return Promise.resolve(
        simCount === 1
          ? makeSimulationRestore(archivedKey, "22000")
          : makeSimulationSuccess(archivedKey),
      );
    });
    vi.spyOn(rpc.Server.prototype, "sendTransaction").mockImplementation((tx) => {
      currentSequence += 1n;
      return Promise.resolve({
        status: "PENDING",
        hash: Buffer.from(tx.hash()).toString("hex"),
        latestLedger: 5_500_020,
        latestLedgerCloseTime: 1_700_000_100,
      });
    });
    vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue(
      txInfo(rpc.Api.GetTransactionStatus.SUCCESS),
    );

    const { logger } = capturingLogger();
    const ttlResult = await processTtlBump({
      config,
      db,
      logger,
      restoreStore,
      pollIntervalMs: 0,
    });

    expect(ttlResult.dryRun).toBe(false);
    expect(ttlResult.restoreSummary?.restoredFootprints).toBe(1);
    expect(ttlResult.restoreSummary?.restoredKeys).toBe(1);
    expect(ttlResult.restoreSummary?.restoreTxHashes).toHaveLength(1);

    // Also verify direct submitStellar polling timeout produces UncertainRestoreError.
    simCount = 0;
    vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue(
      txInfo(rpc.Api.GetTransactionStatus.NOT_FOUND),
    );
    await expect(
      submitStellar(config, chain.routerContractId, "keep_alive", () => [], {
        scopeKey: "ttl-bump:timeout-test",
        restoreStore,
        pollIntervalMs: 0,
        maxPollAttempts: 2,
      }),
    ).rejects.toBeInstanceOf(UncertainRestoreError);
  });
});
