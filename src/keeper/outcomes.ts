import type { Queryable } from "../db/pool.js";
import { text } from "../db/rows.js";
export type KeeperSubmissionStage = "simulated" | "submitted" | "pending" | "confirmed" | "failed";
export interface KeeperSubmissionMetrics {
  readonly simulated: number;
  readonly submitted: number;
  readonly pending: number;
  readonly confirmed: number;
  readonly failed: number;
}
export async function recordKeeperSubmission(
  db: Queryable,
  input: {
    readonly jobName: "ttl-bump" | "claim-settlement";
    readonly signerPublicKey: string;
    readonly transactionHash?: string | null;
    readonly stage: KeeperSubmissionStage;
    readonly errorDetail?: string | null;
  },
): Promise<string> {
  const result = await db.query(
    `INSERT INTO keeper_submission
    (job_name,signer_public_key,transaction_hash,stage,error_detail) VALUES($1,$2,$3,$4,$5)
    RETURNING id::text`,
    [
      input.jobName,
      input.signerPublicKey,
      input.transactionHash ?? null,
      input.stage,
      input.errorDetail ? "maintenance simulation or submission failed" : null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Keeper outcome evidence could not be persisted.");
  return text(row, "id");
}
export async function updateKeeperSubmission(
  db: Queryable,
  id: string,
  input: {
    readonly stage: KeeperSubmissionStage;
    readonly transactionHash?: string | null;
    readonly errorDetail?: string | null;
  },
): Promise<void> {
  await db.query(
    `UPDATE keeper_submission SET stage=$2,transaction_hash=COALESCE($3,transaction_hash),
    error_detail=$4,updated_at=now() WHERE id=$1 AND stage IN ('simulated','submitted','pending')`,
    [
      id,
      input.stage,
      input.transactionHash ?? null,
      input.errorDetail ? "maintenance simulation or submission failed" : null,
    ],
  );
}
export async function readKeeperSubmissionMetrics(db: Queryable): Promise<KeeperSubmissionMetrics> {
  const result = await db.query(`SELECT coalesce(c.state,s.stage) AS stage,count(*)::int AS count
    FROM keeper_submission s LEFT JOIN keeper_checkpoint c ON c.hash=s.transaction_hash AND c.state IN ('confirmed','failed')
    GROUP BY coalesce(c.state,s.stage)`);
  const metrics = { simulated: 0, submitted: 0, pending: 0, confirmed: 0, failed: 0 };
  for (const row of result.rows) {
    const stage = row.stage;
    if (
      stage === "simulated" ||
      stage === "submitted" ||
      stage === "pending" ||
      stage === "confirmed" ||
      stage === "failed"
    )
      metrics[stage] = Number(row.count);
  }
  return metrics;
}
