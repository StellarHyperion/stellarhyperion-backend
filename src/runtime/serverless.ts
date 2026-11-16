import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve as resolvePath } from "node:path";

import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import type { DestinationStream } from "pino";

import { loadConfig, type AppConfig, type LoadOptions } from "../config/config.js";
import { Database, type OpenOptions } from "../db/pool.js";
import { buildServer } from "../http/server.js";
import { createLogger } from "../logging/logger.js";
import { fixedReadiness, type ReadinessSource } from "./readiness.js";

const PROCESS_SIGNAL_EVENTS = [
  "SIGTERM",
  "SIGINT",
  "unhandledRejection",
  "uncaughtException",
  "beforeExit",
  "exit",
] as const;

export interface ServerlessHostOptions {
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly cwd?: string | undefined;
  readonly readFile?: LoadOptions["readFile"] | undefined;
  readonly openDatabase?:
    ((connectionString: string, options: OpenOptions) => Database) | undefined;
  readonly logDestination?: DestinationStream | undefined;
  readonly clock?: (() => number) | undefined;
}

export interface ServerlessHostSnapshot {
  readonly hasActiveRuntime: boolean;
  readonly bootInFlight: boolean;
  readonly coldStarts: number;
  readonly warmReuses: number;
  readonly failedColdStarts: number;
  readonly evictedBrokenRuntimes: number;
  readonly poolsOpened: number;
  readonly poolsClosed: number;
  readonly activePoolStats: Database["stats"] | null;
}

interface ActiveServerlessRuntime {
  readonly app: FastifyInstance;
  readonly db: Database;
  readonly config: AppConfig;
  lastVerifiedAtMs: number;
  poolErrorObserved: boolean;
}

/**
 * Produces an isolated serverless environment snapshot without mutating `process.env`.
 *
 * Enforces the documented serverless entrypoint contract: `api/index.ts` serves read-only
 * HTTP queries against an existing migrated PostgreSQL database and never runs background
 * chain watchers, rail pollers, Redis BullMQ workers or Stellar transaction signers.
 */
export function buildServerlessEnv(
  sourceEnv: Readonly<Record<string, string | undefined>>,
  cwd: string,
): Record<string, string | undefined> {
  return {
    ...sourceEnv,
    NODE_ENV: sourceEnv.NODE_ENV ?? "production",
    HYPERION_NETWORK: sourceEnv.HYPERION_NETWORK ?? "testnet",
    HYPERION_DEPLOYMENTS_FILE:
      sourceEnv.HYPERION_DEPLOYMENTS_FILE ?? resolvePath(cwd, "deployments/testnet.json"),
    INDEXER_ENABLED: "false",
    RAILS_ENABLED: "false",
    KEEPER_ENABLED: "false",
    KEEPER_STELLAR_SECRET: undefined,
  };
}

function buildServerlessReadinessSources(): readonly ReadinessSource[] {
  return [
    fixedReadiness(
      "indexer",
      "ready",
      "disabled in serverless API mode; scheduled or container workers advance cursors",
    ),
    fixedReadiness(
      "rails",
      "ready",
      "disabled in serverless API mode; background rail pollers run outside HTTP functions",
    ),
    fixedReadiness(
      "keeper",
      "ready",
      "disabled in serverless API mode; no background upkeep jobs run in HTTP functions",
    ),
  ];
}

export class ServerlessRuntimeHost {
  private active: ActiveServerlessRuntime | null = null;
  private booting: Promise<ActiveServerlessRuntime> | null = null;
  private coldStarts = 0;
  private warmReuses = 0;
  private failedColdStarts = 0;
  private evictedBrokenRuntimes = 0;
  private poolsOpened = 0;
  private poolsClosed = 0;

  constructor(private readonly options: ServerlessHostOptions = {}) {}

  private now(): number {
    return this.options.clock ? this.options.clock() : Date.now();
  }

  inspect(): ServerlessHostSnapshot {
    return {
      hasActiveRuntime: this.active !== null,
      bootInFlight: this.booting !== null,
      coldStarts: this.coldStarts,
      warmReuses: this.warmReuses,
      failedColdStarts: this.failedColdStarts,
      evictedBrokenRuntimes: this.evictedBrokenRuntimes,
      poolsOpened: this.poolsOpened,
      poolsClosed: this.poolsClosed,
      activePoolStats: this.active ? this.active.db.stats : null,
    };
  }

  async getApp(): Promise<FastifyInstance> {
    const existing = this.active;
    if (existing !== null) {
      const elapsed = this.now() - existing.lastVerifiedAtMs;
      const needsPing =
        existing.poolErrorObserved ||
        existing.db.stats.closed ||
        elapsed >= existing.config.serverlessDb.warmHealthIntervalMs;

      if (!needsPing) {
        this.warmReuses += 1;
        return existing.app;
      }

      try {
        await existing.db.ping();
        existing.poolErrorObserved = false;
        existing.lastVerifiedAtMs = this.now();
        this.warmReuses += 1;
        return existing.app;
      } catch {
        await this.evictRuntime(existing);
      }
    }

    const initialized = await this.ensureBooted();
    return initialized.app;
  }

  private ensureBooted(): Promise<ActiveServerlessRuntime> {
    if (this.booting !== null) {
      return this.booting;
    }

    const promise = this.initializeColdRuntime();
    this.booting = promise;
    return promise;
  }

  private async initializeColdRuntime(): Promise<ActiveServerlessRuntime> {
    const cwd = this.options.cwd ?? process.cwd();
    const baseEnv = this.options.env ?? process.env;
    let db: Database | null = null;
    let app: FastifyInstance | null = null;
    const closeState = { tracked: false };

    try {
      const mergedEnv = buildServerlessEnv(baseEnv, cwd);
      const config = loadConfig({
        env: mergedEnv,
        cwd,
        ...(this.options.readFile ? { readFile: this.options.readFile } : {}),
      });
      // Pass a direct DestinationStream instead of spawning a new SonicBoom exit-hooked wrapper
      // on every cold-start recovery cycle.
      const logger = createLogger(config, this.options.logDestination ?? process.stdout);
      const startedAt = new Date(this.now());

      const runtimeFlag = { poolErrorObserved: false };
      const openDb = this.options.openDatabase ?? ((url, opts) => Database.open(url, opts));
      db = openDb(config.databaseUrl, {
        applicationName: "hyperion-vercel-api",
        maxConnections: config.serverlessDb.maxConnections,
        idleTimeoutMs: config.serverlessDb.idleTimeoutMs,
        connectionTimeoutMs: config.serverlessDb.connectionTimeoutMs,
        allowExitOnIdle: true,
        onPoolError: (error) => {
          runtimeFlag.poolErrorObserved = true;
          logger.warn(
            { reason: error.message },
            "serverless database pool reported idle client error",
          );
        },
      });
      this.poolsOpened += 1;

      const createdDb = db;
      const closeDbOnce = async (): Promise<void> => {
        if (closeState.tracked) return;
        closeState.tracked = true;
        this.poolsClosed += 1;
        await createdDb.close();
      };

      // Verify live PostgreSQL connectivity BEFORE caching the runtime so broken cold starts
      // never poison warm invocations.
      await db.ping();

      app = buildServer({
        config,
        logger,
        db,
        readiness: buildServerlessReadinessSources(),
        startedAt,
      });
      app.addHook("onClose", async () => {
        await closeDbOnce();
      });

      await app.ready();

      const runtime: ActiveServerlessRuntime = {
        app,
        db,
        config,
        lastVerifiedAtMs: this.now(),
        get poolErrorObserved() {
          return runtimeFlag.poolErrorObserved;
        },
        set poolErrorObserved(val: boolean) {
          runtimeFlag.poolErrorObserved = val;
        },
      };

      this.active = runtime;
      this.coldStarts += 1;
      return runtime;
    } catch (error) {
      this.failedColdStarts += 1;
      if (app !== null) {
        await app.close().catch(() => undefined);
      } else if (db !== null && !closeState.tracked) {
        closeState.tracked = true;
        this.poolsClosed += 1;
        await db.close().catch(() => undefined);
      }
      throw error;
    } finally {
      this.booting = null;
    }
  }

  private async evictRuntime(stale: ActiveServerlessRuntime): Promise<void> {
    if (this.active === stale) {
      this.active = null;
      this.evictedBrokenRuntimes += 1;
    }
    await stale.app.close().catch(() => undefined);
  }

  async inject(request: InjectOptions | string): Promise<LightMyRequestResponse> {
    const server = await this.getApp();
    return server.inject(request);
  }

  async handleNodeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const server = await this.getApp();
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

  async reset(): Promise<void> {
    const inFlight = this.booting;
    if (inFlight !== null) {
      await inFlight.catch(() => undefined);
    }
    const current = this.active;
    this.active = null;
    if (current !== null) {
      await current.app.close().catch(() => undefined);
    }
  }
}

export function createServerlessRuntimeHost(
  options: ServerlessHostOptions = {},
): ServerlessRuntimeHost {
  return new ServerlessRuntimeHost(options);
}

export function countProcessLifecycleListeners(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const eventName of PROCESS_SIGNAL_EVENTS) {
    counts[eventName] = process.listenerCount(eventName);
  }
  return counts;
}

export interface ServerlessLifecycleHarnessOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string | undefined;
  readonly concurrentColdBurst?: number | undefined;
  readonly warmInvocations?: number | undefined;
  readonly freezeGapMs?: number | undefined;
  readonly openDatabase: (
    connectionString: string,
    options: OpenOptions,
    controls: { readonly shouldFailPing: () => boolean },
  ) => Database;
}

export interface ServerlessLifecycleReport {
  readonly coldStarts: number;
  readonly warmReuses: number;
  readonly failedColdStarts: number;
  readonly evictedBrokenRuntimes: number;
  readonly poolsOpened: number;
  readonly poolsClosed: number;
  readonly maxConcurrentOpenPools: number;
  readonly activePoolsAfterReset: number;
  readonly processListenerDelta: number;
  readonly maxPoolErrorListeners: number;
  readonly failedOutageStatus: number;
  readonly recoveredReadyStatus: number;
  readonly passed: boolean;
}

/**
 * Reproducible serverless cold-start, warm-reuse, freeze-thaw and outage-recovery check harness.
 */
export async function runServerlessLifecycleHarness(
  options: ServerlessLifecycleHarnessOptions,
): Promise<ServerlessLifecycleReport> {
  let nowMs = 1_760_000_000_000;
  let failDatabasePing = false;
  let currentlyOpenPools = 0;
  let maxConcurrentOpenPools = 0;
  let maxPoolErrorListeners = 0;

  const listenersBefore = countProcessLifecycleListeners();

  const host = createServerlessRuntimeHost({
    env: { NODE_ENV: "test", ...options.env },
    cwd: options.cwd,
    logDestination: { write: () => true },
    clock: () => nowMs,
    openDatabase: (connectionString, openOptions) => {
      const db = options.openDatabase(connectionString, openOptions, {
        shouldFailPing: () => failDatabasePing,
      });
      currentlyOpenPools += 1;
      if (currentlyOpenPools > maxConcurrentOpenPools) {
        maxConcurrentOpenPools = currentlyOpenPools;
      }
      if (db.stats.errorListenerCount > maxPoolErrorListeners) {
        maxPoolErrorListeners = db.stats.errorListenerCount;
      }
      const origClose = db.close.bind(db);
      db.close = async (): Promise<void> => {
        if (!db.stats.closed) {
          currentlyOpenPools -= 1;
        }
        await origClose();
      };
      return db;
    },
  });

  try {
    // Phase 1: Concurrent cold-start burst must deduplicate to a single database pool.
    const burstSize = options.concurrentColdBurst ?? 8;
    const burstResponses = await Promise.all(
      Array.from({ length: burstSize }, () => host.inject({ method: "GET", url: "/ready" })),
    );
    for (const response of burstResponses) {
      if (response.statusCode !== 200) {
        throw new Error(`Expected 200 during cold burst, got ${String(response.statusCode)}`);
      }
    }

    // Phase 2: Sequential warm invocations must reuse the cached app and bounded pool.
    const warmCount = options.warmInvocations ?? 12;
    for (let i = 0; i < warmCount; i += 1) {
      nowMs += 250;
      const route = i % 2 === 0 ? "/health" : "/ready";
      const response = await host.inject({ method: "GET", url: route });
      if (response.statusCode !== 200) {
        throw new Error(`Expected 200 during warm reuse, got ${String(response.statusCode)}`);
      }
    }

    // Phase 3: Simulate container freeze/thaw idle gap + database outage -> evict broken pool without caching a dead connection.
    nowMs += options.freezeGapMs ?? 30_000;
    failDatabasePing = true;

    let failedOutageStatus = 200;
    try {
      const outageResponse = await host.inject({ method: "GET", url: "/ready" });
      failedOutageStatus = outageResponse.statusCode;
    } catch {
      failedOutageStatus = 500;
    }

    // Phase 4: Restore database connectivity -> next invocation recovers cleanly with a fresh pool.
    nowMs += 1_000;
    failDatabasePing = false;
    const recoveredResponse = await host.inject({ method: "GET", url: "/ready" });
    const recoveredReadyStatus = recoveredResponse.statusCode;

    await host.reset();

    const listenersAfter = countProcessLifecycleListeners();
    const processListenerDelta = Object.keys(listenersBefore).reduce(
      (sum, key) => sum + Math.max(0, (listenersAfter[key] ?? 0) - (listenersBefore[key] ?? 0)),
      0,
    );

    const snap = host.inspect();
    const passed =
      snap.coldStarts === 2 &&
      snap.evictedBrokenRuntimes === 1 &&
      snap.poolsOpened === snap.poolsClosed &&
      maxConcurrentOpenPools === 1 &&
      currentlyOpenPools === 0 &&
      processListenerDelta === 0 &&
      maxPoolErrorListeners <= 1 &&
      failedOutageStatus >= 500 &&
      recoveredReadyStatus === 200;

    return {
      coldStarts: snap.coldStarts,
      warmReuses: snap.warmReuses,
      failedColdStarts: snap.failedColdStarts,
      evictedBrokenRuntimes: snap.evictedBrokenRuntimes,
      poolsOpened: snap.poolsOpened,
      poolsClosed: snap.poolsClosed,
      maxConcurrentOpenPools,
      activePoolsAfterReset: currentlyOpenPools,
      processListenerDelta,
      maxPoolErrorListeners,
      failedOutageStatus,
      recoveredReadyStatus,
      passed,
    };
  } finally {
    await host.reset();
  }
}
