import { checkDatabasePolicy } from "../src/db/policy.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { loadConfig } from "../src/config/config.js";
import { Database } from "../src/db/pool.js";
import { checkSchemaCompatibility } from "../src/db/schema.js";
import { buildServer } from "../src/http/server.js";
import { createApiRedis } from "../src/http/rate-limit-redis.js";
import { createLogger } from "../src/logging/logger.js";

interface AppResources {
  readonly app: FastifyInstance;
  readonly db: Database;
  readonly redis: Redis | null;
}

let resources: AppResources | null = null;
let lifecycle: Promise<void> = Promise.resolve();

/** Serialize acquisition and disposal so an old failure cannot tear down a new app. */
function duringLifecycle<T>(work: () => Promise<T>): Promise<T> {
  const operation = lifecycle.then(work);
  // A failed invocation must not poison the queue for subsequent cold starts.
  lifecycle = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

async function dispose(current: AppResources): Promise<void> {
  try {
    await current.app.close();
  } finally {
    try {
      current.redis?.disconnect();
    } finally {
      await current.db.close();
    }
  }
}

async function checkHealth(): Promise<void> {
  const current = resources;
  if (current === null) throw new Error("Application not initialized");
  try {
    await current.db.ping();
  } catch (error) {
    resources = null;
    await dispose(current).catch(() => undefined);
    throw error;
  }
}

export async function checkAppHealth(): Promise<void> {
  await duringLifecycle(checkHealth);
}

export async function closeApp(): Promise<void> {
  await duringLifecycle(async () => {
    const current = resources;
    resources = null;
    if (current !== null) await dispose(current);
  });
}

export function getDb(): Database | null {
  return resources?.db ?? null;
}

async function createApp(): Promise<AppResources> {
  process.env.VERCEL_ENV ??= "production";
  process.env.INDEXER_ENABLED ??= "false";
  process.env.RAILS_ENABLED ??= "false";
  process.env.KEEPER_ENABLED ??= "false";
  process.env.HYPERION_DATABASE_ROLE ??= "read-only";

  const config = loadConfig();
  if (
    config.indexer.enabled ||
    config.rails.enabled ||
    config.keeper.enabled ||
    config.databaseRole !== "read-only"
  )
    throw new Error(
      "API entrypoint requires read-only database credentials and disabled background writers.",
    );
  const logger = createLogger(config);
  const startedAt = new Date();

  const candidateDb = Database.open(config.databaseUrl, {
    applicationName: "hyperion-vercel-api",
    connectionTimeoutMs: 2000,
    readOnly: true,
    maxConnections: 2,
  });
  let candidate: FastifyInstance | null = null;
  let redis: Redis | null = null;
  try {
    await checkSchemaCompatibility(candidateDb, config.schemaVersion);
    await checkDatabasePolicy(candidateDb, config);
    redis = config.redisUrl.length > 0 ? createApiRedis(config.redisUrl) : null;
    candidate = buildServer({
      config,
      logger,
      db: candidateDb,
      ...(redis === null ? {} : { redis }),
      readiness: [],
      startedAt,
    });
    await candidate.ready();
    return { app: candidate, db: candidateDb, redis };
  } catch (error) {
    if (candidate !== null) await candidate.close().catch(() => undefined);
    try {
      redis?.disconnect();
    } catch {
      // Preserve the startup failure even when cleanup itself fails.
    }
    await candidateDb.close().catch(() => undefined);
    throw error;
  }
}

export function getApp(): Promise<FastifyInstance> {
  return duringLifecycle(async () => {
    const current = resources;
    if (current !== null) {
      await checkHealth();
      return current.app;
    }
    const created = await createApp();
    resources = created;
    return created.app;
  });
}

/** Direct harness initialization observes the same concurrency boundary as real requests. */
export function initializeApp(): Promise<FastifyInstance> {
  return getApp();
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const server = await getApp();
    server.server.emit("request", req, res);
  } catch {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "internal_error",
        message: "The API is not configured or is unavailable.",
      }),
    );
  }
}
