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
  maybeOne,
  one,
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
}

export async function readCursor(db: Queryable, chainKey: string): Promise<ChainCursor | null> {
  const { rows } = await db.query(
    `SELECT last_processed, contract, last_processed_at, last_processed_hash
       FROM indexer_cursor WHERE chain_key = $1`,
    [chainKey],
  );
  const row = maybeOne(rows, `cursor for ${chainKey}`);
  if (row === null) return null;
  return {
    position: bigintOf(row, "last_processed"),
    contract: text(row, "contract"),
    observedAt: timestampOrNull(row, "last_processed_at"),
    hash: textOrNull(row, "last_processed_hash"),
  };
}

/**
 * Advance the cursor, or create it.
 *
 * The contract is part of the write rather than just the read. A redeployed router at a new address
 * shares no history with the old one, so a cursor carried across would skip everything the new one
 * has ever done, silently. Storing it means the watcher can notice.
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
  },
): Promise<void> {
  await db.query(
    `INSERT INTO indexer_cursor
       (chain_key, family, contract, last_processed, last_processed_at, last_processed_hash)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (chain_key) DO UPDATE
       SET contract = EXCLUDED.contract,
           family = EXCLUDED.family,
           last_processed = EXCLUDED.last_processed,
           last_processed_at = EXCLUDED.last_processed_at,
           last_processed_hash = EXCLUDED.last_processed_hash,
           updated_at = now()`,
    [
      entry.chainKey,
      entry.family,
      entry.contract,
      entry.position.toString(),
      entry.observedAt,
      entry.hash,
    ],
  );
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

export type BackfillJobStatus = "pending" | "running" | "completed" | "unresolved";

export interface StellarBackfillJob {
  readonly id: bigint;
  readonly chainKey: string;
  readonly contract: string;
  readonly fromLedger: bigint;
  readonly toLedger: bigint;
  readonly completedLedger: bigint | null;
  readonly resumeCursor: string | null;
  readonly status: BackfillJobStatus;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
}

const BACKFILL_STATUSES: readonly BackfillJobStatus[] = [
  "pending",
  "running",
  "completed",
  "unresolved",
];

function parseBackfillStatus(raw: string): BackfillJobStatus {
  if ((BACKFILL_STATUSES as readonly string[]).includes(raw)) {
    return raw as BackfillJobStatus;
  }
  throw new Error(`stellar_backfill_job.status holds unexpected value ${raw}`);
}

function mapBackfillJobRow(row: Record<string, unknown>): StellarBackfillJob {
  return {
    id: bigintOf(row, "id"),
    chainKey: text(row, "chain_key"),
    contract: text(row, "contract"),
    fromLedger: bigintOf(row, "from_ledger"),
    toLedger: bigintOf(row, "to_ledger"),
    completedLedger: bigintOrNull(row, "completed_ledger"),
    resumeCursor: textOrNull(row, "resume_cursor"),
    status: parseBackfillStatus(text(row, "status")),
    lastError: textOrNull(row, "last_error"),
    createdAt: timestamp(row, "created_at"),
    updatedAt: timestamp(row, "updated_at"),
    completedAt: timestampOrNull(row, "completed_at"),
  };
}

export async function enqueueBackfillJob(
  db: Queryable,
  input: {
    readonly chainKey: string;
    readonly contract: string;
    readonly fromLedger: bigint;
    readonly toLedger: bigint;
  },
): Promise<StellarBackfillJob> {
  if (input.fromLedger < 1n || input.toLedger < input.fromLedger) {
    throw new RangeError(
      `backfill job bounds must satisfy 1 <= fromLedger <= toLedger, got ${input.fromLedger.toString()}..${input.toLedger.toString()}`,
    );
  }
  const { rows } = await db.query(
    `INSERT INTO stellar_backfill_job (chain_key, contract, from_ledger, to_ledger, status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (chain_key, contract, from_ledger, to_ledger) DO UPDATE
       SET status = CASE
             WHEN stellar_backfill_job.status = 'completed' THEN 'completed'
             ELSE 'pending'
           END,
           last_error = CASE
             WHEN stellar_backfill_job.status = 'completed' THEN stellar_backfill_job.last_error
             ELSE NULL
           END,
           updated_at = now()
     RETURNING id, chain_key, contract, from_ledger, to_ledger, completed_ledger,
               resume_cursor, status, last_error, created_at, updated_at, completed_at`,
    [input.chainKey, input.contract, input.fromLedger.toString(), input.toLedger.toString()],
  );
  return mapBackfillJobRow(one(rows, "enqueued stellar_backfill_job"));
}

export async function readBackfillJob(
  db: Queryable,
  jobId: bigint,
): Promise<StellarBackfillJob | null> {
  const { rows } = await db.query(
    `SELECT id, chain_key, contract, from_ledger, to_ledger, completed_ledger,
            resume_cursor, status, last_error, created_at, updated_at, completed_at
       FROM stellar_backfill_job
      WHERE id = $1`,
    [jobId.toString()],
  );
  const row = maybeOne(rows, `stellar_backfill_job ${jobId.toString()}`);
  return row === null ? null : mapBackfillJobRow(row);
}

export async function listBackfillJobs(
  db: Queryable,
  options: {
    readonly chainKey?: string;
    readonly contract?: string;
    readonly statuses?: readonly BackfillJobStatus[];
  } = {},
): Promise<readonly StellarBackfillJob[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.chainKey !== undefined) {
    params.push(options.chainKey);
    clauses.push(`chain_key = $${String(params.length)}`);
  }
  if (options.contract !== undefined) {
    params.push(options.contract);
    clauses.push(`contract = $${String(params.length)}`);
  }
  if (options.statuses !== undefined && options.statuses.length > 0) {
    params.push([...options.statuses]);
    clauses.push(`status = ANY($${String(params.length)}::text[])`);
  }

  const whereSql = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
  const { rows } = await db.query(
    `SELECT id, chain_key, contract, from_ledger, to_ledger, completed_ledger,
            resume_cursor, status, last_error, created_at, updated_at, completed_at
       FROM stellar_backfill_job
       ${whereSql}
      ORDER BY from_ledger, id`,
    params,
  );
  return rows.map(mapBackfillJobRow);
}

export async function saveBackfillProgress(
  db: Queryable,
  input: {
    readonly jobId: bigint;
    readonly toLedger: bigint;
    readonly completedLedger: bigint;
    readonly resumeCursor: string;
  },
): Promise<BackfillJobStatus> {
  if (input.completedLedger >= input.toLedger) {
    await db.query(
      `UPDATE stellar_backfill_job
          SET status = 'completed',
              completed_ledger = $2,
              resume_cursor = $3,
              last_error = NULL,
              completed_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [input.jobId.toString(), input.toLedger.toString(), input.resumeCursor],
    );
    return "completed";
  }

  await db.query(
    `UPDATE stellar_backfill_job
        SET status = 'running',
            completed_ledger = GREATEST(
              COALESCE(completed_ledger, from_ledger),
              $2::numeric(20, 0)
            ),
            resume_cursor = $3,
            last_error = NULL,
            completed_at = NULL,
            updated_at = now()
      WHERE id = $1 AND status <> 'completed'`,
    [input.jobId.toString(), input.completedLedger.toString(), input.resumeCursor],
  );
  return "running";
}

export async function markBackfillUnresolved(
  db: Queryable,
  jobId: bigint,
  reason: string,
): Promise<void> {
  await db.query(
    `UPDATE stellar_backfill_job
        SET status = 'unresolved',
            last_error = $2,
            completed_at = NULL,
            updated_at = now()
      WHERE id = $1 AND status <> 'completed'`,
    [jobId.toString(), reason],
  );
}
