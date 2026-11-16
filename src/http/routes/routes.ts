/**
 * Route health REST API endpoints.
 *
 * Exposes the latest sampled health across routes as well as historical transition and diagnostic
 * samples with explicit compacted-versus-raw coverage metadata.
 */
import { describeBlocker, type QuoteBlocker } from "@hyperion/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  queryRouteHealthHistory,
  readRouteHealthCompactionWatermark,
} from "../../chains/writers.js";
import type { Database } from "../../db/pool.js";
import { integer, integerOrNull, text, textOrNull, timestampOrNull } from "../../db/rows.js";
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
  readonly windowStartedAt: string;
  readonly windowEndedAt: string | null;
  readonly compactedCount: number;
  readonly resolution: "raw" | "compacted";
}

interface RouteHealthHistoryQuery {
  readonly originChain?: string;
  readonly destinationChain?: string;
  readonly route?: string;
  readonly token?: string;
  readonly since?: string;
  readonly limit?: string;
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
              sampled_at,
              window_ended_at,
              compacted_count,
              COALESCE(window_ended_at, sampled_at) AS observed_at
         FROM route_health
        ORDER BY origin_chain, destination_chain, route, token, id DESC`,
    );

    const watermark = await readRouteHealthCompactionWatermark(db);

    const routes: FormattedRouteHealth[] = rows.map((row) => {
      const blockerCode = integer(row, "blocker") as QuoteBlocker;
      const blockerInfo = describeBlocker(blockerCode);
      const compactedCount = integerOrNull(row, "compacted_count") ?? 1;
      const observedDate = new Date(row.observed_at as string | number | Date);
      const sampledDate = timestampOrNull(row, "sampled_at") ?? observedDate;
      const windowEndedDate = timestampOrNull(row, "window_ended_at");

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
        observedAt: observedDate.toISOString(),
        windowStartedAt: sampledDate.toISOString(),
        windowEndedAt: windowEndedDate === null ? null : windowEndedDate.toISOString(),
        compactedCount,
        resolution: compactedCount > 1 ? "compacted" : "raw",
      };
    });

    const hasCompactedHistory =
      watermark !== null || routes.some((entry) => entry.compactedCount > 1);

    return reply.send({
      routes,
      count: routes.length,
      coverage: {
        hasCompactedHistory,
        compactedBefore: watermark === null ? null : watermark.compactedBefore.toISOString(),
        rawFrom: watermark === null ? null : watermark.compactedBefore.toISOString(),
        rawWindowSeconds: watermark === null ? null : watermark.rawWindowSeconds,
        lastCompactedAt: watermark === null ? null : watermark.lastCompactedAt.toISOString(),
      },
    });
  });

  app.get(
    "/v1/routes/health/history",
    async (
      request: FastifyRequest<{ Querystring: RouteHealthHistoryQuery }>,
      reply: FastifyReply,
    ) => {
      const query = request.query;

      let parsedRoute: number | undefined;
      if (query.route !== undefined) {
        if (!/^\d+$/.test(query.route)) {
          return reply.code(400).send({ error: "invalid_route", message: "route must be 0..3" });
        }
        const routeNum = Number.parseInt(query.route, 10);
        if (routeNum < 0 || routeNum > 3) {
          return reply.code(400).send({ error: "invalid_route", message: "route must be 0..3" });
        }
        parsedRoute = routeNum;
      }

      let parsedSince: Date | undefined;
      if (query.since !== undefined) {
        const date = new Date(query.since);
        if (Number.isNaN(date.getTime())) {
          return reply
            .code(400)
            .send({ error: "invalid_since", message: "since must be an ISO-8601 timestamp" });
        }
        parsedSince = date;
      }

      let parsedLimit: number | undefined;
      if (query.limit !== undefined) {
        if (!/^\d+$/.test(query.limit)) {
          return reply
            .code(400)
            .send({ error: "invalid_limit", message: "limit must be between 1 and 1000" });
        }
        const limitNum = Number.parseInt(query.limit, 10);
        if (limitNum < 1 || limitNum > 1_000) {
          return reply
            .code(400)
            .send({ error: "invalid_limit", message: "limit must be between 1 and 1000" });
        }
        parsedLimit = limitNum;
      }

      const history = await queryRouteHealthHistory(db, {
        ...(query.originChain === undefined ? {} : { originChain: query.originChain }),
        ...(query.destinationChain === undefined
          ? {}
          : { destinationChain: query.destinationChain }),
        ...(parsedRoute === undefined ? {} : { route: parsedRoute }),
        ...(query.token === undefined ? {} : { token: query.token }),
        ...(parsedSince === undefined ? {} : { since: parsedSince }),
        ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
      });

      const samples = history.samples.map((entry) => {
        const blockerInfo = describeBlocker(entry.blocker as QuoteBlocker);
        return {
          id: entry.id.toString(),
          originChain: entry.originChain,
          destinationChain: entry.destinationChain,
          route: entry.route,
          token: entry.token,
          available: entry.available,
          blocker: {
            code: entry.blocker,
            label: blockerInfo.label,
            detail: blockerInfo.detail,
          },
          flowAvailable: entry.flowAvailable,
          medianSeconds: entry.medianSeconds,
          sampledAt: entry.sampledAt.toISOString(),
          windowEndedAt: entry.windowEndedAt === null ? null : entry.windowEndedAt.toISOString(),
          compactedCount: entry.compactedCount,
          resolution: entry.resolution,
        };
      });

      return reply.send({
        samples,
        count: samples.length,
        coverage: {
          rawFrom:
            history.coverage.rawFrom === null ? null : history.coverage.rawFrom.toISOString(),
          compactedBefore:
            history.coverage.compactedBefore === null
              ? null
              : history.coverage.compactedBefore.toISOString(),
          rawWindowSeconds: history.coverage.rawWindowSeconds,
          lastCompactedAt:
            history.coverage.lastCompactedAt === null
              ? null
              : history.coverage.lastCompactedAt.toISOString(),
          earliestSampleAt:
            history.coverage.earliestSampleAt === null
              ? null
              : history.coverage.earliestSampleAt.toISOString(),
          latestSampleAt:
            history.coverage.latestSampleAt === null
              ? null
              : history.coverage.latestSampleAt.toISOString(),
          storedRowCount: history.coverage.storedRowCount,
          representedSampleCount: history.coverage.representedSampleCount,
          compactedBoundaryRowCount: history.coverage.compactedBoundaryRowCount,
          rawRowCount: history.coverage.rawRowCount,
        },
      });
    },
  );
}
