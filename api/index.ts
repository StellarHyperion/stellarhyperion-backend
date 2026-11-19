import { checkDatabasePolicy } from "../src/db/policy.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve as resolvePath } from "node:path";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config/config.js";
import { Database } from "../src/db/pool.js";
import { checkSchemaCompatibility } from "../src/db/schema.js";
import { buildServer } from "../src/http/server.js";
import { createApiRedis } from "../src/http/rate-limit-redis.js";
import { createLogger } from "../src/logging/logger.js";

let app: FastifyInstance | null = null;
let initializing: Promise<FastifyInstance> | null = null;
let db: Database | null = null;

export async function checkAppHealth(): Promise<void> {
  if (!db || !app) {
    app = null;
    initializing = null;
    db = null;
    throw new Error("Application not initialized");
  }
  try {
    await db.ping();
  } catch (error) {
    const deadApp = app;
    const deadDb = db;
    app = null;
    initializing = null;
    db = null;
    await deadApp.close().catch(() => undefined);
    await deadDb.close().catch(() => undefined);
    throw error;
  }
}

export async function closeApp(): Promise<void> {
  const currentApp = app;
  const currentDb = db;
  app = null;
  initializing = null;
  db = null;
  if (currentApp) {
    await currentApp.close().catch(() => undefined);
  }
  if (currentDb) {
    await currentDb.close().catch(() => undefined);
  }
}

export function getDb(): Database | null {
  return db;
}

export async function initializeApp(): Promise<FastifyInstance> {
  if (app) return app;

  process.env.VERCEL_ENV ??= "production";
  process.env.HYPERION_NETWORK ??= "testnet";
  process.env.HYPERION_DEPLOYMENTS_FILE ??= resolvePath(process.cwd(), "deployments/testnet.json");
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
    max: 2,
    maxConnections: 2,
  });
  try {
    await checkSchemaCompatibility(candidateDb, config.schemaVersion);
    await checkDatabasePolicy(candidateDb, config);
  } catch (error) {
    await candidateDb.close();
    throw error;
  }

  const candidate = buildServer({
    config,
    logger,
    db: candidateDb,
    ...(config.redisUrl.length > 0 ? { redis: createApiRedis(config.redisUrl) } : {}),
    readiness: [],
    startedAt,
  });

  try {
    await candidate.ready();
  } catch (error) {
    await candidate.close();
    await candidateDb.close();
    throw error;
  }
  db = candidateDb;
  app = candidate;
  return candidate;
}

export async function getApp(): Promise<FastifyInstance> {
  if (app) {
    await checkAppHealth();
    return app;
  }
  initializing ??= initializeApp().catch((error: unknown) => {
    initializing = null;
    throw error;
  });
  return initializing;
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
