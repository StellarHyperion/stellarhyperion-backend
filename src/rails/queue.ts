/**
 * Choosing which transfers to ask a rail about next, scheduled fairly across age buckets and
 * destination chains so a large stale backlog or noisy destination cannot starve recent or smaller
 * lanes.
 */
import type { Queryable } from "../db/pool.js";
import { bigintOf, integer, text, textOrNull, timestamp } from "../db/rows.js";
import {
  initialFairSchedulerCursor,
  resolveFairSchedulingConfig,
  scheduleFairRailBatch,
  type FairScheduleResult,
} from "./scheduler.js";
import type {
  AttestationStatus,
  FairSchedulerCursor,
  FairSchedulingConfig,
  PendingTransfer,
  RailAgeBucket,
} from "./types.js";

export {
  AGE_BUCKETS,
  classifyRailAgeBucket,
  computeBucketQuotas,
  initialFairSchedulerCursor,
  resolveFairSchedulingConfig,
  scheduleFairRailBatch,
  type FairScheduleResult,
} from "./scheduler.js";

const STATUSES: readonly string[] = ["pending", "attested", "delivered", "failed", "expired"];

export interface QueueQuery {
  readonly route: number;
  readonly limit: number;
  /**
   * Skip transfers checked more recently than this.
   *
   * Without it a single stuck transfer at the front of the ordering is re-checked on every tick
   * and the rest of the queue never gets a turn.
   */
  readonly notCheckedSince: Date;
  /** Give up on a transfer after this many consecutive failures, and stop polling it. */
  readonly maxCheckFailures: number;
  readonly now?: Date | undefined;
  readonly scheduling?: FairSchedulingConfig | undefined;
  readonly cursor?: FairSchedulerCursor | undefined;
}

export async function schedulePendingForRail(
  db: Queryable,
  query: QueueQuery,
): Promise<FairScheduleResult> {
  const now = query.now ?? new Date();
  if (query.limit <= 0) {
    return {
      selected: [],
      nextCursor: query.cursor ?? initialFairSchedulerCursor(),
      bucketCounts: { fresh: 0, aging: 0, stale: 0 },
      destinationCounts: {},
    };
  }

  const resolved = resolveFairSchedulingConfig(query.scheduling);
  const freshCutoff = new Date(now.getTime() - resolved.freshMaxAgeMs);
  const agingCutoff = new Date(now.getTime() - resolved.agingMaxAgeMs);

  const { rows } = await db.query(
    `WITH eligible AS (
       SELECT t.id,
              t.route,
              t.origin_chain,
              t.destination_chain,
              t.nonce,
              t.origin_tx,
              t.observed_at,
              a.status,
              COALESCE(a.check_failures, 0) AS check_failures,
              a.last_checked_at,
              EXISTS (
                SELECT 1 FROM inbound_delivery d
                 WHERE d.destination_chain = t.destination_chain
                   AND d.route = t.route
                   AND d.source_chain = t.origin_chain
                   AND d.source_nonce = t.nonce
              ) AS delivered,
              CASE
                WHEN t.observed_at >= $5 THEN 'fresh'
                WHEN t.observed_at >= $6 THEN 'aging'
                ELSE 'stale'
              END AS age_bucket,
              ROW_NUMBER() OVER (
                PARTITION BY
                  CASE
                    WHEN t.observed_at >= $5 THEN 'fresh'
                    WHEN t.observed_at >= $6 THEN 'aging'
                    ELSE 'stale'
                  END,
                  t.destination_chain
                ORDER BY a.last_checked_at ASC NULLS FIRST, t.id ASC
              ) AS partition_rank
         FROM outbound_transfer t
         LEFT JOIN rail_attestation a ON a.transfer_id = t.id
        WHERE t.route = $1
          AND (a.transfer_id IS NULL OR a.status IN ('pending', 'attested'))
          AND COALESCE(a.check_failures, 0) < $2
          AND (a.last_checked_at IS NULL OR a.last_checked_at < $3)
     )
     SELECT id,
            route,
            origin_chain,
            destination_chain,
            nonce,
            origin_tx,
            observed_at,
            status,
            check_failures,
            delivered,
            age_bucket
       FROM eligible
      WHERE partition_rank <= $4
      ORDER BY partition_rank ASC, last_checked_at ASC NULLS FIRST, id ASC`,
    [
      query.route,
      query.maxCheckFailures,
      query.notCheckedSince,
      query.limit,
      freshCutoff,
      agingCutoff,
    ],
  );

  const candidates: PendingTransfer[] = rows.map((row) => ({
    transferId: bigintOf(row, "id"),
    route: integer(row, "route"),
    originChain: text(row, "origin_chain"),
    destinationChain: text(row, "destination_chain"),
    nonce: bigintOf(row, "nonce"),
    originTx: text(row, "origin_tx"),
    status: readStatus(row.status === undefined ? null : textOrNull(row, "status")),
    checkFailures: integer(row, "check_failures"),
    delivered: row.delivered === true,
    observedAt: timestamp(row, "observed_at"),
    ageBucket: readAgeBucket(text(row, "age_bucket")),
  }));

  return scheduleFairRailBatch(candidates, {
    limit: query.limit,
    now,
    config: query.scheduling,
    cursor: query.cursor,
  });
}

export async function pendingForRail(
  db: Queryable,
  query: QueueQuery,
): Promise<readonly PendingTransfer[]> {
  const scheduled = await schedulePendingForRail(db, query);
  return scheduled.selected;
}

/**
 * How many transfers are stuck on this rail, for readiness to report.
 *
 * Counted separately from the queue because the queue is capped at a batch and the interesting
 * number is the whole backlog: a hundred pending transfers and a batch of twenty means the poller
 * is five ticks behind, which is a different situation from twenty and a batch of twenty.
 */
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

function readAgeBucket(value: string): RailAgeBucket {
  if (value === "fresh" || value === "aging" || value === "stale") return value;
  throw new Error(`unexpected rail age bucket ${value}`);
}

/** A status the database holds, refused rather than widened if it is not one of the five. */
function readStatus(value: string | null): AttestationStatus | null {
  if (value === null) return null;
  if (!STATUSES.includes(value)) {
    throw new Error(`rail_attestation.status holds ${value}, which this build does not know`);
  }
  return value as AttestationStatus;
}
