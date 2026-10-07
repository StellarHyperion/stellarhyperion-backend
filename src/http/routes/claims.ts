/**
 * Parked claims lookup and listing REST API endpoints.
 *
 * Parked claims hold user funds when destination delivery could not be completed directly
 * (e.g. uninitialized account or contract). Once the recipient is ready, the claim can be
 * settled permissionlessly.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { Database } from "../../db/pool.js";
import { integer, text } from "../../db/rows.js";
import type { ServerDeps } from "../server.js";

export interface FormattedClaim {
  readonly id: string;
  readonly chain: string;
  readonly claimId: string;
  readonly recipient: string;
  readonly token: string;
  readonly amount: string;
  readonly route: number;
  readonly sourceChain: string;
  readonly sourceNonce: string;
  readonly settled: boolean;
  readonly createdAt: string;
  readonly observedAt: string;
}

function formatClaimRow(row: Record<string, unknown>): FormattedClaim {
  return {
    id: text(row, "id"),
    chain: text(row, "chain"),
    claimId: text(row, "claim_id"),
    recipient: text(row, "recipient"),
    token: text(row, "token"),
    amount: text(row, "amount"),
    route: integer(row, "route"),
    sourceChain: text(row, "source_chain"),
    sourceNonce: text(row, "source_nonce"),
    settled: row.settled === true,
    createdAt: new Date(row.created_at as string | number | Date).toISOString(),
    observedAt: new Date(row.observed_at as string | number | Date).toISOString(),
  };
}

export function registerClaimRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const db: Database = deps.db;

  // 1. Get specific claim by chain and claim id
  app.get(
    "/v1/claims/:chain/:claimId",
    async (
      request: FastifyRequest<{ Params: { chain: string; claimId: string } }>,
      reply: FastifyReply,
    ) => {
      const { chain, claimId } = request.params;
      const { rows } = await db.query(
        `SELECT id, chain, claim_id, recipient, token, amount, route, source_chain, source_nonce,
                created_at, settled, observed_at
           FROM pending_claim
          WHERE chain = $1 AND claim_id = $2
          LIMIT 1`,
        [chain, claimId],
      );

      const row = rows[0];
      if (row === undefined) {
        return reply.code(404).send({
          error: "not_found",
          message: `no claim found on chain ${chain} with id ${claimId}`,
        });
      }

      return reply.send(formatClaimRow(row));
    },
  );

  // 2. List claims
  app.get(
    "/v1/claims",
    async (
      request: FastifyRequest<{
        Querystring: {
          chain?: string;
          recipient?: string;
          settled?: string;
          limit?: string;
          offset?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const { chain, recipient, settled, limit, offset } = request.query;

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (chain) {
        params.push(chain);
        conditions.push(`chain = $${String(params.length)}`);
      }
      if (recipient) {
        params.push(recipient);
        conditions.push(`recipient = $${String(params.length)}`);
      }
      if (settled !== undefined) {
        params.push(settled === "true");
        conditions.push(`settled = $${String(params.length)}`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const parsedLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
      const parsedOffset = Math.max(Number(offset) || 0, 0);

      params.push(parsedLimit);
      const limitClause = `LIMIT $${String(params.length)}`;
      params.push(parsedOffset);
      const offsetClause = `OFFSET $${String(params.length)}`;

      const { rows } = await db.query(
        `SELECT id, chain, claim_id, recipient, token, amount, route, source_chain, source_nonce,
                created_at, settled, observed_at
           FROM pending_claim
          ${whereClause}
          ORDER BY id DESC
          ${limitClause}
          ${offsetClause}`,
        params,
      );

      return reply.send({
        claims: rows.map(formatClaimRow),
        limit: parsedLimit,
        offset: parsedOffset,
        count: rows.length,
      });
    },
  );
}
