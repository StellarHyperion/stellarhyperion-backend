import type { FastifyInstance } from "fastify";

import type { ServerDeps } from "../server.js";

export function registerConfigRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const serveReport = () => deps.config.provenance;
  app.get("/v1/config", serveReport);
  app.get("/api/v1/config", serveReport);
}
