import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { EvmBackfillManager } from "../../chains/evm/backfill.js";
import type { ServerDeps } from "../server.js";

interface StartBody {
  readonly owner?: string;
  readonly chain?: string;
  readonly from?: string;
  readonly to?: string;
}

interface OwnerQuery {
  readonly owner?: string;
}

interface CancelBody {
  readonly owner?: string;
}

export function registerBackfillRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const manager = new EvmBackfillManager(deps.config.indexer.evm, deps.db, deps.logger);

  app.get(
    "/v1/evm/backfills",
    async (request: FastifyRequest<{ Querystring: OwnerQuery }>, reply: FastifyReply) => {
      return reply.send({ backfills: manager.list(request.query.owner) });
    },
  );

  app.get(
    "/v1/evm/backfills/:id",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const progress = manager.get(request.params.id);
      return progress === null
        ? reply.code(404).send({ error: "not_found", message: "backfill not found" })
        : await reply.send(progress);
    },
  );

  app.post(
    "/v1/evm/backfills",
    async (request: FastifyRequest<{ Body: StartBody | undefined }>, reply: FastifyReply) => {
      const body = request.body;
      if (body === undefined) {
        return reply.code(400).send({
          error: "bad_request",
          message: "owner, chain, from and to are required; block bounds must be integers",
        });
      }
      const from = parseBlock(body.from);
      const to = parseBlock(body.to);
      if (body.owner === undefined || body.chain === undefined || from === null || to === null) {
        return reply.code(400).send({
          error: "bad_request",
          message: "owner, chain, from and to are required; block bounds must be integers",
        });
      }
      try {
        const progress = manager.start(body.owner, body.chain, from, to);
        return await reply.code(202).send(progress);
      } catch (error) {
        return await reply.code(400).send({ error: "bad_request", message: messageOf(error) });
      }
    },
  );

  app.post(
    "/v1/evm/backfills/:id/cancel",
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: CancelBody | undefined }>,
      reply: FastifyReply,
    ) => {
      const owner = request.body?.owner;
      if (owner === undefined) {
        return reply.code(400).send({ error: "bad_request", message: "owner is required" });
      }
      try {
        return await reply.send(manager.cancel(request.params.id, owner));
      } catch (error) {
        const message = messageOf(error);
        return reply
          .code(message === "backfill not found" ? 404 : 403)
          .send({ error: message === "backfill not found" ? "not_found" : "forbidden", message });
      }
    },
  );
}

function parseBlock(value: string | undefined): bigint | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
