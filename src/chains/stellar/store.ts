/**
 * Soroban events mapped onto the shared row writers, plus the cursor that says they are written.
 *
 * The SQL lives in `../writers.ts` because both chain families write the same tables under the
 * same constraints. What lives here is the part that is genuinely Stellar: which field of which
 * event becomes which column, and the three places where a Soroban event carries less than its
 * EVM counterpart and the row has to say so honestly rather than make something up.
 *
 * Every function takes a `Queryable` rather than the pool, so the watcher can hand it a
 * transaction. That is the whole restart safety claim: a page of events and the cursor advance past
 * it land together or not at all.
 */
import { ROUTE_KINDS } from "@hyperion/protocol";

import type { Queryable } from "../../db/pool.js";
import {
  bigintOf,
  bigintOrNull,
  integer,
  maybeOne,
  text,
  textOrNull,
  timestamp,
  timestampOrNull,
} from "../../db/rows.js";
import type { Position } from "../writers.js";
import {
  settleAction,
  settleClaim,
  writeAction,
  writeClaim,
  writeHealthSample,
  writeInbound,
  writeOutbound,
} from "../writers.js";
import type {
  ActionLifecycleEvent,
  ActionQueuedEvent,
  BridgeInEvent,
  BridgeOutEvent,
  ClaimParkedEvent,
  ClaimSettledEvent,
  PauseSetEvent,
  RouteConfiguredEvent,
  TokenRegisteredEvent,
} from "./events.js";

/** Where a watcher has read up to. */
export interface ChainCursor {
  readonly position: bigint;
  readonly contract: string;
  readonly observedAt: Date | null;
  /** EVM only. Null on Stellar, where a closed ledger cannot change. */
  readonly hash: string | null;
  /** Monotonic revision for compare-and-swap cursor updates. */
  readonly revision: bigint;
}

export class StaleCursorError extends Error {
  constructor(
    readonly chainKey: string,
    readonly expectedRevision: bigint | null,
  ) {
    super(
      `stale cursor write for ${chainKey}: expected revision ${expectedRevision === null ? "none" : expectedRevision.toString()}`,
    );
    this.name = "StaleCursorError";
  }
}

export async function readCursor(db: Queryable, chainKey: string): Promise<ChainCursor | null> {
  const { rows } = await db.query(
    `SELECT last_processed, contract, last_processed_at, last_processed_hash, revision
       FROM indexer_cursor WHERE chain_key = $1`,
    [chainKey],
  );
  const row = maybeOne(rows, `cursor for ${chainKey}`);
  if (row === null) return null;
  const revision = bigintOrNull(row, "revision") ?? 1n;
  return {
    position: bigintOf(row, "last_processed"),
    contract: text(row, "contract"),
    observedAt: timestampOrNull(row, "last_processed_at"),
    hash: textOrNull(row, "last_processed_hash"),
    revision,
  };
}

/**
 * Advance the cursor, or create it.
 *
 * The contract is part of the write rather than just the read. A redeployed router at a new address
 * shares no history with the old one, so a cursor carried across would skip everything the new one
 * has ever done, silently. Storing it means the watcher can notice.
 *
 * When `expectedRevision` is provided (`null` for initial insert, `bigint` for an existing row),
 * the update is compare-and-swap guarded and throws `StaleCursorError` if a concurrent writer
 * modified the cursor first.
 */
export async function writeCursor(
  db: Queryable,
  entry: {
    readonly chainKey: string;
    readonly family: "stellar" | "evm";
    readonly contract: string;
    readonly position: bigint;
    readonly observedAt: Date | null;
    readonly hash: string | null;
    readonly expectedRevision?: bigint | null;
  },
): Promise<void> {
  const baseParams = [
    entry.chainKey,
    entry.family,
    entry.contract,
    entry.position.toString(),
    entry.observedAt,
    entry.hash,
  ];

  if (entry.expectedRevision === undefined) {
    await db.query(
      `INSERT INTO indexer_cursor
         (chain_key, family, contract, last_processed, last_processed_at, last_processed_hash, revision)
       VALUES ($1, $2, $3, $4, $5, $6, 1)
       ON CONFLICT (chain_key) DO UPDATE
         SET contract = EXCLUDED.contract,
             family = EXCLUDED.family,
             last_processed = EXCLUDED.last_processed,
             last_processed_at = EXCLUDED.last_processed_at,
             last_processed_hash = EXCLUDED.last_processed_hash,
             revision = indexer_cursor.revision + 1,
             updated_at = now()`,
      baseParams,
    );
    return;
  }

  if (entry.expectedRevision === null) {
    const result = await db.query(
      `INSERT INTO indexer_cursor
         (chain_key, family, contract, last_processed, last_processed_at, last_processed_hash, revision)
       VALUES ($1, $2, $3, $4, $5, $6, 1)
       ON CONFLICT (chain_key) DO NOTHING
       RETURNING revision`,
      baseParams,
    );
    if (result.rowCount === 0) {
      throw new StaleCursorError(entry.chainKey, null);
    }
    return;
  }

  const result = await db.query(
    `INSERT INTO indexer_cursor
       (chain_key, family, contract, last_processed, last_processed_at, last_processed_hash, revision)
     VALUES ($1, $2, $3, $4, $5, $6, 1)
     ON CONFLICT (chain_key) DO UPDATE
       SET contract = EXCLUDED.contract,
           family = EXCLUDED.family,
           last_processed = EXCLUDED.last_processed,
           last_processed_at = EXCLUDED.last_processed_at,
           last_processed_hash = EXCLUDED.last_processed_hash,
           revision = indexer_cursor.revision + 1,
           updated_at = now()
       WHERE indexer_cursor.revision = $7
     RETURNING revision`,
    [...baseParams, entry.expectedRevision.toString()],
  );
  if (result.rowCount === 0) {
    throw new StaleCursorError(entry.chainKey, entry.expectedRevision);
  }
}

// --------------------------------------------------------------------------------------------
// Expiring database leases (#31)
// --------------------------------------------------------------------------------------------

export class LeaseLostError extends Error {
  constructor(
    readonly chainKey: string,
    readonly contract: string,
    readonly ownerId: string,
  ) {
    super(`watcher lease lost for ${chainKey} (${contract}) held by ${ownerId}`);
    this.name = "LeaseLostError";
  }
}

export interface WatcherLease {
  readonly chainKey: string;
  readonly contract: string;
  readonly ownerId: string;
  readonly leaseUntil: Date;
}

export async function acquireLease(
  db: Queryable,
  params: {
    readonly chainKey: string;
    readonly contract: string;
    readonly ownerId: string;
    readonly ttlMs: number;
  },
): Promise<WatcherLease | null> {
  const { rows, rowCount } = await db.query(
    `INSERT INTO indexer_lease (chain_key, contract, owner_id, lease_until, updated_at)
     VALUES ($1, $2, $3, now() + ($4 * interval '1 millisecond'), now())
     ON CONFLICT (chain_key, contract) DO UPDATE
       SET owner_id = EXCLUDED.owner_id,
           lease_until = EXCLUDED.lease_until,
           updated_at = now()
       WHERE indexer_lease.lease_until <= now()
          OR indexer_lease.owner_id = EXCLUDED.owner_id
     RETURNING owner_id, lease_until`,
    [params.chainKey, params.contract, params.ownerId, params.ttlMs],
  );
  const row = rows[0];
  if (rowCount === 0 || row === undefined) return null;
  return {
    chainKey: params.chainKey,
    contract: params.contract,
    ownerId: text(row, "owner_id"),
    leaseUntil: timestamp(row, "lease_until"),
  };
}

export async function assertLeaseHeld(
  db: Queryable,
  params: {
    readonly chainKey: string;
    readonly contract: string;
    readonly ownerId: string;
    readonly ttlMs?: number;
  },
): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE indexer_lease
        SET lease_until = CASE
              WHEN $4::bigint IS NULL THEN lease_until
              ELSE now() + ($4 * interval '1 millisecond')
            END,
            updated_at = now()
      WHERE chain_key = $1
        AND contract = $2
        AND owner_id = $3
        AND lease_until > now()
     RETURNING owner_id`,
    [params.chainKey, params.contract, params.ownerId, params.ttlMs ?? null],
  );
  if (rowCount === 0) {
    throw new LeaseLostError(params.chainKey, params.contract, params.ownerId);
  }
}

export async function releaseLease(
  db: Queryable,
  params: {
    readonly chainKey: string;
    readonly contract: string;
    readonly ownerId: string;
  },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `DELETE FROM indexer_lease
      WHERE chain_key = $1 AND contract = $2 AND owner_id = $3`,
    [params.chainKey, params.contract, params.ownerId],
  );
  return rowCount > 0;
}

// --------------------------------------------------------------------------------------------
// Durable Stellar history-gap tracking (#29)
// --------------------------------------------------------------------------------------------

export type HistoryGapStatus = "open" | "reconciling" | "reconciled";

export interface HistoryGap {
  readonly id: bigint;
  readonly chainKey: string;
  readonly contract: string;
  readonly startLedger: bigint;
  readonly endLedger: bigint;
  readonly status: HistoryGapStatus;
  readonly replayedThrough: bigint | null;
  readonly reason: string;
  readonly detectedAt: Date;
  readonly reconciledAt: Date | null;
}

export async function recordHistoryGap(
  db: Queryable,
  gap: {
    readonly chainKey: string;
    readonly contract: string;
    readonly startLedger: number;
    readonly endLedger: number;
    readonly reason: string;
  },
): Promise<void> {
  if (gap.endLedger < gap.startLedger) return;
  await db.query(
    `INSERT INTO stellar_history_gap
       (chain_key, contract, start_ledger, end_ledger, status, reason)
     VALUES ($1, $2, $3, $4, 'open', $5)
     ON CONFLICT (chain_key, contract, start_ledger, end_ledger) DO UPDATE
       SET updated_at = now()`,
    [
      gap.chainKey,
      gap.contract,
      String(gap.startLedger),
      String(gap.endLedger),
      gap.reason,
    ],
  );
}

export async function listHistoryGaps(
  db: Queryable,
  params: {
    readonly chainKey: string;
    readonly contract?: string;
    readonly statuses?: readonly HistoryGapStatus[];
  },
): Promise<readonly HistoryGap[]> {
  const conditions = ["chain_key = $1"];
  const values: unknown[] = [params.chainKey];
  if (params.contract !== undefined) {
    values.push(params.contract);
    conditions.push(`contract = $${String(values.length)}`);
  }
  if (params.statuses !== undefined && params.statuses.length > 0) {
    values.push(params.statuses);
    conditions.push(`status = ANY($${String(values.length)}::text[])`);
  }
  const { rows } = await db.query(
    `SELECT id, chain_key, contract, start_ledger, end_ledger, status,
            replayed_through, reason, detected_at, reconciled_at
       FROM stellar_history_gap
      WHERE ${conditions.join(" AND ")}
      ORDER BY start_ledger ASC`,
    values,
  );
  return rows.map((row) => ({
    id: bigintOf(row, "id"),
    chainKey: text(row, "chain_key"),
    contract: text(row, "contract"),
    startLedger: bigintOf(row, "start_ledger"),
    endLedger: bigintOf(row, "end_ledger"),
    status: text(row, "status") as HistoryGapStatus,
    replayedThrough: bigintOrNull(row, "replayed_through"),
    reason: text(row, "reason"),
    detectedAt: timestamp(row, "detected_at"),
    reconciledAt: timestampOrNull(row, "reconciled_at"),
  }));
}

export async function countUnreconciledGaps(
  db: Queryable,
  chainKey: string,
  contract?: string,
): Promise<number> {
  const values: unknown[] = [chainKey];
  const contractFilter = contract === undefined ? "" : " AND contract = $2";
  if (contract !== undefined) values.push(contract);
  const { rows } = await db.query(
    `SELECT count(*)::int AS count
       FROM stellar_history_gap
      WHERE chain_key = $1${contractFilter}
        AND status <> 'reconciled'`,
    values,
  );
  const row = rows[0];
  return row === undefined ? 0 : integer(row, "count");
}

export async function advanceGapReplay(
  db: Queryable,
  params: {
    readonly id: bigint;
    readonly replayedThrough: number;
    readonly reconciled: boolean;
  },
): Promise<void> {
  await db.query(
    `UPDATE stellar_history_gap
        SET replayed_through = $2,
            status = CASE WHEN $3 THEN 'reconciled' ELSE 'reconciling' END,
            reconciled_at = CASE WHEN $3 THEN now() ELSE NULL END,
            updated_at = now()
      WHERE id = $1`,
    [params.id.toString(), String(params.replayedThrough), params.reconciled],
  );
}

// --------------------------------------------------------------------------------------------
// Separate historical-provider backfill progress (#30)
// --------------------------------------------------------------------------------------------

export type BackfillStatus = "running" | "completed" | "failed";

export interface BackfillCursor {
  readonly chainKey: string;
  readonly contract: string;
  readonly jobKey: string;
  readonly startLedger: bigint;
  readonly endLedger: bigint;
  readonly nextLedger: bigint;
  readonly status: BackfillStatus;
  readonly revision: bigint;
}

export async function readBackfillCursor(
  db: Queryable,
  chainKey: string,
  contract: string,
  jobKey: string,
): Promise<BackfillCursor | null> {
  const { rows } = await db.query(
    `SELECT chain_key, contract, job_key, start_ledger, end_ledger, next_ledger, status, revision
       FROM stellar_backfill_cursor
      WHERE chain_key = $1 AND contract = $2 AND job_key = $3`,
    [chainKey, contract, jobKey],
  );
  const row = maybeOne(rows, `backfill cursor for ${chainKey}/${jobKey}`);
  if (row === null) return null;
  return {
    chainKey: text(row, "chain_key"),
    contract: text(row, "contract"),
    jobKey: text(row, "job_key"),
    startLedger: bigintOf(row, "start_ledger"),
    endLedger: bigintOf(row, "end_ledger"),
    nextLedger: bigintOf(row, "next_ledger"),
    status: text(row, "status") as BackfillStatus,
    revision: bigintOrNull(row, "revision") ?? 1n,
  };
}

export async function writeBackfillCursor(
  db: Queryable,
  entry: {
    readonly chainKey: string;
    readonly contract: string;
    readonly jobKey: string;
    readonly startLedger: number;
    readonly endLedger: number;
    readonly nextLedger: number;
    readonly status: BackfillStatus;
    readonly expectedRevision: bigint | null;
  },
): Promise<void> {
  const baseParams = [
    entry.chainKey,
    entry.contract,
    entry.jobKey,
    String(entry.startLedger),
    String(entry.endLedger),
    String(entry.nextLedger),
    entry.status,
  ];

  if (entry.expectedRevision === null) {
    const result = await db.query(
      `INSERT INTO stellar_backfill_cursor
         (chain_key, contract, job_key, start_ledger, end_ledger, next_ledger, status, revision)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1)
       ON CONFLICT (chain_key, contract, job_key) DO NOTHING
       RETURNING revision`,
      baseParams,
    );
    if (result.rowCount === 0) {
      throw new StaleCursorError(`${entry.chainKey}:backfill:${entry.jobKey}`, null);
    }
    return;
  }

  const result = await db.query(
    `UPDATE stellar_backfill_cursor
        SET start_ledger = $4,
            end_ledger = $5,
            next_ledger = $6,
            status = $7,
            revision = revision + 1,
            updated_at = now()
      WHERE chain_key = $1
        AND contract = $2
        AND job_key = $3
        AND revision = $8
     RETURNING revision`,
    [...baseParams, entry.expectedRevision.toString()],
  );
  if (result.rowCount === 0) {
    throw new StaleCursorError(
      `${entry.chainKey}:backfill:${entry.jobKey}`,
      entry.expectedRevision,
    );
  }
}

/** Context for one Soroban event, in the shape the shared writers take. */
export interface EventContext {
  readonly chainKey: string;
  readonly ledger: number;
  readonly txHash: string;
  readonly closedAt: Date;
}

function positionOf(context: EventContext): Position {
  return {
    chainKey: context.chainKey,
    block: BigInt(context.ledger),
    txHash: context.txHash,
    // Soroban orders events by operation and event index within a transaction rather than by a
    // log index over the block, and putting one of those in a column named for the other would
    // read as if the two chains agreed about something they do not.
    logIndex: null,
    observedAt: context.closedAt,
  };
}

export async function recordBridgeOut(
  db: Queryable,
  context: EventContext,
  event: BridgeOutEvent,
): Promise<void> {
  await writeOutbound(db, positionOf(context), {
    route: event.route,
    nonce: event.nonce,
    sender: event.sender,
    token: event.token,
    grossAmount: event.grossAmount,
    fee: event.fee,
    netAmount: event.netAmount,
    destinationChain: event.destinationChain,
    // The 32 byte word as the router emitted it. The EVM router emits a strkey string instead,
    // and neither is converted here.
    destination: event.destination,
    // No rail reference on this side: the Soroban event does not carry one.
    railRef: null,
  });
}

export async function recordBridgeIn(
  db: Queryable,
  context: EventContext,
  event: BridgeInEvent,
): Promise<void> {
  await writeInbound(db, positionOf(context), {
    route: event.route,
    sourceChain: event.sourceChain,
    sourceNonce: event.sourceNonce,
    // No rail message id, even though the router's own replay guard is keyed on exactly that
    // value. It guards on `origin.message_id` and does not emit it, so the hop is the only
    // identity available on this side. The EVM event does carry one.
    railMessageId: null,
    recipient: event.recipient,
    token: event.token,
    amount: event.amount,
    delivered: event.delivered,
    claimId: event.delivered ? null : event.claimId,
  });
}

export async function recordClaimParked(
  db: Queryable,
  context: EventContext,
  event: ClaimParkedEvent,
): Promise<void> {
  await writeClaim(db, positionOf(context), {
    claimId: event.claimId,
    recipient: event.recipient,
    token: event.token,
    amount: event.amount,
    route: event.route,
    sourceChain: event.sourceChain,
    sourceNonce: event.sourceNonce,
    // The claim's own timestamp, which this event carries and the EVM one does not.
    createdAt: new Date(Number(event.createdAt) * 1000),
  });
}

export function recordClaimSettled(
  db: Queryable,
  context: EventContext,
  event: ClaimSettledEvent,
): Promise<boolean> {
  return settleClaim(db, positionOf(context), event.claimId, event.settledBy);
}

export async function recordActionQueued(
  db: Queryable,
  context: EventContext,
  event: ActionQueuedEvent,
  payload: unknown,
): Promise<void> {
  await writeAction(db, positionOf(context), {
    actionId: event.id,
    // Zero, because `AdminAction` is a union with payload variants and the wire carries the
    // variant name rather than an ordinal. The name goes in the payload, where a reviewer reads
    // what the chain said rather than what a decoder made of it.
    kind: 0,
    payload: { variant: event.variant, action: payload },
    eta: new Date(Number(event.eta) * 1000),
    expiresAt: new Date(Number(event.expiresAt) * 1000),
  });
}

export function recordActionSettled(
  db: Queryable,
  context: EventContext,
  event: ActionLifecycleEvent,
  state: "executed" | "cancelled",
): Promise<boolean> {
  return settleAction(db, positionOf(context), event.id, state, event.actor);
}

/**
 * Note that a token is registered, as a route health sample rather than as its own table.
 *
 * There is no token table on purpose. The router is the authority on what it will carry and an app
 * reads that from the chain, so a copy here would be a second answer that goes stale the moment a
 * guardian lowers a limit. What is worth keeping is that the registration happened and when.
 */
export async function recordTokenRegistered(
  db: Queryable,
  context: EventContext,
  event: TokenRegisteredEvent,
): Promise<void> {
  await writeHealthSample(db, positionOf(context), {
    originChain: context.chainKey,
    destinationChain: context.chainKey,
    route: 0,
    token: event.token,
    available: event.enabled,
    blocker: 0,
    flowAvailable: event.flowLimit,
  });
}

/**
 * A pause, recorded as every rail becoming unavailable.
 *
 * There is no pause table, and adding one would mean a second place to look during the exact
 * incident where somebody is already looking at route health. So a pause writes one sample per
 * rail with the blocker the router itself would return, which puts it in the same view as every
 * other reason a transfer will not go through.
 *
 * Pause stops departures and not arrivals, which is why this says nothing about inbound deliveries.
 */
export async function recordPauseSet(
  db: Queryable,
  context: EventContext,
  event: PauseSetEvent,
): Promise<void> {
  const at = positionOf(context);
  for (const route of ROUTE_KINDS) {
    await writeHealthSample(db, at, {
      originChain: context.chainKey,
      destinationChain: context.chainKey,
      route,
      token: context.chainKey,
      available: !event.paused,
      // QuoteBlocker.Paused is 1, and zero when nothing is blocking.
      blocker: event.paused ? 1 : 0,
      flowAvailable: null,
    });
  }
}

export async function recordRouteConfigured(
  db: Queryable,
  context: EventContext,
  event: RouteConfiguredEvent,
  token: string,
): Promise<void> {
  await writeHealthSample(db, positionOf(context), {
    originChain: context.chainKey,
    destinationChain: context.chainKey,
    route: event.route,
    token,
    available: event.enabled,
    // QuoteBlocker.RouteDisabled is 2. Zero when the route is on.
    blocker: event.enabled ? 0 : 2,
    flowAvailable: null,
  });
}
