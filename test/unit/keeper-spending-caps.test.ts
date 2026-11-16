import { Account, Keypair, TransactionBuilder, rpc, type Transaction } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import { processClaimSettlement } from "../../src/keeper/jobs/claims.js";
import { processTtlBump } from "../../src/keeper/jobs/ttl.js";
import { KeeperSpendingTracker } from "../../src/keeper/spending.js";
import { type KeeperStellarRpcAdapter } from "../../src/keeper/stellar.js";
import { KeeperWorker } from "../../src/keeper/worker.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

function buildPreparedTxWithFee(tx: Transaction, feeStroops: string): Transaction {
  const rebuilt = TransactionBuilder.cloneFrom(tx, {
    fee: feeStroops,
    networkPassphrase: TESTNET_PASSPHRASE,
  }).build();
  return rebuilt;
}

class ClaimDb {
  readonly rows: { claim_id: string; settled: boolean }[];
  readonly calls: { sql: string; params: readonly unknown[] }[] = [];

  constructor(claimIds: string[] = ["1", "2", "3"]) {
    this.rows = claimIds.map((id) => ({ claim_id: id, settled: false }));
  }

  query(sql: string, params: readonly unknown[] = []) {
    this.calls.push({ sql, params });
    if (sql.includes("pending_claim")) {
      const unsettled = this.rows.filter((r) => !r.settled);
      return Promise.resolve({ rows: unsettled, rowCount: unsettled.length });
    }
    return Promise.resolve({ rows: [{ nonce: "5" }], rowCount: 1 });
  }

  transaction<T>(work: (db: ClaimDb) => Promise<T>): Promise<T> {
    return work(this);
  }
}

describe("keeper operational spending caps", () => {
  it("charges failed maintenance attempts against the cap and blocks before silently exceeding it", async () => {
    const signer = Keypair.random();
    const config = loadConfig({
      env: completeEnv({
        KEEPER_STELLAR_SECRET: signer.secret(),
        // Cap = 300_000 stroops; each prepared tx costs 120_000 stroops -> 2 failures = 240_000; 3rd attempt (360_000) is blocked!
        KEEPER_DAILY_SPEND_CAP_STROOPS: "300000",
        KEEPER_MAX_SINGLE_TX_FEE_STROOPS: "500000",
      }),
    });

    let seq = 10n;
    const sendSpy = vi.fn((_tx: Transaction) => {
      seq += 1n;
      return Promise.resolve({
        status: "PENDING" as const,
        hash: `failed-tx-${String(seq)}`,
      });
    });

    const rpcClient: KeeperStellarRpcAdapter = {
      getNetwork: () => Promise.resolve({ passphrase: TESTNET_PASSPHRASE }),
      getAccount: (address: string) => Promise.resolve(new Account(address, String(seq))),
      prepareTransaction: (tx: Transaction) =>
        Promise.resolve(buildPreparedTxWithFee(tx, "120000")),
      sendTransaction: sendSpy,
      getTransaction: () => Promise.resolve({ status: rpc.Api.GetTransactionStatus.FAILED }),
    };

    const tracker = new KeeperSpendingTracker(config.keeper.spendingCap);
    const { logger } = capturingLogger();
    const fixedNow = () => new Date("2026-11-15T12:00:00.000Z");

    // Failure 1: 120_000 stroops charged
    await expect(
      processTtlBump({
        config,
        db: new ClaimDb([]),
        logger,
        spendingTracker: tracker,
        rpcClient,
        now: fixedNow,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow("failed on chain");

    // Failure 2: 240_000 stroops total failed spend
    await expect(
      processTtlBump({
        config,
        db: new ClaimDb([]),
        logger,
        spendingTracker: tracker,
        rpcClient,
        now: fixedNow,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow("failed on chain");

    const snapAfterTwo = tracker.snapshot(signer.publicKey(), { now: fixedNow() });
    expect(snapAfterTwo.failedStroops).toBe("240000");
    expect(snapAfterTwo.confirmedStroops).toBe("0");
    expect(snapAfterTwo.failedCount).toBe(2);
    expect(snapAfterTwo.paused).toBe(false);

    // Attempt 3: 240_000 + 120_000 = 360_000 > 300_000 -> blocked BEFORE signing/sending!
    const thirdRes = await processTtlBump({
      config,
      db: new ClaimDb([]),
      logger,
      spendingTracker: tracker,
      rpcClient,
      now: fixedNow,
    });
    expect(thirdRes.pausedByCap).toBe(true);
    expect(thirdRes.bumpedTokens).toBe(0);
    expect(thirdRes.bumpedClaims).toBe(0);
    // sendTransaction was NEVER called a 3rd time!
    expect(sendSpy).toHaveBeenCalledTimes(2);

    const pausedSnap = tracker.snapshot(signer.publicKey(), { now: fixedNow() });
    expect(pausedSnap.paused).toBe(true);
    expect(pausedSnap.totalCommittedStroops).toBe("240000");
    expect(BigInt(pausedSnap.totalCommittedStroops)).toBeLessThanOrEqual(300_000n);
  });

  it("pauses claim settlement when cap is reached without mutating claim database status", async () => {
    const signer = Keypair.random();
    const config = loadConfig({
      env: completeEnv({
        KEEPER_STELLAR_SECRET: signer.secret(),
        // Cap = 150_000 stroops; each claim settlement prepared fee = 100_000 stroops -> settles 1, pauses before 2nd!
        KEEPER_DAILY_SPEND_CAP_STROOPS: "150000",
      }),
    });

    let seq = 50n;
    const sendSpy = vi.fn(() => {
      seq += 1n;
      return Promise.resolve({
        status: "PENDING" as const,
        hash: `settled-tx-${String(seq)}`,
      });
    });

    const rpcClient: KeeperStellarRpcAdapter = {
      getNetwork: () => Promise.resolve({ passphrase: TESTNET_PASSPHRASE }),
      getAccount: (address: string) => Promise.resolve(new Account(address, String(seq))),
      prepareTransaction: (tx: Transaction) =>
        Promise.resolve(buildPreparedTxWithFee(tx, "100000")),
      sendTransaction: sendSpy,
      getTransaction: () => Promise.resolve({ status: rpc.Api.GetTransactionStatus.SUCCESS }),
    };

    const tracker = new KeeperSpendingTracker(config.keeper.spendingCap);
    const db = new ClaimDb(["101", "102", "103"]);
    const { logger } = capturingLogger();
    const fixedNow = () => new Date("2026-11-15T14:00:00.000Z");

    const firstPass = await processClaimSettlement({
      config,
      db,
      logger,
      spendingTracker: tracker,
      rpcClient,
      now: fixedNow,
      pollIntervalMs: 0,
    });
    expect(firstPass.settled).toBe(1);
    expect(firstPass.attempted).toBe(1);
    expect(firstPass.pending).toBe(2);
    expect(firstPass.pausedByCap).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // Subsequent pass while paused performs zero broadcasts and zero DB mutations
    const secondPass = await processClaimSettlement({
      config,
      db,
      logger,
      spendingTracker: tracker,
      rpcClient,
      now: fixedNow,
    });
    expect(secondPass.settled).toBe(0);
    expect(secondPass.attempted).toBe(0);
    expect(secondPass.pending).toBe(3);
    expect(secondPass.pausedByCap).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // Database claim rows remain untouched (zero INSERT/UPDATE/DELETE statements)
    expect(db.rows.every((row) => !row.settled)).toBe(true);
    expect(db.calls.some((call) => /INSERT|UPDATE|DELETE/i.test(call.sql))).toBe(false);
  });

  it("tracks ledger-window caps and records auditable reset, override, and rollover decisions without leaking secrets", () => {
    const signer = Keypair.random();
    const secret = signer.secret();
    const config = loadConfig({
      env: completeEnv({
        KEEPER_STELLAR_SECRET: secret,
        KEEPER_DAILY_SPEND_CAP_STROOPS: "200000",
        KEEPER_SPEND_WINDOW_LEDGERS: "100",
      }),
    });

    const { logger, lines } = capturingLogger();
    const tracker = new KeeperSpendingTracker(config.keeper.spendingCap);
    const worker = new KeeperWorker(config, new ClaimDb([]), logger, tracker);

    // Exhaust window ledger:100:12 (ledger 1250)
    const ticket = tracker.reserveFee({
      signerPublicKey: signer.publicKey(),
      feeStroops: 200_000n,
      operation: "keep_alive",
      ledger: 1250,
      logger,
    });
    tracker.commitConfirmed(ticket, 200_000n, { logger });
    expect(tracker.isPaused(signer.publicKey(), { ledger: 1255 })).toBe(true);
    expect(worker.readiness().state).toBe("degraded");

    // Operator grants an auditable cap override (+150_000 -> 350_000)
    const overrideEntry = worker.overrideSpendingCap({
      signerPublicKey: signer.publicKey(),
      additionalStroops: 150_000n,
      actor: "ops-oncall",
      reason: `Incident bridge surge approved (redact check: ${secret})`,
      ledger: 1260,
    });
    expect(overrideEntry.action).toBe("cap_override");
    expect(overrideEntry.previousEffectiveCapStroops).toBe("200000");
    expect(overrideEntry.nextEffectiveCapStroops).toBe("350000");
    expect(overrideEntry.pausedAfter).toBe(false);
    expect(overrideEntry.reason).not.toContain(secret);
    expect(overrideEntry.reason).toContain("[REDACTED_STELLAR_SECRET]");

    // Operator executes an auditable manual reset in the same ledger window
    const resetEntry = worker.resetSpendingCap({
      signerPublicKey: signer.publicKey(),
      actor: "ops-lead",
      reason: "Post-incident maintenance window reset",
      ledger: 1270,
    });
    expect(resetEntry.action).toBe("manual_reset");
    expect(resetEntry.previousConfirmedStroops).toBe("200000");
    expect(resetEntry.nextEffectiveCapStroops).toBe("200000");
    expect(tracker.snapshot(signer.publicKey(), { ledger: 1270 }).confirmedStroops).toBe("0");

    // Advancing into the next ledger window (ledger 1305 -> bucket 13) appends a window_rollover audit record
    const rolledSnap = tracker.snapshot(signer.publicKey(), { ledger: 1305 });
    expect(rolledSnap.windowId).toBe("ledger:100:13");

    const trail = worker.spendingAuditTrail(signer.publicKey());
    expect(trail.map((entry) => entry.action)).toEqual([
      "cap_paused",
      "cap_override",
      "manual_reset",
      "window_rollover",
    ]);

    // Blank actor or reason is rejected so overrides/resets are always attributable
    expect(() =>
      worker.resetSpendingCap({
        signerPublicKey: signer.publicKey(),
        actor: "   ",
        reason: "valid reason",
      }),
    ).toThrow("non-empty actor and reason");

    const serialized = JSON.stringify({
      diagnostics: worker.spendingDiagnostics(),
      trail,
      lines,
    });
    expect(serialized).not.toContain(secret);
  });
});
