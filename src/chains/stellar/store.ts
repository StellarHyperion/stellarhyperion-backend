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

import type { Queryable, Transactional } from "../../db/pool.js";
import {
  bigintOf,
  bigintOrNull,
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
  readonly revision: bigint;
}

export async function readCursor(db: Queryable, chainKey: string): Promise<ChainCursor | null> {
  const { rows } = await db.query(
    `SELECT last_processed, contract, last_processed_at, last_processed_hash, revision
       FROM indexer_cursor WHERE chain_key = $1`,
    [chainKey],
  );
  const row = maybeOne(rows, `cursor for ${chainKey}`);
  if (row === null) return null;
  const hasRevision = row.revision !== undefined && row.revision !== null;
  return {
    position: bigintOf(row, "last_processed"),
    contract: text(row, "contract"),
    observedAt: timestampOrNull(row, "last_processed_at"),
    hash: textOrNull(row, "last_processed_hash"),
    revision: hasRevision ? bigintOf(row, "revision") : 1n,
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
           revision = indexer_cursor.revision + 1,
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

export interface CursorSnapshot {
  readonly exists: boolean;
  readonly contract: string | null;
  readonly position: bigint | null;
  readonly observedAt: Date | null;
  readonly revision: bigint;
}

export interface CursorRepairEvidence {
  readonly verifiedFromLedger: number;
  readonly verifiedThroughLedger: number;
  readonly rpcOldestLedger: number;
  readonly rpcLatestLedger: number;
  readonly pagesVerified: number;
  readonly terminalCursor: string;
  readonly materializedEventsVerified: number;
}

export interface StellarCursorRepairProposal {
  readonly proposalId: string;
  readonly unsigned: true;
  readonly chainKey: string;
  readonly contract: string;
  readonly action: "initialize" | "advance";
  readonly expectedRevision: bigint;
  readonly beforeState: CursorSnapshot;
  readonly proposedPosition: bigint;
  readonly proposedObservedAt: Date | null;
  readonly evidence: CursorRepairEvidence;
  readonly justification: string;
}

export interface AppliedCursorRepairAudit {
  readonly id: bigint;
  readonly proposalId: string;
  readonly chainKey: string;
  readonly contract: string;
  readonly action: "initialize" | "advance" | "rewind";
  readonly expectedRevision: bigint;
  readonly appliedRevision: bigint;
  readonly beforeContract: string | null;
  readonly beforePosition: bigint | null;
  readonly proposedPosition: bigint;
  readonly justification: string;
  readonly reviewedBy: string;
  readonly reviewNote: string;
  readonly appliedAt: Date;
}

export class CursorRepairConflictError extends Error {
  constructor(reason: string) {
    super(`cursor repair rejected: ${reason}`);
    this.name = "CursorRepairConflictError";
  }
}

export function computeRepairProposalId(
  proposal: Omit<StellarCursorRepairProposal, "proposalId">,
): string {
  const canonical = JSON.stringify({
    unsigned: proposal.unsigned,
    chainKey: proposal.chainKey,
    contract: proposal.contract,
    action: proposal.action,
    expectedRevision: proposal.expectedRevision.toString(),
    beforeState: {
      exists: proposal.beforeState.exists,
      contract: proposal.beforeState.contract,
      position:
        proposal.beforeState.position === null ? null : proposal.beforeState.position.toString(),
      observedAt: proposal.beforeState.observedAt?.toISOString() ?? null,
      revision: proposal.beforeState.revision.toString(),
    },
    proposedPosition: proposal.proposedPosition.toString(),
    proposedObservedAt: proposal.proposedObservedAt?.toISOString() ?? null,
    evidence: proposal.evidence,
    justification: proposal.justification,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Read-only check proving whether an actionable decoded Stellar event is already materialized in
 * the database so a repair planner never skips unindexed transfers or governance state.
 */
export async function isStellarEventMaterialized(
  db: Queryable,
  chainKey: string,
  event: StellarEvent,
): Promise<boolean> {
  switch (event.kind) {
    case "bridgeOut": {
      const { rows } = await db.query(
        "SELECT 1 FROM outbound_transfer WHERE origin_chain = $1 AND nonce = $2 LIMIT 1",
        [chainKey, event.data.nonce.toString()],
      );
      return rows.length > 0;
    }
    case "bridgeIn": {
      const { rows } = await db.query(
        `SELECT 1 FROM inbound_delivery
          WHERE destination_chain = $1
            AND route = $2
            AND source_chain = $3
            AND source_nonce = $4
          LIMIT 1`,
        [chainKey, event.data.route, event.data.sourceChain, event.data.sourceNonce.toString()],
      );
      return rows.length > 0;
    }
    case "claimParked": {
      const { rows } = await db.query(
        "SELECT 1 FROM pending_claim WHERE chain = $1 AND claim_id = $2 LIMIT 1",
        [chainKey, event.data.claimId.toString()],
      );
      return rows.length > 0;
    }
    case "claimSettled": {
      const { rows } = await db.query(
        "SELECT 1 FROM pending_claim WHERE chain = $1 AND claim_id = $2 AND settled = true LIMIT 1",
        [chainKey, event.data.claimId.toString()],
      );
      return rows.length > 0;
    }
    case "actionQueued": {
      const { rows } = await db.query(
        "SELECT 1 FROM admin_action WHERE chain = $1 AND action_id = $2 LIMIT 1",
        [chainKey, event.data.id.toString()],
      );
      return rows.length > 0;
    }
    case "actionExecuted":
    case "actionCancelled": {
      const expectedState = event.kind === "actionExecuted" ? "executed" : "cancelled";
      const { rows } = await db.query(
        "SELECT 1 FROM admin_action WHERE chain = $1 AND action_id = $2 AND state = $3 LIMIT 1",
        [chainKey, event.data.id.toString(), expectedState],
      );
      return rows.length > 0;
    }
    case "tokenRegistered":
    case "routeConfigured":
    case "pauseSet":
    case "ignored":
      return true;
    case "unknown":
      return false;
  }
}

export interface ApplyRepairReview {
  readonly reviewedBy: string;
  readonly reviewNote: string;
}

/**
 * Apply a separately reviewed Stellar cursor repair proposal with compare-and-swap revision
 * verification and an immutable database audit trail.
 */
export async function applyStellarCursorRepair(
  db: Transactional,
  proposal: StellarCursorRepairProposal,
  review: ApplyRepairReview,
): Promise<AppliedCursorRepairAudit> {
  const reviewer = review.reviewedBy.trim();
  const note = review.reviewNote.trim();
  if (reviewer.length === 0) {
    throw new CursorRepairConflictError("reviewedBy is required");
  }
  if (note.length === 0) {
    throw new CursorRepairConflictError("reviewNote is required");
  }

  const expectedId = computeRepairProposalId(proposal);
  if (proposal.proposalId !== expectedId) {
    throw new CursorRepairConflictError(
      "proposalId does not match proposal contents; refusing tampered proposal",
    );
  }

  return db.transaction(async (tx: Queryable) => {
    const locked = await tx.query(
      `SELECT last_processed, contract, last_processed_at, revision
         FROM indexer_cursor
        WHERE chain_key = $1
        FOR UPDATE`,
      [proposal.chainKey],
    );
    const currentRow = maybeOne(locked.rows, `cursor for ${proposal.chainKey}`);

    if (!proposal.beforeState.exists) {
      if (currentRow !== null) {
        throw new CursorRepairConflictError(
          `expected absent cursor for ${proposal.chainKey}, found revision ${bigintOf(currentRow, "revision").toString()}`,
        );
      }
      if (proposal.expectedRevision !== 0n) {
        throw new CursorRepairConflictError(
          `initialize proposal must expect revision 0, got ${proposal.expectedRevision.toString()}`,
        );
      }
    } else {
      if (currentRow === null) {
        throw new CursorRepairConflictError(
          `expected cursor at revision ${proposal.expectedRevision.toString()}, found none`,
        );
      }
      const actualRevision = bigintOf(currentRow, "revision");
      const actualPosition = bigintOf(currentRow, "last_processed");
      const actualContract = text(currentRow, "contract");
      if (actualRevision !== proposal.expectedRevision) {
        throw new CursorRepairConflictError(
          `cursor revision changed from ${proposal.expectedRevision.toString()} to ${actualRevision.toString()}`,
        );
      }
      if (
        actualPosition !== proposal.beforeState.position ||
        actualContract !== proposal.beforeState.contract
      ) {
        throw new CursorRepairConflictError("cursor state no longer matches proposal beforeState");
      }
    }

    const appliedRevision = proposal.expectedRevision + 1n;
    if (!proposal.beforeState.exists) {
      await tx.query(
        `INSERT INTO indexer_cursor
           (chain_key, family, contract, last_processed, last_processed_at, last_processed_hash, revision)
         VALUES ($1, 'stellar', $2, $3, $4, NULL, $5)`,
        [
          proposal.chainKey,
          proposal.contract,
          proposal.proposedPosition.toString(),
          proposal.proposedObservedAt,
          appliedRevision.toString(),
        ],
      );
    } else {
      const updated = await tx.query(
        `UPDATE indexer_cursor
            SET contract = $2,
                last_processed = $3,
                last_processed_at = $4,
                revision = $5,
                updated_at = now()
          WHERE chain_key = $1
            AND revision = $6`,
        [
          proposal.chainKey,
          proposal.contract,
          proposal.proposedPosition.toString(),
          proposal.proposedObservedAt,
          appliedRevision.toString(),
          proposal.expectedRevision.toString(),
        ],
      );
      if (updated.rowCount !== 1) {
        throw new CursorRepairConflictError("concurrent cursor modification detected");
      }
    }

    const payloadJson = JSON.stringify({
      proposalId: proposal.proposalId,
      unsigned: proposal.unsigned,
      chainKey: proposal.chainKey,
      contract: proposal.contract,
      action: proposal.action,
      expectedRevision: proposal.expectedRevision.toString(),
      beforeState: {
        exists: proposal.beforeState.exists,
        contract: proposal.beforeState.contract,
        position:
          proposal.beforeState.position === null ? null : proposal.beforeState.position.toString(),
        observedAt: proposal.beforeState.observedAt?.toISOString() ?? null,
        revision: proposal.beforeState.revision.toString(),
      },
      proposedPosition: proposal.proposedPosition.toString(),
      proposedObservedAt: proposal.proposedObservedAt?.toISOString() ?? null,
      evidence: proposal.evidence,
      justification: proposal.justification,
    });

    const auditInsert = await tx.query(
      `INSERT INTO stellar_cursor_repair_audit
         (proposal_id, chain_key, contract, action, expected_revision, applied_revision,
          before_contract, before_position, before_observed_at, proposed_position,
          proposed_observed_at, verified_from_ledger, verified_through_ledger,
          rpc_oldest_ledger, rpc_latest_ledger, terminal_cursor, justification,
          reviewed_by, review_note, proposal_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb)
       RETURNING id, proposal_id, chain_key, contract, action, expected_revision, applied_revision,
                 before_contract, before_position, proposed_position, justification,
                 reviewed_by, review_note, applied_at`,
      [
        proposal.proposalId,
        proposal.chainKey,
        proposal.contract,
        proposal.action,
        proposal.expectedRevision.toString(),
        appliedRevision.toString(),
        proposal.beforeState.contract,
        proposal.beforeState.position === null ? null : proposal.beforeState.position.toString(),
        proposal.beforeState.observedAt,
        proposal.proposedPosition.toString(),
        proposal.proposedObservedAt,
        String(proposal.evidence.verifiedFromLedger),
        String(proposal.evidence.verifiedThroughLedger),
        String(proposal.evidence.rpcOldestLedger),
        String(proposal.evidence.rpcLatestLedger),
        proposal.evidence.terminalCursor,
        proposal.justification,
        reviewer,
        note,
        payloadJson,
      ],
    );
    const auditRow = auditInsert.rows[0];
    if (auditRow === undefined) {
      throw new Error("failed to persist stellar cursor repair audit row");
    }
    const actionRaw = text(auditRow, "action");
    if (actionRaw !== "initialize" && actionRaw !== "advance" && actionRaw !== "rewind") {
      throw new Error(`unexpected audit action: ${actionRaw}`);
    }
    return {
      id: bigintOf(auditRow, "id"),
      proposalId: text(auditRow, "proposal_id"),
      chainKey: text(auditRow, "chain_key"),
      contract: text(auditRow, "contract"),
      action: actionRaw,
      expectedRevision: bigintOf(auditRow, "expected_revision"),
      appliedRevision: bigintOf(auditRow, "applied_revision"),
      beforeContract: textOrNull(auditRow, "before_contract"),
      beforePosition: bigintOrNull(auditRow, "before_position"),
      proposedPosition: bigintOf(auditRow, "proposed_position"),
      justification: text(auditRow, "justification"),
      reviewedBy: text(auditRow, "reviewed_by"),
      reviewNote: text(auditRow, "review_note"),
      appliedAt: timestamp(auditRow, "applied_at"),
    };
  });
}

export async function readStellarCursorRepairAudits(
  db: Queryable,
  chainKey: string,
): Promise<readonly AppliedCursorRepairAudit[]> {
  const { rows } = await db.query(
    `SELECT id, proposal_id, chain_key, contract, action, expected_revision, applied_revision,
            before_contract, before_position, proposed_position, justification,
            reviewed_by, review_note, applied_at
       FROM stellar_cursor_repair_audit
      WHERE chain_key = $1
      ORDER BY id ASC`,
    [chainKey],
  );
  return rows.map((row) => {
    const actionRaw = text(row, "action");
    if (actionRaw !== "initialize" && actionRaw !== "advance" && actionRaw !== "rewind") {
      throw new Error(`unexpected audit action: ${actionRaw}`);
    }
    return {
      id: bigintOf(row, "id"),
      proposalId: text(row, "proposal_id"),
      chainKey: text(row, "chain_key"),
      contract: text(row, "contract"),
      action: actionRaw,
      expectedRevision: bigintOf(row, "expected_revision"),
      appliedRevision: bigintOf(row, "applied_revision"),
      beforeContract: textOrNull(row, "before_contract"),
      beforePosition: bigintOrNull(row, "before_position"),
      proposedPosition: bigintOf(row, "proposed_position"),
      justification: text(row, "justification"),
      reviewedBy: text(row, "reviewed_by"),
      reviewNote: text(row, "review_note"),
      appliedAt: timestamp(row, "applied_at"),
    };
  });
}
