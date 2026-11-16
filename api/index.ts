import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve as resolvePath } from "node:path";
import type { FastifyInstance } from "fastify";
import { loadConfig, type LoadOptions } from "../src/config/config.js";
import { Database, type Queryable } from "../src/db/pool.js";
import { SchemaCompatibilityError, verifySchemaCompatibility } from "../src/db/schema-check.js";
import { buildServer } from "../src/http/server.js";
import { createLogger } from "../src/logging/logger.js";

export interface ApiHandlerOptions {
  readonly loadOptions?: LoadOptions;
  readonly openDb?: (connectionString: string) => Database & Queryable;
}

export function createApiHandler(
  options: ApiHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  let app: FastifyInstance | null = null;

  async function getApp(): Promise<FastifyInstance> {
    if (app) return app;

    const envSource: Record<string, string | undefined> = options.loadOptions?.env
      ? { ...options.loadOptions.env }
      : process.env;
    envSource.HYPERION_NETWORK ??= "testnet";
    envSource.HYPERION_DEPLOYMENTS_FILE ??= resolvePath(process.cwd(), "deployments/testnet.json");
    envSource.REDIS_URL ??= "redis://127.0.0.1:6379";
    envSource.INDEXER_ENABLED ??= "false";
    envSource.RAILS_ENABLED ??= "false";
    envSource.KEEPER_ENABLED ??= "false";

    const config = loadConfig({ ...options.loadOptions, env: envSource });
    const logger = createLogger(config);
    const startedAt = new Date();

    const db = options.openDb
      ? options.openDb(config.databaseUrl)
      : Database.open(config.databaseUrl, {
          applicationName: "hyperion-vercel-api",
          connectionTimeoutMs: 2000,
        });

    try {
      await verifySchemaCompatibility(db, config.schema);
      const candidate = buildServer({
        config,
        logger,
        db,
        readiness: [],
        startedAt,
      });
      await candidate.ready();
      app = candidate;
      return candidate;
    } catch (error) {
      await db.close().catch(() => undefined);
      if (error instanceof SchemaCompatibilityError) {
        logger.error(
          {
            code: error.code,
            expectedVersion: error.details.expectedVersion,
            appliedVersion: error.details.appliedVersion,
            missingMigrations: error.details.missingMigrations,
            aheadMigrations: error.details.aheadMigrations,
            schemaIssues: error.details.schemaIssues,
          },
          "api startup schema compatibility check failed",
        );
      }
      throw error;
    }
  }

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    } catch (error) {
      if (error instanceof SchemaCompatibilityError) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "schema_incompatible",
            code: error.code,
            message: error.publicMessage,
          }),
        );
        return;
      }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "internal_error",
          message: "The API is not configured or is unavailable.",
        }),
      );
    }
  };
}

const defaultHandler = createApiHandler();

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await defaultHandler(req, res);
}
