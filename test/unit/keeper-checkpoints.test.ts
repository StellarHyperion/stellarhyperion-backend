import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { Account, Keypair, Transaction, rpc } from "@stellar/stellar-sdk";
import pino, { type Logger } from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import type { Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";
import {
  buildKeeperOperationKey,
  PostgresTxCheckpointStore,
  UncertainBroadcastError,
  UnresolvedCheckpointConflictError,
} from "../../src/keeper/checkpoints.js";
import { processClaimSettlement } from "../../src/keeper/jobs/claims.js";
import { processTtlBump } from "../../src/keeper/jobs/ttl.js";
import { completeEnv } from "../helpers.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

class PGliteDb implements Transactional {
  constructor(private readonly pg: PGlite) {}

  async query(sql: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
    const result = await this.pg.query<Record<string, unknown>>(sql, [...params]);
    return {
      rows: result.rows,
      rowCount: result.affectedRows ?? result.rows.length,
    };
  }

  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (tx) => {
      const wrapped: Queryable = {
        query: async (sql: string, params: readonly unknown[] = []) => {
          const result = await tx.query<Record<string, unknown>>(sql, [...params]);
          return {
            rows: result.rows,
            rowCount: result.affectedRows ?? result.rows.length,
          };
        },
      };
      return work(wrapped);
    });
  }
}

function rawCapturingLogger(): { logger: Logger; rawLines: string[] } {
  const rawLines: string[] = [];
  const logger = pino(
    { level: "trace" },
    {
      write(line: string) {
        rawLines.push(line);
      },
    },
  );
  return { logger, rawLines };
}

describe("Keeper signed transaction checkpoints before broadcast", () => {
  let pg: PGlite;
  let db: PGliteDb;
  let store: PostgresTxCheckpointStore;

  beforeAll(async () => {
    pg = new PGlite();
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const fullSql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      const upSql = fullSql.split("-- Down Migration")[0] ?? fullSql;
      await pg.exec(upSql);
    }
    db = new PGliteDb(pg);
    store = new PostgresTxCheckpointStore(db);
  });

  afterAll(async () => {
    await pg.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM keeper_tx_checkpoint");
    await db.query("DELETE FROM pending_claim");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function seedPendingClaim(chain: string, claimId: bigint): Promise<void> {
    await db.query(
      `INSERT INTO pending_claim
         (chain, claim_id, recipient, token, amount, route, source_chain, source_nonce, created_at, settled)
       VALUES ($1, $2, 'GRECIPIENT', 'CTOKEN', '5000000', 0, 'sepolia', $3, now(), false)`,
      [chain, String(claimId), String(claimId)],
    );
  }

  it("persists signed_pending_broadcast durably BEFORE sendTransaction and blocks broadcast if checkpoint write fails", async () => {
    const signer = Keypair.random();
    const config = loadConfig({
      env: completeEnv({ KEEPER_STELLAR_SECRET: signer.secret() }),
    });
    const chain = config.indexer.stellar!;
    await seedPendingClaim(chain.chain, 42n);

    vi.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({
      passphrase: chain.networkPassphrase,
      protocolVersion: "22",
    });
    vi.spyOn(rpc.Server.prototype, "getAccount").mockImplementation(() =>
      Promise.resolve(new Account(signer.publicKey(), "100")),
    );
    vi.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation((tx) =>
      Promise.resolve(tx as Transaction),
    );

    const observedDuringSend: { state: string | undefined; txHash: string | undefined } = {
      state: undefined,
      txHash: undefined,
    };

    const sendSpy = vi
      .spyOn(rpc.Server.prototype, "sendTransaction")
      .mockImplementation(async (tx) => {
        const expectedHash = Buffer.from(tx.hash()).toString("hex");
        const saved = await store.getByOperationKey(
          buildKeeperOperationKey("claim-settlement", chain.chain, 42n),
        );
        observedDuringSend.state = saved?.state;
        observedDuringSend.txHash = saved?.txHash;
        return {
          status: "PENDING",
          hash: expectedHash,
          latestLedger: 5_700_000,
          latestLedgerCloseTime: 1_700_000_000,
        };
      });

    vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
    } as rpc.Api.GetTransactionResponse);

    const { logger } = rawCapturingLogger();
    const result = await processClaimSettlement({
      config,
      db,
      logger,
      checkpointStore: store,
      pollIntervalMs: 0,
    });

    expect(result.settled).toBe(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(observedDuringSend.state).toBe("signed_pending_broadcast");
    expect(observedDuringSend.txHash).toMatch(/^[0-9a-f]{64}$/);

    const finalRecord = await store.getByOperationKey(
      buildKeeperOperationKey("claim-settlement", chain.chain, 42n),
    );
    expect(finalRecord?.state).toBe("confirmed");
    expect(finalRecord?.signerPublicKey).toBe(signer.publicKey());

    // Now verify that if checkpoint persistence fails, sendTransaction is NEVER called.
    await seedPendingClaim(chain.chain, 43n);
    sendSpy.mockClear();
    const failingStore = {
      getByOperationKey: () => Promise.resolve(null),
      saveSignedBeforeBroadcast: () => Promise.reject(new Error("database disk full")),
      markBroadcastUnknown: () => Promise.resolve(),
      markConfirmed: () => Promise.resolve(),
      markFailed: () => Promise.resolve(),
      countUnresolved: () => Promise.resolve(0),
    };

    const failedRun = await processClaimSettlement({
      config,
      db,
      logger,
      checkpointStore: failingStore,
      pollIntervalMs: 0,
    });
    expect(failedRun.settled).toBe(0);
    expect(failedRun.attempted).toBe(2);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("reconciles unknown broadcast outcomes by saved hash before retry and never generates a blind second claim payment attempt", async () => {
    const signer = Keypair.random();
    const config = loadConfig({
      env: completeEnv({ KEEPER_STELLAR_SECRET: signer.secret() }),
    });
    const chain = config.indexer.stellar!;
    await seedPendingClaim(chain.chain, 77n);

    let sequence = 500n;
    vi.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({
      passphrase: chain.networkPassphrase,
      protocolVersion: "22",
    });
    vi.spyOn(rpc.Server.prototype, "getAccount").mockImplementation(() =>
      Promise.resolve(new Account(signer.publicKey(), String(sequence))),
    );
    vi.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation((tx) =>
      Promise.resolve(tx as Transaction),
    );

    const signSpy = vi.spyOn(Transaction.prototype, "sign");
    let capturedEnvelopes: string[] = [];

    // Attempt 1: sendTransaction throws a network socket hangup AFTER signing & checkpointing!
    const sendSpy = vi.spyOn(rpc.Server.prototype, "sendTransaction").mockImplementation((tx) => {
      sequence += 1n;
      const envelopeXdr = tx.toXdr();
      capturedEnvelopes.push(envelopeXdr);
      return Promise.reject(
        new Error(`RPC socket hang up after sending ${envelopeXdr} for ${signer.secret()}`),
      );
    });

    const { logger, rawLines } = rawCapturingLogger();
    const firstAttempt = await processClaimSettlement({
      config,
      db,
      logger,
      checkpointStore: store,
      pollIntervalMs: 0,
    });

    expect(firstAttempt.settled).toBe(0);
    expect(firstAttempt.uncertain).toBe(1);
    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);

    const opKey = buildKeeperOperationKey("claim-settlement", chain.chain, 77n);
    const savedAfterCrash = await store.getByOperationKey(opKey);
    expect(savedAfterCrash?.state).toBe("broadcast_unknown");
    const savedHash = savedAfterCrash!.txHash;

    // Also verify SQL store refuses overwriting an unresolved checkpoint with a new txHash.
    await expect(
      store.saveSignedBeforeBroadcast({
        operationKey: opKey,
        txHash: "f".repeat(64),
        chain: chain.chain,
        jobKind: "claim-settlement",
        claimId: 77n,
        contract: chain.routerContractId,
        method: "settle_claim",
        signerPublicKey: signer.publicKey(),
        sequenceNumber: 502n,
        feeStroops: 100n,
      }),
    ).rejects.toBeInstanceOf(UnresolvedCheckpointConflictError);

    // Attempt 2: Retry while savedHash is STILL NOT_FOUND on RPC -> MUST block blind retry!
    const getTxSpy = vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.NOT_FOUND,
    } as rpc.Api.GetTransactionResponse);

    const secondAttempt = await processClaimSettlement({
      config,
      db,
      logger,
      checkpointStore: store,
      pollIntervalMs: 0,
    });

    expect(getTxSpy).toHaveBeenCalledWith(savedHash);
    expect(secondAttempt.settled).toBe(0);
    expect(secondAttempt.uncertain).toBe(1);
    // ZERO additional sign or sendTransaction calls occurred!
    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // Attempt 3: Saved transaction lands on-chain (SUCCESS) -> reconciles as confirmed WITHOUT signing or broadcasting a 2nd payment!
    getTxSpy.mockResolvedValueOnce({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
    } as rpc.Api.GetTransactionResponse);

    const thirdAttempt = await processClaimSettlement({
      config,
      db,
      logger,
      checkpointStore: store,
      pollIntervalMs: 0,
    });

    expect(thirdAttempt.settled).toBe(1);
    expect(thirdAttempt.uncertain).toBe(0);
    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect((await store.getByOperationKey(opKey))?.state).toBe("confirmed");

    // Verify zero secret key or signed credential/envelope material appeared anywhere in logs or DB!
    const combinedLogs = rawLines.join("\n");
    expect(combinedLogs).not.toContain(signer.secret());
    expect(combinedLogs).not.toMatch(/\bS[A-Z2-7]{55}\b/);
    for (const envXdr of capturedEnvelopes) {
      expect(combinedLogs).not.toContain(envXdr);
    }
    expect(savedAfterCrash?.lastError).not.toContain(signer.secret());
    capturedEnvelopes = [];
  });

  it("allows a clean retry for TTL maintenance only after saved checkpoint hash is confirmed FAILED on chain", async () => {
    const signer = Keypair.random();
    const config = loadConfig({
      env: completeEnv({ KEEPER_STELLAR_SECRET: signer.secret() }),
    });
    const chain = config.indexer.stellar!;

    let sequence = 900n;
    vi.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({
      passphrase: chain.networkPassphrase,
      protocolVersion: "22",
    });
    vi.spyOn(rpc.Server.prototype, "getAccount").mockImplementation(() =>
      Promise.resolve(new Account(signer.publicKey(), String(sequence))),
    );
    vi.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation((tx) =>
      Promise.resolve(tx as Transaction),
    );

    const sentHashes: string[] = [];
    vi.spyOn(rpc.Server.prototype, "sendTransaction").mockImplementation((tx) => {
      sequence += 1n;
      const hash = Buffer.from(tx.hash()).toString("hex");
      sentHashes.push(hash);
      return Promise.resolve({
        status: "PENDING",
        hash,
        latestLedger: 5_800_000,
        latestLedgerCloseTime: 1_700_000_100,
      });
    });

    // First run times out polling (remains NOT_FOUND) -> UncertainBroadcastError!
    const getTxSpy = vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.NOT_FOUND,
    } as rpc.Api.GetTransactionResponse);

    const { logger, rawLines } = rawCapturingLogger();
    await expect(
      processTtlBump({
        config,
        db,
        logger,
        checkpointStore: store,
        pollIntervalMs: 0,
        maxPollAttempts: 2,
      }),
    ).rejects.toBeInstanceOf(UncertainBroadcastError);

    expect(sentHashes).toHaveLength(1);
    expect(await store.countUnresolved(chain.chain)).toBe(1);

    // Next run: reconciliation checks sentHashes[0] -> sees FAILED on chain -> marks failed -> builds & confirms fresh tx!
    getTxSpy
      .mockResolvedValueOnce({
        status: rpc.Api.GetTransactionStatus.FAILED,
      } as rpc.Api.GetTransactionResponse)
      .mockResolvedValueOnce({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
      } as rpc.Api.GetTransactionResponse);

    const recovered = await processTtlBump({
      config,
      db,
      logger,
      checkpointStore: store,
      pollIntervalMs: 0,
      maxPollAttempts: 2,
    });

    expect(recovered.dryRun).toBe(false);
    expect(sentHashes).toHaveLength(2);
    expect(sentHashes[1]).not.toBe(sentHashes[0]);
    expect(await store.countUnresolved(chain.chain)).toBe(0);

    const combinedLogs = rawLines.join("\n");
    expect(combinedLogs).not.toContain(signer.secret());
    expect(combinedLogs).not.toMatch(/\bS[A-Z2-7]{55}\b/);
  });

  it("enforces PostgreSQL schema check constraints on keeper_tx_checkpoint", async () => {
    await expect(
      db.query(
        `INSERT INTO keeper_tx_checkpoint
           (operation_key, tx_hash, chain, job_kind, claim_id, contract, method,
            signer_public_key, sequence_number, fee_stroops, state)
         VALUES ('bad-claim', 'hash1', 'stellar-testnet', 'claim-settlement', NULL,
                 'CROUTER', 'settle_claim', 'GSIGNER', 1, 100, 'signed_pending_broadcast')`,
      ),
    ).rejects.toThrow();

    await expect(
      db.query(
        `INSERT INTO keeper_tx_checkpoint
           (operation_key, tx_hash, chain, job_kind, claim_id, contract, method,
            signer_public_key, sequence_number, fee_stroops, state)
         VALUES ('bad-ttl', 'hash2', 'stellar-testnet', 'ttl-bump', 99,
                 'CROUTER', 'keep_alive', 'GSIGNER', 2, 100, 'signed_pending_broadcast')`,
      ),
    ).rejects.toThrow();
  });
});
