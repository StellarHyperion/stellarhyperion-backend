import Fastify, { LogController } from "fastify";
import type { FastifyBaseLogger, FastifyError, FastifyInstance } from "fastify";
import type { Logger } from "pino";

import rateLimit from "@fastify/rate-limit";

import type { AppConfig } from "../config/config.js";
import { QueryBudgetExceededError, QueryCancelledError, type Database } from "../db/pool.js";
import type { BullMQWorkerState, RedisPingable, ReadinessSource } from "../runtime/readiness.js";
import { registerRequestBudgets } from "./request-budget.js";
import { registerClaimRoutes } from "./routes/claims.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMetricsRoutes } from "./routes/metrics.js";
import { registerRouteHealthRoutes } from "./routes/routes.js";
import { registerTransferRoutes } from "./routes/transfers.js";

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
  /** Optional override for public read deadline budget in milliseconds. */
  readonly readBudgetMs?: number;
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
    // Behind a load balancer the client address is in the header, and rate limiting in B7 needs
    // the real one. Only trustworthy because this never faces the internet directly.
    trustProxy: true,
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
    reply.header("Access-Control-Allow-Headers", "Accept, Content-Type, X-Request-Timeout-Ms");
    reply.header("Access-Control-Expose-Headers", "X-Request-Budget-Ms, Retry-After");
  });
  app.options("/*", async (_request, reply) => reply.code(204).send());

  registerRequestBudgets(app, {
    defaultBudgetMs: deps.readBudgetMs ?? deps.config.http.readTimeoutMs,
  });

  void app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
    allowList: (req) => deps.config.nodeEnv === "test" || req.url.includes("/stream"),
    errorResponseBuilder: () => ({
      error: "too_many_requests",
      message:
        "rate limit exceeded; status endpoints must not be polled faster than twice a second",
    }),
  });

  registerHealthRoutes(app, deps);
  registerTransferRoutes(app, deps);
  registerClaimRoutes(app, deps);
  registerRouteHealthRoutes(app, deps);
  registerMetricsRoutes(app, deps);

  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({
      error: "not_found",
      message: `no route for ${request.method} ${request.url}`,
    });
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const rawError: unknown = error;
    if (rawError instanceof QueryCancelledError || request.readBudget.isClientDisconnected()) {
      request.log.debug({ err: error }, "public read cancelled after client disconnect");
      if (!reply.sent && !reply.raw.writableEnded && !reply.raw.destroyed) {
        void reply.code(499).send({
          error: "client_closed_request",
          message: "client disconnected before read completed",
          requestId: request.id,
        });
      }
      return;
    }

    if (rawError instanceof QueryBudgetExceededError) {
      request.log.warn({ err: error }, "public read exceeded request budget");
      void reply.header("Retry-After", "1").code(504).send({
        error: "request_timeout",
        message: "public read exceeded request budget",
        requestId: request.id,
      });
      return;
    }

    const status = error.statusCode ?? 500;
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
