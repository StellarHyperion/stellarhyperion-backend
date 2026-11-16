import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve as resolvePath } from "node:path";
import type { FastifyInstance } from "fastify";
import type { LoadOptions } from "../src/config/config.js";
import { loadConfig } from "../src/config/config.js";
import { Database } from "../src/db/pool.js";
import { buildServer } from "../src/http/server.js";
import { createLogger } from "../src/logging/logger.js";

let app: FastifyInstance | null = null;

export interface ServerlessBootstrapOptions extends LoadOptions {
  readonly openDatabase?: (
    connectionString: string,
    options: {
      readonly applicationName: string;
      readonly connectionTimeoutMs: number;
      readonly readOnly: boolean;
    },
  ) => Database;
}

export async function createServerlessApp(
  options: ServerlessBootstrapOptions = {},
): Promise<FastifyInstance> {
  const baseEnv = options.env ?? process.env;
  const resolvedEnv: Record<string, string | undefined> = {
    ...baseEnv,
    HYPERION_NETWORK: baseEnv.HYPERION_NETWORK ?? "testnet",
    HYPERION_DEPLOYMENTS_FILE:
      baseEnv.HYPERION_DEPLOYMENTS_FILE ??
      resolvePath(options.cwd ?? process.cwd(), "deployments/testnet.json"),
    REDIS_URL: baseEnv.REDIS_URL ?? "redis://127.0.0.1:6379",
    INDEXER_ENABLED: baseEnv.INDEXER_ENABLED ?? "false",
    RAILS_ENABLED: baseEnv.RAILS_ENABLED ?? "false",
    KEEPER_ENABLED: baseEnv.KEEPER_ENABLED ?? "false",
    DATABASE_ROLE: baseEnv.DATABASE_ROLE ?? "readonly",
  };

  const config = loadConfig({
    ...options,
    env: resolvedEnv,
  });
  const logger = createLogger(config);
  const startedAt = new Date();

  const openDb = options.openDatabase ?? ((url, dbOptions) => Database.open(url, dbOptions));
  const db = openDb(config.databaseUrl, {
    applicationName: "hyperion-vercel-api",
    connectionTimeoutMs: 2000,
    readOnly: config.database.readOnly,
  });

  const server = buildServer({
    config,
    logger,
    db,
    readiness: [],
    startedAt,
  });

  await server.ready();
  return server;
}

async function getApp(): Promise<FastifyInstance> {
  if (app) return app;
  app = await createServerlessApp();
  return app;
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
