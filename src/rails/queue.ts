/**
 * Choosing which transfers to ask a rail about next, and claiming per-transfer check ownership.
 *
 * One query, and the shape of it is the whole design. A transfer needs looking at when it has left
 * one chain and has not arrived on the other, which is two conditions the schema expresses in two
 * different tables: no `rail_attestation` row yet, or one that is still `pending` or `attested`.
 * Candidates are interleaved across `destination_chain` using a window rank so a deep backlog on a
 * slow destination RPC cannot starve healthy destinations out of the batch window.
 */
import type { Queryable } from "../db/pool.js";
import { bigintOf, bigintOrNull, integer, text, textOrNull, timestampOrNull } from "../db/rows.js";
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
  /** Optional ceiling on candidates selected for any single destination chain in one batch. */
  readonly maxPerDestination?: number | undefined;
}

export interface TransferCheckLease {
  readonly transferId: bigint;
  readonly hadPriorRow: boolean;
  readonly priorCheckedAt: Date | null;
}

export type ClaimCheckOutcome =
  | { readonly kind: "skipped" }
  | { readonly kind: "already_delivered"; readonly lease: TransferCheckLease | null }
  | {
      readonly kind: "claimed";
      readonly lease: TransferCheckLease;
      readonly status: AttestationStatus | null;
      readonly checkFailures: number;
    };

export async function pendingForRail(
  db: Queryable,
  query: QueueQuery,
): Promise<readonly PendingTransfer[]> {
  const { rows } = await db.query(
    `WITH ranked AS (
       SELECT t.id,
              t.route,
              t.origin_chain,
              t.destination_chain,
              t.nonce,
              t.origin_tx,
              a.status,
              a.last_checked_at,
              COALESCE(a.check_failures, 0) AS check_failures,
              EXISTS (
                SELECT 1 FROM inbound_delivery d
                 WHERE d.destination_chain = t.destination_chain
                   AND d.route = t.route
                   AND d.source_chain = t.origin_chain
                   AND d.source_nonce = t.nonce
              ) AS delivered,
              ROW_NUMBER() OVER (
                PARTITION BY t.destination_chain
                ORDER BY a.last_checked_at NULLS FIRST, t.id ASC
              ) AS destination_rank
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
            status,
            check_failures,
            delivered
       FROM ranked
      WHERE ($5::int IS NULL OR destination_rank <= $5::int)
      ORDER BY destination_rank ASC, last_checked_at NULLS FIRST, id ASC
      LIMIT $4`,
    [
      query.route,
      query.maxCheckFailures,
      query.notCheckedSince,
      query.limit,
      query.maxPerDestination ?? null,
    ],
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
 * Atomically claim a transfer row for checking so two replicas polling the same database cannot
 * duplicate provider lookups or destination RPC receipt verifications within the recheck window.
 */
export async function claimTransferForCheck(
  db: Queryable,
  transfer: PendingTransfer,
  options: {
    readonly claimedAt: Date;
    readonly notCheckedSince: Date;
    readonly maxCheckFailures: number;
    readonly allowImmediateRecheck: boolean;
  },
): Promise<ClaimCheckOutcome> {
  const { rows } = await db.query(
    `WITH prior AS (
       SELECT transfer_id, status, last_checked_at, check_failures
         FROM rail_attestation
        WHERE transfer_id = $1::bigint
     ),
     claimed AS (
       INSERT INTO rail_attestation
         (transfer_id, route, status, last_checked_at, check_failures, updated_at)
       VALUES ($1::bigint, $2, 'pending', $3, 0, $3)
       ON CONFLICT (transfer_id) DO UPDATE
         SET last_checked_at = EXCLUDED.last_checked_at,
             updated_at = EXCLUDED.updated_at
       WHERE rail_attestation.status IN ('pending', 'attested')
         AND COALESCE(rail_attestation.check_failures, 0) < $4
         AND (
           $6::boolean
           OR rail_attestation.last_checked_at IS NULL
           OR rail_attestation.last_checked_at < $5
         )
       RETURNING transfer_id
     )
     SELECT c.transfer_id AS claimed_id,
            p.transfer_id IS NOT NULL AS had_prior,
            p.status AS prior_status,
            p.last_checked_at AS prior_checked_at,
            COALESCE(p.check_failures, 0) AS prior_failures,
            EXISTS (
              SELECT 1 FROM inbound_delivery d
               WHERE d.destination_chain = $7
                 AND d.route = $2
                 AND d.source_chain = $8
                 AND d.source_nonce = $9::numeric
            ) AS delivered
       FROM (SELECT 1) AS anchor
       LEFT JOIN claimed c ON true
       LEFT JOIN prior p ON true`,
    [
      transfer.transferId.toString(),
      transfer.route,
      options.claimedAt,
      options.maxCheckFailures,
      options.notCheckedSince,
      options.allowImmediateRecheck,
      transfer.destinationChain,
      transfer.originChain,
      transfer.nonce.toString(),
    ],
  );

  const row = rows[0];
  if (row === undefined) {
    return { kind: "skipped" };
  }

  const claimedId = bigintOrNull(row, "claimed_id");
  const hadPriorRow = row.had_prior === true;
  const priorCheckedAt = timestampOrNull(row, "prior_checked_at");
  const priorStatus = readStatus(textOrNull(row, "prior_status"));
  const priorFailures = integer(row, "prior_failures");
  const delivered = row.delivered === true;

  const lease: TransferCheckLease | null =
    claimedId !== null
      ? {
          transferId: claimedId,
          hadPriorRow,
          priorCheckedAt,
        }
      : null;

  if (delivered && priorStatus !== "delivered") {
    return { kind: "already_delivered", lease };
  }

  if (lease === null) {
    return { kind: "skipped" };
  }

  return {
    kind: "claimed",
    lease,
    status: priorStatus,
    checkFailures: priorFailures,
  };
}

/**
 * Restore the pre-claim timestamp if a pass was aborted or rate-limited before completing its
 * provider lookup, so the transfer remains eligible on the next pass after cooldown.
 */
export async function releaseUncheckedClaim(
  db: Queryable,
  lease: TransferCheckLease,
): Promise<void> {
  if (!lease.hadPriorRow) {
    await db.query(
      `DELETE FROM rail_attestation
        WHERE transfer_id = $1::bigint
          AND status = 'pending'
          AND rail_status IS NULL
          AND rail_reference IS NULL
          AND check_failures = 0
          AND last_error IS NULL`,
      [lease.transferId.toString()],
    );
    return;
  }

  await db.query(
    `UPDATE rail_attestation
        SET last_checked_at = $2,
            updated_at = now()
      WHERE transfer_id = $1::bigint
        AND status IN ('pending', 'attested')`,
    [lease.transferId.toString(), lease.priorCheckedAt],
  );
}

/**
 * How many transfers are stuck on this rail, for readiness to report.
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
    throw new Error(`rail_attestation.status holds ${value}, which this build does not know`);
  }
  return value as AttestationStatus;
}
