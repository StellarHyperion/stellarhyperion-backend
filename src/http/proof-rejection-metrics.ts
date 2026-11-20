import { RouteKind } from "@hyperion/protocol";
import type { Queryable } from "../db/pool.js";
import { bigintOf, RowError, text } from "../db/rows.js";
import {
  emptyProofFailureCategories,
  PROOF_FAILURE_CATEGORIES,
  type ProofFailureCategory,
} from "./proof-failure-categories.js";

// CASE expressions return only this public vocabulary. Raw diagnostic values never leave SQL.
const cctpCategory = `CASE
  WHEN verification_failure IN ('recipient_mismatch','destination_domain_mismatch') THEN 'recipient'
  WHEN verification_failure IN ('token_mismatch','messenger_mismatch','source_adapter_mismatch') THEN 'token'
  WHEN verification_failure IN ('amount_mismatch','fee_mismatch') THEN 'amount'
  WHEN verification_failure IN ('finality_mismatch','receipt_missing','receipt_reverted','confirmations_pending','non_canonical_receipt') THEN 'finality'
  ELSE 'provider_inconsistency' END`;

async function aggregate(db: Queryable, sql: string, params: readonly unknown[] = []) {
  const counts = emptyProofFailureCategories();
  try {
    const result = await db.query(`/* proof_rejection_metrics */ ${sql}`, params);
    for (const row of result.rows) {
      const category = text(row, "category");
      if (!(PROOF_FAILURE_CATEGORIES as readonly string[]).includes(category))
        throw new RowError("category", "is outside the proof rejection vocabulary");
      const count = bigintOf(row, "count");
      if (count < 0n || count > BigInt(Number.MAX_SAFE_INTEGER))
        throw new RowError("count", "is outside the supported metric range");
      counts[category as ProofFailureCategory] += Number(count);
    }
    return { known: true, counts };
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      (error.code !== "42P01" && error.code !== "42703")
    )
      throw error;
    return { known: false, counts };
  }
}

/** Current unresolved evidence reasons, not successful deliveries or a monotonic attempt count. */
export async function readProofRejectionMetrics(db: Queryable) {
  const cctp = await aggregate(
    db,
    `SELECT ${cctpCategory} AS category, count(*)::text AS count
    FROM rail_attestation WHERE route=$1 AND verification_failure IS NOT NULL
    GROUP BY category`,
    [RouteKind.Cctp],
  );
  // Each transfer contributes once per distinct mismatch category. Missing receipt evidence is
  // a finality blocker. Verified/provider-only states do not become rejection or delivery counts.
  const its = await aggregate(
    db,
    `WITH reasons AS (
    SELECT transfer_id, 'finality' AS category FROM rail_attestation
      WHERE route=$1 AND its_verification_state='receipt_unavailable'
    UNION
    SELECT a.transfer_id, CASE WHEN d.value->>'category' IN ('recipient','token','amount')
      THEN d.value->>'category' ELSE 'provider_inconsistency' END AS category
    FROM rail_attestation a LEFT JOIN LATERAL jsonb_array_elements(a.diagnostics) d(value) ON true
      WHERE a.route=$1 AND a.its_verification_state='payout_unverified'
    ) SELECT category,count(*)::text AS count FROM reasons GROUP BY category`,
    [RouteKind.AxelarIts],
  );
  // Durable source rejections supersede prunable raw quarantine. Counting both would duplicate
  // the same failed source record. Decoder/ordering failures are structural provider problems.
  const ingestion = await aggregate(
    db,
    `SELECT 'provider_inconsistency' AS category, count(*)::text AS count
    FROM ingestion_rejection WHERE reconciled_at IS NULL`,
  );
  const total = emptyProofFailureCategories();
  for (const category of PROOF_FAILURE_CATEGORIES) {
    total[category] = cctp.counts[category] + its.counts[category] + ingestion.counts[category];
    if (!Number.isSafeInteger(total[category]))
      throw new RowError("count", "exceeds the supported metric range");
  }
  return {
    total,
    byRail: { cctp: cctp.counts, its: its.counts },
    ingestion: ingestion.counts,
    coverage: {
      version: 1,
      known: cctp.known && its.known && ingestion.known,
      sources: { cctp: cctp.known, its: its.known, ingestion: ingestion.known },
    },
  };
}
