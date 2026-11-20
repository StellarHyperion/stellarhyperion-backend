import { evaluateFreshnessSlo } from "../../runtime/freshness.js";
/**
 * Metrics REST API endpoint.
 *
 * Provides system-level counts and watcher health statistics for monitoring and dashboards.
 */
import type { FastifyInstance, FastifyReply } from "fastify";

import type { Database } from "../../db/pool.js";
import { integer, text, textOrNull } from "../../db/rows.js";
import {
  evaluateHeartbeatFreshness,
  readWorkerHeartbeats,
  type WorkerHeartbeatRecord,
} from "../../runtime/readiness.js";
import type { ServerDeps } from "../server.js";
import { readKeeperSubmissionMetrics } from "../../keeper/outcomes.js";

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

    // 6. Durable Stellar history-gap reconciliation status (#29)
    const gapResult = await db.query(
      "SELECT status, count(*)::int AS count FROM stellar_history_gap GROUP BY status",
    );
    const historyGaps = { open: 0, reconciling: 0, reconciled: 0 };
    for (const row of gapResult.rows) {
      const status = text(row, "status");
      const count = integer(row, "count");
      if (status === "open" || status === "reconciling" || status === "reconciled") {
        historyGaps[status] = count;
      }
    }
    const oldestGapResult = await db.query(
      `SELECT start_ledger, end_ledger
         FROM stellar_history_gap
        WHERE status <> 'reconciled'
        ORDER BY start_ledger ASC
        LIMIT 1`,
    );
    const oldestGap = oldestGapResult.rows[0];
    const historicalCoverage = {
      unresolved: historyGaps.open + historyGaps.reconciling,
      oldestMissingStartLedger: oldestGap ? text(oldestGap, "start_ledger") : null,
      oldestMissingEndLedger: oldestGap ? text(oldestGap, "end_ledger") : null,
      unknown: oldestGap === undefined && historyGaps.open + historyGaps.reconciling > 0,
    };

    // 7. Persistent worker heartbeats & freshness (#107)
    let heartbeatRecords: WorkerHeartbeatRecord[] = [];
    try {
      heartbeatRecords = await readWorkerHeartbeats(db);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        (error as { code?: unknown }).code !== "42P01"
      ) {
        throw error;
      }
    }

    const now = new Date();
    let staleWorkers = 0;
    let degradedWorkers = 0;
    let downWorkers = 0;
    const workers = heartbeatRecords.map((hb) => {
      const freshness = evaluateHeartbeatFreshness(hb, now);
      if (freshness.stale) staleWorkers += 1;
      if (freshness.report.state === "degraded") degradedWorkers += 1;
      if (freshness.report.state === "down") downWorkers += 1;
      return {
        name: hb.workerName,
        kind: hb.workerKind,
        chain: hb.chainKey,
        state: freshness.report.state,
        detail: freshness.report.detail,
        lastHeartbeatAt: hb.lastHeartbeatAt.toISOString(),
        lastCompletedAt: hb.lastCompletedAt ? hb.lastCompletedAt.toISOString() : null,
        lastCursorBlock: hb.lastCursorBlock,
        consecutiveFailures: hb.consecutiveFailures,
        lastError: hb.lastError,
        stale: freshness.stale,
        ageSeconds: freshness.ageSeconds,
      };
    });

    const freshnessSlo = await evaluateFreshnessSlo(db, deps.config);
    const database = typeof db.telemetrySnapshot === "function" ? db.telemetrySnapshot() : null;
    let keeperSubmissions = {
      simulated: 0,
      submitted: 0,
      pending: 0,
      confirmed: 0,
      failed: 0,
    };
    try {
      keeperSubmissions = await readKeeperSubmissionMetrics(db);
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "42P01"
      ))
        throw error;
    }

    return reply.send({
      service: "hyperion-backend",
      network: deps.config.network,
      uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
      transfers: {
        totalOutbound,
        totalInbound,
      },
      claims,
      railAttestations: railStatusCounts,
      cursors,
      historyGaps,
      historicalCoverage,
      freshnessSlo,
      database,
      deploymentMode: deps.config.deploymentMode,
      workers,
      freshness: {
        totalWorkers: workers.length,
        staleWorkers,
        degradedWorkers,
        downWorkers,
      },
      keeperSubmissions,
    });
  });
}
