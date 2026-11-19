import type { Queryable } from "../db/pool.js";

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
): Promise<number> {
  const result = await db.query(
    `INSERT INTO keeper_submission
       (job_name, signer_public_key, transaction_hash, stage, error_detail)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      input.jobName,
      input.signerPublicKey,
      input.transactionHash ?? null,
      input.stage,
      input.errorDetail ?? null,
    ],
  );
  return Number(result.rows[0]?.id ?? 0);
}

export async function updateKeeperSubmission(
  db: Queryable,
  id: number,
  input: {
    readonly stage: KeeperSubmissionStage;
    readonly transactionHash?: string | null;
    readonly errorDetail?: string | null;
  },
): Promise<void> {
  await db.query(
    `UPDATE keeper_submission
        SET stage = $2,
            transaction_hash = COALESCE($3, transaction_hash),
            error_detail = $4,
            updated_at = now()
      WHERE id = $1`,
    [id, input.stage, input.transactionHash ?? null, input.errorDetail ?? null],
  );
}

export async function readKeeperSubmissionMetrics(db: Queryable): Promise<KeeperSubmissionMetrics> {
  const result = await db.query(
    `SELECT stage, count(*)::int AS count
       FROM keeper_submission
      GROUP BY stage`,
  );
  const metrics: Record<keyof KeeperSubmissionMetrics, number> = {
    simulated: 0,
    submitted: 0,
    pending: 0,
    confirmed: 0,
    failed: 0,
  };
  for (const row of result.rows) {
    const stage = row.stage as keyof KeeperSubmissionMetrics;
    if (stage in metrics) metrics[stage] = Number(row.count);
  }
  return metrics;
}

export async function countPendingKeeperSubmissions(db: Queryable): Promise<number> {
  const result = await db.query(
    "SELECT count(*)::int AS count FROM keeper_submission WHERE stage = 'pending'",
  );
  return Number(result.rows[0]?.count ?? 0);
}
