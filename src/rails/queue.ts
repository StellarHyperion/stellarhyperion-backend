/**
 * Choosing which transfers to ask a rail about next.
 *
 * One query, and the shape of it is the whole design. A transfer needs looking at when it has left
 * one chain and has not arrived on the other, which is two conditions the schema expresses in two
 * different tables: no `rail_attestation` row yet, or one that is still `pending` or `attested`.
 * A `LEFT JOIN` covers both without a union, and the ordering matches the partial index B2 already
 * created for exactly this.
 *
 * The `delivered` column is the part worth reading twice. It is computed from our own
 * `inbound_delivery` table rather than from a rail, because an inbound row means the money arrived
 * and that is a stronger claim than any rail's opinion about whether it will. A transfer that has
 * arrived is settled without spending a request on it, which on a busy day is most of them.
 */
import type { Queryable } from "../db/pool.js";
import { bigintOf, integer, text, textOrNull } from "../db/rows.js";
import type { AttestationStatus, PendingTransfer } from "./types.js";

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
}

export async function pendingForRail(
  db: Queryable,
  query: QueueQuery,
): Promise<readonly PendingTransfer[]> {
  const { rows } = await db.query(
    `SELECT t.id,
            t.route,
            t.origin_chain,
            t.destination_chain,
            t.nonce,
            t.origin_tx,
            a.status,
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
        AND COALESCE(a.check_failures, 0) < $2
        AND (a.last_checked_at IS NULL OR a.last_checked_at < $3)
      ORDER BY a.last_checked_at NULLS FIRST, t.id
      LIMIT $4`,
    [query.route, query.maxCheckFailures, query.notCheckedSince, query.limit],
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
  }));
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

/** A status the database holds, refused rather than widened if it is not one of the five. */
function readStatus(value: string | null): AttestationStatus | null {
  if (value === null) return null;
  if (!STATUSES.includes(value)) {
    // The column has a check constraint, so this means a migration added a state the code does
    // not know, and guessing which of the five it resembles would file a transfer under the wrong
    // one forever.
    throw new Error(`rail_attestation.status holds ${value}, which this build does not know`);
  }
  return value as AttestationStatus;
}
