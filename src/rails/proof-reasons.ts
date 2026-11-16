/**
 * Shared normalized destination proof rejection categories across CCTP and Axelar ITS.
 *
 * All dimensions are strictly bounded to fixed rail and reason identifiers so arbitrary
 * transaction hashes, message hashes, wallet addresses, and RPC endpoint credentials never appear
 * in metric labels or public diagnostics.
 */
import type { Queryable } from "../db/pool.js";

export const PROOF_RAILS = ["cctp", "axelar-its"] as const;
export type ProofRail = (typeof PROOF_RAILS)[number];

export const PROOF_REJECTION_REASONS = [
  "recipient_mismatch",
  "token_mismatch",
  "amount_mismatch",
  "insufficient_finality",
  "provider_inconsistency",
] as const;

export type ProofRejectionReason = (typeof PROOF_REJECTION_REASONS)[number];

export interface RailProofRejectionSummary {
  readonly total: number;
  readonly reasons: Readonly<Record<ProofRejectionReason, number>>;
  readonly lastRejectedAt: string | null;
}

export interface ProofRejectionMetricsSnapshot {
  readonly categories: readonly ProofRejectionReason[];
  readonly totalRejected: number;
  readonly integrityRejections: number;
  readonly byReason: Readonly<Record<ProofRejectionReason, number>>;
  readonly byRail: Readonly<Record<ProofRail, RailProofRejectionSummary>>;
}

export interface ProofRejectionLogger {
  warn?: (fields: Record<string, unknown>, msg: string) => void;
}

function isProofRail(value: unknown): value is ProofRail {
  return value === "cctp" || value === "axelar-its";
}

function isProofRejectionReason(value: unknown): value is ProofRejectionReason {
  return (
    value === "recipient_mismatch" ||
    value === "token_mismatch" ||
    value === "amount_mismatch" ||
    value === "insufficient_finality" ||
    value === "provider_inconsistency"
  );
}

function isUndefinedTableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "42P01"
  );
}

function emptyReasonMap(): Record<ProofRejectionReason, number> {
  return {
    recipient_mismatch: 0,
    token_mismatch: 0,
    amount_mismatch: 0,
    insufficient_finality: 0,
    provider_inconsistency: 0,
  };
}

export function createEmptyProofRejectionSnapshot(): ProofRejectionMetricsSnapshot {
  return {
    categories: PROOF_REJECTION_REASONS,
    totalRejected: 0,
    integrityRejections: 0,
    byReason: emptyReasonMap(),
    byRail: {
      cctp: {
        total: 0,
        reasons: emptyReasonMap(),
        lastRejectedAt: null,
      },
      "axelar-its": {
        total: 0,
        reasons: emptyReasonMap(),
        lastRejectedAt: null,
      },
    },
  };
}

export async function recordProofRejection(
  db: Queryable,
  rail: ProofRail,
  reason: ProofRejectionReason,
  logger?: ProofRejectionLogger,
): Promise<void> {
  if (!isProofRail(rail) || !isProofRejectionReason(reason)) {
    return;
  }

  logger?.warn?.({ rail, reason }, "destination proof candidate rejected");

  try {
    await db.query(
      `INSERT INTO proof_rejection_counter (rail, reason, rejected_count, updated_at)
       VALUES ($1, $2, 1, now())
       ON CONFLICT (rail, reason) DO UPDATE
         SET rejected_count = proof_rejection_counter.rejected_count + 1,
             updated_at = now()`,
      [rail, reason],
    );
  } catch (error) {
    if (!isUndefinedTableError(error)) {
      throw error;
    }
  }
}

export async function readProofRejectionMetrics(
  db: Queryable,
): Promise<ProofRejectionMetricsSnapshot> {
  const byReason = emptyReasonMap();
  const railReasons: Record<ProofRail, Record<ProofRejectionReason, number>> = {
    cctp: emptyReasonMap(),
    "axelar-its": emptyReasonMap(),
  };
  const railTotals: Record<ProofRail, number> = {
    cctp: 0,
    "axelar-its": 0,
  };
  const railUpdated: Record<ProofRail, Date | null> = {
    cctp: null,
    "axelar-its": null,
  };

  try {
    const res = await db.query(
      `SELECT rail, reason, rejected_count, updated_at
         FROM proof_rejection_counter
        ORDER BY rail ASC, reason ASC`,
    );

    for (const row of res.rows) {
      if (!isProofRail(row.rail) || !isProofRejectionReason(row.reason)) continue;
      const count = Number(row.rejected_count ?? 0);
      if (!Number.isFinite(count) || count < 0) continue;

      railReasons[row.rail][row.reason] += count;
      railTotals[row.rail] += count;
      byReason[row.reason] += count;

      if (row.updated_at !== null && row.updated_at !== undefined) {
        const dt = new Date(row.updated_at as string | number | Date);
        if (!Number.isNaN(dt.getTime())) {
          const prev = railUpdated[row.rail];
          if (prev === null || dt > prev) {
            railUpdated[row.rail] = dt;
          }
        }
      }
    }
  } catch (error) {
    if (isUndefinedTableError(error)) {
      return createEmptyProofRejectionSnapshot();
    }
    throw error;
  }

  const totalRejected = railTotals.cctp + railTotals["axelar-its"];
  const integrityRejections =
    byReason.recipient_mismatch + byReason.token_mismatch + byReason.amount_mismatch;

  return {
    categories: PROOF_REJECTION_REASONS,
    totalRejected,
    integrityRejections,
    byReason,
    byRail: {
      cctp: {
        total: railTotals.cctp,
        reasons: railReasons.cctp,
        lastRejectedAt: railUpdated.cctp ? railUpdated.cctp.toISOString() : null,
      },
      "axelar-its": {
        total: railTotals["axelar-its"],
        reasons: railReasons["axelar-its"],
        lastRejectedAt: railUpdated["axelar-its"] ? railUpdated["axelar-its"].toISOString() : null,
      },
    },
  };
}
