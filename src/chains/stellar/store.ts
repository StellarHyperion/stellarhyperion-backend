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
import { createHash } from "node:crypto";

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
import { endOfLedgerCursor } from "./cursor.js";
import type {
  ActionLifecycleEvent,
  ActionQueuedEvent,
  BridgeInEvent,
  BridgeOutEvent,
  ClaimParkedEvent,
  ClaimSettledEvent,
  PauseSetEvent,
  RawStellarEvent,
  RouteConfiguredEvent,
  StellarEvent,
  TokenRegisteredEvent,
} from "./events.js";
import type { RetainedHistoryWindow } from "./rpc.js";

/** Where a watcher has read up to. */
export interface ChainCursor {
  readonly position: bigint;
  readonly contract: string;
  readonly observedAt: Date | null;
  /** EVM only. Null on Stellar, where a closed ledger cannot change. */
  readonly hash: string | null;
  /** Monotonic revision for compare-and-swap cursor updates. */
  readonly revision: bigint;
  readonly deploymentRevision: number;
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
    `SELECT last_processed, contract, last_processed_at, last_processed_hash, revision, deployment_revision
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
    deploymentRevision: Number(row.deployment_revision ?? 1),
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
    readonly deploymentRevision?: number;
    readonly expectedContract?: string;
    readonly expectedDeploymentRevision?: number;
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
         (chain_key, family, contract, last_processed, last_processed_at, last_processed_hash, revision, deployment_revision)
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7)
       ON CONFLICT (chain_key) DO UPDATE
         SET contract = EXCLUDED.contract,
             family = EXCLUDED.family,
             last_processed = EXCLUDED.last_processed,
             last_processed_at = EXCLUDED.last_processed_at,
             last_processed_hash = EXCLUDED.last_processed_hash,
             revision = indexer_cursor.revision + 1,
             deployment_revision = EXCLUDED.deployment_revision,
             updated_at = now()`,
      [...baseParams, entry.deploymentRevision ?? 1],
    );
    return;
  }

  if (entry.expectedRevision === null) {
    const result = await db.query(
      `INSERT INTO indexer_cursor
         (chain_key, family, contract, last_processed, last_processed_at, last_processed_hash, revision, deployment_revision)
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7)
       ON CONFLICT (chain_key) DO NOTHING
       RETURNING revision`,
      [...baseParams, entry.deploymentRevision ?? 1],
    );
    if (result.rowCount === 0) {
      throw new StaleCursorError(entry.chainKey, null);
    }
    return;
  }

  const result = await db.query(
    `UPDATE indexer_cursor
       SET family = $2, contract = $3, last_processed = $4,
           last_processed_at = $5, last_processed_hash = $6,
           revision = revision + 1, deployment_revision = $8, updated_at = now()
     WHERE chain_key = $1 AND revision = $7 AND contract = $9
       AND deployment_revision = $10
       AND (($8 = deployment_revision AND contract = $3 AND last_processed <= $4)
            OR $8 > deployment_revision)
     RETURNING revision`,
    [
      ...baseParams,
      entry.expectedRevision.toString(),
      entry.deploymentRevision ?? 1,
      entry.expectedContract ?? entry.contract,
      entry.expectedDeploymentRevision ?? entry.deploymentRevision ?? 1,
    ],
  );
  if (result.rowCount === 0) {
    throw new StaleCursorError(entry.chainKey, entry.expectedRevision);
  }
}

const MAX_QUARANTINE_RAW_BYTES = 16_384;

/** Record a watched Stellar deployment revision transition for auditability. */
export async function recordDeploymentRevision(
  db: Queryable,
  entry: {
    readonly chainKey: string;
    readonly deploymentRevision: number;
    readonly contract: string;
    readonly startLedger: bigint;
    readonly previousContract: string | null;
    readonly previousCursor: bigint | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO stellar_deployment_revision
       (chain_key, deployment_revision, contract, start_ledger, previous_contract, previous_cursor)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (chain_key, deployment_revision) DO NOTHING`,
    [
      entry.chainKey,
      entry.deploymentRevision,
      entry.contract,
      entry.startLedger.toString(),
      entry.previousContract,
      entry.previousCursor === null ? null : entry.previousCursor.toString(),
    ],
  );
}

function boundRawEventJson(raw: RawStellarEvent): string {
  const serialized = JSON.stringify(raw, (_key, value: unknown) => {
    if (/secret|password|authorization|credential|private.?key|access.?token/i.test(_key))
      return "[redacted]";
    return typeof value === "bigint" ? value.toString() : value;
  });
  if (Buffer.byteLength(serialized, "utf8") <= MAX_QUARANTINE_RAW_BYTES) return serialized;
  // Oversized payloads must be fetched again from their source position; a partial preview
  // cannot be replayed and can expose arbitrary attacker-controlled data.
  return JSON.stringify({
    truncated: true,
    byteLength: Buffer.byteLength(serialized, "utf8"),
    id: raw.id,
    type: raw.type,
    ledger: raw.ledger,
    ledgerClosedAt: raw.ledgerClosedAt,
    contractId: raw.contractId,
    txHash: raw.txHash,
    transactionIndex: raw.transactionIndex,
    operationIndex: raw.operationIndex,
  });
}
export function boundDecodeError(error: string | null): string | null {
  if (error === null) return null;
  // Decoder errors may embed raw ScVal content. Keep a diagnostic category only.
  return (
    error
      .split(":", 1)[0]
      ?.replace(/[^a-zA-Z0-9 _.-]/g, "?")
      .slice(0, 128) ?? "decode failed"
  );
}

/**
 * Persist an unknown or undecodable raw Soroban event with its exact source position so offline
 * decoder replay can reprocess it without losing ledger position.
 */
export async function recordQuarantinedEvent(
  db: Queryable,
  entry: {
    readonly chainKey: string;
    readonly contract: string;
    readonly deploymentRevision: number;
    readonly raw: RawStellarEvent;
    readonly reason: "unknown_tag" | "decode_error";
    readonly tag: string | null;
    readonly decodeError: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO stellar_event_quarantine
       (chain_key, contract, deployment_revision, event_id, ledger, tx_hash, tx_index, op_index,
        ledger_closed_at, reason, tag, decode_error, raw_event)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
     ON CONFLICT (chain_key, contract, deployment_revision, event_id) DO UPDATE
       SET contract = EXCLUDED.contract,
           deployment_revision = EXCLUDED.deployment_revision,
           reason = EXCLUDED.reason,
           tag = EXCLUDED.tag,
           decode_error = EXCLUDED.decode_error,
           raw_event = EXCLUDED.raw_event,
           updated_at = now()`,
    [
      entry.chainKey,
      entry.contract,
      entry.deploymentRevision,
      entry.raw.id,
      String(entry.raw.ledger),
      entry.raw.txHash,
      entry.raw.transactionIndex,
      entry.raw.operationIndex,
      new Date(entry.raw.ledgerClosedAt),
      entry.reason,
      entry.tag,
      boundDecodeError(entry.decodeError),
      boundRawEventJson(entry.raw),
    ],
  );
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
              ELSE clock_timestamp() + ($4 * interval '1 millisecond')
            END,
            updated_at = clock_timestamp()
      WHERE chain_key = $1
        AND contract = $2
        AND owner_id = $3
        AND lease_until > clock_timestamp()
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
    [gap.chainKey, gap.contract, String(gap.startLedger), String(gap.endLedger), gap.reason],
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
  readonly router: string;
  readonly ledger: number;
  readonly txHash: string;
  readonly closedAt: Date;
}

function positionOf(context: EventContext): Position {
  return {
    chainKey: context.chainKey,
    router: context.router,
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

export interface EventEvidenceSnapshot {
  readonly eventId: string;
  readonly ledger: number;
  readonly txHash: string;
  readonly contractId: string;
  readonly payload: Record<string, unknown>;
}

export interface EventIdentityConflict {
  readonly identity: string;
  readonly detectedAt: Date;
  readonly existing: EventEvidenceSnapshot;
  readonly incoming: EventEvidenceSnapshot;
  readonly differingFields: readonly string[];
}

/**
 * Canonical identity keys for a Soroban event.
 *
 * Every event has its RPC event id (`event:<chain>:<id>`). Events that map onto a unique natural
 * key in the shared tables also carry that semantic identity so two distinct events claiming the
 * same transfer, claim, or action are detected even if their RPC event ids differ.
 */
export function canonicalEventIdentities(
  chainKey: string,
  raw: RawStellarEvent,
  decoded: StellarEvent,
): readonly string[] {
  const keys = [`event:${chainKey}:${raw.id}`];
  switch (decoded.kind) {
    case "bridgeOut":
      keys.push(`bridgeOut:${chainKey}:${decoded.data.nonce.toString()}`);
      break;
    case "bridgeIn":
      keys.push(
        `bridgeIn:${chainKey}:${String(decoded.data.route)}:${decoded.data.sourceChain}:${decoded.data.sourceNonce.toString()}`,
      );
      break;
    case "claimParked":
      keys.push(`claimParked:${chainKey}:${decoded.data.claimId.toString()}`);
      break;
    case "claimSettled":
      keys.push(`claimSettled:${chainKey}:${decoded.data.claimId.toString()}`);
      break;
    case "actionQueued":
      keys.push(`actionQueued:${chainKey}:${decoded.data.id.toString()}`);
      break;
    case "actionExecuted":
      keys.push(`actionExecuted:${chainKey}:${decoded.data.id.toString()}`);
      break;
    case "actionCancelled":
      keys.push(`actionCancelled:${chainKey}:${decoded.data.id.toString()}`);
      break;
    case "tokenRegistered":
    case "routeConfigured":
    case "pauseSet":
    case "ignored":
    case "unknown":
      break;
  }
  return keys;
}

/** Normalize any `bigint` values to integer strings so canonical comparisons never lose precision. */
function normalizeValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = normalizeValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalEventPayload(
  raw: RawStellarEvent,
  decoded: StellarEvent,
): Record<string, unknown> {
  const canonical = JSON.stringify({
    kind: decoded.kind,
    data: "data" in decoded ? normalizeValue(decoded.data) : null,
    topicJson: normalizeValue(raw.topicJson),
    valueJson: normalizeValue(raw.valueJson),
  });
  return { kind: decoded.kind, sha256: createHash("sha256").update(canonical).digest("hex") };
}

function findDifferingFields(
  existing: EventEvidenceSnapshot,
  incoming: EventEvidenceSnapshot,
): string[] {
  const diffs: string[] = [];
  if (existing.ledger !== incoming.ledger) diffs.push("ledger");
  if (existing.txHash !== incoming.txHash) diffs.push("txHash");
  if (existing.contractId !== incoming.contractId) diffs.push("contractId");
  if (JSON.stringify(existing.payload) !== JSON.stringify(incoming.payload)) {
    diffs.push("payload");
  }
  return diffs;
}

/**
 * Detects two distinct payloads claiming the same canonical event identity and retains
 * reconciliation evidence. Identical replays (e.g. from mid-ledger restarts) are not conflicts.
 */
export class EventConflictDetector {
  private readonly seen = new Map<string, EventEvidenceSnapshot>();
  private readonly recorded: EventIdentityConflict[] = [];

  get conflicts(): readonly EventIdentityConflict[] {
    return this.recorded;
  }

  inspect(
    chainKey: string,
    raw: RawStellarEvent,
    decoded: StellarEvent,
    now: Date = new Date(),
  ): EventIdentityConflict | null {
    const identities = canonicalEventIdentities(chainKey, raw, decoded);
    const incoming: EventEvidenceSnapshot = {
      eventId: raw.id,
      ledger: raw.ledger,
      txHash: raw.txHash,
      contractId: raw.contractId,
      payload: canonicalEventPayload(raw, decoded),
    };

    for (const identity of identities) {
      const existing = this.seen.get(identity);
      if (existing === undefined) continue;
      const differingFields = findDifferingFields(existing, incoming);
      if (differingFields.length > 0) {
        const conflict: EventIdentityConflict = {
          identity,
          detectedAt: now,
          existing,
          incoming,
          differingFields,
        };
        this.recorded.push(conflict);
        return conflict;
      }
    }

    for (const identity of identities) {
      if (!this.seen.has(identity)) {
        this.seen.set(identity, incoming);
      }
    }
    return null;
  }
}

/** Persist identities in the same transaction as event application. Concurrent replays
 * serialize on the unique key; a rollback cannot poison later conflict detection. */
export async function inspectEventConflict(
  db: Queryable,
  chainKey: string,
  raw: RawStellarEvent,
  decoded: StellarEvent,
): Promise<EventIdentityConflict | null> {
  const incoming: EventEvidenceSnapshot = {
    eventId: raw.id,
    ledger: raw.ledger,
    txHash: raw.txHash,
    contractId: raw.contractId,
    payload: canonicalEventPayload(raw, decoded),
  };
  for (const identity of canonicalEventIdentities(chainKey, raw, decoded)) {
    await db.query(
      `INSERT INTO stellar_event_identity (chain_key, contract, identity, evidence)
      VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING`,
      [chainKey, raw.contractId, identity, JSON.stringify(incoming)],
    );
    const { rows } = await db.query(
      `SELECT evidence FROM stellar_event_identity
      WHERE chain_key = $1 AND identity = $3 AND (contract = $2 OR (identity NOT LIKE 'event:%' AND identity NOT LIKE 'bridgeOut:%')) FOR UPDATE`,
      [chainKey, raw.contractId, identity],
    );
    const existing = rows[0]?.evidence as EventEvidenceSnapshot | undefined;
    if (existing === undefined) throw new Error("missing durable event identity");
    const differingFields = findDifferingFields(existing, incoming);
    if (differingFields.length === 0) continue;
    const conflict: EventIdentityConflict = {
      identity,
      existing,
      incoming,
      differingFields,
      detectedAt: new Date(),
    };
    await db.query(
      `INSERT INTO stellar_event_conflict
      (chain_key, contract, identity, incoming_digest, evidence)
      VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT DO NOTHING`,
      [chainKey, raw.contractId, identity, incoming.payload.sha256, JSON.stringify(conflict)],
    );
    return conflict;
  }
  return null;
}

export async function persistScanJournal(
  db: Queryable,
  contract: string,
  journal: unknown,
): Promise<void> {
  const entry = journal as { chainKey: string };
  await db.query(
    `INSERT INTO stellar_scan_journal (chain_key, contract, journal)
    VALUES ($1, $2, $3::jsonb)`,
    [entry.chainKey, contract, JSON.stringify(journal)],
  );
}

export type CursorRepairAction =
  | "noop"
  | "initialize_cursor"
  | "advance_cursor"
  | "rewind_cursor"
  | "reset_cursor"
  | "backfill_required";

export interface VerifiedLedgerBoundary {
  readonly ledger: number;
  /** First ledger proved complete by this range, inclusive. */
  readonly from?: number;
  readonly cursor: string;
  readonly source: "journal" | "verified_boundary";
}

export interface CursorRepairPlanInput {
  readonly chainKey: string;
  readonly expectedContract: string;
  readonly startLedger: number;
  readonly currentCursor: ChainCursor | null;
  readonly retainedHistory: RetainedHistoryWindow | null;
  readonly verifiedBoundaries: readonly VerifiedLedgerBoundary[];
  readonly conflicts: readonly EventIdentityConflict[];
}

export interface CursorRepairProposal {
  readonly unsigned: true;
  readonly readOnly: true;
  readonly chainKey: string;
  readonly action: CursorRepairAction;
  readonly currentPosition: string | null;
  readonly proposedPosition: string | null;
  readonly proposedRpcCursor: string | null;
  readonly blockedByConflicts: boolean;
  readonly conflictCount: number;
  readonly gap: { readonly from: number; readonly to: number } | null;
  readonly sql: string | null;
  readonly params: readonly unknown[];
  readonly rationale: string;
  readonly warnings: readonly string[];
  readonly evidence: {
    readonly retainedHistory: RetainedHistoryWindow | null;
    readonly highestVerifiedLedger: number | null;
  };
}

/**
 * Generate an unsigned, read-only database repair proposal from verified completed ledger
 * boundaries and retained-history evidence. Never executes or signs database writes.
 */
export function planCursorRepair(input: CursorRepairPlanInput): CursorRepairProposal {
  const {
    chainKey,
    expectedContract,
    startLedger,
    currentCursor,
    retainedHistory,
    verifiedBoundaries,
    conflicts,
  } = input;

  // A later boundary alone cannot bridge an unverified earlier gap.
  let covered =
    currentCursor?.contract === expectedContract ? Number(currentCursor.position) : startLedger - 1;
  let highestVerified: number | null = null;
  for (const boundary of [...verifiedBoundaries].sort((a, b) => a.ledger - b.ledger)) {
    if (
      !Number.isSafeInteger(boundary.from) ||
      !Number.isSafeInteger(boundary.ledger) ||
      boundary.from === undefined ||
      boundary.from < 1 ||
      boundary.from > boundary.ledger ||
      boundary.cursor !== endOfLedgerCursor(boundary.ledger)
    )
      continue;
    if (boundary.from <= covered + 1 && boundary.ledger > covered) {
      covered = boundary.ledger;
      highestVerified = covered;
    }
  }

  const warnings: string[] = [];
  if (conflicts.length > 0) {
    warnings.push(
      `${String(conflicts.length)} event identity conflict(s) detected; reconcile before applying cursor changes`,
    );
  }
  const blockedByConflicts = conflicts.length > 0;
  const baseEvidence = { retainedHistory, highestVerifiedLedger: highestVerified };

  if (currentCursor !== null && currentCursor.contract !== expectedContract) {
    return {
      unsigned: true,
      readOnly: true,
      chainKey,
      action: "reset_cursor",
      currentPosition: currentCursor.position.toString(),
      proposedPosition: null,
      proposedRpcCursor: null,
      blockedByConflicts,
      conflictCount: conflicts.length,
      gap: null,
      sql: "DELETE FROM indexer_cursor WHERE chain_key = $1 AND contract = $2 AND last_processed = $3 AND revision = $4 AND deployment_revision = $5",
      params: [
        chainKey,
        currentCursor.contract,
        currentCursor.position.toString(),
        currentCursor.revision.toString(),
        currentCursor.deploymentRevision,
      ],
      rationale: `stored cursor belongs to contract ${currentCursor.contract}, not expected router ${expectedContract}`,
      warnings,
      evidence: baseEvidence,
    };
  }

  if (currentCursor === null) {
    if (highestVerified !== null) {
      return {
        unsigned: true,
        readOnly: true,
        chainKey,
        action: "initialize_cursor",
        currentPosition: null,
        proposedPosition: String(highestVerified),
        proposedRpcCursor: endOfLedgerCursor(highestVerified),
        blockedByConflicts,
        conflictCount: conflicts.length,
        gap: null,
        sql: `INSERT INTO indexer_cursor (chain_key, family, contract, last_processed, last_processed_at, last_processed_hash)
VALUES ($1, 'stellar', $2, $3, NULL, NULL)
ON CONFLICT (chain_key) DO NOTHING`,
        params: [chainKey, expectedContract, String(highestVerified)],
        rationale: `no cursor row exists; initialize from verified completed ledger boundary ${String(highestVerified)}`,
        warnings,
        evidence: baseEvidence,
      };
    }
    if (retainedHistory !== null && startLedger < retainedHistory.oldestLedger) {
      return {
        unsigned: true,
        readOnly: true,
        chainKey,
        action: "backfill_required",
        currentPosition: null,
        proposedPosition: null,
        proposedRpcCursor: null,
        blockedByConflicts,
        conflictCount: conflicts.length,
        gap: { from: startLedger, to: retainedHistory.oldestLedger - 1 },
        sql: null,
        params: [],
        rationale: `configured startLedger ${String(startLedger)} is older than retained history (${String(retainedHistory.oldestLedger)}) with no verified boundary`,
        warnings: [...warnings, "archive backfill is required to cover ledgers below oldestLedger"],
        evidence: baseEvidence,
      };
    }
    return {
      unsigned: true,
      readOnly: true,
      chainKey,
      action: "noop",
      currentPosition: null,
      proposedPosition: null,
      proposedRpcCursor: null,
      blockedByConflicts,
      conflictCount: conflicts.length,
      gap: null,
      sql: null,
      params: [],
      rationale: "no cursor row exists yet and startLedger is within retained history",
      warnings,
      evidence: baseEvidence,
    };
  }

  const currentPos = Number(currentCursor.position);

  if (retainedHistory !== null && currentPos > retainedHistory.latestLedger) {
    if (highestVerified !== null && highestVerified <= retainedHistory.latestLedger) {
      return {
        unsigned: true,
        readOnly: true,
        chainKey,
        action: "rewind_cursor",
        currentPosition: currentCursor.position.toString(),
        proposedPosition: String(highestVerified),
        proposedRpcCursor: endOfLedgerCursor(highestVerified),
        blockedByConflicts,
        conflictCount: conflicts.length,
        gap: null,
        sql: `UPDATE indexer_cursor
   SET last_processed = $1, revision = revision + 1, updated_at = now()
 WHERE chain_key = $2 AND contract = $3 AND last_processed = $4 AND revision = $5 AND deployment_revision = $6`,
        params: [
          String(highestVerified),
          chainKey,
          expectedContract,
          currentCursor.position.toString(),
          currentCursor.revision.toString(),
          currentCursor.deploymentRevision,
        ],
        rationale: `cursor ${currentCursor.position.toString()} exceeds latest retained ledger ${String(retainedHistory.latestLedger)}; rewind to verified boundary ${String(highestVerified)}`,
        warnings,
        evidence: baseEvidence,
      };
    }
    return {
      unsigned: true,
      readOnly: true,
      chainKey,
      action: "backfill_required",
      currentPosition: currentCursor.position.toString(),
      proposedPosition: null,
      proposedRpcCursor: null,
      blockedByConflicts,
      conflictCount: conflicts.length,
      gap: null,
      sql: null,
      params: [],
      rationale: `cursor ${currentCursor.position.toString()} exceeds latest retained ledger ${String(retainedHistory.latestLedger)} and no verified fallback boundary exists`,
      warnings: [...warnings, "manual verification required before rewinding cursor"],
      evidence: baseEvidence,
    };
  }

  if (retainedHistory !== null && currentPos + 1 < retainedHistory.oldestLedger) {
    if (
      highestVerified !== null &&
      highestVerified >= retainedHistory.oldestLedger - 1 &&
      highestVerified > currentPos
    ) {
      return {
        unsigned: true,
        readOnly: true,
        chainKey,
        action: "advance_cursor",
        currentPosition: currentCursor.position.toString(),
        proposedPosition: String(highestVerified),
        proposedRpcCursor: endOfLedgerCursor(highestVerified),
        blockedByConflicts,
        conflictCount: conflicts.length,
        gap: null,
        sql: `UPDATE indexer_cursor
   SET last_processed = $1, revision = revision + 1, updated_at = now()
 WHERE chain_key = $2 AND contract = $3 AND last_processed = $4 AND revision = $5 AND deployment_revision = $6`,
        params: [
          String(highestVerified),
          chainKey,
          expectedContract,
          currentCursor.position.toString(),
          currentCursor.revision.toString(),
          currentCursor.deploymentRevision,
        ],
        rationale: `cursor ${currentCursor.position.toString()} fell behind retention (${String(retainedHistory.oldestLedger)}), but verified boundary ${String(highestVerified)} bridges the gap`,
        warnings,
        evidence: baseEvidence,
      };
    }
    return {
      unsigned: true,
      readOnly: true,
      chainKey,
      action: "backfill_required",
      currentPosition: currentCursor.position.toString(),
      proposedPosition: null,
      proposedRpcCursor: null,
      blockedByConflicts,
      conflictCount: conflicts.length,
      gap: { from: currentPos + 1, to: retainedHistory.oldestLedger - 1 },
      sql: null,
      params: [],
      rationale: `ledgers ${String(currentPos + 1)}..${String(retainedHistory.oldestLedger - 1)} fell outside provider retention with no verified completion evidence`,
      warnings: [
        ...warnings,
        "archive backfill is required; advancing past an unverified gap would drop history",
      ],
      evidence: baseEvidence,
    };
  }

  if (highestVerified !== null && highestVerified > currentPos) {
    return {
      unsigned: true,
      readOnly: true,
      chainKey,
      action: "advance_cursor",
      currentPosition: currentCursor.position.toString(),
      proposedPosition: String(highestVerified),
      proposedRpcCursor: endOfLedgerCursor(highestVerified),
      blockedByConflicts,
      conflictCount: conflicts.length,
      gap: null,
      sql: `UPDATE indexer_cursor
   SET last_processed = $1, revision = revision + 1, updated_at = now()
 WHERE chain_key = $2 AND contract = $3 AND last_processed = $4 AND revision = $5 AND deployment_revision = $6`,
      params: [
        String(highestVerified),
        chainKey,
        expectedContract,
        currentCursor.position.toString(),
        currentCursor.revision.toString(),
        currentCursor.deploymentRevision,
      ],
      rationale: `verified completed ledger boundary ${String(highestVerified)} is ahead of stored cursor ${currentCursor.position.toString()}`,
      warnings,
      evidence: baseEvidence,
    };
  }

  return {
    unsigned: true,
    readOnly: true,
    chainKey,
    action: "noop",
    currentPosition: currentCursor.position.toString(),
    proposedPosition: null,
    proposedRpcCursor: null,
    blockedByConflicts,
    conflictCount: conflicts.length,
    gap: null,
    sql: null,
    params: [],
    rationale: "cursor is consistent with retained history and verified boundaries",
    warnings,
    evidence: baseEvidence,
  };
}

/**
 * Read-only wrapper that inspects `indexer_cursor` in `db` and generates an unsigned repair
 * proposal without performing any writes.
 */
export async function planCursorRepairFromDb(
  db: Queryable,
  input: Omit<CursorRepairPlanInput, "currentCursor">,
): Promise<CursorRepairProposal> {
  const currentCursor = await readCursor(db, input.chainKey);
  return planCursorRepair({ ...input, currentCursor });
}
