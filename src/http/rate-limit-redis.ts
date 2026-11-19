import { Redis } from "ioredis";

/** A request-facing Redis connection must fail within a bounded time during an outage. */
export function createApiRedis(url: string): Redis {
  const redis = new Redis(url, {
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    connectTimeout: 2000,
    commandTimeout: 2000,
  });
  // Requests and readiness report failures; avoid ioredis printing raw connection errors.
  redis.on("error", () => undefined);
  return redis;
}
