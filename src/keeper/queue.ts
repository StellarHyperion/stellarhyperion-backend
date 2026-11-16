/**
 * BullMQ queue and worker management for the keeper.
 *
 * Sets up the `hyperion-keeper` queue on Redis and schedules repeatable jobs for the two
 * Stellar upkeep tasks. Connects via ioredis with `maxRetriesPerRequest: null` as
 * required by BullMQ.
 */
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";

import { processClaimSettlement } from "./jobs/claims.js";
import { processTtlBump } from "./jobs/ttl.js";
import type { KeeperContext, KeeperJobName, KeeperJobResult } from "./types.js";

export const KEEPER_QUEUE_NAME = "hyperion-keeper";

export interface KeeperHandle {
  readonly queue: Queue;
  readonly worker: Worker<unknown, KeeperJobResult>;
  readonly redis: Redis;
  readonly activePolicyVersion: () => number;
  readonly inFlightPolicyVersions: () => readonly number[];
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
  const { config, logger, policyStore } = ctx;
  const redis = createKeeperRedis(redisUrl);
  await redis.connect();

  const queue = new Queue(KEEPER_QUEUE_NAME, {
    connection: redis,
  });

  const initialPolicy = policyStore?.current();
  let scheduledEveryMs = initialPolicy?.values.keeperPollIntervalMs ?? config.keeper.pollIntervalMs;
  const inFlight = new Map<string, number>();

  const worker = new Worker<unknown, KeeperJobResult, string>(
    KEEPER_QUEUE_NAME,
    async (job) => {
      // Policy snapshot is captured once at the job boundary so an in-flight job finishes
      // under the policy version that was active when it started.
      const capturedPolicy = policyStore?.current();
      const policyVersion = capturedPolicy?.version ?? 1;
      const jobKey = `${job.name}:${job.id ?? "unassigned"}`;
      inFlight.set(jobKey, policyVersion);

      try {
        logger.info({ jobName: job.name, jobId: job.id, policyVersion }, "processing keeper job");
        switch (job.name as KeeperJobName) {
          case "ttl-bump": {
            const result = await processTtlBump(ctx, job.data as object);
            return {
              kind: "ttl-bump",
              result: { ...result, policyVersion },
              policyVersion,
            };
          }
          case "claim-settlement": {
            const result = await processClaimSettlement(ctx, job.data as object);
            return {
              kind: "claim-settlement",
              result: { ...result, policyVersion },
              policyVersion,
            };
          }
          default:
            throw new Error(`unknown keeper job name: ${job.name}`);
        }
      } finally {
        inFlight.delete(jobKey);
      }
    },
    {
      connection: createKeeperRedis(redisUrl),
      concurrency: initialPolicy?.values.keeperConcurrency ?? config.keeper.concurrency,
    },
  );

  worker.on("completed", (job, result) => {
    logger.info(
      { jobName: job.name, jobId: job.id, kind: result.kind, policyVersion: result.policyVersion },
      "keeper job completed",
    );
  });

  worker.on("failed", (job, error) => {
    logger.error({ jobName: job?.name, jobId: job?.id, err: error }, "keeper job failed");
  });

  // Schedule repeatable jobs for the two Stellar tasks
  await queue.upsertJobScheduler(
    "repeat:ttl-bump",
    { every: scheduledEveryMs },
    { name: "ttl-bump" },
  );
  await queue.upsertJobScheduler(
    "repeat:claim-settlement",
    { every: scheduledEveryMs },
    { name: "claim-settlement" },
  );
  await queue.removeJobScheduler("repeat:rail-second-step");
  await queue.removeJobScheduler("repeat:gas-topup");

  const unsubscribe = policyStore?.subscribe((next) => {
    worker.concurrency = next.values.keeperConcurrency;
    if (next.values.keeperPollIntervalMs !== scheduledEveryMs) {
      scheduledEveryMs = next.values.keeperPollIntervalMs;
      void Promise.all([
        queue.upsertJobScheduler(
          "repeat:ttl-bump",
          { every: scheduledEveryMs },
          { name: "ttl-bump" },
        ),
        queue.upsertJobScheduler(
          "repeat:claim-settlement",
          { every: scheduledEveryMs },
          { name: "claim-settlement" },
        ),
      ]).catch((err: unknown) => {
        logger.error(
          { err, policyVersion: next.version },
          "failed to update keeper repeatable job schedule after policy reload",
        );
      });
    }
  });

  return {
    queue,
    worker,
    redis,
    activePolicyVersion: () => policyStore?.current().version ?? 1,
    inFlightPolicyVersions: () => [...inFlight.values()],
    close: async () => {
      unsubscribe?.();
      await worker.close();
      await queue.close();
      redis.disconnect();
    },
  };
}
