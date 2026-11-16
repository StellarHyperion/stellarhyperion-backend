/**
 * Persisted historical coverage-gap tracking and deterministic backfill resolution.
 *
 * Keeps unresolved ledger/block holes and unverified pre-cursor history separate from
 * `indexer_cursor`, so an indexer caught up at the current chain head never hides an earlier
 * RPC retention gap.
 */
import { isEvmDeployment, isStellarDeployment } from "@hyperion/protocol";

import type { AppConfig } from "../config/config.js";
import type { Queryable } from "../db/pool.js";

export type CoverageStatus = "complete" | "gapped" | "unknown";

export type CoverageGapReason =
  "rpc_retention_gap" | "start_override_skip" | "rpc_range_refused" | "manual_gap";

export interface MissingRangeSummary {
  readonly chain: string;
  readonly family: "stellar" | "evm";
  readonly fromHeight: string;
  readonly toHeight: string;
  readonly missingCount: string;
  readonly reason: string;
  readonly detectedAt: string;
}

export interface ChainCoverageReport {
  readonly chain: string;
  readonly family: "stellar" | "evm";
  readonly coverageStatus: CoverageStatus;
  readonly coverageDetail: string;
  readonly deployedStart: string;
  readonly verifiedFrom: string | null;
  readonly verifiedThrough: string | null;
  readonly currentCursor: string | null;
  readonly unresolvedGapCount: number;
  readonly missingBlocksTotal: string;
  readonly oldestMissingRange: MissingRangeSummary | null;
}

export interface CoverageGapMetricsSnapshot {
  readonly overallStatus: CoverageStatus;
  readonly unresolvedGapCount: number;
  readonly missingBlocksTotal: string;
  readonly oldestMissingRange: MissingRangeSummary | null;
  readonly byChain: readonly ChainCoverageReport[];
}

function isUndefinedTableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "42P01"
  );
}

function scalarBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  return null;
}

export interface RecordGapInput {
  readonly chainKey: string;
  readonly family: "stellar" | "evm";
  readonly fromHeight: bigint;
  readonly toHeight: bigint;
  readonly reason: CoverageGapReason;
  readonly now?: Date;
}

export interface RecordVerifiedRangeInput {
  readonly chainKey: string;
  readonly family: "stellar" | "evm";
  readonly deployedStart: bigint;
  readonly fromHeight: bigint;
  readonly toHeight: bigint;
  readonly now?: Date;
}

/**
 * Record an unresolved historical gap `[fromHeight, toHeight]`, coalescing any overlapping or
 * adjacent open intervals so missing block totals remain exact across repeated passes.
 */
export async function recordCoverageGap(db: Queryable, input: RecordGapInput): Promise<void> {
  if (input.toHeight < input.fromHeight) return;
  const at = input.now ?? new Date();

  try {
    const overlapping = await db.query(
      `SELECT id, from_height, to_height
         FROM indexer_coverage_gap
        WHERE chain_key = $1
          AND status = 'open'
          AND from_height <= $2
          AND to_height >= $3
        ORDER BY from_height ASC, id ASC`,
      [input.chainKey, (input.toHeight + 1n).toString(), (input.fromHeight - 1n).toString()],
    );

    let mergedFrom = input.fromHeight;
    let mergedTo = input.toHeight;
    const idsToReplace: string[] = [];

    for (const row of overlapping.rows) {
      const idVal = scalarBigInt(row.id);
      const rFrom = scalarBigInt(row.from_height);
      const rTo = scalarBigInt(row.to_height);
      if (idVal === null || rFrom === null || rTo === null) continue;
      if (rFrom < mergedFrom) mergedFrom = rFrom;
      if (rTo > mergedTo) mergedTo = rTo;
      idsToReplace.push(idVal.toString());
    }

    if (idsToReplace.length === 1) {
      await db.query(
        `UPDATE indexer_coverage_gap
            SET from_height = $2,
                to_height = $3
          WHERE id = $1`,
        [idsToReplace[0], mergedFrom.toString(), mergedTo.toString()],
      );
      return;
    }

    if (idsToReplace.length > 1) {
      await db.query(
        `DELETE FROM indexer_coverage_gap
          WHERE id = ANY($1::bigint[])`,
        [idsToReplace],
      );
    }

    await db.query(
      `INSERT INTO indexer_coverage_gap (
         chain_key, family, from_height, to_height, reason, status, detected_at
       ) VALUES ($1, $2, $3, $4, $5, 'open', $6)`,
      [input.chainKey, input.family, mergedFrom.toString(), mergedTo.toString(), input.reason, at],
    );
  } catch (error) {
    if (isUndefinedTableError(error)) return;
    throw error;
  }
}

/**
 * Deterministically update historical coverage state and resolve, trim, or split any overlapping
 * open gaps when `[fromHeight, toHeight]` has been verified by live scan or archive backfill.
 */
export async function resolveBackfillCoverage(
  db: Queryable,
  input: RecordVerifiedRangeInput,
): Promise<void> {
  if (input.toHeight < input.fromHeight) return;
  const at = input.now ?? new Date();

  try {
    const overlapping = await db.query(
      `SELECT id, from_height, to_height, reason, detected_at
         FROM indexer_coverage_gap
        WHERE chain_key = $1
          AND status = 'open'
          AND from_height <= $2
          AND to_height >= $3
        ORDER BY from_height ASC, id ASC`,
      [input.chainKey, input.toHeight.toString(), input.fromHeight.toString()],
    );

    for (const row of overlapping.rows) {
      const gapId = scalarBigInt(row.id);
      const gFrom = scalarBigInt(row.from_height);
      const gTo = scalarBigInt(row.to_height);
      if (gapId === null || gFrom === null || gTo === null) continue;
      const reason =
        typeof row.reason === "string" ? (row.reason as CoverageGapReason) : "rpc_retention_gap";
      const detectedAt =
        row.detected_at !== null && row.detected_at !== undefined
          ? new Date(row.detected_at as string | number | Date)
          : at;

      if (input.fromHeight <= gFrom && input.toHeight >= gTo) {
        // Entire gap covered by backfill.
        await db.query(
          `UPDATE indexer_coverage_gap
              SET status = 'resolved',
                  resolved_at = $2
            WHERE id = $1`,
          [gapId.toString(), at],
        );
      } else if (input.fromHeight <= gFrom && input.toHeight < gTo) {
        // Left side covered; shrink remaining open gap to [toHeight + 1, gTo].
        await db.query(
          `UPDATE indexer_coverage_gap
              SET from_height = $2
            WHERE id = $1`,
          [gapId.toString(), (input.toHeight + 1n).toString()],
        );
      } else if (input.fromHeight > gFrom && input.toHeight >= gTo) {
        // Right side covered; shrink remaining open gap to [gFrom, fromHeight - 1].
        await db.query(
          `UPDATE indexer_coverage_gap
              SET to_height = $2
            WHERE id = $1`,
          [gapId.toString(), (input.fromHeight - 1n).toString()],
        );
      } else {
        // Interior slice covered; split into [gFrom, fromHeight - 1] and [toHeight + 1, gTo].
        await db.query(
          `UPDATE indexer_coverage_gap
              SET to_height = $2
            WHERE id = $1`,
          [gapId.toString(), (input.fromHeight - 1n).toString()],
        );
        await db.query(
          `INSERT INTO indexer_coverage_gap (
             chain_key, family, from_height, to_height, reason, status, detected_at
           ) VALUES ($1, $2, $3, $4, $5, 'open', $6)`,
          [
            input.chainKey,
            input.family,
            (input.toHeight + 1n).toString(),
            gTo.toString(),
            reason,
            detectedAt,
          ],
        );
      }
    }

    const stateRes = await db.query(
      `SELECT verified_from, verified_through, coverage_known
         FROM indexer_coverage_state
        WHERE chain_key = $1`,
      [input.chainKey],
    );
    const existing = stateRes.rows[0];
    const prevFrom = existing ? scalarBigInt(existing.verified_from) : null;
    const prevThrough = existing ? scalarBigInt(existing.verified_through) : null;

    const nextFrom =
      prevFrom === null
        ? input.fromHeight
        : input.fromHeight < prevFrom
          ? input.fromHeight
          : prevFrom;
    const nextThrough =
      prevThrough === null
        ? input.toHeight
        : input.toHeight > prevThrough
          ? input.toHeight
          : prevThrough;
    const coverageKnown = nextFrom <= input.deployedStart;

    await db.query(
      `INSERT INTO indexer_coverage_state (
         chain_key, family, deployed_start, verified_from, verified_through, coverage_known, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (chain_key) DO UPDATE
         SET deployed_start = EXCLUDED.deployed_start,
             verified_from = EXCLUDED.verified_from,
             verified_through = EXCLUDED.verified_through,
             coverage_known = EXCLUDED.coverage_known,
             updated_at = EXCLUDED.updated_at`,
      [
        input.chainKey,
        input.family,
        input.deployedStart.toString(),
        nextFrom.toString(),
        nextThrough.toString(),
        coverageKnown,
        at,
      ],
    );
  } catch (error) {
    if (isUndefinedTableError(error)) return;
    throw error;
  }
}

export class CoverageTracker {
  constructor(private readonly db: Queryable) {}

  recordGap(input: RecordGapInput, tx?: Queryable): Promise<void> {
    return recordCoverageGap(tx ?? this.db, input);
  }

  recordVerifiedRange(input: RecordVerifiedRangeInput, tx?: Queryable): Promise<void> {
    return resolveBackfillCoverage(tx ?? this.db, input);
  }
}

interface ExpectedChainDeployment {
  readonly chain: string;
  readonly family: "stellar" | "evm";
  readonly deployedStart: bigint;
}

function expectedChainDeployments(config: AppConfig): readonly ExpectedChainDeployment[] {
  const result: ExpectedChainDeployment[] = [];
  for (const chainKey of Object.keys(config.deployments.networks).sort()) {
    const entry = config.deployments.networks[chainKey as keyof typeof config.deployments.networks];
    if (entry === undefined) continue;
    if (isStellarDeployment(entry)) {
      result.push({
        chain: chainKey,
        family: "stellar",
        deployedStart: BigInt(entry.deployedAt.ledger),
      });
    } else if (isEvmDeployment(entry)) {
      result.push({
        chain: chainKey,
        family: "evm",
        deployedStart: BigInt(entry.deployedAt.blockNumber),
      });
    }
  }
  return result;
}

/**
 * Compute historical coverage-gap metrics from PostgreSQL, strictly separating current cursor lag
 * from unresolved retention holes and explicitly representing unknown historical coverage.
 */
export async function readCoverageGapMetrics(
  db: Queryable,
  config: AppConfig,
): Promise<CoverageGapMetricsSnapshot> {
  const deployments = expectedChainDeployments(config);

  const cursorByChain = new Map<string, bigint>();
  try {
    const cursorRes = await db.query("SELECT chain_key, last_processed FROM indexer_cursor");
    for (const row of cursorRes.rows) {
      if (typeof row.chain_key !== "string") continue;
      const pos = scalarBigInt(row.last_processed);
      if (pos !== null) {
        cursorByChain.set(row.chain_key, pos);
      }
    }
  } catch (error) {
    if (!isUndefinedTableError(error)) throw error;
  }

  let coverageTablesPresent = true;
  const stateByChain = new Map<
    string,
    {
      readonly deployedStart: bigint;
      readonly verifiedFrom: bigint | null;
      readonly verifiedThrough: bigint | null;
      readonly coverageKnown: boolean;
    }
  >();
  const openGapsByChain = new Map<string, MissingRangeSummary[]>();

  try {
    const stateRes = await db.query(
      `SELECT chain_key, deployed_start, verified_from, verified_through, coverage_known
         FROM indexer_coverage_state`,
    );
    for (const row of stateRes.rows) {
      if (typeof row.chain_key !== "string") continue;
      const deployedStart = scalarBigInt(row.deployed_start);
      if (deployedStart === null) continue;
      stateByChain.set(row.chain_key, {
        deployedStart,
        verifiedFrom: scalarBigInt(row.verified_from),
        verifiedThrough: scalarBigInt(row.verified_through),
        coverageKnown: Boolean(row.coverage_known),
      });
    }

    const gapRes = await db.query(
      `SELECT chain_key, family, from_height, to_height, reason, detected_at
         FROM indexer_coverage_gap
        WHERE status = 'open'
        ORDER BY from_height ASC, id ASC`,
    );
    for (const row of gapRes.rows) {
      if (typeof row.chain_key !== "string") continue;
      if (row.family !== "stellar" && row.family !== "evm") continue;
      const fromH = scalarBigInt(row.from_height);
      const toH = scalarBigInt(row.to_height);
      if (fromH === null || toH === null || toH < fromH) continue;
      const width = toH - fromH + 1n;
      const entry: MissingRangeSummary = {
        chain: row.chain_key,
        family: row.family,
        fromHeight: fromH.toString(),
        toHeight: toH.toString(),
        missingCount: width.toString(),
        reason: typeof row.reason === "string" ? row.reason : "rpc_retention_gap",
        detectedAt: new Date(row.detected_at as string | number | Date).toISOString(),
      };
      const existing = openGapsByChain.get(row.chain_key) ?? [];
      existing.push(entry);
      openGapsByChain.set(row.chain_key, existing);
    }
  } catch (error) {
    if (isUndefinedTableError(error)) {
      coverageTablesPresent = false;
    } else {
      throw error;
    }
  }

  const byChain: ChainCoverageReport[] = [];
  let totalOpenGaps = 0;
  let totalMissingBlocks = 0n;
  let globalOldestMissing: MissingRangeSummary | null = null;

  for (const dep of deployments) {
    const cursor = cursorByChain.get(dep.chain) ?? null;
    const state = stateByChain.get(dep.chain) ?? null;
    const gaps = openGapsByChain.get(dep.chain) ?? [];
    const chainGapCount = gaps.length;
    let chainMissing = 0n;
    for (const gap of gaps) {
      chainMissing += BigInt(gap.missingCount);
    }
    const oldestForChain = gaps[0] ?? null;

    totalOpenGaps += chainGapCount;
    totalMissingBlocks += chainMissing;
    if (oldestForChain !== null) {
      if (
        globalOldestMissing === null ||
        BigInt(oldestForChain.fromHeight) < BigInt(globalOldestMissing.fromHeight)
      ) {
        globalOldestMissing = oldestForChain;
      }
    }

    let coverageStatus: CoverageStatus;
    let coverageDetail: string;

    if (chainGapCount > 0) {
      coverageStatus = "gapped";
      coverageDetail = `${String(chainGapCount)} unresolved historical gap(s) totaling ${chainMissing.toString()} missing ${dep.family === "stellar" ? "ledgers" : "blocks"}`;
    } else if (!coverageTablesPresent) {
      coverageStatus = "unknown";
      coverageDetail = "historical coverage tables have not been migrated on this database";
    } else if (state === null && cursor === null) {
      coverageStatus = "unknown";
      coverageDetail = "no scan or backfill evidence recorded yet for this router deployment";
    } else if (state === null || !state.coverageKnown || state.verifiedFrom === null) {
      coverageStatus = "unknown";
      coverageDetail =
        "cursor exists, but historical coverage back to the deployment height has not been verified";
    } else if (state.verifiedFrom > dep.deployedStart) {
      coverageStatus = "unknown";
      coverageDetail = `verified coverage starts at ${state.verifiedFrom.toString()}, after deployment height ${dep.deployedStart.toString()}`;
    } else {
      coverageStatus = "complete";
      coverageDetail = `continuous verified coverage from deployment height ${dep.deployedStart.toString()} through ${(state.verifiedThrough ?? cursor ?? dep.deployedStart).toString()}`;
    }

    byChain.push({
      chain: dep.chain,
      family: dep.family,
      coverageStatus,
      coverageDetail,
      deployedStart: dep.deployedStart.toString(),
      verifiedFrom:
        state?.verifiedFrom !== null && state?.verifiedFrom !== undefined
          ? state.verifiedFrom.toString()
          : null,
      verifiedThrough:
        state?.verifiedThrough !== null && state?.verifiedThrough !== undefined
          ? state.verifiedThrough.toString()
          : null,
      currentCursor: cursor !== null ? cursor.toString() : null,
      unresolvedGapCount: chainGapCount,
      missingBlocksTotal: chainMissing.toString(),
      oldestMissingRange: oldestForChain,
    });
  }

  let overallStatus: CoverageStatus = "complete";
  if (byChain.length === 0) {
    overallStatus = "unknown";
  } else if (byChain.some((c) => c.coverageStatus === "gapped")) {
    overallStatus = "gapped";
  } else if (byChain.some((c) => c.coverageStatus === "unknown")) {
    overallStatus = "unknown";
  }

  return {
    overallStatus,
    unresolvedGapCount: totalOpenGaps,
    missingBlocksTotal: totalMissingBlocks.toString(),
    oldestMissingRange: globalOldestMissing,
    byChain,
  };
}
