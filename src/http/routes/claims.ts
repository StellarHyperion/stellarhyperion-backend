/**
 * Parked claims lookup and listing REST API endpoints.
 *
 * Parked claims hold user funds when destination delivery could not be completed directly
 * (e.g. uninitialized account or contract). Once the recipient is ready, the claim can be
 * settled permissionlessly.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { Database } from "../../db/pool.js";
import { integer, normalizeDeploymentRouter, publicRouterOrNull, text } from "../../db/rows.js";
import type { ServerDeps } from "../server.js";

export interface FormattedClaim {
  readonly id: string;
  readonly chain: string;
  readonly router: string | null;
  readonly claimId: string;
  readonly recipient: string;
  readonly token: string;
  readonly amount: string;
  readonly route: number;
  readonly sourceChain: string;
  readonly sourceRouter: string | null;
  readonly sourceNonce: string;
  readonly settled: boolean;
  readonly createdAt: string;
  readonly observedAt: string;
}

function formatClaimRow(row: Record<string, unknown>): FormattedClaim {
  return {
    id: text(row, "id"),
    chain: text(row, "chain"),
    router: publicRouterOrNull(row, "router"),
    claimId: text(row, "claim_id"),
    recipient: text(row, "recipient"),
    token: text(row, "token"),
    amount: text(row, "amount"),
    route: integer(row, "route"),
    sourceChain: text(row, "source_chain"),
    sourceRouter: publicRouterOrNull(row, "source_router"),
    sourceNonce: text(row, "source_nonce"),
    settled: row.settled === true,
    createdAt: new Date(row.created_at as string | number | Date).toISOString(),
    observedAt: new Date(row.observed_at as string | number | Date).toISOString(),
  };
}

export function registerClaimRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const db: Database = deps.db;

  // 1a. Get specific claim by chain, router deployment, and claim id
  app.get(
    "/v1/claims/:chain/:router/:claimId",
    async (
      request: FastifyRequest<{ Params: { chain: string; router: string; claimId: string } }>,
      reply: FastifyReply,
    ) => {
      const { chain, router, claimId } = request.params;
      const { rows } = await db.query(
        `SELECT chain || ':' || claim_id::text AS id, chain, router, claim_id, recipient, token, amount,
                route, source_chain, source_router, source_nonce, created_at, settled, observed_at
           FROM pending_claim
          WHERE chain = $1 AND router = $2 AND claim_id = $3
          LIMIT 1`,
        [chain, normalizeDeploymentRouter(router), claimId],
      );

      const row = rows[0];
      if (row === undefined) {
        return reply.code(404).send({
          error: "not_found",
          message: `no claim found on chain ${chain} router ${router} with id ${claimId}`,
        });
      }

      return reply.send(formatClaimRow(row));
    },
  );

  // 1b. Get specific claim by chain and claim id (with optional ?router= deployment filter)
  app.get(
    "/v1/claims/:chain/:claimId",
    async (
      request: FastifyRequest<{
        Params: { chain: string; claimId: string };
        Querystring: { router?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { chain, claimId } = request.params;
      const routerFilter = request.query.router?.trim();
      const { rows } = routerFilter
        ? await db.query(
            `SELECT chain || ':' || claim_id::text AS id, chain, router, claim_id, recipient, token, amount,
                    route, source_chain, source_router, source_nonce, created_at, settled, observed_at
               FROM pending_claim
              WHERE chain = $1 AND router = $2 AND claim_id = $3
              ORDER BY observed_at DESC
              LIMIT 1`,
            [chain, normalizeDeploymentRouter(routerFilter), claimId],
          )
        : await db.query(
            `SELECT chain || ':' || claim_id::text AS id, chain, router, claim_id, recipient, token, amount,
                    route, source_chain, source_router, source_nonce, created_at, settled, observed_at
               FROM pending_claim
              WHERE chain = $1 AND claim_id = $2
              ORDER BY observed_at DESC
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
          router?: string;
          sourceRouter?: string;
          recipient?: string;
          settled?: string;
          limit?: string;
          offset?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const { chain, router, sourceRouter, recipient, settled, limit, offset } = request.query;

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (chain) {
        params.push(chain);
        conditions.push(`chain = $${String(params.length)}`);
      }
      if (router?.trim()) {
        params.push(normalizeDeploymentRouter(router));
        conditions.push(`router = $${String(params.length)}`);
      }
      if (sourceRouter?.trim()) {
        params.push(normalizeDeploymentRouter(sourceRouter));
        conditions.push(`source_router = $${String(params.length)}`);
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
        `SELECT chain || ':' || claim_id::text AS id, chain, router, claim_id, recipient, token, amount,
                route, source_chain, source_router, source_nonce, created_at, settled, observed_at
           FROM pending_claim
          ${whereClause}
          ORDER BY chain ASC, claim_id DESC
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
