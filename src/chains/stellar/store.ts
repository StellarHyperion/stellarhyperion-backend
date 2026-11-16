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
  boolean as booleanOf,
  integer,
  json,
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
  RawStellarEvent,
  RouteConfiguredEvent,
  StellarEvent,
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

const MAX_SUMMARY_BYTES = 2048;

export interface EventIdentityEvidence {
  readonly chainKey: string;
  readonly canonicalKey: string;
  readonly eventKind: "bridgeOut" | "bridgeIn" | "claimParked" | "actionQueued";
  readonly contract: string;
  readonly eventId: string;
  readonly ledger: number;
  readonly txHash: string;
  readonly payloadDigest: string;
  readonly boundedSummary: Record<string, unknown>;
}

export interface StellarEventConflictReport {
  readonly chainKey: string;
  readonly canonicalKey: string;
  readonly eventKind: string;
  readonly contract: string;
  readonly existingEventId: string;
  readonly existingLedger: number;
  readonly existingTxHash: string;
  readonly existingPayloadDigest: string;
  readonly existingSummary: unknown;
  readonly conflictingEventId: string;
  readonly conflictingLedger: number;
  readonly conflictingTxHash: string;
  readonly conflictingPayloadDigest: string;
  readonly conflictingSummary: unknown;
  readonly detectedAt: Date;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

function digestOfPayload(payload: Record<string, unknown>): string {
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

function boundSummary(
  payload: Record<string, unknown>,
  payloadDigest: string,
): Record<string, unknown> {
  const serialized = stableJson(payload);
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength <= MAX_SUMMARY_BYTES) {
    return payload;
  }
  const preview = serialized.slice(0, MAX_SUMMARY_BYTES - 256);
  return {
    truncated: true,
    originalByteLength: byteLength,
    payloadDigest,
    preview,
  };
}

export function deriveStellarEventIdentity(
  chainKey: string,
  contract: string,
  raw: RawStellarEvent,
  decoded: StellarEvent,
): EventIdentityEvidence | null {
  switch (decoded.kind) {
    case "bridgeOut": {
      const payload: Record<string, unknown> = {
        route: decoded.data.route,
        nonce: decoded.data.nonce.toString(),
        sender: decoded.data.sender,
        token: decoded.data.token,
        grossAmount: decoded.data.grossAmount.toString(),
        fee: decoded.data.fee.toString(),
        netAmount: decoded.data.netAmount.toString(),
        destinationChain: decoded.data.destinationChain,
        destination: decoded.data.destination,
      };
      const payloadDigest = digestOfPayload(payload);
      return {
        chainKey,
        canonicalKey: `bridgeOut:${decoded.data.nonce.toString()}`,
        eventKind: "bridgeOut",
        contract,
        eventId: raw.id,
        ledger: raw.ledger,
        txHash: raw.txHash,
        payloadDigest,
        boundedSummary: boundSummary(payload, payloadDigest),
      };
    }
    case "bridgeIn": {
      const claimId = decoded.data.delivered ? null : decoded.data.claimId.toString();
      const payload: Record<string, unknown> = {
        route: decoded.data.route,
        sourceChain: decoded.data.sourceChain,
        sourceNonce: decoded.data.sourceNonce.toString(),
        recipient: decoded.data.recipient,
        token: decoded.data.token,
        amount: decoded.data.amount.toString(),
        delivered: decoded.data.delivered,
        claimId,
      };
      const payloadDigest = digestOfPayload(payload);
      return {
        chainKey,
        canonicalKey: `bridgeIn:${String(decoded.data.route)}:${decoded.data.sourceChain}:${decoded.data.sourceNonce.toString()}`,
        eventKind: "bridgeIn",
        contract,
        eventId: raw.id,
        ledger: raw.ledger,
        txHash: raw.txHash,
        payloadDigest,
        boundedSummary: boundSummary(payload, payloadDigest),
      };
    }
    case "claimParked": {
      const payload: Record<string, unknown> = {
        claimId: decoded.data.claimId.toString(),
        recipient: decoded.data.recipient,
        token: decoded.data.token,
        amount: decoded.data.amount.toString(),
        route: decoded.data.route,
        sourceChain: decoded.data.sourceChain,
        sourceNonce: decoded.data.sourceNonce.toString(),
        createdAt: decoded.data.createdAt.toString(),
      };
      const payloadDigest = digestOfPayload(payload);
      return {
        chainKey,
        canonicalKey: `claimParked:${decoded.data.claimId.toString()}`,
        eventKind: "claimParked",
        contract,
        eventId: raw.id,
        ledger: raw.ledger,
        txHash: raw.txHash,
        payloadDigest,
        boundedSummary: boundSummary(payload, payloadDigest),
      };
    }
    case "actionQueued": {
      const payload: Record<string, unknown> = {
        id: decoded.data.id.toString(),
        variant: decoded.data.variant,
        eta: decoded.data.eta.toString(),
        expiresAt: decoded.data.expiresAt.toString(),
        action: raw.valueJson,
      };
      const payloadDigest = digestOfPayload(payload);
      return {
        chainKey,
        canonicalKey: `actionQueued:${decoded.data.id.toString()}`,
        eventKind: "actionQueued",
        contract,
        eventId: raw.id,
        ledger: raw.ledger,
        txHash: raw.txHash,
        payloadDigest,
        boundedSummary: boundSummary(payload, payloadDigest),
      };
    }
    default:
      return null;
  }
}

async function readFallbackMaterializedIdentity(
  db: Queryable,
  incoming: EventIdentityEvidence,
  decoded: StellarEvent,
): Promise<EventIdentityEvidence | null> {
  if (decoded.kind === "bridgeOut") {
    const { rows } = await db.query(
      `SELECT route, nonce, sender, token, gross_amount, fee, net_amount,
              destination_chain, destination, origin_block, origin_tx
         FROM outbound_transfer
        WHERE origin_chain = $1 AND nonce = $2`,
      [incoming.chainKey, decoded.data.nonce.toString()],
    );
    const row = maybeOne(rows, `outbound transfer ${decoded.data.nonce.toString()}`);
    if (row === null) return null;
    const payload: Record<string, unknown> = {
      route: integer(row, "route"),
      nonce: bigintOf(row, "nonce").toString(),
      sender: text(row, "sender"),
      token: text(row, "token"),
      grossAmount: bigintOf(row, "gross_amount").toString(),
      fee: bigintOf(row, "fee").toString(),
      netAmount: bigintOf(row, "net_amount").toString(),
      destinationChain: text(row, "destination_chain"),
      destination: text(row, "destination"),
    };
    const payloadDigest = digestOfPayload(payload);
    return {
      chainKey: incoming.chainKey,
      canonicalKey: incoming.canonicalKey,
      eventKind: "bridgeOut",
      contract: incoming.contract,
      eventId: `materialized:outbound:${decoded.data.nonce.toString()}`,
      ledger: Number(bigintOf(row, "origin_block")),
      txHash: text(row, "origin_tx"),
      payloadDigest,
      boundedSummary: boundSummary(payload, payloadDigest),
    };
  }

  if (decoded.kind === "bridgeIn") {
    const { rows } = await db.query(
      `SELECT route, source_chain, source_nonce, recipient, token, amount,
              delivered, claim_id, destination_block, destination_tx
         FROM inbound_delivery
        WHERE destination_chain = $1
          AND route = $2
          AND source_chain = $3
          AND source_nonce = $4`,
      [
        incoming.chainKey,
        decoded.data.route,
        decoded.data.sourceChain,
        decoded.data.sourceNonce.toString(),
      ],
    );
    const row = maybeOne(rows, `inbound delivery ${incoming.canonicalKey}`);
    if (row === null) return null;
    const claimIdVal = bigintOrNull(row, "claim_id");
    const delivered = booleanOf(row, "delivered");
    const payload: Record<string, unknown> = {
      route: integer(row, "route"),
      sourceChain: text(row, "source_chain"),
      sourceNonce: bigintOf(row, "source_nonce").toString(),
      recipient: text(row, "recipient"),
      token: text(row, "token"),
      amount: bigintOf(row, "amount").toString(),
      delivered,
      claimId: delivered || claimIdVal === null ? null : claimIdVal.toString(),
    };
    const payloadDigest = digestOfPayload(payload);
    return {
      chainKey: incoming.chainKey,
      canonicalKey: incoming.canonicalKey,
      eventKind: "bridgeIn",
      contract: incoming.contract,
      eventId: `materialized:inbound:${incoming.canonicalKey}`,
      ledger: Number(bigintOf(row, "destination_block")),
      txHash: text(row, "destination_tx"),
      payloadDigest,
      boundedSummary: boundSummary(payload, payloadDigest),
    };
  }

  return null;
}

export async function verifyAndRecordEventIdentity(
  db: Queryable,
  incoming: EventIdentityEvidence,
  decoded: StellarEvent,
  memoryCache: Map<string, EventIdentityEvidence>,
): Promise<
  | { readonly status: "accepted"; readonly replay: boolean }
  | { readonly status: "conflict"; readonly report: StellarEventConflictReport }
> {
  const cacheKey = `${incoming.chainKey}::${incoming.canonicalKey}`;
  let existing: EventIdentityEvidence | null = null;

  const { rows } = await db.query(
    `SELECT contract, event_id, ledger, tx_hash, payload_digest, bounded_summary
       FROM stellar_event_identity
      WHERE chain_key = $1 AND canonical_key = $2`,
    [incoming.chainKey, incoming.canonicalKey],
  );
  const stored = maybeOne(rows, `stellar event identity ${incoming.canonicalKey}`);
  if (stored !== null) {
    existing = {
      chainKey: incoming.chainKey,
      canonicalKey: incoming.canonicalKey,
      eventKind: incoming.eventKind,
      contract: text(stored, "contract"),
      eventId: text(stored, "event_id"),
      ledger: Number(bigintOf(stored, "ledger")),
      txHash: text(stored, "tx_hash"),
      payloadDigest: text(stored, "payload_digest"),
      boundedSummary: (json(stored, "bounded_summary") ?? {}) as Record<string, unknown>,
    };
  } else {
    existing =
      (await readFallbackMaterializedIdentity(db, incoming, decoded)) ??
      memoryCache.get(cacheKey) ??
      null;
  }

  if (existing === null) {
    await db.query(
      `INSERT INTO stellar_event_identity
         (chain_key, canonical_key, event_kind, contract, event_id, ledger, tx_hash, payload_digest, bounded_summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       ON CONFLICT (chain_key, canonical_key) DO NOTHING`,
      [
        incoming.chainKey,
        incoming.canonicalKey,
        incoming.eventKind,
        incoming.contract,
        incoming.eventId,
        String(incoming.ledger),
        incoming.txHash,
        incoming.payloadDigest,
        JSON.stringify(incoming.boundedSummary),
      ],
    );
    memoryCache.set(cacheKey, incoming);
    return { status: "accepted", replay: false };
  }

  if (existing.payloadDigest === incoming.payloadDigest) {
    memoryCache.set(cacheKey, existing);
    return { status: "accepted", replay: true };
  }

  const detectedAt = new Date();
  await db.query(
    `INSERT INTO stellar_event_conflict
       (chain_key, canonical_key, event_kind, contract,
        existing_event_id, existing_ledger, existing_tx_hash, existing_payload_digest, existing_summary,
        conflicting_event_id, conflicting_ledger, conflicting_tx_hash, conflicting_payload_digest, conflicting_summary,
        detected_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14::jsonb, $15)
     ON CONFLICT (chain_key, canonical_key, conflicting_payload_digest, conflicting_event_id) DO NOTHING`,
    [
      incoming.chainKey,
      incoming.canonicalKey,
      incoming.eventKind,
      incoming.contract,
      existing.eventId,
      String(existing.ledger),
      existing.txHash,
      existing.payloadDigest,
      JSON.stringify(existing.boundedSummary),
      incoming.eventId,
      String(incoming.ledger),
      incoming.txHash,
      incoming.payloadDigest,
      JSON.stringify(incoming.boundedSummary),
      detectedAt,
    ],
  );

  return {
    status: "conflict",
    report: {
      chainKey: incoming.chainKey,
      canonicalKey: incoming.canonicalKey,
      eventKind: incoming.eventKind,
      contract: incoming.contract,
      existingEventId: existing.eventId,
      existingLedger: existing.ledger,
      existingTxHash: existing.txHash,
      existingPayloadDigest: existing.payloadDigest,
      existingSummary: existing.boundedSummary,
      conflictingEventId: incoming.eventId,
      conflictingLedger: incoming.ledger,
      conflictingTxHash: incoming.txHash,
      conflictingPayloadDigest: incoming.payloadDigest,
      conflictingSummary: incoming.boundedSummary,
      detectedAt,
    },
  };
}

export async function readStellarEventConflicts(
  db: Queryable,
  chainKey: string,
): Promise<readonly StellarEventConflictReport[]> {
  const { rows } = await db.query(
    `SELECT chain_key, canonical_key, event_kind, contract,
            existing_event_id, existing_ledger, existing_tx_hash, existing_payload_digest, existing_summary,
            conflicting_event_id, conflicting_ledger, conflicting_tx_hash, conflicting_payload_digest, conflicting_summary,
            detected_at
       FROM stellar_event_conflict
      WHERE chain_key = $1
      ORDER BY id ASC`,
    [chainKey],
  );
  return rows.map((row) => ({
    chainKey: text(row, "chain_key"),
    canonicalKey: text(row, "canonical_key"),
    eventKind: text(row, "event_kind"),
    contract: text(row, "contract"),
    existingEventId: text(row, "existing_event_id"),
    existingLedger: Number(bigintOf(row, "existing_ledger")),
    existingTxHash: text(row, "existing_tx_hash"),
    existingPayloadDigest: text(row, "existing_payload_digest"),
    existingSummary: json(row, "existing_summary"),
    conflictingEventId: text(row, "conflicting_event_id"),
    conflictingLedger: Number(bigintOf(row, "conflicting_ledger")),
    conflictingTxHash: text(row, "conflicting_tx_hash"),
    conflictingPayloadDigest: text(row, "conflicting_payload_digest"),
    conflictingSummary: json(row, "conflicting_summary"),
    detectedAt: timestamp(row, "detected_at"),
  }));
}
