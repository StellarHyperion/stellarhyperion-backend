import type { FastifyInstance } from "fastify";
import { EvmBackfillManager } from "../../chains/evm/backfill.js";
import type { ServerDeps } from "../server.js";
export function registerBackfillRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const manager = new EvmBackfillManager(deps.config.indexer.evm, deps.db, deps.logger);
  app.get("/v1/evm/backfills", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { backfills: await manager.list() };
  });
  app.get<{ Params: { id: string } }>("/v1/evm/backfills/:id", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!/^[0-9a-f-]{36}$/.test(request.params.id))
      return reply.code(400).send({ error: "bad_request" });
    const job = await manager.get(request.params.id);
    return job ?? reply.code(404).send({ error: "not_found" });
  });
}
