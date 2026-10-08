/**
 * `/health` and `/ready`, which answer different questions, and say which one they answered.
 *
 * `/health` is liveness. It touches nothing outside the process and returns 200 as long as the
 * event loop is still handling requests. Giving it a database check would mean a thirty second
 * database blip restarts every replica, and restarting a process does not fix somebody else's
 * database.
 *
 * `/ready` is readiness. It checks Postgres and asks every watcher how it is getting on, and
 * returns 503 when the answer is that this process cannot do its job. A load balancer takes a
 * replica out of rotation on a 503 and puts it back when it recovers, with no restart.
 *
 * Both bodies carry a `meaning` string, because the one thing more annoying than a probe that
 * lies is two probes whose difference is documented somewhere else.
 */
import type { FastifyInstance } from "fastify";

import type { ServerDeps } from "../server.js";
import type { ReadinessReport } from "../../runtime/readiness.js";
import { checkRedisHealth, worstOf } from "../../runtime/readiness.js";

const LIVENESS_MEANING =
  "This process is running and answering. It says nothing about Postgres or the chains. Use /ready for that.";

const READINESS_MEANING =
  "This process can do its job: Postgres and Redis answer and every watcher is current. A 503 here means take this replica out of rotation, not restart it.";

export function registerHealthRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const startedAt = deps.startedAt ?? new Date();

  app.get("/health", () => ({
    status: "ok",
    meaning: LIVENESS_MEANING,
    service: "hyperion-backend",
    network: deps.config.network,
    uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
  }));

  app.get("/ready", async (_request, reply) => {
    const checks: ReadinessReport[] = [await checkDatabase(deps), await checkRedis(deps)];

    for (const source of deps.readiness) {
      try {
        const report = await source.readiness();
        if (report.name === "redis" && deps.redis !== undefined) continue;
        checks.push(report);
      } catch (error) {
        // A readiness check that throws is itself a failure, and swallowing it would report
        // ready for a component nobody can hear from.
        checks.push({
          name: "unknown",
          state: "down",
          detail: `readiness check threw: ${messageOf(error)}`,
        });
      }
    }

    const state = worstOf(checks);
    // Degraded still serves. One stalled chain watcher is a reason to alert, not a reason to stop
    // answering questions about the three chains that are fine.
    const status = state === "down" ? 503 : 200;
    return reply.code(status).send({
      status: state,
      meaning: READINESS_MEANING,
      network: deps.config.network,
      indexer: deps.config.indexer.enabled ? "enabled" : "disabled",
      checks,
    });
  });
}

async function checkDatabase(deps: ServerDeps): Promise<ReadinessReport> {
  try {
    await deps.db.ping();
    return { name: "postgres", state: "ready", detail: "answering" };
  } catch (error) {
    // The message is from pg and can name a host and a database but never a password, because
    // the pool was built from a connection string pg does not echo back.
    return { name: "postgres", state: "down", detail: `not answering: ${messageOf(error)}` };
  }
}

async function checkRedis(deps: ServerDeps): Promise<ReadinessReport> {
  if (deps.redis !== undefined) {
    return checkRedisHealth(deps.redis, { workers: deps.bullmqWorkers });
  }
  return { name: "redis", state: "down", detail: "redis client not configured or unreachable" };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
