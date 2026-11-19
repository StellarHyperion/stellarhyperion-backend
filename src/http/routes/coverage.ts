/**
 * Transfer history coverage and indexer freshness metadata (#96).
 *
 * History responses report where the indexer has scanned through, when it was last updated,
 * and how many history gaps are known, so clients can distinguish genuinely empty history from
 * incomplete or unavailable coverage. Metadata is scoped to the requested source deployment
 * and an api-only process never claims active watcher freshness without durable evidence.
 */
import type { AppConfig } from "../../config/config.js";
import type { Queryable } from "../../db/pool.js";
import { integer, textOrNull, timestampOrNull } from "../../db/rows.js";

export type CoverageStatus = "complete" | "incomplete" | "unavailable" | "empty";

export interface CoverageMetadata {
  readonly sourceChain: string;
  readonly scannedThrough: string | null;
  readonly updatedAt: string | null;
  readonly knownGaps: number;
  readonly coverage: CoverageStatus;
}

export async function coverageMetadata(
  db: Queryable,
  config: Pick<AppConfig, "indexer" | "deploymentMode">,
  chain: string,
  resultCount: number,
): Promise<CoverageMetadata> {
  const cursor = await db.query(
    "SELECT last_processed AS scanned_through, updated_at FROM indexer_cursor WHERE chain_key = $1",
    [chain],
  );
  const gaps = await db.query(
    "SELECT COUNT(*) AS gap_count FROM stellar_history_gap WHERE chain_key = $1 AND status IN ('open', 'reconciling')",
    [chain],
  );
  const scannedThrough = textOrNull(cursor.rows[0] ?? {}, "scanned_through");
  const updatedAt = timestampOrNull(cursor.rows[0] ?? {}, "updated_at");
  const knownGaps = integer(gaps.rows[0] ?? {}, "gap_count");
  const enabled = config.indexer?.enabled ?? false;
  const apiOnly = config.deploymentMode === "api-only";
  let coverage: CoverageStatus = "unavailable";
  if (chain && enabled && !apiOnly) {
    coverage = knownGaps > 0 ? "incomplete" : "complete";
  }
  if (resultCount === 0 && coverage === "complete") coverage = "empty";
  return {
    sourceChain: chain,
    scannedThrough,
    updatedAt: updatedAt ? updatedAt.toISOString() : null,
    knownGaps,
    coverage,
  };
}
