/**
 * BullMQ queue and worker management for the keeper.
 *
 * Sets up the `hyperion-keeper` queue on Redis and schedules repeatable jobs for the four
 * permissionless upkeep tasks. Connects via ioredis with `maxRetriesPerRequest: null` as
 * required by BullMQ.
 */
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";

import { processClaimSettlement } from "./jobs/claims.js";
import { processGasTopup } from "./jobs/gas.js";
import { processRailSecondStep } from "./jobs/second-step.js";
import { processTtlBump } from "./jobs/ttl.js";
import type { KeeperContext, KeeperJobName, KeeperJobResult } from "./types.js";

export const KEEPER_QUEUE_NAME = "hyperion-keeper";

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
        case "rail-second-step": {
          const result = await processRailSecondStep(ctx, job.data as object);
          return { kind: "rail-second-step", result };
        }
        case "gas-topup": {
          const result = await processGasTopup(ctx, job.data as object);
          return { kind: "gas-topup", result };
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
    logger.info(
      { jobName: job.name, jobId: job.id, kind: result.kind },
      "keeper job completed",
    );
  });

  worker.on("failed", (job, error) => {
    logger.error(
      { jobName: job?.name, jobId: job?.id, err: error },
      "keeper job failed",
    );
  });

  // Schedule repeatable jobs for the four keeper tasks
  const every = config.keeper.pollIntervalMs;
  await queue.upsertJobScheduler("repeat:ttl-bump", { every }, { name: "ttl-bump" });
  await queue.upsertJobScheduler("repeat:claim-settlement", { every }, { name: "claim-settlement" });
  await queue.upsertJobScheduler("repeat:rail-second-step", { every }, { name: "rail-second-step" });
  await queue.upsertJobScheduler("repeat:gas-topup", { every }, { name: "gas-topup" });

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
