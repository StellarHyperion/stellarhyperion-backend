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
  return {
    kind: decoded.kind,
    data: "data" in decoded ? normalizeValue(decoded.data) : null,
    topicJson: normalizeValue(raw.topicJson),
    valueJson: normalizeValue(raw.valueJson),
  };
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

export type CursorRepairAction =
  | "noop"
  | "initialize_cursor"
  | "advance_cursor"
  | "rewind_cursor"
  | "reset_cursor"
  | "backfill_required";

export interface VerifiedLedgerBoundary {
  readonly ledger: number;
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

  const highestVerified =
    verifiedBoundaries.length === 0
      ? null
      : verifiedBoundaries.reduce((max, b) => Math.max(max, b.ledger), 0);

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
      sql: "DELETE FROM indexer_cursor WHERE chain_key = $1 AND contract = $2",
      params: [chainKey, currentCursor.contract],
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
   SET last_processed = $1, updated_at = now()
 WHERE chain_key = $2 AND contract = $3 AND last_processed = $4`,
        params: [
          String(highestVerified),
          chainKey,
          expectedContract,
          currentCursor.position.toString(),
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
   SET last_processed = $1, updated_at = now()
 WHERE chain_key = $2 AND contract = $3 AND last_processed = $4`,
        params: [
          String(highestVerified),
          chainKey,
          expectedContract,
          currentCursor.position.toString(),
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
   SET last_processed = $1, updated_at = now()
 WHERE chain_key = $2 AND contract = $3 AND last_processed = $4`,
      params: [
        String(highestVerified),
        chainKey,
        expectedContract,
        currentCursor.position.toString(),
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
