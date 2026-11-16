/**
 * Metrics REST API endpoint.
 *
 * Provides system-level counts, watcher cursor freshness, and historical coverage completeness
 * for monitoring and dashboards.
 */
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  remainingGapLedgers,
  summarizeHistoryCoverage,
  type HistoryCoverageSummary,
} from "../../chains/stellar/store.js";
import type { Database } from "../../db/pool.js";
import { integer, text, textOrNull } from "../../db/rows.js";
import type { ReadinessReport } from "../../runtime/readiness.js";
import type { ServerDeps } from "../server.js";

const EMPTY_COVERAGE: HistoryCoverageSummary = {
  complete: true,
  openGaps: 0,
  reconcilingGaps: 0,
  closedGaps: 0,
  missingLedgers: 0n,
  gaps: [],
};

function isUndefinedTableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "42P01"
  );
}

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

    // 5. Historical coverage gaps
    let coverage: HistoryCoverageSummary = EMPTY_COVERAGE;
    try {
      coverage = await summarizeHistoryCoverage(db);
    } catch (error) {
      if (!isUndefinedTableError(error)) {
        throw error;
      }
    }

    const readinessByChain = new Map<string, ReadinessReport>();
    for (const source of deps.readiness) {
      try {
        const report = await source.readiness();
        readinessByChain.set(report.name, report);
      } catch {
        // Ignore readiness source errors here; /ready reports them explicitly.
      }
    }

    // 6. Watcher cursor positions + per-chain completeness
    const cursorResult = await db.query(
      "SELECT chain_key, last_processed AS cursor_block, last_processed_hash AS cursor_hash, updated_at FROM indexer_cursor",
    );
    const cursors = cursorResult.rows.map((row) => {
      const chain = text(row, "chain_key");
      const chainGaps = coverage.gaps.filter(
        (gap) => gap.chainKey === chain && gap.status !== "closed",
      );
      let chainMissing = 0n;
      for (const gap of chainGaps) {
        chainMissing += remainingGapLedgers(gap);
      }
      const readiness = readinessByChain.get(chain);
      const cursorFresh =
        readiness === undefined
          ? null
          : (readiness.cursorFresh ?? (readiness.state === "ready" ? true : false));

      return {
        chain,
        block: text(row, "cursor_block"),
        hash: textOrNull(row, "cursor_hash"),
        updatedAt: new Date(row.updated_at as string | number | Date).toISOString(),
        cursorFresh,
        historyComplete: chainGaps.length === 0,
        openHistoryGaps: chainGaps.length,
        missingLedgers: chainMissing.toString(),
      };
    });

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
      historyCoverage: {
        complete: coverage.complete,
        openGaps: coverage.openGaps,
        reconcilingGaps: coverage.reconcilingGaps,
        closedGaps: coverage.closedGaps,
        missingLedgers: coverage.missingLedgers.toString(),
        gaps: coverage.gaps.map((gap) => ({
          id: gap.id.toString(),
          chain: gap.chainKey,
          contract: gap.contract,
          fromLedger: gap.fromLedger.toString(),
          toLedger: gap.toLedger.toString(),
          reconciledThrough:
            gap.reconciledThrough === null ? null : gap.reconciledThrough.toString(),
          missingLedgers: remainingGapLedgers(gap).toString(),
          status: gap.status,
          reason: gap.reason,
          detectedAt: gap.detectedAt.toISOString(),
          reconciledAt: gap.reconciledAt === null ? null : gap.reconciledAt.toISOString(),
        })),
      },
    });
  });
}
