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
import {
  assertPaginationCompatibility,
  computeClaimFilterHash,
  decodeClaimCursor,
  encodeClaimCursor,
  parseSortDirection,
} from "../keyset.js";
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
        `SELECT chain || ':' || claim_id::text AS id, chain, claim_id, recipient, token, amount, route, source_chain, source_nonce,
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
          cursor?: string;
          sort?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const { chain, recipient, settled, limit, offset, cursor, sort } = request.query;

      assertPaginationCompatibility(cursor, offset);
      const sortDirection = parseSortDirection(sort);
      const parsedSettled = settled !== undefined ? settled === "true" : null;
      const filterHash = computeClaimFilterHash({
        chain,
        recipient,
        settled: parsedSettled,
      });
      const decodedCursor =
        cursor !== undefined ? decodeClaimCursor(cursor, sortDirection, filterHash) : null;

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
      if (parsedSettled !== null) {
        params.push(parsedSettled);
        conditions.push(`settled = $${String(params.length)}`);
      }

      if (decodedCursor !== null) {
        params.push(decodedCursor.lastChain);
        const chainParam = `$${String(params.length)}`;
        params.push(decodedCursor.lastClaimId.toString());
        const idParam = `$${String(params.length)}`;
        conditions.push(
          sortDirection === "desc"
            ? `(chain > ${chainParam} OR (chain = ${chainParam} AND claim_id < ${idParam}::numeric))`
            : `(chain > ${chainParam} OR (chain = ${chainParam} AND claim_id > ${idParam}::numeric))`,
        );
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const orderClause =
        sortDirection === "desc"
          ? "ORDER BY chain ASC, claim_id DESC"
          : "ORDER BY chain ASC, claim_id ASC";
      const parsedLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
      const parsedOffset = Math.max(Number(offset) || 0, 0);

      params.push(parsedLimit + 1);
      const limitClause = `LIMIT $${String(params.length)}`;

      let offsetClause = "";
      if (decodedCursor === null) {
        params.push(parsedOffset);
        offsetClause = `OFFSET $${String(params.length)}`;
      }

      const { rows } = await db.query(
        `SELECT chain || ':' || claim_id::text AS id, chain, claim_id, recipient, token, amount, route, source_chain, source_nonce,
                created_at, settled, observed_at
           FROM pending_claim
          ${whereClause}
          ${orderClause}
          ${limitClause}
          ${offsetClause}`,
        params,
      );

      const hasMore = rows.length > parsedLimit;
      const pageRows = hasMore ? rows.slice(0, parsedLimit) : rows;
      const claims = pageRows.map(formatClaimRow);
      const lastClaim = claims.at(-1);
      const nextCursor =
        hasMore && lastClaim !== undefined
          ? encodeClaimCursor({
              lastChain: lastClaim.chain,
              lastClaimId: lastClaim.claimId,
              sort: sortDirection,
              filterHash,
            })
          : null;

      return reply.send({
        claims,
        limit: parsedLimit,
        offset: decodedCursor !== null ? null : parsedOffset,
        count: claims.length,
        pageInfo: {
          mode: decodedCursor !== null ? "keyset" : "offset",
          sort: sortDirection,
          hasMore,
          nextCursor,
        },
      });
    },
  );
}
