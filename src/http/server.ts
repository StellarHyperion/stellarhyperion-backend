import Fastify, { LogController } from "fastify";
import type { FastifyBaseLogger, FastifyError, FastifyInstance } from "fastify";
import type { Logger } from "pino";

import rateLimit from "@fastify/rate-limit";
import type { Redis } from "ioredis";

import type { AppConfig } from "../config/config.js";
import type { Database } from "../db/pool.js";
import type { BullMQWorkerState, RedisPingable, ReadinessSource } from "../runtime/readiness.js";
import { registerClaimRoutes } from "./routes/claims.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMetricsRoutes } from "./routes/metrics.js";
import { registerRouteHealthRoutes } from "./routes/routes.js";
import { registerTransferRoutes } from "./routes/transfers.js";

export const DEFAULT_RATE_LIMIT_MAX = 120;
export const DEFAULT_STREAM_RATE_LIMIT_MAX = 20;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_RATE_LIMIT_CACHE_SIZE = 10_000;

export interface RateLimitPolicyOptions {
  readonly enabled?: boolean;
  readonly max?: number;
  readonly streamMax?: number;
  readonly timeWindowMs?: number;
  readonly cacheSize?: number;
  readonly keyPrefix?: string;
}

export interface ServerDeps {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly db: Database;
  readonly redis?: RedisPingable;
  readonly bullmqWorkers?: readonly BullMQWorkerState[];
  /** Everything with an opinion about whether this process can do its job. */
  readonly readiness: readonly ReadinessSource[];
  /** Set at boot so `/health` can report how long the process has been up. */
  readonly startedAt?: Date;
  /** Explicit proxy trust policy; defaults to `false` so unvalidated forwarded headers are ignored. */
  readonly trustProxy?: boolean | string | string[];
  /** Bounded public API rate-limit policy with optional shared Redis store. */
  readonly rateLimit?: RateLimitPolicyOptions;
}

function isIoredisStore(redis: RedisPingable | undefined): redis is Redis {
  return (
    redis !== undefined &&
    typeof (redis as Partial<Redis>).defineCommand === "function" &&
    typeof (redis as Partial<Redis>).pttl === "function"
  );
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  // Declared at the interface fastify describes rather than at pino's concrete type, and that
  // matters more than it looks. Fastify infers its whole instance generic from this option, so
  // handing it a `pino.Logger` pins every route registrar in this process to that exact type, and
  // `registerHealthRoutes` then stops matching the `FastifyInstance` it is typed against. A type
  // annotation does the widening without an assertion, which keeps the intent visible instead of
  // looking like a cast somebody added to silence the compiler.
  const loggerInstance: FastifyBaseLogger = deps.logger;

  const app = Fastify({
    // Fastify gets the same instance the watchers use, so a request line and a watcher line carry
    // the same service fields and the same redaction rules.
    loggerInstance,
    // Explicit proxy handling: only trust forwarded client IP headers when configured by the
    // deployment, preventing clients from spoofing X-Forwarded-For to bypass rate limits.
    trustProxy: deps.trustProxy ?? false,
    // A request id that survives into every log line for that request. Fastify generates one;
    // naming the header means a caller can supply theirs and have it show up in our logs.
    requestIdHeader: "x-request-id",
    logController: new LogController({ disableRequestLogging: deps.config.nodeEnv === "test" }),
    bodyLimit: 64 * 1024,
  });

  // This API exposes public chain data and never accepts a signed transaction or a key.
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Accept, Content-Type, X-API-Schema-Version");
    reply.header("Access-Control-Expose-Headers", "X-API-Schema-Version");
  });
  app.options("/*", async (_request, reply) => reply.code(204).send());

  const rateLimitEnabled = deps.rateLimit?.enabled ?? deps.config.nodeEnv !== "test";
  const max = deps.rateLimit?.max ?? DEFAULT_RATE_LIMIT_MAX;
  const timeWindow = deps.rateLimit?.timeWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  const cacheSize = deps.rateLimit?.cacheSize ?? DEFAULT_RATE_LIMIT_CACHE_SIZE;
  const sharedRedis = isIoredisStore(deps.redis) ? deps.redis : undefined;

  void app.register(rateLimit, {
    max,
    timeWindow,
    cache: cacheSize,
    skipOnError: true,
    ...(sharedRedis !== undefined
      ? {
          redis: sharedRedis,
          nameSpace: deps.rateLimit?.keyPrefix ?? "hyperion:rl:",
        }
      : {}),
    keyGenerator: (req) => req.ip,
    allowList: (req) => !rateLimitEnabled || req.url === "/health" || req.url === "/ready",
    addHeadersOnExceeding: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
    },
    addHeaders: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
      "retry-after": true,
    },
    errorResponseBuilder: (_req, context) => ({
      statusCode: context.statusCode,
      error: "too_many_requests",
      message:
        "rate limit exceeded; status endpoints must not be polled faster than the deployment budget",
      retryAfterMs: context.ttl,
    }),
  });

  app.after(() => {
    registerHealthRoutes(app, deps);
    registerTransferRoutes(app, deps);
    registerClaimRoutes(app, deps);
    registerRouteHealthRoutes(app, deps);
    registerMetricsRoutes(app, deps);
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({
      error: "not_found",
      message: `no route for ${request.method} ${request.url}`,
    });
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status === 429) {
      void reply.code(429).send({
        error: "too_many_requests",
        message: error.message,
        requestId: request.id,
      });
      return;
    }
    // The log gets the error, the response does not. An internal error message is the kind of
    // thing that carries a table name, a file path or, on a bad day, a connection string.
    request.log.error({ err: error, status }, "request failed");
    void reply.code(status).send({
      error: status >= 500 ? "internal_error" : "bad_request",
      message: status >= 500 ? "the server could not complete that request" : error.message,
      requestId: request.id,
    });
  });

  return app;
}
