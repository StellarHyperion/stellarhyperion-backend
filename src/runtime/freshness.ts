/**
 * Configurable freshness SLO evaluation (#108).
 *
 * Evaluates durable source scan lag (from `indexer_cursor` and `stellar_history_gap`) and
 * destination proof backlog (from `outbound_transfer` without a matching `inbound_delivery`)
 * against explicit per-lane targets. Works identically whether the API and indexer run in
 * one process or as separate processes.
 *
 * A provider/rail status alone never establishes destination delivery; only `inbound_delivery`
 * settles destination delivery.
 */
import type { AppConfig } from "../config/config.js";
import type { Queryable } from "../db/pool.js";
import { integer, text, timestampOrNull, type Row } from "../db/rows.js";

export interface LaneFreshnessTarget {
  readonly maxSourceScanLagMs: number;
  readonly maxProofBacklogCount: number;
  readonly maxProofBacklogAgeMs: number;
}

export interface FreshnessSloConfig {
  readonly defaults: LaneFreshnessTarget;
  readonly lanes: Readonly<Record<string, Partial<LaneFreshnessTarget>>>;
}

export const DEFAULT_LANE_FRESHNESS_TARGET: LaneFreshnessTarget = {
  maxSourceScanLagMs: 120_000,
  maxProofBacklogCount: 100,
  maxProofBacklogAgeMs: 900_000,
};

export interface SourceScanLagStatus {
  readonly chain: string;
  readonly cursorBlock: string | null;
  readonly updatedAt: string | null;
  readonly lagMs: number | null;
  readonly targetMaxLagMs: number;
  readonly openHistoryGaps: number;
  readonly reconcilingHistoryGaps: number;
  readonly status: "ok" | "breached" | "unknown" | "disabled";
  readonly stage: "source_scan";
  readonly monitoring: "local" | "remote" | "disabled";
  readonly reason: string | null;
}

export interface LaneProofBacklogStatus {
  readonly lane: string;
  readonly stage: "destination_proof";
  readonly originChain: string;
  readonly destinationChain: string;
  readonly pendingCount: number;
  readonly oldestPendingAt: string | null;
  readonly oldestPendingAgeMs: number | null;
  readonly targetMaxCount: number;
  readonly targetMaxAgeMs: number;
  readonly status: "ok" | "breached";
  readonly reason: string | null;
}

export interface FreshnessSloReport {
  readonly evaluatedAt: string;
  readonly status: "ok" | "breached" | "unknown";
  readonly met: boolean;
  readonly breaches: readonly string[];
  readonly sources: readonly SourceScanLagStatus[];
  readonly lanes: readonly LaneProofBacklogStatus[];
}

export function resolveLaneTarget(
  slo: FreshnessSloConfig,
  laneOrChain: string,
): LaneFreshnessTarget {
  const override = slo.lanes[laneOrChain];
  if (override === undefined) return slo.defaults;
  return {
    maxSourceScanLagMs: override.maxSourceScanLagMs ?? slo.defaults.maxSourceScanLagMs,
    maxProofBacklogCount: override.maxProofBacklogCount ?? slo.defaults.maxProofBacklogCount,
    maxProofBacklogAgeMs: override.maxProofBacklogAgeMs ?? slo.defaults.maxProofBacklogAgeMs,
  };
}

export async function evaluateFreshnessSlo(
  db: Queryable,
  config: Pick<AppConfig, "indexer" | "freshnessSlo" | "deploymentMode">,
  now = new Date(),
): Promise<FreshnessSloReport> {
  const nowMs = now.getTime();
  const breaches: string[] = [];
  let unknown = false;

  // 1. Durable cursor freshness
  const cursorResult = await db.query(
    "SELECT chain_key, last_processed AS cursor_block, updated_at FROM indexer_cursor",
  );
  const cursorsByChain = new Map<string, { cursorBlock: string; updatedAt: Date | null }>();
  for (const row of cursorResult.rows) {
    if (typeof row.chain_key !== "string") continue;
    const chain = text(row, "chain_key");
    const blockRaw = row.cursor_block ?? row.last_processed;
    const cursorBlock =
      typeof blockRaw === "string" || typeof blockRaw === "number" || typeof blockRaw === "bigint"
        ? String(blockRaw)
        : "0";
    const updatedAt = timestampOrNull(row, "updated_at");
    cursorsByChain.set(chain, { cursorBlock, updatedAt });
  }

  // 2. Durable Stellar history-gap evidence
  const gapResult = await db.query(
    `SELECT chain_key, status, count(*)::int AS count
       FROM stellar_history_gap
      WHERE status IN ('open', 'reconciling')
      GROUP BY chain_key, status`,
  );
  const gapsByChain = new Map<string, { open: number; reconciling: number }>();
  for (const row of gapResult.rows) {
    if (typeof row.chain_key !== "string" || typeof row.status !== "string") continue;
    const chain = text(row, "chain_key");
    const status = text(row, "status");
    const count = integer(row, "count");
    const entry = gapsByChain.get(chain) ?? { open: 0, reconciling: 0 };
    if (status === "open") entry.open += count;
    if (status === "reconciling") entry.reconciling += count;
    gapsByChain.set(chain, entry);
  }

  const configuredChains = new Set<string>();
  if (config.indexer.stellar !== null) {
    configuredChains.add(config.indexer.stellar.chain);
  }
  for (const evm of config.indexer.evm) {
    configuredChains.add(evm.chain);
  }
  for (const chain of cursorsByChain.keys()) {
    configuredChains.add(chain);
  }

  const sources: SourceScanLagStatus[] = [];
  for (const chain of [...configuredChains].sort()) {
    const cursor = cursorsByChain.get(chain);
    const gaps = gapsByChain.get(chain) ?? { open: 0, reconciling: 0 };
    const chainTarget = resolveLaneTarget(config.freshnessSlo, chain);
    const laneLags = Object.keys(config.freshnessSlo.lanes)
      .filter((lane) => lane.startsWith(`${chain}->`))
      .map((lane) => resolveLaneTarget(config.freshnessSlo, lane).maxSourceScanLagMs);
    const target = {
      ...chainTarget,
      maxSourceScanLagMs: Math.min(chainTarget.maxSourceScanLagMs, ...laneLags),
    };
    const monitoring = config.indexer.enabled
      ? ("local" as const)
      : config.deploymentMode === "api-only"
        ? ("remote" as const)
        : ("disabled" as const);
    if (monitoring === "disabled") {
      sources.push({
        chain,
        cursorBlock: cursor?.cursorBlock ?? null,
        updatedAt: cursor?.updatedAt?.toISOString() ?? null,
        lagMs: null,
        targetMaxLagMs: target.maxSourceScanLagMs,
        openHistoryGaps: gaps.open,
        reconcilingHistoryGaps: gaps.reconciling,
        status: "disabled",
        stage: "source_scan",
        monitoring,
        reason: "watcher intentionally disabled for this deployment mode",
      });
      continue;
    }

    if (cursor === undefined || cursor.updatedAt === null) {
      const hasGapBreach = gaps.open + gaps.reconciling > 0;
      if (!hasGapBreach) unknown = true;
      const reason = hasGapBreach
        ? `${String(gaps.open + gaps.reconciling)} incomplete history gap(s) with no cursor timestamp`
        : "no cursor recorded yet";
      if (hasGapBreach) {
        breaches.push(`source:${chain}: ${reason}`);
      }
      sources.push({
        chain,
        cursorBlock: cursor?.cursorBlock ?? null,
        updatedAt: null,
        lagMs: null,
        targetMaxLagMs: target.maxSourceScanLagMs,
        openHistoryGaps: gaps.open,
        reconcilingHistoryGaps: gaps.reconciling,
        status: hasGapBreach ? "breached" : "unknown",
        stage: "source_scan",
        monitoring,
        reason,
      });
      continue;
    }

    const elapsed = nowMs - cursor.updatedAt.getTime();
    if (!Number.isFinite(elapsed) || elapsed < -30_000) {
      unknown = true;
      sources.push({
        chain,
        cursorBlock: cursor.cursorBlock,
        updatedAt: Number.isFinite(cursor.updatedAt.getTime())
          ? cursor.updatedAt.toISOString()
          : null,
        lagMs: null,
        targetMaxLagMs: target.maxSourceScanLagMs,
        openHistoryGaps: gaps.open,
        reconcilingHistoryGaps: gaps.reconciling,
        status: "unknown",
        stage: "source_scan",
        monitoring,
        reason: "invalid or future cursor timestamp",
      });
      continue;
    }
    const lagMs = Math.max(0, elapsed);
    const reasons: string[] = [];
    if (lagMs > target.maxSourceScanLagMs) {
      reasons.push(`scan lag ${String(lagMs)}ms exceeds ${String(target.maxSourceScanLagMs)}ms`);
    }
    if (gaps.open + gaps.reconciling > 0) {
      reasons.push(`${String(gaps.open + gaps.reconciling)} incomplete history gap(s)`);
    }
    const status = reasons.length > 0 ? "breached" : "ok";
    const reason = reasons.length > 0 ? reasons.join("; ") : null;
    if (reason !== null) {
      breaches.push(`source:${chain}: ${reason}`);
    }

    sources.push({
      chain,
      cursorBlock: cursor.cursorBlock,
      updatedAt: cursor.updatedAt.toISOString(),
      lagMs,
      targetMaxLagMs: target.maxSourceScanLagMs,
      openHistoryGaps: gaps.open,
      reconcilingHistoryGaps: gaps.reconciling,
      status,
      stage: "source_scan",
      monitoring,
      reason,
    });
  }

  // 3. Destination proof backlog (only inbound_delivery settles delivery, never rail status alone)
  const backlogResult = await db.query(
    `SELECT t.origin_chain,
            t.destination_chain,
            count(*)::int AS pending_count,
            min(t.observed_at) AS oldest_pending_at
       FROM outbound_transfer t
      WHERE NOT EXISTS (
        SELECT 1
          FROM inbound_delivery d
         WHERE d.destination_chain = t.destination_chain
           AND d.route = t.route AND d.source_chain = t.origin_chain
           AND d.source_nonce = t.nonce
           AND (d.source_transfer_id = t.id OR (
             d.source_transfer_id IS NULL AND NOT EXISTS (
               SELECT 1 FROM outbound_transfer peer WHERE peer.id <> t.id
                 AND peer.origin_chain = t.origin_chain AND peer.nonce = t.nonce
                 AND peer.route = t.route AND peer.destination_chain = t.destination_chain
             )
           ))
           AND (d.delivered = true OR EXISTS (
             SELECT 1 FROM pending_claim c WHERE c.chain = d.destination_chain
               AND c.claim_id = d.claim_id AND c.route = d.route
               AND c.source_chain = d.source_chain AND c.source_nonce = d.source_nonce
               AND c.settled = true AND c.settled_tx IS NOT NULL
               AND (c.source_transfer_id = t.id OR (c.source_transfer_id IS NULL AND d.source_transfer_id IS NULL))
           ))
      )
      GROUP BY t.origin_chain, t.destination_chain
      ORDER BY t.origin_chain, t.destination_chain`,
  );

  const lanes: LaneProofBacklogStatus[] = [];
  for (const row of backlogResult.rows as readonly Row[]) {
    if (typeof row.origin_chain !== "string" || typeof row.destination_chain !== "string") {
      continue;
    }
    const originChain = text(row, "origin_chain");
    const destinationChain = text(row, "destination_chain");
    const lane = `${originChain}->${destinationChain}`;
    const pendingCount = integer(row, "pending_count");
    const oldestPendingAt = timestampOrNull(row, "oldest_pending_at");
    const oldestPendingAgeMs =
      oldestPendingAt !== null ? Math.max(0, nowMs - oldestPendingAt.getTime()) : null;
    const target = resolveLaneTarget(config.freshnessSlo, lane);

    const reasons: string[] = [];
    if (pendingCount > target.maxProofBacklogCount) {
      reasons.push(
        `pending proof backlog ${String(pendingCount)} exceeds ${String(target.maxProofBacklogCount)}`,
      );
    }
    if (oldestPendingAgeMs !== null && oldestPendingAgeMs > target.maxProofBacklogAgeMs) {
      reasons.push(
        `oldest pending proof age ${String(oldestPendingAgeMs)}ms exceeds ${String(target.maxProofBacklogAgeMs)}ms`,
      );
    }
    const status = reasons.length > 0 ? "breached" : "ok";
    const reason = reasons.length > 0 ? reasons.join("; ") : null;
    if (reason !== null) {
      breaches.push(`lane:${lane}: ${reason}`);
    }

    lanes.push({
      lane,
      stage: "destination_proof",
      originChain,
      destinationChain,
      pendingCount,
      oldestPendingAt: oldestPendingAt !== null ? oldestPendingAt.toISOString() : null,
      oldestPendingAgeMs,
      targetMaxCount: target.maxProofBacklogCount,
      targetMaxAgeMs: target.maxProofBacklogAgeMs,
      status,
      reason,
    });
  }

  const met = breaches.length === 0 && !unknown;
  return {
    evaluatedAt: now.toISOString(),
    status: breaches.length > 0 ? "breached" : unknown ? "unknown" : "ok",
    met,
    breaches,
    sources,
    lanes,
  };
}
