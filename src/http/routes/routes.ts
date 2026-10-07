/**
 * Route health REST API endpoint.
 *
 * Exposes the latest sampled health across routes, including available flow capacity
 * and blocker states (such as paused or flow limit exceeded).
 */
import { describeBlocker, type QuoteBlocker } from "@hyperion/protocol";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { Database } from "../../db/pool.js";
import { integer, text, textOrNull } from "../../db/rows.js";
import type { ServerDeps } from "../server.js";

export interface FormattedRouteHealth {
  readonly originChain: string;
  readonly destinationChain: string;
  readonly route: number;
  readonly token: string;
  readonly available: boolean;
  readonly blocker: {
    readonly code: number;
    readonly label: string;
    readonly detail: string;
  };
  readonly flowAvailable: string | null;
  readonly observedAt: string;
}

export function registerRouteHealthRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const db: Database = deps.db;

  app.get("/v1/routes/health", async (_request, reply: FastifyReply) => {
    // Return latest sample per (origin_chain, destination_chain, route, token)
    const { rows } = await db.query(
      `SELECT DISTINCT ON (origin_chain, destination_chain, route, token)
              origin_chain,
              destination_chain,
              route,
              token,
              available,
              blocker,
              flow_available,
              observed_at
         FROM route_health
        ORDER BY origin_chain, destination_chain, route, token, id DESC`,
    );

    const routes: FormattedRouteHealth[] = rows.map((row) => {
      const blockerCode = integer(row, "blocker") as QuoteBlocker;
      const blockerInfo = describeBlocker(blockerCode);

      return {
        originChain: text(row, "origin_chain"),
        destinationChain: text(row, "destination_chain"),
        route: integer(row, "route"),
        token: text(row, "token"),
        available: row.available === true,
        blocker: {
          code: blockerCode,
          label: blockerInfo.label,
          detail: blockerInfo.detail,
        },
        flowAvailable: textOrNull(row, "flow_available"),
        observedAt: new Date(row.observed_at as string | number | Date).toISOString(),
      };
    });

    return reply.send({ routes, count: routes.length });
  });
}
