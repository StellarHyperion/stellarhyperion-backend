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
  text,
  textOrNull,
  timestamp,
  timestampOrNull,
} from "../../db/rows.js";
import { ledgerSpanCount, unreconciledStartLedger } from "./cursor.js";
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

export type HistoryGapStatus = "open" | "reconciling" | "closed";

export interface StellarHistoryGap {
  readonly id: bigint;
  readonly chainKey: string;
  readonly contract: string;
  readonly fromLedger: bigint;
  readonly toLedger: bigint;
  readonly reconciledThrough: bigint | null;
  readonly status: HistoryGapStatus;
  readonly reason: string;
  readonly detectedAt: Date;
  readonly reconciledAt: Date | null;
}

export interface HistoryCoverageSummary {
  readonly complete: boolean;
  readonly openGaps: number;
  readonly reconcilingGaps: number;
  readonly closedGaps: number;
  readonly missingLedgers: bigint;
  readonly gaps: readonly StellarHistoryGap[];
}

const GAP_STATUSES: readonly HistoryGapStatus[] = ["open", "reconciling", "closed"];

function parseGapStatus(raw: string): HistoryGapStatus {
  if ((GAP_STATUSES as readonly string[]).includes(raw)) {
    return raw as HistoryGapStatus;
  }
  throw new Error(`stellar_history_gap.status holds unexpected value ${raw}`);
}

function mapHistoryGapRow(row: Record<string, unknown>): StellarHistoryGap {
  return {
    id: bigintOf(row, "id"),
    chainKey: text(row, "chain_key"),
    contract: text(row, "contract"),
    fromLedger: bigintOf(row, "from_ledger"),
    toLedger: bigintOf(row, "to_ledger"),
    reconciledThrough: bigintOrNull(row, "reconciled_through"),
    status: parseGapStatus(text(row, "status")),
    reason: text(row, "reason"),
    detectedAt: timestamp(row, "detected_at"),
    reconciledAt: timestampOrNull(row, "reconciled_at"),
  };
}

export function remainingGapLedgers(
  gap: Pick<StellarHistoryGap, "fromLedger" | "toLedger" | "reconciledThrough" | "status">,
): bigint {
  if (gap.status === "closed") return 0n;
  const start = unreconciledStartLedger(gap.fromLedger, gap.reconciledThrough);
  return ledgerSpanCount(start, gap.toLedger);
}

export async function recordHistoryGap(
  db: Queryable,
  gap: {
    readonly chainKey: string;
    readonly contract: string;
    readonly fromLedger: bigint;
    readonly toLedger: bigint;
    readonly reason: string;
  },
): Promise<void> {
  if (gap.fromLedger < 0n || gap.toLedger < gap.fromLedger) {
    throw new RangeError(
      `history gap bounds must satisfy 0 <= fromLedger <= toLedger, got ${gap.fromLedger.toString()}..${gap.toLedger.toString()}`,
    );
  }
  await db.query(
    `INSERT INTO stellar_history_gap
       (chain_key, contract, from_ledger, to_ledger, status, reason)
     VALUES ($1, $2, $3, $4, 'open', $5)
     ON CONFLICT (chain_key, contract, from_ledger, to_ledger) DO UPDATE
       SET reason = EXCLUDED.reason,
           updated_at = now()
     WHERE stellar_history_gap.status <> 'closed'`,
    [gap.chainKey, gap.contract, gap.fromLedger.toString(), gap.toLedger.toString(), gap.reason],
  );
}

export async function listHistoryGaps(
  db: Queryable,
  options: {
    readonly chainKey?: string;
    readonly contract?: string;
    readonly includeClosed?: boolean;
  } = {},
): Promise<readonly StellarHistoryGap[]> {
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
  if (options.includeClosed !== true) {
    clauses.push(`status <> 'closed'`);
  }

  const whereSql = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
  const { rows } = await db.query(
    `SELECT id, chain_key, contract, from_ledger, to_ledger, reconciled_through,
            status, reason, detected_at, reconciled_at
       FROM stellar_history_gap
       ${whereSql}
      ORDER BY chain_key, from_ledger, to_ledger`,
    params,
  );
  return rows.map(mapHistoryGapRow);
}

export async function summarizeHistoryCoverage(
  db: Queryable,
  options: { readonly chainKey?: string; readonly contract?: string } = {},
): Promise<HistoryCoverageSummary> {
  const gaps = await listHistoryGaps(db, { ...options, includeClosed: true });
  let openGaps = 0;
  let reconcilingGaps = 0;
  let closedGaps = 0;
  let missingLedgers = 0n;

  for (const gap of gaps) {
    if (gap.status === "open") {
      openGaps += 1;
      missingLedgers += remainingGapLedgers(gap);
    } else if (gap.status === "reconciling") {
      reconcilingGaps += 1;
      missingLedgers += remainingGapLedgers(gap);
    } else {
      closedGaps += 1;
    }
  }

  return {
    complete: openGaps === 0 && reconcilingGaps === 0,
    openGaps,
    reconcilingGaps,
    closedGaps,
    missingLedgers,
    gaps,
  };
}

export async function advanceOrCloseHistoryGap(
  db: Queryable,
  gap: Pick<StellarHistoryGap, "id" | "fromLedger" | "toLedger">,
  completedThrough: bigint,
  reconciledAt?: Date,
): Promise<HistoryGapStatus> {
  if (completedThrough >= gap.toLedger) {
    await db.query(
      `UPDATE stellar_history_gap
          SET status = 'closed',
              reconciled_through = $2,
              reconciled_at = COALESCE($3, now()),
              updated_at = now()
        WHERE id = $1`,
      [gap.id.toString(), gap.toLedger.toString(), reconciledAt ?? null],
    );
    return "closed";
  }

  if (completedThrough >= gap.fromLedger) {
    await db.query(
      `UPDATE stellar_history_gap
          SET status = 'reconciling',
              reconciled_through = GREATEST(
                COALESCE(reconciled_through, from_ledger),
                $2::numeric(20, 0)
              ),
              reconciled_at = NULL,
              updated_at = now()
        WHERE id = $1 AND status <> 'closed'`,
      [gap.id.toString(), completedThrough.toString()],
    );
  }
  return "reconciling";
}
