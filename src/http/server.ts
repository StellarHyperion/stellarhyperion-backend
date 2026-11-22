import Fastify, { LogController } from "fastify";
import type { FastifyBaseLogger, FastifyError, FastifyInstance } from "fastify";
import type { Logger } from "pino";

import rateLimit from "@fastify/rate-limit";
import type { Redis } from "ioredis";

import type { AppConfig } from "../config/config.js";
import { DatabaseBackpressureError, type Database } from "../db/pool.js";
import type { BullMQWorkerState, RedisPingable, ReadinessSource } from "../runtime/readiness.js";
import { registerClaimRoutes } from "./routes/claims.js";
import { registerAxelarEvidenceRoutes } from "./routes/axelar-evidence.js";
import { registerBackfillRoutes } from "./routes/backfills.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMetricsRoutes } from "./routes/metrics.js";
import { registerRouteHealthRoutes } from "./routes/routes.js";
import { registerTransferRoutes } from "./routes/transfers.js";
import { RequestBudgetExceededError } from "./request-budget.js";
import { openApiDocument } from "./openapi.js";

export const DEFAULT_RATE_LIMIT_MAX = 120;
export const DEFAULT_STREAM_RATE_LIMIT_MAX = 20;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_RATE_LIMIT_CACHE_SIZE = 10_000;

export type ApiErrorCode =
  "bad_request" | "not_found" | "timeout" | "unavailable" | "internal_error" | "too_many_requests";

export interface ApiErrorEnvelope {
  readonly error: ApiErrorCode;
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
}

function errorEnvelope(
  error: ApiErrorCode,
  message: string,
  requestId?: string,
  extra: Pick<ApiErrorEnvelope, "retryAfterMs"> = {},
): ApiErrorEnvelope {
  return {
    error,
    code: error,
    message,
    ...(requestId === undefined ? {} : { requestId }),
    ...extra,
  };
}

function errorCode(status: number): ApiErrorCode {
  return status === 404
    ? "not_found"
    : status === 408 || status === 504
      ? "timeout"
      : status === 429
        ? "too_many_requests"
        : status === 503
          ? "unavailable"
          : status >= 500
            ? "internal_error"
            : "bad_request";
}
function publicErrorMessage(code: ApiErrorCode): string {
  return code === "internal_error"
    ? "the server could not complete that request"
    : code === "timeout"
      ? "the request timed out"
      : code === "unavailable"
        ? "the service is temporarily unavailable"
        : code === "not_found"
          ? "the requested resource was not found"
          : code === "too_many_requests"
            ? "rate limit exceeded; retry after the deployment request budget resets"
            : "the request was invalid";
}

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

  // Preserve legacy fields while adding a stable category and bounded public message.
  app.addHook("onSend", (request, reply, payload, done) => {
    if (reply.statusCode < 400 || typeof payload !== "string") {
      done(null, payload);
      return;
    }
    try {
      const body: unknown = JSON.parse(payload);
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        done(null, payload);
        return;
      }
      const existing = body as Record<string, unknown>;
      const code = errorCode(reply.statusCode);
      done(
        null,
        JSON.stringify({
          ...existing,
          error: typeof existing.error === "string" ? existing.error : code,
          code,
          message:
            typeof existing.message === "string" ? existing.message : publicErrorMessage(code),
          requestId: request.id,
        }),
      );
      return;
    } catch {
      /* Non-JSON payloads, including SSE frames, pass through. */
    }
    done(null, payload);
  });

  // This API exposes public chain data and never accepts a signed transaction or a key.
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    reply.header(
      "Access-Control-Allow-Headers",
      "Accept, Content-Type, If-None-Match, X-API-Schema-Version",
    );
    reply.header(
      "Access-Control-Expose-Headers",
      "ETag, Cache-Control, X-API-Schema-Version, Retry-After",
    );
  });
  app.options("/*", async (_request, reply) => reply.code(204).send());
  app.get("/openapi.json", (_request, reply) =>
    reply.header("Cache-Control", "public, max-age=300").send(openApiDocument),
  );

  const rateLimitEnabled = deps.rateLimit?.enabled ?? deps.config.nodeEnv !== "test";
  const max = deps.rateLimit?.max ?? DEFAULT_RATE_LIMIT_MAX;
  const streamMax = deps.rateLimit?.streamMax ?? DEFAULT_STREAM_RATE_LIMIT_MAX;
  const timeWindow = deps.rateLimit?.timeWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  const cacheSize = deps.rateLimit?.cacheSize ?? DEFAULT_RATE_LIMIT_CACHE_SIZE;
  if (
    !Number.isSafeInteger(max) ||
    max < 1 ||
    max > 1_000_000 ||
    !Number.isSafeInteger(streamMax) ||
    streamMax < 1 ||
    streamMax > 1_000_000 ||
    !Number.isSafeInteger(timeWindow) ||
    timeWindow < 1 ||
    timeWindow > 86_400_000 ||
    !Number.isSafeInteger(cacheSize) ||
    cacheSize < 1 ||
    cacheSize > DEFAULT_RATE_LIMIT_CACHE_SIZE
  ) {
    throw new RangeError("rate-limit policy exceeds supported request, time or storage bounds");
  }
  const sharedRedis = isIoredisStore(deps.redis) ? deps.redis : undefined;

  void app.register(rateLimit, {
    max,
    timeWindow,
    cache: cacheSize,
    skipOnError: false,
    ...(sharedRedis !== undefined
      ? {
          redis: sharedRedis,
          nameSpace: deps.rateLimit?.keyPrefix ?? "hyperion:rl:",
        }
      : {}),
    keyGenerator: (req) => req.ip,
    allowList: (req) =>
      !rateLimitEnabled || ["/health", "/ready"].includes(req.url.split("?")[0] ?? ""),
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
      code: "too_many_requests",
      message:
        "rate limit exceeded; status endpoints must not be polled faster than the deployment budget",
      retryAfterMs: context.ttl,
    }),
  });

  app.after(() => {
    registerHealthRoutes(app, deps);
    registerTransferRoutes(app, deps);
    registerAxelarEvidenceRoutes(app, deps);
    registerClaimRoutes(app, deps);
    registerBackfillRoutes(app, deps);
    registerRouteHealthRoutes(app, deps);
    registerMetricsRoutes(app, deps);
  });

  app.setNotFoundHandler((request, reply) => {
    void reply
      .code(404)
      .send(errorEnvelope("not_found", "the requested resource was not found", request.id));
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof DatabaseBackpressureError) {
      reply.header("Retry-After", Math.max(1, Math.ceil(error.retryAfterMs / 1000)));
      void reply
        .code(error.statusCode)
        .send(
          errorEnvelope(
            "unavailable",
            "the database is temporarily busy; retry shortly",
            request.id,
            { retryAfterMs: error.retryAfterMs },
          ),
        );
      return;
    }
    if (error instanceof RequestBudgetExceededError) {
      void reply.code(504).send({
        error: "request_budget_exceeded",
        message: "The public read exceeded its request budget.",
        requestId: request.id,
      });
      return;
    }
    const status = error.statusCode ?? 500;
    const code = errorCode(status);
    if (status === 429) {
      const seconds = Number(reply.getHeader("retry-after"));
      void reply.code(429).send({
        error: "too_many_requests",
        code: "too_many_requests",
        message: "rate limit exceeded; retry after the deployment request budget resets",
        retryAfterMs: Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : timeWindow,
        requestId: request.id,
      });
      return;
    }
    // The log gets the error, the response does not. An internal error message is the kind of
    // thing that carries a table name, a file path or, on a bad day, a connection string.
    request.log.error({ err: error, status }, "request failed");
    const message = publicErrorMessage(code);
    void reply.code(status).send(errorEnvelope(code, message, request.id));
  });

  return app;
}
