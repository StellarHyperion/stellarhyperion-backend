import type { Queryable } from "../db/pool.js";
import { bigintOf, boolean, numericStringOrNull, RowError, text } from "../db/rows.js";

export interface CoverageSource {
  readonly chain: string;
  readonly family: "stellar" | "evm";
  readonly contract: string;
}
const safeCount = (row: Record<string, unknown>, key: string): number => {
  const value = bigintOf(row, key);
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RowError(key, "is outside the supported metric range");
  return Number(value);
};
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new RowError("snapshot", "is not an object");
  return value as Record<string, unknown>;
};

/** One database statement keeps counts, replay progress, oldest intervals and coverage consistent. */
export async function readHistoricalCoverage(db: Queryable, expected: readonly CoverageSource[]) {
  let snapshot: Record<string, unknown>;
  try {
    const result = await db.query(
      `/* historical_coverage_snapshot */
      WITH configured AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(chain text, family text, contract text)),
      gaps AS (
        SELECT chain_key AS chain, 'stellar' AS family,
          GREATEST(start_ledger,COALESCE(replayed_through+1,start_ledger)) AS first_missing,
          end_ledger AS last_missing FROM stellar_history_gap WHERE status IN ('open','reconciling')
        UNION ALL
        SELECT chain_key,'evm',next_block,to_block FROM evm_backfill_job
          WHERE state <> 'completed' AND next_block <= to_block
      ), sources AS (
        SELECT chain,family FROM configured UNION SELECT chain_key,family FROM indexer_cursor
        UNION SELECT chain,family FROM gaps
      ) SELECT jsonb_build_object(
        'historyGaps', (SELECT jsonb_build_object(
          'open',count(*) FILTER (WHERE status='open')::text,
          'reconciling',count(*) FILTER (WHERE status='reconciling')::text,
          'reconciled',count(*) FILTER (WHERE status='reconciled')::text) FROM stellar_history_gap),
        'sources', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'chain',s.chain,'family',s.family,
          'unresolved',(SELECT count(*)::text FROM gaps g WHERE g.chain=s.chain AND g.family=s.family),
          'from',(SELECT first_missing::text FROM gaps g WHERE g.chain=s.chain AND g.family=s.family
            AND first_missing<=last_missing ORDER BY first_missing,last_missing LIMIT 1),
          'to',(SELECT last_missing::text FROM gaps g WHERE g.chain=s.chain AND g.family=s.family
            AND first_missing<=last_missing ORDER BY first_missing,last_missing LIMIT 1),
          'observed', EXISTS (SELECT 1 FROM indexer_cursor c WHERE c.chain_key=s.chain AND c.family=s.family)
            AND NOT EXISTS (SELECT 1 FROM configured e WHERE e.chain=s.chain AND e.family=s.family
              AND NOT EXISTS (SELECT 1 FROM indexer_cursor c WHERE c.chain_key=e.chain AND c.family=e.family AND c.contract=e.contract))
            AND NOT EXISTS (SELECT 1 FROM indexer_cursor c WHERE c.chain_key=s.chain AND c.family=s.family AND
              CASE WHEN s.family='stellar' THEN NOT EXISTS (SELECT 1 FROM stellar_scan_journal j
                WHERE j.chain_key=c.chain_key AND j.contract=c.contract
                  AND CASE WHEN j.journal->'committedRange'->>'from' ~ '^[0-9]{1,20}$'
                    AND j.journal->'committedRange'->>'to' ~ '^[0-9]{1,20}$'
                    THEN (j.journal->'committedRange'->>'from')::numeric <= (j.journal->'committedRange'->>'to')::numeric ELSE false END)
              ELSE NOT EXISTS (SELECT 1 FROM evm_scan_provenance p WHERE p.chain_key=c.chain_key AND p.contract=c.contract) END)
          ) ORDER BY s.chain,s.family) FROM sources s),'[]'::jsonb)) AS snapshot`,
      [JSON.stringify(expected)],
    );
    if (result.rows.length !== 1) throw new RowError("snapshot", "did not return one row");
    snapshot = object(result.rows[0]?.snapshot);
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      (error.code !== "42P01" && error.code !== "42703")
    )
      throw error;
    return {
      historyGaps: { open: 0, reconciling: 0, reconciled: 0 },
      historicalCoverage: {
        version: 1,
        scope: "recorded_ranges",
        unresolved: null,
        oldestMissingStartLedger: null,
        oldestMissingEndLedger: null,
        unknown: true,
        sources: [],
      },
    };
  }
  const counts = object(snapshot.historyGaps);
  if (!Array.isArray(snapshot.sources)) throw new RowError("sources", "is not an array");
  const sources = snapshot.sources.map((value: unknown) => {
    const row = object(value);
    const family = text(row, "family");
    if (family !== "stellar" && family !== "evm") throw new RowError("family", "is not supported");
    const unresolved = safeCount(row, "unresolved");
    const start = numericStringOrNull(row, "from"),
      end = numericStringOrNull(row, "to");
    return {
      chain: text(row, "chain"),
      family,
      unresolved,
      oldestMissingStart: start,
      oldestMissingEnd: end,
      unknown: !boolean(row, "observed") || (unresolved > 0 && (start === null || end === null)),
    };
  });
  const unresolved = sources.reduce((total, source) => total + source.unresolved, 0);
  if (!Number.isSafeInteger(unresolved))
    throw new RowError("unresolved", "exceeds the supported metric range");
  const oldest = sources
    .filter(
      (source): source is typeof source & { oldestMissingStart: string } =>
        source.family === "stellar" && source.oldestMissingStart !== null,
    )
    .sort((a, b) => {
      const left = BigInt(a.oldestMissingStart),
        right = BigInt(b.oldestMissingStart);
      return left < right ? -1 : left > right ? 1 : a.chain.localeCompare(b.chain);
    })[0];
  return {
    historyGaps: {
      open: safeCount(counts, "open"),
      reconciling: safeCount(counts, "reconciling"),
      reconciled: safeCount(counts, "reconciled"),
    },
    historicalCoverage: {
      version: 1,
      scope: "recorded_ranges",
      unresolved,
      oldestMissingStartLedger: oldest?.oldestMissingStart ?? null,
      oldestMissingEndLedger: oldest?.oldestMissingEnd ?? null,
      unknown: sources.length === 0 || sources.some((source) => source.unknown),
      sources,
    },
  };
}
