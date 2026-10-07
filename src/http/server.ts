/**
 * The HTTP surface, which for now is two probes and nothing else.
 *
 * B7 adds the transfer status API on top of this. The shape it slots into is already here: the
 * server takes its dependencies as an argument rather than importing them, so a route added later
 * gets the same database handle the watchers are using and a test can build the whole server
 * without a process environment.
 */
import Fastify from "fastify";
import type { FastifyBaseLogger, FastifyError, FastifyInstance } from "fastify";
import type { Logger } from "pino";

import rateLimit from "@fastify/rate-limit";

import type { AppConfig } from "../config/config.js";
import type { Database } from "../db/pool.js";
import type { ReadinessSource } from "../runtime/readiness.js";
import { registerClaimRoutes } from "./routes/claims.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMetricsRoutes } from "./routes/metrics.js";
import { registerRouteHealthRoutes } from "./routes/routes.js";
import { registerTransferRoutes } from "./routes/transfers.js";

export interface ServerDeps {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly db: Database;
  /** Everything with an opinion about whether this process can do its job. */
  readonly readiness: readonly ReadinessSource[];
  /** Set at boot so `/health` can report how long the process has been up. */
  readonly startedAt?: Date;
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
    disableRequestLogging: deps.config.nodeEnv === "test",
    bodyLimit: 64 * 1024,
  });

  void app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
    allowList: () => deps.config.nodeEnv === "test",
    errorResponseBuilder: () => ({
      error: "too_many_requests",
      message: "rate limit exceeded; status endpoints must not be polled faster than twice a second",
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
