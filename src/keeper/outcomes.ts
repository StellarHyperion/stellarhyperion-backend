import type { Queryable, Transactional } from "../db/pool.js";
import { integer, text, textOrNull } from "../db/rows.js";
import type { KeeperJobName } from "./types.js";

export type KeeperOutcomeKind = "simulated" | "submitted" | "pending" | "confirmed" | "failed";

export interface KeeperOutcomeCounts {
  readonly simulated: number;
  readonly submitted: number;
  readonly pending: number;
  readonly confirmed: number;
  readonly failed: number;
}

export interface KeeperPendingSubmissionRef {
  readonly txHash: string;
  readonly chain: string;
  readonly jobKind: KeeperJobName;
  readonly contractId: string;
  readonly method: string;
  readonly submittedAt: string;
  readonly lastError: string | null;
}

export interface KeeperOutcomeMetricsSnapshot {
  /** Low-cardinality totals across all keeper jobs; never keyed by transaction hash. */
  readonly totals: KeeperOutcomeCounts;
  /** Low-cardinality breakdown bounded strictly to known keeper job kinds. */
  readonly byJobKind: Readonly<Record<KeeperJobName, KeeperOutcomeCounts>>;
  /** Bounded list of unresolved public transaction hashes surviving shutdown/recovery. */
  readonly pendingSubmissions: readonly KeeperPendingSubmissionRef[];
}

export interface RecordSubmittedInput {
  readonly txHash: string;
  readonly chainKey: string;
  readonly jobKind: KeeperJobName;
  readonly contractId: string;
  readonly method: string;
}

export type ReconcileDecision =
  | { readonly status: "confirmed" }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "pending" };

const JOB_KINDS: readonly KeeperJobName[] = ["ttl-bump", "claim-settlement"];

function emptyCounts(): {
  simulated: number;
  submitted: number;
  pending: number;
  confirmed: number;
  failed: number;
} {
  return {
    simulated: 0,
    submitted: 0,
    pending: 0,
    confirmed: 0,
    failed: 0,
  };
}

function isUndefinedTableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "42P01"
  );
}

function sanitizePublicError(reason: string): string {
  return reason
    .replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'`<>]+/g, "[redacted-url]")
    .replace(/\bS[A-Z2-7]{55}\b/g, "[redacted-secret]")
    .slice(0, 240);
}

export class KeeperOutcomeTracker {
  private cachedPendingCount = 0;

  constructor(private readonly db: Transactional) {}

  get pendingCount(): number {
    return this.cachedPendingCount;
  }

  async recordSimulated(jobKind: KeeperJobName): Promise<void> {
    await this.incrementCounter(this.db, jobKind, "simulated");
  }

  async recordPreBroadcastFailure(jobKind: KeeperJobName): Promise<void> {
    await this.incrementCounter(this.db, jobKind, "failed");
  }

  async recordSubmitted(input: RecordSubmittedInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO keeper_tx_submission (
           tx_hash, chain_key, job_kind, contract_id, method, status, submitted_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, 'pending', now(), now())
         ON CONFLICT (tx_hash) DO NOTHING
         RETURNING tx_hash`,
        [input.txHash, input.chainKey, input.jobKind, input.contractId, input.method],
      );
      if (inserted.rowCount > 0) {
        await this.incrementCounter(tx, input.jobKind, "submitted");
      }
    });
    await this.refreshPendingCount();
  }

  async recordConfirmed(txHash: string, fallbackJobKind: KeeperJobName): Promise<boolean> {
    let transitioned = false;
    await this.db.transaction(async (tx) => {
      const updated = await tx.query(
        `UPDATE keeper_tx_submission
            SET status = 'confirmed',
                last_error = NULL,
                resolved_at = now(),
                updated_at = now()
          WHERE tx_hash = $1
            AND status = 'pending'
          RETURNING job_kind`,
        [txHash],
      );
      const row = updated.rows[0];
      if (row !== undefined) {
        transitioned = true;
        const kind = (text(row, "job_kind") as KeeperJobName | undefined) ?? fallbackJobKind;
        await this.incrementCounter(tx, kind, "confirmed");
      }
    });
    await this.refreshPendingCount();
    return transitioned;
  }

  async recordSubmissionFailed(
    txHash: string,
    fallbackJobKind: KeeperJobName,
    reason: string,
  ): Promise<boolean> {
    const safeReason = sanitizePublicError(reason);
    let transitioned = false;
    await this.db.transaction(async (tx) => {
      const updated = await tx.query(
        `UPDATE keeper_tx_submission
            SET status = 'failed',
                last_error = $2,
                resolved_at = now(),
                updated_at = now()
          WHERE tx_hash = $1
            AND status = 'pending'
          RETURNING job_kind`,
        [txHash, safeReason],
      );
      const row = updated.rows[0];
      if (row !== undefined) {
        transitioned = true;
        const kind = (text(row, "job_kind") as KeeperJobName | undefined) ?? fallbackJobKind;
        await this.incrementCounter(tx, kind, "failed");
      }
    });
    await this.refreshPendingCount();
    return transitioned;
  }

  async touchPendingNote(txHash: string, note: string): Promise<void> {
    const safeNote = sanitizePublicError(note);
    await this.db.query(
      `UPDATE keeper_tx_submission
          SET last_error = $2,
              updated_at = now()
        WHERE tx_hash = $1
          AND status = 'pending'`,
      [txHash, safeNote],
    );
    await this.refreshPendingCount();
  }

  async listPendingSubmissions(limit = 50): Promise<readonly KeeperPendingSubmissionRef[]> {
    const res = await this.db.query(
      `SELECT tx_hash, chain_key, job_kind, contract_id, method, submitted_at, last_error
         FROM keeper_tx_submission
        WHERE status = 'pending'
        ORDER BY submitted_at ASC
        LIMIT $1`,
      [limit],
    );
    this.cachedPendingCount = res.rows.length;
    return res.rows.map((row) => ({
      txHash: text(row, "tx_hash"),
      chain: text(row, "chain_key"),
      jobKind: text(row, "job_kind") as KeeperJobName,
      contractId: text(row, "contract_id"),
      method: text(row, "method"),
      submittedAt: new Date(row.submitted_at as string | number | Date).toISOString(),
      lastError: textOrNull(row, "last_error"),
    }));
  }

  async reconcilePending(
    inspectTx: (ref: KeeperPendingSubmissionRef) => Promise<ReconcileDecision>,
  ): Promise<{ confirmed: number; failed: number; remainingPending: number }> {
    const pending = await this.listPendingSubmissions(100);
    let confirmed = 0;
    let failed = 0;

    for (const ref of pending) {
      const decision = await inspectTx(ref);
      if (decision.status === "confirmed") {
        if (await this.recordConfirmed(ref.txHash, ref.jobKind)) {
          confirmed += 1;
        }
      } else if (decision.status === "failed") {
        if (await this.recordSubmissionFailed(ref.txHash, ref.jobKind, decision.reason)) {
          failed += 1;
        }
      }
    }

    const remainingPending = await this.refreshPendingCount();
    return { confirmed, failed, remainingPending };
  }

  async refreshPendingCount(): Promise<number> {
    try {
      const res = await this.db.query(
        "SELECT count(*)::int AS count FROM keeper_tx_submission WHERE status = 'pending'",
      );
      const count = res.rows[0] !== undefined ? integer(res.rows[0], "count") : 0;
      this.cachedPendingCount = count;
      return count;
    } catch (error) {
      if (isUndefinedTableError(error)) {
        this.cachedPendingCount = 0;
        return 0;
      }
      throw error;
    }
  }

  private async incrementCounter(
    target: Queryable,
    jobKind: KeeperJobName,
    outcome: Exclude<KeeperOutcomeKind, "pending">,
  ): Promise<void> {
    await target.query(
      `INSERT INTO keeper_tx_outcome_counter (job_kind, outcome, total_count, updated_at)
       VALUES ($1, $2, 1, now())
       ON CONFLICT (job_kind, outcome)
       DO UPDATE SET total_count = keeper_tx_outcome_counter.total_count + 1,
                     updated_at = now()`,
      [jobKind, outcome],
    );
  }
}

export async function readKeeperOutcomeMetrics(
  db: Queryable,
  pendingLimit = 20,
): Promise<KeeperOutcomeMetricsSnapshot> {
  const byJob: Record<
    KeeperJobName,
    {
      simulated: number;
      submitted: number;
      pending: number;
      confirmed: number;
      failed: number;
    }
  > = {
    "ttl-bump": emptyCounts(),
    "claim-settlement": emptyCounts(),
  };

  try {
    const counterRes = await db.query(
      "SELECT job_kind, outcome, total_count::int AS count FROM keeper_tx_outcome_counter",
    );
    for (const row of counterRes.rows) {
      if (typeof row.job_kind !== "string" || typeof row.outcome !== "string") continue;
      const jobKind = row.job_kind as KeeperJobName;
      if (!JOB_KINDS.includes(jobKind)) continue;
      const bucket = byJob[jobKind];
      const count = integer(row, "count");
      if (row.outcome === "simulated") bucket.simulated = count;
      else if (row.outcome === "submitted") bucket.submitted = count;
      else if (row.outcome === "confirmed") bucket.confirmed = count;
      else if (row.outcome === "failed") bucket.failed = count;
    }

    const pendingCountsRes = await db.query(
      `SELECT job_kind, count(*)::int AS count
         FROM keeper_tx_submission
        WHERE status = 'pending'
        GROUP BY job_kind`,
    );
    for (const row of pendingCountsRes.rows) {
      if (typeof row.job_kind !== "string") continue;
      const jobKind = row.job_kind as KeeperJobName;
      if (!JOB_KINDS.includes(jobKind)) continue;
      byJob[jobKind].pending = integer(row, "count");
    }

    const pendingListRes = await db.query(
      `SELECT tx_hash, chain_key, job_kind, contract_id, method, submitted_at, last_error
         FROM keeper_tx_submission
        WHERE status = 'pending'
        ORDER BY submitted_at ASC
        LIMIT $1`,
      [pendingLimit],
    );
    const pendingSubmissions: KeeperPendingSubmissionRef[] = [];
    for (const row of pendingListRes.rows) {
      if (typeof row.tx_hash !== "string" || typeof row.job_kind !== "string") continue;
      pendingSubmissions.push({
        txHash: text(row, "tx_hash"),
        chain: text(row, "chain_key"),
        jobKind: text(row, "job_kind") as KeeperJobName,
        contractId: text(row, "contract_id"),
        method: text(row, "method"),
        submittedAt: new Date(row.submitted_at as string | number | Date).toISOString(),
        lastError: textOrNull(row, "last_error"),
      });
    }

    const totals = emptyCounts();
    for (const kind of JOB_KINDS) {
      totals.simulated += byJob[kind].simulated;
      totals.submitted += byJob[kind].submitted;
      totals.pending += byJob[kind].pending;
      totals.confirmed += byJob[kind].confirmed;
      totals.failed += byJob[kind].failed;
    }

    return {
      totals,
      byJobKind: byJob,
      pendingSubmissions,
    };
  } catch (error) {
    if (isUndefinedTableError(error)) {
      return {
        totals: emptyCounts(),
        byJobKind: byJob,
        pendingSubmissions: [],
      };
    }
    throw error;
  }
}
