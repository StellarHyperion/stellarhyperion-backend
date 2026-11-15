import { Keypair, rpc } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import { executeKeeperJobWithRecovery } from "../../src/keeper/queue.js";
import {
  KeeperRecoveryLedger,
  pruneKeeperJobHistory,
  recoverFailedKeeperJob,
  type RetainableJobLike,
  type RetainableQueueLike,
} from "../../src/keeper/recovery.js";
import type * as KeeperStellarModule from "../../src/keeper/stellar.js";
import {
  KeeperUncertainSubmissionError,
  submitStellar,
  type KeeperTxLookupClient,
} from "../../src/keeper/stellar.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

vi.mock("../../src/keeper/stellar.js", async (importOriginal) => {
  const actual = await importOriginal<typeof KeeperStellarModule>();
  return {
    ...actual,
    submitStellar: vi.fn(),
  };
});

class MockDb {
  readonly rows: { claim_id: string }[];
  constructor(claimIds: string[] = ["1", "2"]) {
    this.rows = claimIds.map((id) => ({ claim_id: id }));
  }

  query(sql: string) {
    if (sql.includes("pending_claim")) {
      return Promise.resolve({ rows: this.rows, rowCount: this.rows.length });
    }
    return Promise.resolve({ rows: [{ nonce: "9" }], rowCount: 1 });
  }

  transaction<T>(work: (db: MockDb) => Promise<T>): Promise<T> {
    return work(this);
  }
}

interface StoredQueueJob extends RetainableJobLike {
  readonly id: string;
  state: "completed" | "failed" | "waiting";
}

class InMemoryRetainableQueue implements RetainableQueueLike {
  readonly jobs = new Map<string, StoredQueueJob>();

  put(
    id: string,
    name: string,
    data: unknown,
    state: "completed" | "failed" | "waiting",
    finishedOn: number,
  ): StoredQueueJob {
    const job: StoredQueueJob = {
      id,
      name,
      data,
      state,
      finishedOn,
      timestamp: finishedOn,
      remove: () => {
        this.jobs.delete(id);
        return Promise.resolve();
      },
    };
    this.jobs.set(id, job);
    return job;
  }

  getCompleted(): Promise<RetainableJobLike[]> {
    return Promise.resolve([...this.jobs.values()].filter((j) => j.state === "completed"));
  }

  getFailed(): Promise<RetainableJobLike[]> {
    return Promise.resolve([...this.jobs.values()].filter((j) => j.state === "failed"));
  }

  getJob(jobId: string): Promise<RetainableJobLike | undefined> {
    return Promise.resolve(this.jobs.get(jobId));
  }

  add(
    name: string,
    data: unknown,
    opts?: { readonly jobId?: string },
  ): Promise<{ readonly id?: string }> {
    const id = opts?.jobId ?? `job:${String(this.jobs.size + 1)}`;
    const existing = this.jobs.get(id);
    if (existing) {
      return Promise.resolve({ id: existing.id });
    }
    this.put(id, name, data, "waiting", Date.now());
    return Promise.resolve({ id });
  }
}

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

function buildLookupClient(
  txStatuses: ReadonlyMap<string, rpc.Api.GetTransactionStatus>,
): KeeperTxLookupClient {
  return {
    getNetwork: () => Promise.resolve({ passphrase: TESTNET_PASSPHRASE }),
    getTransaction: (hash: string) =>
      Promise.resolve({
        status: txStatuses.get(hash) ?? rpc.Api.GetTransactionStatus.NOT_FOUND,
      }),
  };
}

beforeEach(() => {
  vi.mocked(submitStellar).mockReset();
});

describe("keeper queue retention and failed-job recovery policy", () => {
  it("reconciles pending public transactions before requeueing failed ttl-bump or claim-settlement jobs", async () => {
    const secret = Keypair.random().secret();
    const config = loadConfig({ env: completeEnv({ KEEPER_STELLAR_SECRET: secret }) });
    const { logger } = capturingLogger();
    const ledger = new KeeperRecoveryLedger();
    const queue = new InMemoryRetainableQueue();
    const db = new MockDb(["10", "11"]);
    const ctx = { config, db, logger, recoveryLedger: ledger };

    // 1. ttl-bump broadcasts tx-pending-ttl whose confirmation times out
    vi.mocked(submitStellar).mockRejectedValueOnce(
      new KeeperUncertainSubmissionError(
        "tx-pending-ttl",
        config.indexer.stellar?.routerContractId ?? "CROUTER",
        "keep_alive",
      ),
    );
    queue.put("failed-ttl-1", "ttl-bump", { idempotencyKey: "win-1" }, "failed", 1_000);
    await expect(
      executeKeeperJobWithRecovery(ctx, "failed-ttl-1", "ttl-bump", { idempotencyKey: "win-1" }),
    ).rejects.toThrow("remains pending");

    // While NOT_FOUND on RPC, recovery holds and refuses to requeue!
    const txMap = new Map<string, rpc.Api.GetTransactionStatus>([
      ["tx-pending-ttl", rpc.Api.GetTransactionStatus.NOT_FOUND],
    ]);
    const heldDecision = await recoverFailedKeeperJob(ctx, queue, "failed-ttl-1", {
      lookupClient: buildLookupClient(txMap),
    });
    expect(heldDecision.status).toBe("held_pending");
    expect(heldDecision.requeuedJobId).toBeNull();
    expect(heldDecision.pendingTxHashes).toEqual(["tx-pending-ttl"]);
    expect([...queue.jobs.values()].some((j) => j.state === "waiting")).toBe(false);

    // Once tx-pending-ttl confirms on chain, recovery reconciles confirmed accounting WITHOUT rebroadcasting!
    txMap.set("tx-pending-ttl", rpc.Api.GetTransactionStatus.SUCCESS);
    const confirmedDecision = await recoverFailedKeeperJob(ctx, queue, "failed-ttl-1", {
      lookupClient: buildLookupClient(txMap),
    });
    expect(confirmedDecision.status).toBe("reconciled_confirmed");
    expect(confirmedDecision.requeuedJobId).toBeNull();
    expect(confirmedDecision.confirmedResult).toEqual({
      kind: "ttl-bump",
      result: {
        bumpedTokens: 1,
        bumpedClaims: 2,
        bumpedTransfers: 1,
        dryRun: false,
        txHash: "tx-pending-ttl",
        detail: "Reconciled confirmed router maintenance without rebroadcast: tx-pending-ttl",
      },
    });
    expect(submitStellar).toHaveBeenCalledTimes(1);

    // 2. claim-settlement where claim #10 succeeded ("tx-claim-10") and claim #11 had uncertain "tx-claim-11" that later FAILED on chain
    vi.mocked(submitStellar)
      .mockResolvedValueOnce("tx-claim-10")
      .mockRejectedValueOnce(
        new KeeperUncertainSubmissionError(
          "tx-claim-11",
          config.indexer.stellar?.routerContractId ?? "CROUTER",
          "settle_claim",
        ),
      );
    queue.put("failed-claim-1", "claim-settlement", { limit: 10 }, "failed", 2_000);
    await expect(
      executeKeeperJobWithRecovery(ctx, "failed-claim-1", "claim-settlement", { limit: 10 }),
    ).rejects.toThrow("pending reconciliation");

    // Reconcile when tx-claim-11 FAILED on chain -> requeues safely without retrying already-confirmed claim #10!
    txMap.set("tx-claim-11", rpc.Api.GetTransactionStatus.FAILED);
    const requeued = await recoverFailedKeeperJob(ctx, queue, "failed-claim-1", {
      lookupClient: buildLookupClient(txMap),
    });
    expect(requeued.status).toBe("requeued");
    expect(requeued.requeuedJobId).toContain("recovery:claim-settlement");

    // Running the requeued job settles ONLY claim #11 (claim #10 was already confirmed in ledger)!
    vi.mocked(submitStellar).mockResolvedValueOnce("tx-claim-11-retry");
    const retryJob = queue.jobs.get(requeued.requeuedJobId ?? "");
    expect(retryJob).toBeDefined();
    const retryOutcome = await executeKeeperJobWithRecovery(
      ctx,
      retryJob?.id ?? "retry",
      "claim-settlement",
      retryJob?.data,
    );
    expect(retryOutcome).toEqual({
      kind: "claim-settlement",
      result: {
        settled: 1,
        attempted: 1,
        pending: 1,
        dryRun: false,
        settledTxHashes: ["tx-claim-11-retry"],
        detail: "1 confirmed settlements of 1 attempts.",
      },
    });
  });

  it("prevents duplicate queue payloads from producing duplicate confirmed accounting", async () => {
    const secret = Keypair.random().secret();
    const config = loadConfig({ env: completeEnv({ KEEPER_STELLAR_SECRET: secret }) });
    const { logger } = capturingLogger();
    const ledger = new KeeperRecoveryLedger();
    const db = new MockDb(["21", "22"]);
    const ctx = { config, db, logger, recoveryLedger: ledger };

    // Duplicate ttl-bump payloads with the same idempotencyKey
    vi.mocked(submitStellar).mockResolvedValue("tx-ttl-unique");
    const firstTtl = await executeKeeperJobWithRecovery(ctx, "job-ttl-a", "ttl-bump", {
      idempotencyKey: "slot-500",
    });
    const duplicateTtl = await executeKeeperJobWithRecovery(ctx, "job-ttl-b", "ttl-bump", {
      idempotencyKey: "slot-500",
    });

    expect(firstTtl.kind === "ttl-bump" && firstTtl.result.bumpedClaims).toBe(2);
    expect(duplicateTtl).toEqual({
      kind: "ttl-bump",
      result: {
        bumpedTokens: 0,
        bumpedClaims: 0,
        bumpedTransfers: 0,
        dryRun: false,
        deduplicated: true,
        txHash: "tx-ttl-unique",
        detail: "Duplicate queue payload skipped; maintenance window already confirmed.",
      },
    });
    expect(submitStellar).toHaveBeenCalledTimes(1);

    // Duplicate claim-settlement payloads targeting the same unsettled DB claims before watcher ingests event
    vi.mocked(submitStellar)
      .mockResolvedValueOnce("tx-claim-21")
      .mockResolvedValueOnce("tx-claim-22");
    const firstClaims = await executeKeeperJobWithRecovery(ctx, "job-claim-a", "claim-settlement", {
      limit: 20,
    });
    const duplicateClaims = await executeKeeperJobWithRecovery(
      ctx,
      "job-claim-b",
      "claim-settlement",
      { limit: 20 },
    );

    expect(firstClaims.kind === "claim-settlement" && firstClaims.result.settled).toBe(2);
    expect(duplicateClaims.kind === "claim-settlement" && duplicateClaims.result.settled).toBe(0);
    expect(duplicateClaims.kind === "claim-settlement" && duplicateClaims.result.attempted).toBe(0);
    // Total submitStellar calls across all 4 jobs = 1 (ttl) + 2 (claims 21 & 22) = 3!
    expect(submitStellar).toHaveBeenCalledTimes(3);
  });

  it("bounds completed and deterministic failed job retention while preserving uncertain submission evidence", async () => {
    const secret = Keypair.random().secret();
    const config = loadConfig({
      env: completeEnv({
        KEEPER_STELLAR_SECRET: secret,
        KEEPER_MAX_COMPLETED_JOBS: "2",
        KEEPER_COMPLETED_MAX_AGE_SECONDS: "600",
        KEEPER_MAX_FAILED_JOBS: "2",
        KEEPER_FAILED_MAX_AGE_SECONDS: "600",
      }),
    });
    const ledger = new KeeperRecoveryLedger();
    const queue = new InMemoryRetainableQueue();
    const nowMs = 1_000_000;

    // 4 completed jobs (1 expired, 3 recent -> maxCompletedJobs=2 keeps only c3 and c4)
    queue.put("c1", "ttl-bump", {}, "completed", nowMs - 700_000);
    queue.put("c2", "ttl-bump", {}, "completed", nowMs - 30_000);
    queue.put("c3", "ttl-bump", {}, "completed", nowMs - 20_000);
    queue.put("c4", "ttl-bump", {}, "completed", nowMs - 10_000);

    // 1 uncertain failed job older than maxFailedAge + 3 newer deterministic failed jobs
    queue.put("f-uncertain", "claim-settlement", { limit: 5 }, "failed", nowMs - 900_000);
    ledger.recordFailedJob({
      jobId: "f-uncertain",
      jobName: "claim-settlement",
      payload: { limit: 5 },
      payloadKey: "claim-settlement:limit=5:exclude=",
      failedAtMs: nowMs - 900_000,
      reason: `pending for ${secret}`,
      pendingSubmissions: [
        {
          txHash: "tx-uncertain-hash",
          contract: "CROUTER",
          method: "settle_claim",
          claimId: "99",
        },
      ],
      uncertain: true,
    });

    for (const detId of ["f-det-1", "f-det-2", "f-det-3"]) {
      const ts =
        detId === "f-det-1"
          ? nowMs - 50_000
          : detId === "f-det-2"
            ? nowMs - 40_000
            : nowMs - 30_000;
      queue.put(detId, "ttl-bump", {}, "failed", ts);
      ledger.recordFailedJob({
        jobId: detId,
        jobName: "ttl-bump",
        payload: {},
        payloadKey: "ttl-bump:claims=50:transfers=50",
        failedAtMs: ts,
        reason: "RPC timeout before broadcast",
        pendingSubmissions: [],
        uncertain: false,
      });
    }

    const summary = await pruneKeeperJobHistory(queue, config.keeper.retention, ledger, nowMs);
    expect(summary.removedCompleted).toBe(2);
    expect(summary.removedFailed).toBe(1);
    expect(summary.preservedUncertainJobIds).toEqual(["f-uncertain"]);

    // Uncertain job AND its evidence survived both age and count eviction!
    expect(queue.jobs.has("f-uncertain")).toBe(true);
    const preserved = ledger.getFailedJobEvidence("f-uncertain");
    expect(preserved?.pendingSubmissions[0]?.txHash).toBe("tx-uncertain-hash");
    // Secret seed was scrubbed from stored evidence reason!
    expect(preserved?.reason).not.toContain(secret);
    expect(preserved?.reason).toContain("[REDACTED_STELLAR_SECRET]");

    // Kept newest 2 deterministic failures (f-det-2, f-det-3) and evicted oldest (f-det-1)
    expect(queue.jobs.has("f-det-1")).toBe(false);
    expect(queue.jobs.has("f-det-2")).toBe(true);
    expect(queue.jobs.has("f-det-3")).toBe(true);
  });

  it("refuses removed synthetic gas-topup and rail-second-step jobs during execution and recovery", async () => {
    const config = loadConfig({ env: completeEnv() });
    const { logger } = capturingLogger();
    const ledger = new KeeperRecoveryLedger();
    const queue = new InMemoryRetainableQueue();
    const ctx = { config, db: new MockDb([]), logger, recoveryLedger: ledger };

    await expect(executeKeeperJobWithRecovery(ctx, "legacy-1", "gas-topup", {})).rejects.toThrow(
      "unknown keeper job name: gas-topup",
    );
    await expect(
      executeKeeperJobWithRecovery(ctx, "legacy-2", "rail-second-step", {}),
    ).rejects.toThrow("unknown keeper job name: rail-second-step");

    queue.put("legacy-failed", "gas-topup", {}, "failed", Date.now());
    await expect(recoverFailedKeeperJob(ctx, queue, "legacy-failed")).rejects.toThrow(
      "Unsupported or missing failed keeper job",
    );
  });
});
