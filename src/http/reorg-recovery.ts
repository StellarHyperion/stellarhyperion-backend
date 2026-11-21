import type { Queryable } from "../db/pool.js";
import { integer, text, timestampOrNull } from "../db/rows.js";

/** Completed recovery comes from committed scan evidence, including after a process restart. */
export async function readCommittedReorgRecovery(db: Queryable) {
  const { rows } = await db.query(
    `SELECT chain_key, count(*)::text AS reorgs, sum(logs_written)::text AS replayed_logs,
            max(committed_at) AS last_recovery_at
       FROM evm_scan_provenance WHERE reorg_detected
      GROUP BY chain_key ORDER BY chain_key LIMIT 512`,
  );
  return rows.map((row) => ({
    chain: text(row, "chain_key"),
    reorgs: integer(row, "reorgs"),
    replayedLogs: integer(row, "replayed_logs"),
    lastRecoveryAt: timestampOrNull(row, "last_recovery_at")?.toISOString() ?? null,
    detectedDepth: null,
  }));
}

export function reorgRecoveryState(input: {
  readonly committedRecoveries: number;
  readonly pending: boolean;
  readonly stale: boolean;
  readonly failures: number;
  readonly state: string;
}): "none" | "automatic" | "operator_intervention" {
  if (input.pending) return "operator_intervention";
  if (input.committedRecoveries === 0) return "none";
  return input.stale || input.failures > 0 || input.state !== "ready"
    ? "operator_intervention"
    : "automatic";
}
