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
import { bigintOf, maybeOne, text, textOrNull, timestampOrNull } from "../../db/rows.js";
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
  RawStellarEvent,
  RouteConfiguredEvent,
  TokenRegisteredEvent,
} from "./events.js";

const MAX_QUARANTINE_RAW_BYTES = 16_384;
const MAX_QUARANTINE_PREVIEW_CHARS = 4_096;
const MAX_QUARANTINE_ERROR_CHARS = 1_024;

/** Where a watcher has read up to. */
export interface ChainCursor {
  readonly position: bigint;
  readonly contract: string;
  readonly observedAt: Date | null;
  /** EVM only. Null on Stellar, where a closed ledger cannot change. */
  readonly hash: string | null;
  readonly deploymentRevision: number;
}

export async function readCursor(db: Queryable, chainKey: string): Promise<ChainCursor | null> {
  const { rows } = await db.query(
    `SELECT last_processed, contract, last_processed_at, last_processed_hash, deployment_revision
       FROM indexer_cursor WHERE chain_key = $1`,
    [chainKey],
  );
  const row = maybeOne(rows, `cursor for ${chainKey}`);
  if (row === null) return null;
  const rawRevision = row.deployment_revision;
  const deploymentRevision =
    rawRevision === undefined || rawRevision === null ? 1 : Number(rawRevision);
  return {
    position: bigintOf(row, "last_processed"),
    contract: text(row, "contract"),
    observedAt: timestampOrNull(row, "last_processed_at"),
    hash: textOrNull(row, "last_processed_hash"),
    deploymentRevision,
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
    readonly deploymentRevision?: number;
  },
): Promise<void> {
  if (entry.deploymentRevision === undefined) {
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
    return;
  }

  await db.query(
    `INSERT INTO indexer_cursor
       (chain_key, family, contract, last_processed, last_processed_at, last_processed_hash, deployment_revision)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (chain_key) DO UPDATE
       SET contract = EXCLUDED.contract,
           family = EXCLUDED.family,
           last_processed = EXCLUDED.last_processed,
           last_processed_at = EXCLUDED.last_processed_at,
           last_processed_hash = EXCLUDED.last_processed_hash,
           deployment_revision = EXCLUDED.deployment_revision,
           updated_at = now()`,
    [
      entry.chainKey,
      entry.family,
      entry.contract,
      entry.position.toString(),
      entry.observedAt,
      entry.hash,
      entry.deploymentRevision,
    ],
  );
}

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
  const serialized = JSON.stringify(raw, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  if (Buffer.byteLength(serialized, "utf8") <= MAX_QUARANTINE_RAW_BYTES) {
    return serialized;
  }
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
    preview: serialized.slice(0, MAX_QUARANTINE_PREVIEW_CHARS),
  });
}

function boundDecodeError(error: string | null): string | null {
  if (error === null) return null;
  if (error.length <= MAX_QUARANTINE_ERROR_CHARS) return error;
  return `${error.slice(0, MAX_QUARANTINE_ERROR_CHARS - 3)}...`;
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
     ON CONFLICT (chain_key, event_id) DO UPDATE
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
