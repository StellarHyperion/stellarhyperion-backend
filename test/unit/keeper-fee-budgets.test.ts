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
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/config.js";
import { ConfigError } from "../../src/config/env.js";
import {
  ClaimRecipientOverrideError,
  KeeperBudgetExceededError,
  KeeperBudgetTracker,
} from "../../src/keeper/budgets.js";
import { processClaimSettlement } from "../../src/keeper/jobs/claims.js";
import { processTtlBump } from "../../src/keeper/jobs/ttl.js";
import { KeeperWorker } from "../../src/keeper/worker.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

class MockDb {
  calls: { sql: string; params: readonly unknown[] }[] = [];
  constructor(private readonly claimIds: readonly string[] = ["1", "2", "3"]) {}

  query(sql: string, params: readonly unknown[] = []) {
    this.calls.push({ sql, params });
    return Promise.resolve({
      rows: sql.includes("pending_claim")
        ? this.claimIds.map((claim_id) => ({ claim_id }))
        : [{ nonce: "9" }],
      rowCount: this.claimIds.length,
    });
  }

  transaction<T>(work: (db: MockDb) => Promise<T>) {
    return work(this);
  }
}

function makeKey(contractId: string, index: bigint): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: xdr.ScAddress.scAddressTypeContract(
        new xdr.ContractId(StrKey.decodeContract(contractId)),
      ),
      key: xdr.ScVal.scvU64(index),
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
}

function makeSimulation(
  key: xdr.LedgerKey,
  opts: {
    minResourceFee?: string;
    cpuInstructions?: number;
    readBytes?: number;
    writeBytes?: number;
  } = {},
): rpc.Api.SimulateTransactionSuccessResponse {
  const minResourceFee = opts.minResourceFee ?? "50000";
  const builder = new SorobanDataBuilder()
    .setFootprint([], [key])
    .setResources(
      opts.cpuInstructions ?? 2_000_000,
      opts.readBytes ?? 4_096,
      opts.writeBytes ?? 2_048,
    )
    .setResourceFee(minResourceFee);
  return {
    id: "sim-budget",
    latestLedger: 5_600_000,
    events: [],
    _parsed: true,
    transactionData: builder,
    minResourceFee,
    result: { auth: [], retval: xdr.ScVal.scvVoid() },
  };
}

describe("Keeper transaction fee and simulation resource budgets", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks signing with a structured diagnostic when simulation cost exceeds fee or resource allowances", async () => {
    const signer = Keypair.random();
    const config = loadConfig({
      env: completeEnv({
        KEEPER_STELLAR_SECRET: signer.secret(),
        KEEPER_MAX_TX_FEE_STROOPS: "100000",
        KEEPER_MAX_CPU_INSTRUCTIONS: "5000000",
      }),
    });
    const chain = config.indexer.stellar;
    if (!chain) throw new Error("Expected Stellar config");

    vi.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({
      passphrase: chain.networkPassphrase,
      protocolVersion: "22",
    });
    vi.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(
      new Account(signer.publicKey(), "100"),
    );
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      makeSimulation(makeKey(chain.routerContractId, 1n), {
        minResourceFee: "250000",
        cpuInstructions: 9_000_000,
      }),
    );

    const signSpy = vi.spyOn(Transaction.prototype, "sign");
    const sendSpy = vi.spyOn(rpc.Server.prototype, "sendTransaction");

    const tracker = new KeeperBudgetTracker(config.keeper.budgets);
    const { logger, lines } = capturingLogger();

    let caught: unknown;
    try {
      await processTtlBump({
        config,
        db: new MockDb(),
        logger,
        budgetTracker: tracker,
        pollIntervalMs: 0,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(KeeperBudgetExceededError);
    const budgetError = caught as KeeperBudgetExceededError;
    expect(budgetError.diagnostic.code).toBe("keeper_budget_exceeded");
    expect(budgetError.diagnostic.exceededDimensions).toEqual([
      "txFeeStroops (250100 > 100000)",
      "cpuInstructions (9000000 > 5000000)",
    ]);

    // Critically: signing and broadcasting were both blocked completely!
    expect(signSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
    expect(tracker.snapshot().submittedStroops).toBe("0");
    expect(tracker.snapshot().confirmedStroops).toBe("0");
    expect(tracker.snapshot().blockedCount).toBe(1);
    expect(JSON.stringify(lines)).not.toContain(signer.secret());
  });

  it("distinguishes submitted from confirmed spending across failed, pending and confirmed transactions and rolls intervals", async () => {
    const signer = Keypair.random();
    let nowMs = 1_700_000_000_000;
    const config = loadConfig({
      env: completeEnv({
        KEEPER_STELLAR_SECRET: signer.secret(),
        KEEPER_MAX_TX_FEE_STROOPS: "200000",
        KEEPER_MAX_JOB_FEE_STROOPS: "500000",
        KEEPER_MAX_INTERVAL_FEE_STROOPS: "220000",
        KEEPER_BUDGET_INTERVAL_MS: "60000",
      }),
    });
    const chain = config.indexer.stellar;
    if (!chain) throw new Error("Expected Stellar config");

    let sequence = 300n;
    const key = makeKey(chain.routerContractId, 1n);

    vi.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({
      passphrase: chain.networkPassphrase,
      protocolVersion: "22",
    });
    vi.spyOn(rpc.Server.prototype, "getAccount").mockImplementation(() =>
      Promise.resolve(new Account(signer.publicKey(), String(sequence))),
    );
    // Each tx has total fee = 100 base + 99900 resource = 100000 stroops.
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(() =>
      Promise.resolve(makeSimulation(key, { minResourceFee: "99900" })),
    );

    const hashes: string[] = [];
    vi.spyOn(rpc.Server.prototype, "sendTransaction").mockImplementation((tx) => {
      sequence += 1n;
      const hash = Buffer.from(tx.hash()).toString("hex");
      hashes.push(hash);
      return Promise.resolve({
        status: "PENDING",
        hash,
        latestLedger: 5_600_010,
        latestLedgerCloseTime: 1_700_000_010,
      });
    });

    // Claim 1 confirms SUCCESS (100000 confirmed); Claim 2 fails on-chain FAILED (100000 submitted, 0 confirmed);
    // Claim 3 would bring intervalSubmittedStroops to 300000 > 220000 cap, so Claim 3 is blocked BEFORE signing!
    vi.spyOn(rpc.Server.prototype, "getTransaction").mockImplementation((hash) => {
      const status =
        hash === hashes[0]
          ? rpc.Api.GetTransactionStatus.SUCCESS
          : rpc.Api.GetTransactionStatus.FAILED;
      return Promise.resolve({ status } as rpc.Api.GetTransactionResponse);
    });

    const signSpy = vi.spyOn(Transaction.prototype, "sign");
    const tracker = new KeeperBudgetTracker(config.keeper.budgets, () => nowMs);
    const { logger } = capturingLogger();

    const result = await processClaimSettlement({
      config,
      db: new MockDb(["1", "2", "3"]),
      logger,
      budgetTracker: tracker,
      pollIntervalMs: 0,
    });

    // Only 2 transactions were signed (Claim 1 and Claim 2); Claim 3 was blocked pre-sign by submitted cap!
    expect(signSpy).toHaveBeenCalledTimes(2);
    expect(result.settled).toBe(1);
    expect(result.pending).toBe(2);
    expect(result.budgetAccounting).toMatchObject({
      submittedStroops: "200000",
      confirmedStroops: "100000",
      failedSubmittedStroops: "100000",
      pendingSubmittedStroops: "0",
      submittedTxCount: 2,
      confirmedTxCount: 1,
      blockedCount: 1,
    });

    const intervalSnap = tracker.snapshot(nowMs);
    expect(intervalSnap.submittedStroops).toBe("200000");
    expect(intervalSnap.confirmedStroops).toBe("100000");
    expect(intervalSnap.failedSubmittedStroops).toBe("100000");

    // Advance clock into next 60s operational interval -> budget resets cleanly!
    nowMs += 60_000;
    const nextInterval = tracker.snapshot(nowMs);
    expect(nextInterval.submittedStroops).toBe("0");
    expect(nextInterval.confirmedStroops).toBe("0");

    // Also verify KeeperWorker readiness degrades when interval fee cap is exhausted.
    const cappedTracker = new KeeperBudgetTracker(
      { ...config.keeper.budgets, maxIntervalFeeStroops: 100_000n },
      () => nowMs,
    );
    const capSession = cappedTracker.createJobSession();
    capSession.recordSubmitted("tx-cap", 100_000n, nowMs);
    const worker = new KeeperWorker(config, new MockDb(), logger, cappedTracker);
    const ready = worker.readiness();
    expect(ready.state).toBe("degraded");
    expect(ready.detail).toContain("operational fee budget exhausted");
  });

  it("forbids manual claim recipient redirection in both environment config and job payloads", async () => {
    const attackerAddress = encodeStellarAddress(
      AddressKind.Account,
      new Uint8Array(32).fill(0x99),
    );

    // 1. Environment variable override is rejected at loadConfig startup without echoing value.
    expect(() =>
      loadConfig({
        env: completeEnv({ KEEPER_CLAIM_RECIPIENT: attackerAddress }),
      }),
    ).toThrow(ConfigError);

    try {
      loadConfig({
        env: completeEnv({ KEEPER_PAYOUT_RECIPIENT_OVERRIDE: attackerAddress }),
      });
      throw new Error("Expected ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain("KEEPER_PAYOUT_RECIPIENT_OVERRIDE");
      expect((error as ConfigError).message).not.toContain(attackerAddress);
    }

    // 2. Runtime BullMQ / manual job payload override is rejected before any DB query or signing.
    const config = loadConfig({
      env: completeEnv({ KEEPER_STELLAR_SECRET: Keypair.random().secret() }),
    });
    const db = new MockDb(["1"]);
    const { logger } = capturingLogger();

    await expect(
      processClaimSettlement({ config, db, logger }, {
        limit: 5,
        recipient: attackerAddress,
      } as unknown as Record<string, unknown>),
    ).rejects.toBeInstanceOf(ClaimRecipientOverrideError);

    await expect(
      processClaimSettlement({ config, db, logger }, {
        redirectTo: attackerAddress,
      } as unknown as Record<string, unknown>),
    ).rejects.toBeInstanceOf(ClaimRecipientOverrideError);

    expect(db.calls).toHaveLength(0);
  });
});
