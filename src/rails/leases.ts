/**
 * Database-backed ownership leases and monotonic fencing tokens for rail passes.
 *
 * Multiple replicas polling external rail APIs must not process the same candidate simultaneously
 * or allow a slow, paused replica whose lease expired to overwrite a newer replica's decision or
 * mark a stale payout delivered. Every lease acquisition increments `fencing_token` monotonically
 * on `rail_work_lease`, and every commit validates `(lease_owner, fencing_token, expires_at > now)`
 * inside the target database transaction before writing `inbound_delivery` or `rail_attestation`.
 */
import type { Queryable, Transactional } from "../db/pool.js";
import { bigintOf, integer, maybeOne, text, textOrNull, timestamp, type Row } from "../db/rows.js";
import type {
  AttestationStatus,
  LeaseLossReason,
  LeasedPendingTransfer,
  RailWorkLease,
} from "./types.js";

const STATUSES: readonly AttestationStatus[] = [
  "pending",
  "attested",
  "delivered",
  "failed",
  "expired",
];

export const DEFAULT_RAIL_LEASE_DURATION_MS = 30_000;

export class RailLeaseLostError extends Error {
  constructor(
    readonly transferId: bigint,
    readonly reason: LeaseLossReason,
    detail: string,
  ) {
    super(`rail lease lost for transfer ${transferId.toString()} (${reason}): ${detail}`);
    this.name = "RailLeaseLostError";
  }
}

export interface ClaimQueueQuery {
  readonly route: number;
  readonly limit: number;
  readonly notCheckedSince: Date;
  readonly maxCheckFailures: number;
  readonly owner: string;
  readonly now: Date;
  readonly leaseDurationMs: number;
}

function parseStatus(value: string | null): AttestationStatus | null {
  if (value === null) return null;
  const match = STATUSES.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new Error(`rail_attestation.status holds ${value}, which this build does not know`);
  }
  return match;
}

function readLeaseRow(row: Row): RailWorkLease {
  return {
    transferId: bigintOf(row, "transfer_id"),
    route: integer(row, "route"),
    owner: text(row, "lease_owner"),
    fencingToken: bigintOf(row, "fencing_token"),
    acquiredAt: timestamp(row, "acquired_at"),
    expiresAt: timestamp(row, "expires_at"),
  };
}

function validateLeaseInputs(owner: string, leaseDurationMs: number): string {
  const trimmed = owner.trim();
  if (trimmed.length === 0) {
    throw new Error("rail lease owner must be a non-empty string");
  }
  if (!Number.isInteger(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new Error("rail leaseDurationMs must be a positive integer");
  }
  return trimmed;
}

/**
 * Atomically select eligible candidate transfers and claim bounded ownership leases on them.
 *
 * Uses `FOR UPDATE OF t SKIP LOCKED` so concurrent replicas skip candidates currently being
 * claimed by another replica instead of blocking or duplicating work.
 */
export async function claimPendingForRail(
  db: Transactional,
  query: ClaimQueueQuery,
): Promise<readonly LeasedPendingTransfer[]> {
  const owner = validateLeaseInputs(query.owner, query.leaseDurationMs);
  if (query.limit <= 0) return [];

  const expiresAt = new Date(query.now.getTime() + query.leaseDurationMs);

  return db.transaction(async (tx) => {
    const candidates = await tx.query(
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
         LEFT JOIN rail_work_lease l ON l.transfer_id = t.id
        WHERE t.route = $1
          AND (a.transfer_id IS NULL OR a.status IN ('pending', 'attested'))
          AND COALESCE(a.check_failures, 0) < $2
          AND (a.last_checked_at IS NULL OR a.last_checked_at < $3)
          AND (l.transfer_id IS NULL OR l.expires_at <= $4)
        ORDER BY a.last_checked_at NULLS FIRST, t.id
        LIMIT $5
        FOR UPDATE OF t SKIP LOCKED`,
      [query.route, query.maxCheckFailures, query.notCheckedSince, query.now, query.limit],
    );

    const claimed: LeasedPendingTransfer[] = [];
    for (const row of candidates.rows) {
      const transferId = bigintOf(row, "id");
      const route = integer(row, "route");
      const leaseRes = await tx.query(
        `INSERT INTO rail_work_lease
           (transfer_id, route, lease_owner, fencing_token, acquired_at, expires_at)
         VALUES ($1, $2, $3, 1, $4, $5)
         ON CONFLICT (transfer_id) DO UPDATE
           SET route = EXCLUDED.route,
               lease_owner = EXCLUDED.lease_owner,
               fencing_token = rail_work_lease.fencing_token + 1,
               acquired_at = EXCLUDED.acquired_at,
               expires_at = EXCLUDED.expires_at
         WHERE rail_work_lease.expires_at <= $4
         RETURNING transfer_id, route, lease_owner, fencing_token, acquired_at, expires_at`,
        [transferId.toString(), route, owner, query.now, expiresAt],
      );
      const leaseRow = maybeOne(leaseRes.rows, "rail_work_lease");
      if (leaseRow === null) continue;

      claimed.push({
        transferId,
        route,
        originChain: text(row, "origin_chain"),
        destinationChain: text(row, "destination_chain"),
        nonce: bigintOf(row, "nonce"),
        originTx: text(row, "origin_tx"),
        status: parseStatus(row.status === undefined ? null : textOrNull(row, "status")),
        checkFailures: integer(row, "check_failures"),
        delivered: row.delivered === true,
        lease: readLeaseRow(leaseRow),
      });
    }

    return claimed;
  });
}

async function verifyActiveLeaseInTx(tx: Queryable, lease: RailWorkLease, at: Date): Promise<Row> {
  const res = await tx.query(
    `SELECT transfer_id, route, lease_owner, fencing_token, acquired_at, expires_at
       FROM rail_work_lease
      WHERE transfer_id = $1
      FOR UPDATE`,
    [lease.transferId.toString()],
  );
  const row = maybeOne(res.rows, "rail_work_lease");
  if (row === null) {
    throw new RailLeaseLostError(lease.transferId, "lease_missing", "no lease row exists");
  }

  const dbOwner = text(row, "lease_owner");
  const dbToken = bigintOf(row, "fencing_token");
  if (dbOwner !== lease.owner || dbToken !== lease.fencingToken) {
    throw new RailLeaseLostError(
      lease.transferId,
      "lease_stolen",
      `held by ${dbOwner} with fencing token ${dbToken.toString()}, expected ${lease.owner} token ${lease.fencingToken.toString()}`,
    );
  }

  const dbExpiresAt = timestamp(row, "expires_at");
  if (dbExpiresAt.getTime() <= at.getTime()) {
    throw new RailLeaseLostError(
      lease.transferId,
      "lease_expired",
      `lease expired at ${dbExpiresAt.toISOString()} before ${at.toISOString()}`,
    );
  }

  return row;
}

/**
 * Extend an active lease before running a second stage (such as destination receipt verification).
 * Throws `RailLeaseLostError` if the lease has already expired or been acquired by another worker.
 */
export async function renewRailLease(
  db: Transactional,
  lease: RailWorkLease,
  now: Date,
  leaseDurationMs: number,
): Promise<RailWorkLease> {
  validateLeaseInputs(lease.owner, leaseDurationMs);
  const nextExpiresAt = new Date(now.getTime() + leaseDurationMs);

  return db.transaction(async (tx) => {
    await verifyActiveLeaseInTx(tx, lease, now);
    const updated = await tx.query(
      `UPDATE rail_work_lease
          SET expires_at = $2
        WHERE transfer_id = $1
          AND lease_owner = $3
          AND fencing_token = $4
        RETURNING transfer_id, route, lease_owner, fencing_token, acquired_at, expires_at`,
      [lease.transferId.toString(), nextExpiresAt, lease.owner, lease.fencingToken.toString()],
    );
    const row = maybeOne(updated.rows, "rail_work_lease");
    if (row === null) {
      throw new RailLeaseLostError(lease.transferId, "lease_stolen", "lease disappeared on renew");
    }
    return readLeaseRow(row);
  });
}

/**
 * Execute database writes (`writeInbound`, `writeAttestation`) inside a fenced transaction.
 *
 * If the caller's lease expired or was acquired by another replica (`fencing_token` mismatch),
 * throws `RailLeaseLostError` without executing `work` so a stale worker can never commit a
 * conflicting decision or mark delivery after losing ownership. On success, marks the lease
 * expired at `commitAt` while preserving `fencing_token` monotonically.
 */
export async function commitWithRailLease<T>(
  db: Transactional,
  lease: RailWorkLease,
  commitAt: Date,
  work: (tx: Queryable) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const row = await verifyActiveLeaseInTx(tx, lease, commitAt);
    const result = await work(tx);
    const acquiredAt = timestamp(row, "acquired_at");
    const releasedExpiresAt = commitAt.getTime() >= acquiredAt.getTime() ? commitAt : acquiredAt;
    await tx.query(
      `UPDATE rail_work_lease
          SET expires_at = $2
        WHERE transfer_id = $1
          AND lease_owner = $3
          AND fencing_token = $4`,
      [lease.transferId.toString(), releasedExpiresAt, lease.owner, lease.fencingToken.toString()],
    );
    return result;
  });
}

/** Explicitly expire a held lease early (for example on rate limit or graceful abort). */
export async function releaseRailLease(
  db: Transactional,
  lease: RailWorkLease,
  now: Date,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const current = await tx.query(
      `SELECT acquired_at FROM rail_work_lease
        WHERE transfer_id = $1 AND lease_owner = $2 AND fencing_token = $3
        FOR UPDATE`,
      [lease.transferId.toString(), lease.owner, lease.fencingToken.toString()],
    );
    const row = maybeOne(current.rows, "rail_work_lease");
    if (row === null) return false;
    const acquiredAt = timestamp(row, "acquired_at");
    const releasedExpiresAt = now.getTime() >= acquiredAt.getTime() ? now : acquiredAt;
    const updated = await tx.query(
      `UPDATE rail_work_lease
          SET expires_at = $4
        WHERE transfer_id = $1 AND lease_owner = $2 AND fencing_token = $3`,
      [lease.transferId.toString(), lease.owner, lease.fencingToken.toString(), releasedExpiresAt],
    );
    return updated.rowCount > 0;
  });
}
