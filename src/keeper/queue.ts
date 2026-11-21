/**
 * BullMQ queue and worker management for the keeper.
 *
 * Sets up the `hyperion-keeper` queue on Redis and schedules repeatable jobs for the two
 * Stellar upkeep tasks. Connects via ioredis with `maxRetriesPerRequest: null` as
 * required by BullMQ.
 */
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { rpc } from "@stellar/stellar-sdk";

import type { AppConfig } from "../config/config.js";
import type { Transactional } from "../db/pool.js";
import { processClaimSettlement } from "./jobs/claims.js";
import { processTtlBump } from "./jobs/ttl.js";
import { reconcileKeeperCheckpointsBeforeRetry } from "./stellar.js";
import type { KeeperContext, KeeperJobName, KeeperJobResult } from "./types.js";

export const KEEPER_QUEUE_NAME = "hyperion-keeper";
export const KEEPER_JOB_RETENTION = {
  completed: { age: 7 * 24 * 60 * 60, count: 1_000 },
  failed: { age: 30 * 24 * 60 * 60, count: 5_000 },
} as const;

export interface KeeperHandle {
  readonly queue: Queue;
  readonly worker: Worker<unknown, KeeperJobResult>;
  readonly redis: Redis;
  close(): Promise<void>;
}

export function createKeeperRedis(redisUrl: string): Redis {
  return new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
  });
}

export async function startKeeperQueue(
  ctx: KeeperContext,
  redisUrl: string,
): Promise<KeeperHandle> {
  const { config, logger } = ctx;
  const redis = createKeeperRedis(redisUrl);
  await redis.connect();

  const queue = new Queue(KEEPER_QUEUE_NAME, {
    connection: redis,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: KEEPER_JOB_RETENTION.completed,
      removeOnFail: KEEPER_JOB_RETENTION.failed,
    },
  });

  const worker = new Worker<unknown, KeeperJobResult, string>(
    KEEPER_QUEUE_NAME,
    async (job) => {
      logger.info({ jobName: job.name, jobId: job.id }, "processing keeper job");
      switch (job.name as KeeperJobName) {
        case "ttl-bump": {
          const result = await processTtlBump(ctx, job.data as object);
          return { kind: "ttl-bump", result };
        }
        case "claim-settlement": {
          const result = await processClaimSettlement(ctx, job.data as object);
          return { kind: "claim-settlement", result };
        }
        default:
          throw new Error(`unknown keeper job name: ${job.name}`);
      }
    },
    {
      connection: createKeeperRedis(redisUrl),
      concurrency: config.keeper.concurrency,
    },
  );

  worker.on("completed", (job, result) => {
    logger.info({ jobName: job.name, jobId: job.id, kind: result.kind }, "keeper job completed");
  });

  worker.on("failed", (job) => {
    logger.error(
      { jobName: job?.name, jobId: job?.id },
      "keeper job failed; details omitted to protect configured credentials",
    );
  });

  // Schedule repeatable jobs for the two Stellar tasks
  const every = config.keeper.pollIntervalMs;
  await queue.upsertJobScheduler("repeat:ttl-bump", { every }, { name: "ttl-bump" });
  await queue.upsertJobScheduler(
    "repeat:claim-settlement",
    { every },
    { name: "claim-settlement" },
  );
  await queue.removeJobScheduler("repeat:rail-second-step");
  await queue.removeJobScheduler("repeat:gas-topup");

  return {
    queue,
    worker,
    redis,
    close: async () => {
      await worker.close();
      await queue.close();
      redis.disconnect();
    },
  };
}

export async function requeueFailedKeeperJob(
  queue: Queue,
  db: Transactional,
  config: AppConfig,
  jobId: string,
  reviewedBy: string,
  reason: string,
  client?: rpc.Server,
): Promise<void> {
  const reviewer = reviewedBy.trim();
  const reviewReason = reason.trim();
  if (!jobId.trim() || jobId.length > 200)
    throw new Error("Keeper queue job ID must contain 1 to 200 characters.");
  if (!reviewer || reviewer.length > 200)
    throw new Error("Reviewed-by must contain 1 to 200 characters.");
  if (!reviewReason || reviewReason.length > 2_000)
    throw new Error("Review reason must contain 1 to 2,000 characters.");

  const initialJob = await queue.getJob(jobId);
  if (!initialJob) throw new Error("Keeper queue job was not found.");
  if (initialJob.name !== "ttl-bump" && initialJob.name !== "claim-settlement")
    throw new Error("Only supported Stellar maintenance jobs may be recovered.");
  if ((await initialJob.getState()) !== "failed")
    throw new Error("Only failed keeper jobs may be recovered.");

  await reconcileKeeperCheckpointsBeforeRetry(config, db, client);
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `keeper-requeue:${jobId}`,
    ]);
    const job = await queue.getJob(jobId);
    if (!job || job.name !== initialJob.name || (await job.getState()) !== "failed")
      throw new Error("Keeper queue job is no longer failed and cannot be recovered.");

    await tx.query(
      `INSERT INTO keeper_requeue_audit(queue_job_id,job_name,reviewed_by,reviewed_reason)
       VALUES($1,$2,$3,$4)`,
      [jobId, job.name, reviewer, reviewReason],
    );
    await job.retry();
  });
}
