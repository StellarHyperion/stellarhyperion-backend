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

async function initializeApp(): Promise<FastifyInstance> {
  if (app) return app;

  process.env.HYPERION_NETWORK ??= "testnet";
  process.env.HYPERION_DEPLOYMENTS_FILE ??= resolvePath(process.cwd(), "deployments/testnet.json");
  process.env.INDEXER_ENABLED ??= "false";
  process.env.RAILS_ENABLED ??= "false";
  process.env.KEEPER_ENABLED ??= "false";

  const config = loadConfig();
  const logger = createLogger(config);
  const startedAt = new Date();

  const db = Database.open(config.databaseUrl, {
    applicationName: "hyperion-vercel-api",
    connectionTimeoutMs: 2000,
  });
  try {
    await checkSchemaCompatibility(db, config.schemaVersion);
  } catch (error) {
    await db.close();
    throw error;
  }

  const candidate = buildServer({
    config,
    logger,
    db,
    ...(config.redisUrl.length > 0 ? { redis: createApiRedis(config.redisUrl) } : {}),
    readiness: [],
    startedAt,
  });

  try {
    await candidate.ready();
  } catch (error) {
    await candidate.close();
    await db.close();
    throw error;
  }
  app = candidate;
  return candidate;
}

function getApp(): Promise<FastifyInstance> {
  if (app) return Promise.resolve(app);
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
