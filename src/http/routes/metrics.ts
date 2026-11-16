/**
 * Metrics REST API endpoint.
 *
 * Provides system-level counts and watcher health statistics for monitoring and dashboards.
 */
import type { FastifyInstance, FastifyReply } from "fastify";

import type { Database } from "../../db/pool.js";
import { integer, text, textOrNull } from "../../db/rows.js";
import type { ServerDeps } from "../server.js";

export function registerMetricsRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const db: Database = deps.db;
  const startedAt = deps.startedAt ?? new Date();

  app.get("/v1/metrics", async (_request, reply: FastifyReply) => {
    // 1. Total outbound transfers
    const outboundResult = await db.query("SELECT count(*)::int AS count FROM outbound_transfer");
    const totalOutbound = outboundResult.rows[0] ? integer(outboundResult.rows[0], "count") : 0;

    // 2. Total inbound deliveries
    const inboundResult = await db.query("SELECT count(*)::int AS count FROM inbound_delivery");
    const totalInbound = inboundResult.rows[0] ? integer(inboundResult.rows[0], "count") : 0;

    // 3. Claims breakdown
    const claimsResult = await db.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE settled = true)::int AS settled,
              count(*) FILTER (WHERE settled = false)::int AS unsettled
         FROM pending_claim`,
    );
    const claimsRow = claimsResult.rows[0];
    const claims = {
      total: claimsRow ? integer(claimsRow, "total") : 0,
      settled: claimsRow ? integer(claimsRow, "settled") : 0,
      unsettled: claimsRow ? integer(claimsRow, "unsettled") : 0,
    };

    // 4. Rail attestations breakdown
    const railResult = await db.query(
      "SELECT status, count(*)::int AS count FROM rail_attestation GROUP BY status",
    );
    const railStatusCounts: Record<string, number> = {};
    for (const row of railResult.rows) {
      railStatusCounts[text(row, "status")] = integer(row, "count");
    }

    // 5. Watcher cursor positions
    const cursorResult = await db.query(
      "SELECT chain_key, last_processed AS cursor_block, last_processed_hash AS cursor_hash, updated_at FROM indexer_cursor",
    );
    const cursors = cursorResult.rows.map((row) => ({
      chain: text(row, "chain_key"),
      block: text(row, "cursor_block"),
      hash: textOrNull(row, "cursor_hash"),
      updatedAt: new Date(row.updated_at as string | number | Date).toISOString(),
    }));

    const currentTime = deps.now?.() ?? new Date();
    const watchedChains: string[] = [
      ...(deps.config.indexer.stellar ? [deps.config.indexer.stellar.chain] : []),
      ...deps.config.indexer.evm.map((entry) => entry.chain),
    ];
    const missingCursors = watchedChains.filter(
      (chain) => !cursors.some((cursor) => cursor.chain === chain),
    );
    const relevantCursors =
      watchedChains.length > 0
        ? cursors.filter((cursor) => watchedChains.includes(cursor.chain))
        : cursors;
    const agesMs = relevantCursors.map((cursor) =>
      Math.max(0, currentTime.getTime() - Date.parse(cursor.updatedAt)),
    );
    const maxCursorAgeMs = agesMs.length > 0 ? Math.max(...agesMs) : null;
    const latestCursorUpdatedAt =
      relevantCursors.length > 0
        ? relevantCursors.reduce(
            (latest, cursor) =>
              Date.parse(cursor.updatedAt) > Date.parse(latest) ? cursor.updatedAt : latest,
            relevantCursors[0]?.updatedAt ?? "",
          )
        : null;
    const freshnessState: "fresh" | "stale" | "incomplete" | "empty" =
      relevantCursors.length === 0
        ? "empty"
        : missingCursors.length > 0
          ? "incomplete"
          : maxCursorAgeMs !== null && maxCursorAgeMs > deps.config.workerFreshnessStaleMs
            ? "stale"
            : "fresh";

    return reply.send({
      service: "hyperion-backend",
      role: deps.config.indexer.enabled ? "worker" : "api-only",
      network: deps.config.network,
      uptimeSeconds: Math.floor((currentTime.getTime() - startedAt.getTime()) / 1000),
      transfers: {
        totalOutbound,
        totalInbound,
      },
      claims,
      railAttestations: railStatusCounts,
      cursors,
      workerFreshness: {
        state: freshnessState,
        indexerEnabled: deps.config.indexer.enabled,
        railsEnabled: deps.config.rails.enabled,
        keeperEnabled: deps.config.keeper.enabled,
        staleAfterMs: deps.config.workerFreshnessStaleMs,
        maxCursorAgeMs,
        latestCursorUpdatedAt,
        watchedChains,
        missingCursors,
      },
    });
  });
}
