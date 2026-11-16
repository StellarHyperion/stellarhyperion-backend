import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { Account, Keypair, Transaction, rpc } from "@stellar/stellar-sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import type { Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";
import { processClaimSettlement } from "../../src/keeper/jobs/claims.js";
import { processTtlBump } from "../../src/keeper/jobs/ttl.js";
import {
  PendingInFlightSequenceError,
  PostgresSignerLeaseStore,
  SignerLeaseBusyError,
  SignerLeaseLostError,
} from "../../src/keeper/leases.js";
import { submitStellar } from "../../src/keeper/stellar.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

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

describe("Distributed keeper signer leases and sequence fencing", () => {
  let pg: PGlite;
  let db: PGliteDb;

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
  });

  afterAll(async () => {
    await pg.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM keeper_signer_lease");
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

  it("ensures only one lease holder can create the next signed operation across concurrent replicas", async () => {
    const nowMs = 1_750_000_000_000;
    const signer = Keypair.random();
    const configA = loadConfig({
      env: completeEnv({
        KEEPER_STELLAR_SECRET: signer.secret(),
        KEEPER_INSTANCE_ID: "replica-a",
        KEEPER_LEASE_TTL_MS: "20000",
      }),
    });
    const configB = loadConfig({
      env: completeEnv({
        KEEPER_STELLAR_SECRET: signer.secret(),
        KEEPER_INSTANCE_ID: "replica-b",
        KEEPER_LEASE_TTL_MS: "20000",
      }),
    });
    const chain = configA.indexer.stellar!;
    await seedPendingClaim(chain.chain, 1n);

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
    const signSpy = vi.spyOn(Transaction.prototype, "sign");
    const sentSequences: string[] = [];
    vi.spyOn(rpc.Server.prototype, "sendTransaction").mockImplementation((tx) => {
      sentSequences.push("sequence" in tx ? tx.sequence : "");
      return Promise.resolve({
        status: "PENDING",
        hash: Buffer.from(tx.hash()).toString("hex"),
        latestLedger: 5_900_000,
        latestLedgerCloseTime: 1_700_000_000,
      });
    });
    vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
    } as rpc.Api.GetTransactionResponse);

    const store = new PostgresSignerLeaseStore(db, () => nowMs);
    const { logger } = capturingLogger();

    const [resA, resB] = await Promise.all([
      processClaimSettlement({
        config: configA,
        db,
        logger,
        leaseStore: store,
        holderId: "replica-a",
        leaseTtlMs: 20_000,
        clock: () => nowMs,
        pollIntervalMs: 0,
      }),
      processClaimSettlement({
        config: configB,
        db,
        logger,
        leaseStore: store,
        holderId: "replica-b",
        leaseTtlMs: 20_000,
        clock: () => nowMs,
        pollIntervalMs: 0,
      }),
    ]);

    const settledTotal = resA.settled + resB.settled;
    const skippedCount = (resA.leaseSkipped ? 1 : 0) + (resB.leaseSkipped ? 1 : 0);
    expect(settledTotal).toBe(1);
    expect(skippedCount).toBe(1);
    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(sentSequences).toEqual(["101"]);

    // Standby replica TTL bump also yields cleanly without signing when active lease is held.
    const ttlStandby = await processTtlBump({
      config: configB,
      db,
      logger,
      leaseStore: store,
      holderId: "replica-b",
      leaseTtlMs: 20_000,
      clock: () => nowMs,
      pollIntervalMs: 0,
    });
    expect(ttlStandby.leaseSkipped).toBe(true);
    expect(signSpy).toHaveBeenCalledTimes(1);
  });

  it("provides bounded safe recovery from a crashed signer lease for both unbroadcast and in-flight crashes", async () => {
    let nowMs = 1_750_000_100_000;
    const signer = Keypair.random();
    const config = loadConfig({
      env: completeEnv({
        KEEPER_STELLAR_SECRET: signer.secret(),
        KEEPER_LEASE_TTL_MS: "15000",
      }),
    });
    const chain = config.indexer.stellar!;
    const store = new PostgresSignerLeaseStore(db, () => nowMs);
    const { logger } = capturingLogger();

    let onChainSequence = 200n;
    vi.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({
      passphrase: chain.networkPassphrase,
      protocolVersion: "22",
    });
    vi.spyOn(rpc.Server.prototype, "getAccount").mockImplementation(() =>
      Promise.resolve(new Account(signer.publicKey(), String(onChainSequence))),
    );
    vi.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation((tx) =>
      Promise.resolve(tx as Transaction),
    );

    const sentSequences: string[] = [];
    vi.spyOn(rpc.Server.prototype, "sendTransaction").mockImplementation((tx) => {
      sentSequences.push("sequence" in tx ? tx.sequence : "");
      return Promise.resolve({
        status: "PENDING",
        hash: Buffer.from(tx.hash()).toString("hex"),
        latestLedger: 5_900_100,
        latestLedgerCloseTime: 1_700_000_100,
      });
    });

    // Crash scenario 1: Replica A acquires lease and reserves sequence 201, then crashes BEFORE broadcast!
    const leaseA = await store.acquireOrRenew({
      signerPublicKey: signer.publicKey(),
      chain: chain.chain,
      holderId: "crashed-replica-a",
      leaseTtlMs: 15_000,
      nowMs,
    });
    expect(leaseA.fenceToken).toBe(1n);
    const resSeqA = await store.reserveNextSequence({
      signerPublicKey: signer.publicKey(),
      holderId: "crashed-replica-a",
      fenceToken: leaseA.fenceToken,
      onChainSequence: 200n,
      leaseTtlMs: 15_000,
      nowMs,
    });
    expect(resSeqA.nextSequence).toBe(201n);

    // Before TTL expires (nowMs + 5s), Replica B cannot take over yet.
    nowMs += 5_000;
    await expect(
      store.acquireOrRenew({
        signerPublicKey: signer.publicKey(),
        chain: chain.chain,
        holderId: "replica-b",
        leaseTtlMs: 15_000,
        nowMs,
      }),
    ).rejects.toBeInstanceOf(SignerLeaseBusyError);

    // Once bounded TTL expires (nowMs + 16s total), Replica B recovers cleanly, reclaims unbroadcast sequence 201, and confirms!
    nowMs += 11_000;
    const getTxSpy = vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
    } as rpc.Api.GetTransactionResponse);

    const hashB = await submitStellar(config, chain.routerContractId, "keep_alive", () => [], {
      leaseStore: store,
      holderId: "replica-b",
      leaseTtlMs: 15_000,
      clock: () => nowMs,
      logger,
      pollIntervalMs: 0,
    });
    expect(hashB).toMatch(/^[0-9a-f]{64}$/);
    expect(sentSequences).toEqual(["201"]);
    onChainSequence = 201n;

    const inspectedAfterB = await store.inspect(signer.publicKey());
    expect(inspectedAfterB?.fenceToken).toBe(2n);
    expect(inspectedAfterB?.lastConfirmedSequence).toBe(201n);

    // Crash scenario 2: Replica B reserves 202 and records in_flight_tx_hash before crashing mid-flight!
    const reserved202 = await store.reserveNextSequence({
      signerPublicKey: signer.publicKey(),
      holderId: "replica-b",
      fenceToken: 2n,
      onChainSequence: 201n,
      leaseTtlMs: 15_000,
      nowMs,
    });
    expect(reserved202.nextSequence).toBe(202n);
    await store.assertFenceBeforeBroadcast({
      signerPublicKey: signer.publicKey(),
      holderId: "replica-b",
      fenceToken: 2n,
      sequenceNumber: 202n,
      txHash: "a".repeat(64),
      nowMs,
    });

    // Advance past Replica B's lease TTL. While in-flight tx is still NOT_FOUND and account sequence is 201, Replica C blocks reuse!
    nowMs += 20_000;
    getTxSpy.mockResolvedValueOnce({
      status: rpc.Api.GetTransactionStatus.NOT_FOUND,
    } as rpc.Api.GetTransactionResponse);

    await expect(
      submitStellar(config, chain.routerContractId, "keep_alive", () => [], {
        leaseStore: store,
        holderId: "replica-c",
        leaseTtlMs: 15_000,
        clock: () => nowMs,
        logger,
        pollIntervalMs: 0,
      }),
    ).rejects.toBeInstanceOf(PendingInFlightSequenceError);

    // Once in-flight tx "aaaa..." settles as SUCCESS on RPC (even before getAccount advances from 201!),
    // Replica C reconciles sequence 202 and builds sequence 203 cleanly without sequence collision!
    getTxSpy
      .mockResolvedValueOnce({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
      } as rpc.Api.GetTransactionResponse)
      .mockResolvedValueOnce({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
      } as rpc.Api.GetTransactionResponse);

    await submitStellar(config, chain.routerContractId, "keep_alive", () => [], {
      leaseStore: store,
      holderId: "replica-c",
      leaseTtlMs: 15_000,
      clock: () => nowMs,
      logger,
      pollIntervalMs: 0,
    });

    expect(sentSequences).toEqual(["201", "203"]);
  });

  it("prevents a stale process that lost lease ownership during simulation from broadcasting new work", async () => {
    let nowMs = 1_750_000_200_000;
    const signer = Keypair.random();
    const config = loadConfig({
      env: completeEnv({
        KEEPER_STELLAR_SECRET: signer.secret(),
        KEEPER_LEASE_TTL_MS: "10000",
      }),
    });
    const chain = config.indexer.stellar!;
    const store = new PostgresSignerLeaseStore(db, () => nowMs);
    const { logger } = capturingLogger();

    const onChainSequence = 300n;
    vi.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({
      passphrase: chain.networkPassphrase,
      protocolVersion: "22",
    });
    vi.spyOn(rpc.Server.prototype, "getAccount").mockImplementation(() =>
      Promise.resolve(new Account(signer.publicKey(), String(onChainSequence))),
    );

    const broadcastedHashes: string[] = [];
    const sendSpy = vi.spyOn(rpc.Server.prototype, "sendTransaction").mockImplementation((tx) => {
      const hash = Buffer.from(tx.hash()).toString("hex");
      broadcastedHashes.push(hash);
      return Promise.resolve({
        status: "PENDING",
        hash,
        latestLedger: 5_900_200,
        latestLedgerCloseTime: 1_700_000_200,
      });
    });
    vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
    } as rpc.Api.GetTransactionResponse);

    let callCount = 0;
    vi.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation(async (tx) => {
      callCount += 1;
      if (callCount === 1) {
        // Stale Replica A stalls past its 10s lease TTL during simulation!
        nowMs += 12_000;
        // While Replica A is stalled, Replica B legitimately acquires ownership (fenceToken = 2)!
        const takeover = await store.acquireOrRenew({
          signerPublicKey: signer.publicKey(),
          chain: chain.chain,
          holderId: "replica-b",
          leaseTtlMs: 10_000,
          nowMs,
        });
        expect(takeover.fenceToken).toBe(2n);
      }
      return tx as Transaction;
    });

    await expect(
      submitStellar(config, chain.routerContractId, "keep_alive", () => [], {
        leaseStore: store,
        holderId: "stale-replica-a",
        leaseTtlMs: 10_000,
        clock: () => nowMs,
        logger,
        pollIntervalMs: 0,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof SignerLeaseLostError)) return false;
      expect(error.expectedFenceToken).toBe(1n);
      expect(error.actualHolderId).toBe("replica-b");
      expect(error.actualFenceToken).toBe(2n);
      return true;
    });

    // Stale Replica A NEVER invoked sendTransaction!
    expect(sendSpy).not.toHaveBeenCalled();
    expect(broadcastedHashes).toHaveLength(0);

    // Active Replica B can now proceed and broadcast cleanly under fenceToken = 2!
    const activeHash = await submitStellar(config, chain.routerContractId, "keep_alive", () => [], {
      leaseStore: store,
      holderId: "replica-b",
      leaseTtlMs: 10_000,
      clock: () => nowMs,
      logger,
      pollIntervalMs: 0,
    });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(broadcastedHashes).toEqual([activeHash]);
  });

  it("enforces PostgreSQL check constraints on keeper_signer_lease", async () => {
    await expect(
      db.query(
        `INSERT INTO keeper_signer_lease
           (signer_public_key, chain, holder_id, fence_token, expires_at)
         VALUES ('GBADFENCE', 'stellar-testnet', 'replica-a', 0, now() + INTERVAL '10 seconds')`,
      ),
    ).rejects.toThrow();

    await expect(
      db.query(
        `INSERT INTO keeper_signer_lease
           (signer_public_key, chain, holder_id, fence_token,
            last_reserved_sequence, last_confirmed_sequence, expires_at)
         VALUES ('GBADSEQ', 'stellar-testnet', 'replica-a', 1, 50, 51, now() + INTERVAL '10 seconds')`,
      ),
    ).rejects.toThrow();
  });
});
