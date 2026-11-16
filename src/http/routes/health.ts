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
import type { ReadinessPolicyConfig, ReadinessReport } from "../../runtime/readiness.js";
import {
  applyDependencyPolicy,
  checkRedisHealth,
  inferCategoryFromCheckName,
  worstOf,
} from "../../runtime/readiness.js";

const LIVENESS_MEANING =
  "This process is running and answering. It says nothing about Postgres or the chains. Use /ready for that.";

function readinessMeaning(policy: ReadinessPolicyConfig): string {
  if (policy.mode === "api-only") {
    return "API-only mode: verifies configured database and persisted-state policy only. Background workers (indexer, rails, keeper) are absent in this process and are never certified live here.";
  }
  return "Worker readiness: evaluates database, Redis, and active worker dependencies against configured required/optional/disabled policy. A 503 means a required dependency is down or stale; optional outages report degraded (200).";
}

export function registerHealthRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const startedAt = deps.startedAt ?? new Date();
  const policy = deps.config.readinessPolicy;

  app.get("/health", () => ({
    status: "ok",
    meaning: LIVENESS_MEANING,
    service: "hyperion-backend",
    network: deps.config.network,
    mode: policy.mode,
    uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
  }));

  app.get("/ready", async (_request, reply) => {
    const dbCheckRaw = await checkDatabase(deps);
    const redisCheckRaw = await checkRedis(deps);
    const rawChecks: ReadinessReport[] = [dbCheckRaw, redisCheckRaw];

    for (const source of deps.readiness) {
      try {
        const report = await source.readiness();
        if (report.name === "redis" && deps.redis !== undefined) continue;
        rawChecks.push(report);
      } catch (error) {
        // A readiness check that throws is itself a failure, and swallowing it would report
        // ready for a component nobody can hear from.
        rawChecks.push({
          name: "unknown",
          category: "indexer",
          observedState: "down",
          certified: false,
          state: "down",
          detail: `readiness check threw: ${messageOf(error)}`,
        });
      }
    }

    // In API-only mode, explicitly represent absent worker categories so callers never mistake an
    // omitted check for a certified worker, and evaluate persisted cursor freshness if configured.
    if (policy.mode === "api-only") {
      const presentCategories = new Set(
        rawChecks.map((item) => item.category ?? inferCategoryFromCheckName(item.name)),
      );
      if (!presentCategories.has("indexer") && policy.maxCursorStaleMs === null) {
        rawChecks.push({
          name: "indexer",
          category: "indexer",
          observedState: "absent",
          certified: false,
          state: "ready",
          detail: "absent in api-only deployment mode; no chain watchers run in this process",
        });
      }
      if (!presentCategories.has("rails")) {
        rawChecks.push({
          name: "rails",
          category: "rails",
          observedState: "absent",
          certified: false,
          state: "ready",
          detail: "absent in api-only deployment mode; no rail pollers run in this process",
        });
      }
      if (!presentCategories.has("keeper")) {
        rawChecks.push({
          name: "keeper",
          category: "keeper",
          observedState: "absent",
          certified: false,
          state: "ready",
          detail: "absent in api-only deployment mode; no keeper workers run in this process",
        });
      }
    }

    if (policy.maxCursorStaleMs !== null && policy.indexer !== "disabled") {
      rawChecks.push(await checkPersistedCursorFreshness(deps, dbCheckRaw.state === "ready"));
    }

    const checks = rawChecks.map((report) => applyDependencyPolicy(report, policy));
    const certifiedWorkers = checks
      .filter(
        (item) =>
          item.certified === true &&
          (item.category === "indexer" || item.category === "rails" || item.category === "keeper"),
      )
      .map((item) => item.name);

    const state = worstOf(checks);
    // Degraded still serves. One stalled chain watcher or optional outage is a reason to alert,
    // not a reason to stop answering questions about the chains that are fine.
    const status = state === "down" ? 503 : 200;
    return reply.code(status).send({
      status: state,
      meaning: readinessMeaning(policy),
      network: deps.config.network,
      mode: policy.mode,
      policy: {
        database: policy.database,
        redis: policy.redis,
        indexer: policy.indexer,
        rails: policy.rails,
        keeper: policy.keeper,
        maxCursorStaleMs: policy.maxCursorStaleMs,
      },
      indexer: deps.config.indexer.enabled ? "enabled" : "disabled",
      certifiedWorkers,
      checks,
    });
  });
}

async function checkDatabase(deps: ServerDeps): Promise<ReadinessReport> {
  try {
    await deps.db.ping();
    return {
      name: "postgres",
      category: "database",
      observedState: "ready",
      state: "ready",
      detail: "answering",
    };
  } catch (error) {
    // The message is from pg and can name a host and a database but never a password, because
    // the pool was built from a connection string pg does not echo back.
    return {
      name: "postgres",
      category: "database",
      observedState: "down",
      certified: false,
      state: "down",
      detail: `not answering: ${messageOf(error)}`,
    };
  }
}

async function checkRedis(deps: ServerDeps): Promise<ReadinessReport> {
  const policy = deps.config.readinessPolicy;
  if (deps.redis !== undefined) {
    const res = await checkRedisHealth(deps.redis, { workers: deps.bullmqWorkers });
    return {
      ...res,
      category: "redis",
      observedState: res.state,
    };
  }
  if (!deps.config.keeper.enabled && policy.redis === "disabled") {
    return {
      name: "redis",
      category: "redis",
      observedState: "absent",
      certified: false,
      state: "ready",
      detail: "not required: keeper is disabled",
    };
  }
  return {
    name: "redis",
    category: "redis",
    observedState: "down",
    certified: false,
    state: "down",
    detail: "redis client not configured or unreachable",
  };
}

async function checkPersistedCursorFreshness(
  deps: ServerDeps,
  databaseAnswering: boolean,
): Promise<ReadinessReport> {
  const maxStaleMs = deps.config.readinessPolicy.maxCursorStaleMs ?? 0;
  if (!databaseAnswering) {
    return {
      name: "indexer-cursor",
      category: "indexer",
      observedState: "down",
      certified: false,
      stale: true,
      state: "down",
      detail: "cannot verify persisted cursor freshness while postgres is unreachable",
    };
  }

  const expectedChains: string[] = [];
  if (deps.config.indexer.stellar !== null) {
    expectedChains.push(deps.config.indexer.stellar.chain);
  }
  for (const evm of deps.config.indexer.evm) {
    expectedChains.push(evm.chain);
  }

  try {
    const res = await deps.db.query("SELECT chain_key, updated_at FROM indexer_cursor");
    const updatedByChain = new Map<string, number>();
    for (const row of res.rows) {
      if (
        typeof row.chain_key === "string" &&
        row.updated_at !== undefined &&
        row.updated_at !== null
      ) {
        const ts = new Date(row.updated_at as string | number | Date).getTime();
        if (Number.isFinite(ts)) {
          updatedByChain.set(row.chain_key, ts);
        }
      }
    }

    const targets = expectedChains.length > 0 ? expectedChains : [...updatedByChain.keys()];
    if (targets.length === 0) {
      return {
        name: "indexer-cursor",
        category: "indexer",
        observedState: "down",
        certified: false,
        stale: true,
        state: "down",
        detail: "no persisted indexer_cursor rows exist yet",
      };
    }

    const now = Date.now();
    const staleDetails: string[] = [];
    for (const chain of targets) {
      const updatedAt = updatedByChain.get(chain);
      if (updatedAt === undefined) {
        staleDetails.push(`${chain} cursor missing`);
        continue;
      }
      const ageMs = Math.max(0, now - updatedAt);
      if (ageMs > maxStaleMs) {
        staleDetails.push(`${chain} cursor age ${String(ageMs)}ms exceeds ${String(maxStaleMs)}ms`);
      }
    }

    if (staleDetails.length > 0) {
      return {
        name: "indexer-cursor",
        category: "indexer",
        observedState: "down",
        certified: false,
        stale: true,
        state: "down",
        detail: staleDetails.join("; "),
      };
    }

    return {
      name: "indexer-cursor",
      category: "indexer",
      observedState: "ready",
      // Persisted cursor freshness verifies DB evidence, not an in-process watcher loop.
      certified: deps.config.readinessPolicy.mode !== "api-only",
      stale: false,
      state: "ready",
      detail: `persisted cursors within ${String(maxStaleMs)}ms freshness budget`,
    };
  } catch (error) {
    return {
      name: "indexer-cursor",
      category: "indexer",
      observedState: "down",
      certified: false,
      stale: true,
      state: "down",
      detail: `cursor freshness query failed: ${messageOf(error)}`,
    };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
