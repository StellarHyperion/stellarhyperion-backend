import { readHistoricalCoverage, type CoverageSource } from "../historical-coverage.js";
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
import { readProofRejectionMetrics } from "../proof-rejection-metrics.js";
import { readKeeperSubmissionMetrics } from "../../keeper/outcomes.js";
import { readWorkerRuns } from "../../runtime/worker-runs.js";

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

    const configuredSources: CoverageSource[] = [];
    const stellar = deps.config.indexer.stellar;
    if (stellar !== null)
      configuredSources.push({
        chain: stellar.chain,
        family: "stellar",
        contract: stellar.routerContractId,
      });
    for (const evm of deps.config.indexer.evm)
      configuredSources.push({ chain: evm.chain, family: "evm", contract: evm.routerAddress });
    const { historyGaps, historicalCoverage } = await readHistoricalCoverage(db, configuredSources);

    const proofRejections = await readProofRejectionMetrics(db);

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
      const completedTicks =
        typeof hb.metadata.ticks === "number" && Number.isSafeInteger(hb.metadata.ticks)
          ? hb.metadata.ticks
          : 0;
      const reorgs =
        typeof hb.metadata.reorgs === "number" && Number.isSafeInteger(hb.metadata.reorgs)
          ? hb.metadata.reorgs
          : 0;
      const reorgDepth =
        typeof hb.metadata.reorgDepth === "number" && Number.isSafeInteger(hb.metadata.reorgDepth)
          ? hb.metadata.reorgDepth
          : null;
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
        runId: hb.runId ?? null,
        completedTicks,
        reorgs,
        reorgDepth,
        recoveryState:
          reorgs === 0 ? "none" : hb.state === "down" ? "operator_intervention" : "automatic",
      };
    });
    const freshnessSlo = await evaluateFreshnessSlo(db, deps.config);
    const reorgWorkers = workers.filter((worker) => worker.reorgs > 0);
    const reorgRecovery = {
      detected: reorgWorkers.reduce((total, worker) => total + worker.reorgs, 0),
      automaticWorkers: reorgWorkers.filter((worker) => worker.recoveryState === "automatic").length,
      operatorInterventionWorkers: reorgWorkers.filter(
        (worker) => worker.recoveryState === "operator_intervention",
      ).length,
      workers: reorgWorkers.map((worker) => ({
        name: worker.name,
        chain: worker.chain,
        reorgs: worker.reorgs,
        reorgDepth: worker.reorgDepth,
        state: worker.state,
        recoveryState: worker.recoveryState,
      })),
      reconciliation: freshnessSlo,
      canonicalProofCounts: proofRejections.coverage,
    };
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
      proofRejections: proofRejections.total,
      proofRejectionsByRail: proofRejections.byRail,
      proofRejectionIngestion: proofRejections.ingestion,
      proofRejectionCoverage: proofRejections.coverage,
      freshnessSlo,
      database,
      deploymentMode: deps.config.deploymentMode,
      workers,
      reorgRecovery,
      workerRuns: await readWorkerRuns(db),
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
