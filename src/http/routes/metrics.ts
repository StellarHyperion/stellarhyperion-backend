/**
 * Metrics REST API endpoint.
 *
 * Provides system-level counts and watcher health statistics for monitoring and dashboards.
 */
import type { FastifyInstance, FastifyReply } from "fastify";

import type { Database } from "../../db/pool.js";
import { integer, text, textOrNull } from "../../db/rows.js";
import {
  MIN_BOUNDED_HEARTBEAT_MS,
  generateProcessReplicaId,
  summarizeWorkerHeartbeats,
} from "../../runtime/heartbeat.js";
import type { ServerDeps } from "../server.js";

export function registerMetricsRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const db: Database = deps.db;
  const startedAt = deps.startedAt ?? new Date();
  const replicaId = generateProcessReplicaId(deps.replicaId);

  app.get("/v1/metrics", async (_request, reply: FastifyReply) => {
    const nowDate = deps.now?.() ?? new Date();
    const nowMs = nowDate.getTime();

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
    const cursors = cursorResult.rows.map((row) => {
      const rawUpdated = new Date(row.updated_at as string | number | Date).getTime();
      const boundedUpdated = Number.isNaN(rawUpdated)
        ? nowMs
        : Math.max(MIN_BOUNDED_HEARTBEAT_MS, Math.min(rawUpdated, nowMs));
      return {
        chain: text(row, "chain_key"),
        block: text(row, "cursor_block"),
        hash: textOrNull(row, "cursor_hash"),
        updatedAt: new Date(boundedUpdated).toISOString(),
      };
    });

    // 6. Persistent worker heartbeats across split processes
    const heartbeatSummary = await summarizeWorkerHeartbeats(
      db,
      deps.config,
      deps.now ? { now: deps.now } : {},
    );

    return reply.send({
      service: "hyperion-backend",
      network: deps.config.network,
      replicaId,
      uptimeSeconds: Math.max(0, Math.floor((nowMs - startedAt.getTime()) / 1000)),
      transfers: {
        totalOutbound,
        totalInbound,
      },
      claims,
      railAttestations: railStatusCounts,
      cursors,
      heartbeats: heartbeatSummary.heartbeats,
      indexerHeartbeat: {
        status: heartbeatSummary.status,
        detail: heartbeatSummary.detail,
        evaluatedAt: heartbeatSummary.evaluatedAt,
        expectedWorkers: heartbeatSummary.expectedWorkers,
        freshWorkers: heartbeatSummary.freshWorkers,
        staleWorkers: heartbeatSummary.staleWorkers,
        missingWorkers: heartbeatSummary.missingWorkers,
        evidenceGapWorkers: heartbeatSummary.evidenceGapWorkers,
        degradedWorkers: heartbeatSummary.degradedWorkers,
        totalWorkloadPending: heartbeatSummary.totalWorkloadPending,
      },
    });
  });
}
