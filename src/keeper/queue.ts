/**
 * BullMQ queue and worker management for the keeper.
 *
 * Sets up the `hyperion-keeper` queue on Redis, bounds completed/failed job retention while
 * preserving uncertain submission evidence, and provides reviewed recovery for failed jobs.
 */
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";

import { KeeperBatchUncertainError, processClaimSettlement } from "./jobs/claims.js";
import { processTtlBump } from "./jobs/ttl.js";
import {
  KeeperRecoveryLedger,
  canonicalizeKeeperPayloadKey,
  isSupportedKeeperJobName,
  pruneKeeperJobHistory,
  recoverFailedKeeperJob,
  type KeeperRecoveryDecision,
  type UncertainTxRecord,
} from "./recovery.js";
import {
  KeeperUncertainSubmissionError,
  sanitizeKeeperText,
  type KeeperTxLookupClient,
} from "./stellar.js";
import type {
  ClaimSettlementPayload,
  KeeperContext,
  KeeperJobResult,
  TtlBumpPayload,
} from "./types.js";

export const KEEPER_QUEUE_NAME = "hyperion-keeper";

export interface KeeperHandle {
  readonly queue: Queue;
  readonly worker: Worker<unknown, KeeperJobResult>;
  readonly redis: Redis;
  readonly recoveryLedger: KeeperRecoveryLedger;
  recoverFailedJob(
    jobId: string,
    options?: { readonly lookupClient?: KeeperTxLookupClient },
  ): Promise<KeeperRecoveryDecision>;
  pruneHistory(): Promise<void>;
  close(): Promise<void>;
}

export function createKeeperRedis(redisUrl: string): Redis {
  return new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
  });
}

export function extractUncertainSubmissionsFromError(error: unknown): readonly UncertainTxRecord[] {
  if (error instanceof KeeperBatchUncertainError) {
    return error.pendingSubmissions;
  }
  if (error instanceof KeeperUncertainSubmissionError) {
    const maybeCounts = (
      error as KeeperUncertainSubmissionError & {
        bumpedCounts?: UncertainTxRecord["bumpedCounts"];
      }
    ).bumpedCounts;
    return [
      {
        txHash: error.txHash,
        contract: error.contract,
        method: error.method,
        ...(maybeCounts !== undefined ? { bumpedCounts: maybeCounts } : {}),
      },
    ];
  }
  return [];
}

export async function executeKeeperJobWithRecovery(
  ctx: KeeperContext,
  jobId: string,
  jobName: string,
  rawData: unknown,
): Promise<KeeperJobResult> {
  if (!isSupportedKeeperJobName(jobName)) {
    throw new Error(`unknown keeper job name: ${jobName}`);
  }

  const payload = (rawData ?? {}) as TtlBumpPayload | ClaimSettlementPayload;
  try {
    if (jobName === "ttl-bump") {
      const result = await processTtlBump(ctx, payload);
      return { kind: "ttl-bump", result };
    }
    const result = await processClaimSettlement(ctx, payload);
    return { kind: "claim-settlement", result };
  } catch (error) {
    const pendingSubmissions = extractUncertainSubmissionsFromError(error);
    const reason = error instanceof Error ? error.message : String(error);
    ctx.recoveryLedger?.recordFailedJob({
      jobId,
      jobName,
      payload,
      payloadKey: canonicalizeKeeperPayloadKey(jobName, payload),
      failedAtMs: Date.now(),
      reason,
      pendingSubmissions,
      uncertain: pendingSubmissions.length > 0,
    });
    throw error;
  }
}

export async function startKeeperQueue(
  ctx: KeeperContext,
  redisUrl: string,
): Promise<KeeperHandle> {
  const { config, logger } = ctx;
  const recoveryLedger =
    ctx.recoveryLedger ?? new KeeperRecoveryLedger(config.keeper.retention.maxCompletedJobs * 4);
  const sharedCtx: KeeperContext = { ...ctx, recoveryLedger };

  const redis = createKeeperRedis(redisUrl);
  await redis.connect();

  const defaultJobOptions = {
    attempts: 1,
    removeOnComplete: {
      count: config.keeper.retention.maxCompletedJobs,
      age: config.keeper.retention.completedMaxAgeSeconds,
    },
    // Failed jobs are pruned selectively by pruneKeeperJobHistory so uncertain submissions survive.
    removeOnFail: false,
  };

  const queue = new Queue(KEEPER_QUEUE_NAME, {
    connection: redis,
    defaultJobOptions,
  });

  const worker = new Worker<unknown, KeeperJobResult, string>(
    KEEPER_QUEUE_NAME,
    async (job) => {
      const jobId = job.id ?? `${job.name}:${String(Date.now())}`;
      logger.info({ jobName: job.name, jobId }, "processing keeper job");
      return executeKeeperJobWithRecovery(sharedCtx, jobId, job.name, job.data);
    },
    {
      connection: createKeeperRedis(redisUrl),
      concurrency: config.keeper.concurrency,
    },
  );

  const pruneHistory = async (): Promise<void> => {
    try {
      await pruneKeeperJobHistory(queue, config.keeper.retention, recoveryLedger);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ reason: sanitizeKeeperText(msg) }, "keeper queue retention sweep failed");
    }
  };

  worker.on("completed", (job, result) => {
    logger.info({ jobName: job.name, jobId: job.id, kind: result.kind }, "keeper job completed");
    void pruneHistory();
  });

  worker.on("failed", (job, error) => {
    logger.error(
      {
        jobName: job?.name,
        jobId: job?.id,
        reason: sanitizeKeeperText(error.message),
      },
      "keeper job failed",
    );
    void pruneHistory();
  });

  // Schedule repeatable jobs strictly for the two supported Stellar tasks
  const every = config.keeper.pollIntervalMs;
  await queue.upsertJobScheduler(
    "repeat:ttl-bump",
    { every },
    { name: "ttl-bump", opts: defaultJobOptions },
  );
  await queue.upsertJobScheduler(
    "repeat:claim-settlement",
    { every },
    { name: "claim-settlement", opts: defaultJobOptions },
  );
  await queue.removeJobScheduler("repeat:rail-second-step");
  await queue.removeJobScheduler("repeat:gas-topup");

  return {
    queue,
    worker,
    redis,
    recoveryLedger,
    recoverFailedJob: (jobId, options) => recoverFailedKeeperJob(sharedCtx, queue, jobId, options),
    pruneHistory,
    close: async () => {
      await worker.close();
      await queue.close();
      redis.disconnect();
    },
  };
}
