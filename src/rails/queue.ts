/**
 * Choosing which transfers to ask a rail about next, honoring durable persisted `next_attempt_at`
 * timestamps and `retry_class` classifications across process restarts.
 */
import type { Queryable } from "../db/pool.js";
import { bigintOf, integer, text, textOrNull, timestampOrNull } from "../db/rows.js";
import { parseRetryClass } from "./retry-schedule.js";
import type { AttestationStatus, PendingTransfer } from "./types.js";

export {
  computeFailureSchedule,
  computeHealthySchedule,
  parseRetryClass,
  readRetrySchedule,
  recoverTerminalRetrySchedule,
  resolveRetryPolicy,
  writeScheduledAttestation,
} from "./retry-schedule.js";

const STATUSES: readonly string[] = ["pending", "attested", "delivered", "failed", "expired"];

export interface QueueQuery {
  readonly route: number;
  readonly limit: number;
  /**
   * Fallback cutoff for legacy rows that have no persisted `next_attempt_at` yet.
   */
  readonly notCheckedSince: Date;
  /** Give up on a transfer after this many consecutive failures, and stop polling it. */
  readonly maxCheckFailures: number;
  /** Current clock used to evaluate durable `next_attempt_at` timestamps. */
  readonly now?: Date | undefined;
}

export async function pendingForRail(
  db: Queryable,
  query: QueueQuery,
): Promise<readonly PendingTransfer[]> {
  const now = query.now ?? new Date();
  const { rows } = await db.query(
    `SELECT t.id,
            t.route,
            t.origin_chain,
            t.destination_chain,
            t.nonce,
            t.origin_tx,
            a.status,
            a.retry_class,
            a.next_attempt_at,
            COALESCE(a.check_failures, 0) AS check_failures,
            EXISTS (
              SELECT 1 FROM inbound_delivery d
               WHERE d.destination_chain = t.destination_chain
                 AND d.route = t.route
                 AND d.source_chain = t.origin_chain
                 AND d.source_nonce = t.nonce
            ) AS delivered
       FROM outbound_transfer t
       LEFT JOIN rail_attestation a ON a.transfer_id = t.id
      WHERE t.route = $1
        AND (a.transfer_id IS NULL OR a.status IN ('pending', 'attested'))
        AND (
          EXISTS (
            SELECT 1 FROM inbound_delivery d
             WHERE d.destination_chain = t.destination_chain
               AND d.route = t.route
               AND d.source_chain = t.origin_chain
               AND d.source_nonce = t.nonce
          )
          OR (
            (a.retry_class IS NULL OR a.retry_class <> 'terminal_evidence')
            AND COALESCE(a.check_failures, 0) < $2
            AND (
              (a.next_attempt_at IS NOT NULL AND a.next_attempt_at <= $4)
              OR (a.next_attempt_at IS NULL AND (a.last_checked_at IS NULL OR a.last_checked_at < $3))
            )
          )
        )
      ORDER BY a.next_attempt_at ASC NULLS FIRST, a.last_checked_at ASC NULLS FIRST, t.id ASC
      LIMIT $5`,
    [query.route, query.maxCheckFailures, query.notCheckedSince, now, query.limit],
  );

  return rows.map((row) => ({
    transferId: bigintOf(row, "id"),
    route: integer(row, "route"),
    originChain: text(row, "origin_chain"),
    destinationChain: text(row, "destination_chain"),
    nonce: bigintOf(row, "nonce"),
    originTx: text(row, "origin_tx"),
    status: readStatus(row.status === undefined ? null : textOrNull(row, "status")),
    checkFailures: integer(row, "check_failures"),
    delivered: row.delivered === true,
    retryClass:
      row.retry_class === undefined ? null : parseRetryClass(textOrNull(row, "retry_class")),
    nextAttemptAt:
      row.next_attempt_at === undefined ? null : timestampOrNull(row, "next_attempt_at"),
  }));
}

export async function outstandingForRail(db: Queryable, route: number): Promise<number> {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n
       FROM outbound_transfer t
       LEFT JOIN rail_attestation a ON a.transfer_id = t.id
      WHERE t.route = $1
        AND (a.transfer_id IS NULL OR a.status IN ('pending', 'attested'))`,
    [route],
  );
  const row = rows[0];
  return row === undefined ? 0 : integer(row, "n");
}

function readStatus(value: string | null): AttestationStatus | null {
  if (value === null) return null;
  if (!STATUSES.includes(value)) {
    throw new Error(`rail_attestation.status holds ${value}, which this build does not know`);
  }
  return value as AttestationStatus;
}
