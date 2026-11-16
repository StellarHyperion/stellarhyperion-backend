import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve as resolvePath } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Logger } from "pino";

import { loadConfig, type AppConfig } from "../src/config/config.js";
import { Database } from "../src/db/pool.js";
import { buildServer } from "../src/http/server.js";
import { createLogger } from "../src/logging/logger.js";

export interface ServerlessRuntimeOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly startedAt?: Date;
  readonly createLoggerFn?: (config: AppConfig) => Logger;
  readonly openDatabase?: (databaseUrl: string) => Database;
}

export interface ServerlessRuntimeStats {
  readonly initializedCount: number;
  readonly activeInstances: number;
  readonly activeDatabases: number;
}

export interface ServerlessRuntime {
  getApp(): Promise<FastifyInstance>;
  handler(req: IncomingMessage, res: ServerResponse): Promise<void>;
  close(): Promise<void>;
  stats(): ServerlessRuntimeStats;
}

interface InitializedPair {
  readonly app: FastifyInstance;
  readonly db: Database;
}

function buildServerlessEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
  cwd: string,
): Record<string, string | undefined> {
  return {
    ...baseEnv,
    HYPERION_NETWORK: baseEnv.HYPERION_NETWORK ?? "testnet",
    HYPERION_DEPLOYMENTS_FILE:
      baseEnv.HYPERION_DEPLOYMENTS_FILE ?? resolvePath(cwd, "deployments/testnet.json"),
    REDIS_URL: baseEnv.REDIS_URL ?? "redis://127.0.0.1:6379",
    INDEXER_ENABLED: baseEnv.INDEXER_ENABLED ?? "false",
    RAILS_ENABLED: baseEnv.RAILS_ENABLED ?? "false",
    KEEPER_ENABLED: baseEnv.KEEPER_ENABLED ?? "false",
  };
}

export function createServerlessRuntime(options: ServerlessRuntimeOptions = {}): ServerlessRuntime {
  let current: InitializedPair | null = null;
  let inFlight: Promise<InitializedPair> | null = null;
  let initializedCount = 0;
  let activeInstances = 0;
  let activeDatabases = 0;

  const initOnce = async (): Promise<InitializedPair> => {
    if (current !== null) {
      return current;
    }
    if (inFlight !== null) {
      return inFlight;
    }

    const promise = (async (): Promise<InitializedPair> => {
      const envSource = options.env ?? process.env;
      const cwd = options.cwd ?? process.cwd();
      const effectiveEnv = buildServerlessEnv(envSource, cwd);
      const config = loadConfig({ env: effectiveEnv, cwd });
      const logger = (options.createLoggerFn ?? createLogger)(config);
      const startedAt = options.startedAt ?? new Date();

      const db = options.openDatabase
        ? options.openDatabase(config.databaseUrl)
        : Database.open(config.databaseUrl, {
            applicationName: "hyperion-vercel-api",
            connectionTimeoutMs: 2000,
          });
      activeDatabases += 1;

      let server: FastifyInstance | null = null;
      try {
        server = buildServer({
          config,
          logger,
          db,
          readiness: [],
          startedAt,
        });
        activeInstances += 1;
        await server.ready();
        initializedCount += 1;
        const pair: InitializedPair = { app: server, db };
        current = pair;
        return pair;
      } catch (err) {
        if (server !== null) {
          await server.close().catch(() => undefined);
          activeInstances = Math.max(0, activeInstances - 1);
        }
        await db.close().catch(() => undefined);
        activeDatabases = Math.max(0, activeDatabases - 1);
        throw err;
      } finally {
        inFlight = null;
      }
    })();

    inFlight = promise;
    return promise;
  };

  const getApp = async (): Promise<FastifyInstance> => {
    const pair = await initOnce();
    return pair.app;
  };

  const close = async (): Promise<void> => {
    if (inFlight !== null) {
      await inFlight.catch(() => undefined);
    }
    const pair = current;
    current = null;
    if (pair !== null) {
      await pair.app.close();
      activeInstances = Math.max(0, activeInstances - 1);
      await pair.db.close();
      activeDatabases = Math.max(0, activeDatabases - 1);
    }
  };

  const runtimeHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
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
  };

  return {
    getApp,
    handler: runtimeHandler,
    close,
    stats: () => ({
      initializedCount,
      activeInstances,
      activeDatabases,
    }),
  };
}

const defaultRuntime = createServerlessRuntime();

export async function resetDefaultServerlessRuntime(): Promise<void> {
  await defaultRuntime.close();
}

export function getDefaultServerlessRuntimeStats(): ServerlessRuntimeStats {
  return defaultRuntime.stats();
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await defaultRuntime.handler(req, res);
}
