import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve as resolvePath } from "node:path";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config/config.js";
import { Database } from "../src/db/pool.js";
import { buildServer } from "../src/http/server.js";
import { createLogger } from "../src/logging/logger.js";

let app: FastifyInstance | null = null;

async function getApp(): Promise<FastifyInstance> {
  if (app) return app;

  process.env.HYPERION_NETWORK ??= "testnet";
  process.env.HYPERION_DEPLOYMENTS_FILE ??= resolvePath(process.cwd(), "deployments/testnet.json");
  process.env.DATABASE_URL ??= "postgres://hyperion:hyperion@127.0.0.1:5432/hyperion";
  process.env.REDIS_URL ??= "redis://127.0.0.1:6379";
  process.env.INDEXER_ENABLED ??= "false";
  process.env.RAILS_ENABLED ??= "false";
  process.env.KEEPER_ENABLED ??= "false";

  const config = loadConfig();
  const logger = createLogger(config);
  const startedAt = new Date();

  let db: Database;
  try {
    db = Database.open(config.databaseUrl, {
      applicationName: "hyperion-vercel-api",
      connectionTimeoutMs: 2000,
    });
  } catch {
    db = Database.open("postgres://hyperion:hyperion@127.0.0.1:5432/hyperion", {
      connectionTimeoutMs: 1000,
    });
  }

  app = buildServer({
    config,
    logger,
    db,
    readiness: [],
    startedAt,
  });

  await app.ready();
  return app;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const server = await getApp();
    server.server.emit("request", req, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal Server Error";
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "internal_error", message }));
  }
}
