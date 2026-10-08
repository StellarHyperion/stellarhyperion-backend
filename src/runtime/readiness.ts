/**
 * What "ready" means, as a thing a component reports rather than a thing the HTTP layer guesses.
 *
 * `/health` and `/ready` are answering two different questions and the distinction is not
 * cosmetic. A liveness probe that checks Postgres restarts the API every time the database
 * hiccups, which turns a brief database problem into a rolling outage. A readiness probe that
 * does not check Postgres sends traffic to a process that cannot answer a single query. So
 * liveness is "this process is still a process" and readiness is "this process can do its job",
 * and anything with a dependency belongs in the second one.
 *
 * This interface is the seam the rail pollers and the keeper plug into later: each one reports
 * its own readiness and the HTTP layer only aggregates.
 */

export type ReadinessState = "ready" | "degraded" | "down";

export interface ReadinessReport {
  /** Stable, lowercase, dash separated. Shows up in the `/ready` body and in alerts. */
  readonly name: string;
  readonly state: ReadinessState;
  /** One sentence a human can act on. Never a stack trace and never a connection string. */
  readonly detail: string;
}

export interface ReadinessSource {
  /**
   * Answer from cached state, not by making a network call.
   *
   * Readiness is polled by a load balancer every couple of seconds. A check that talks to an RPC
   * endpoint turns the probe into load, and a slow endpoint into a false negative. Components
   * record their own last known good state as they work and report it from memory here. The one
   * exception is the database, which gets a `SELECT 1`, because that is cheaper than the probe
   * itself and because it is the dependency nothing else can compensate for.
   */
  readiness(): ReadinessReport | Promise<ReadinessReport>;
}

/**
 * The worst state wins.
 *
 * A single degraded watcher makes the process degraded rather than down, because it can still
 * answer about the chains that are working. Anything down makes the whole thing down.
 */
export function worstOf(reports: readonly ReadinessReport[]): ReadinessState {
  if (reports.some((report) => report.state === "down")) return "down";
  if (reports.some((report) => report.state === "degraded")) return "degraded";
  return "ready";
}

/** Readiness that only reports what it is told, for a component with nothing to check. */
export function fixedReadiness(
  name: string,
  state: ReadinessState,
  detail: string,
): ReadinessSource {
  return { readiness: () => ({ name, state, detail }) };
}

export interface RedisPingable {
  ping(): Promise<unknown>;
}

export interface BullMQWorkerState {
  readonly name?: string;
  isPaused?(): boolean | Promise<boolean>;
  isRunning?(): boolean;
}

export interface RedisHealthOptions {
  readonly timeoutMs?: number | undefined;
  readonly workers?: readonly BullMQWorkerState[] | undefined;
}

export const DEFAULT_REDIS_TIMEOUT_MS = 2000;

/**
 * Check Redis connectivity and BullMQ worker readiness.
 *
 * Pings Redis with a default timeout of 2000ms. If Redis fails or times out,
 * reports state "down". If Redis is responding but BullMQ workers are paused,
 * reports state "degraded".
 */
export async function checkRedisHealth(
  redis: RedisPingable,
  options: RedisHealthOptions = {},
): Promise<ReadinessReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REDIS_TIMEOUT_MS;

  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`timeout after ${String(timeoutMs)}ms`));
      }, timeoutMs);
    });

    try {
      await Promise.race([redis.ping(), timeoutPromise]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "redis",
      state: "down",
      detail: message.includes("timeout")
        ? `redis ping timed out after ${String(timeoutMs)}ms`
        : `redis unreachable: ${message}`,
    };
  }

  if (options.workers !== undefined && options.workers.length > 0) {
    for (const worker of options.workers) {
      const isPaused = typeof worker.isPaused === "function" ? await worker.isPaused() : false;
      const isRunning = typeof worker.isRunning === "function" ? worker.isRunning() : true;
      if (isPaused || !isRunning) {
        return {
          name: "redis",
          state: "degraded",
          detail: `worker ${worker.name ?? "bullmq"} is ${isPaused ? "paused" : "not running"}`,
        };
      }
    }
  }

  return {
    name: "redis",
    state: "ready",
    detail: "answering",
  };
}

export function redisReadiness(
  redis: RedisPingable,
  options: RedisHealthOptions = {},
): ReadinessSource {
  return {
    readiness: () => checkRedisHealth(redis, options),
  };
}

export function bullmqWorkersReadiness(
  workers: readonly BullMQWorkerState[],
  name = "bullmq",
): ReadinessSource {
  return {
    readiness: async () => {
      for (const worker of workers) {
        const isPaused = typeof worker.isPaused === "function" ? await worker.isPaused() : false;
        const isRunning = typeof worker.isRunning === "function" ? worker.isRunning() : true;
        if (isPaused || !isRunning) {
          return {
            name,
            state: "degraded",
            detail: `worker ${worker.name ?? "unnamed"} is ${isPaused ? "paused" : "not running"}`,
          };
        }
      }
      return {
        name,
        state: "ready",
        detail: "active and non-paused",
      };
    },
  };
}

export class ReadinessRegistry {
  private readonly sources: ReadinessSource[] = [];

  register(source: ReadinessSource): void {
    this.sources.push(source);
  }

  registerRedis(redis: RedisPingable, options?: RedisHealthOptions): void {
    this.sources.push(redisReadiness(redis, options));
  }

  registerBullmq(workers: readonly BullMQWorkerState[], name?: string): void {
    this.sources.push(bullmqWorkersReadiness(workers, name));
  }

  async check(): Promise<{ state: ReadinessState; checks: ReadinessReport[] }> {
    const checks: ReadinessReport[] = [];
    for (const source of this.sources) {
      try {
        checks.push(await source.readiness());
      } catch (error) {
        checks.push({
          name: "unknown",
          state: "down",
          detail: `readiness check threw: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return { state: worstOf(checks), checks };
  }
}
