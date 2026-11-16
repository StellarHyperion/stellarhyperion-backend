import { writeAttestation } from "../chains/writers.js";
import type { Queryable, Transactional } from "../db/pool.js";
import { bigintOf, boolean, integer, text, textOrNull, timestamp } from "../db/rows.js";
import type { AttestationStatus } from "./types.js";

const VALID_STATUSES: readonly AttestationStatus[] = [
  "pending",
  "attested",
  "delivered",
  "failed",
  "expired",
];

const MAX_PUBLIC_TEXT_LEN = 256;

export class InvalidRailTransitionError extends Error {
  constructor(
    readonly transferId: bigint,
    readonly previousStatus: AttestationStatus | null,
    readonly nextStatus: AttestationStatus,
    detail: string,
  ) {
    super(
      `Invalid rail lifecycle transition for transfer ${transferId.toString()} (${previousStatus ?? "none"} -> ${nextStatus}): ${detail}`,
    );
    this.name = "InvalidRailTransitionError";
  }
}

export interface RailTransitionEvidence {
  readonly railStatus?: string | null;
  readonly railReference?: string | null;
  readonly destinationTx?: string | null;
  readonly commandId?: string | null;
  readonly railMessageId?: string | null;
}

export interface NormalizedRailTransitionEvidence {
  readonly railStatus: string | null;
  readonly railReference: string | null;
  readonly destinationTx: string | null;
  readonly commandId: string | null;
  readonly railMessageId: string | null;
}

export interface CommitRailTransitionInput {
  readonly transferId: bigint;
  readonly route: number;
  readonly nextStatus: AttestationStatus;
  readonly reason: string;
  readonly evidence?: RailTransitionEvidence;
  readonly attestedAt?: Date | null;
  readonly checkedAt: Date;
  readonly checkFailures: number;
  readonly lastError?: string | null;
  readonly preserveIfUnchanged?: boolean;
  /**
   * Required when applying a backward transition (for example attested -> pending,
   * failed -> pending, expired -> pending, or delivered -> attested after reorg review).
   */
  readonly reconciliationReason?: string;
}

export interface CommitRailTransitionResult {
  readonly previousStatus: AttestationStatus | null;
  readonly nextStatus: AttestationStatus;
  readonly transitionRecorded: boolean;
  readonly transitionId: bigint | null;
  readonly reconciled: boolean;
}

export interface JoinedRailLifecycleTransition {
  readonly id: bigint;
  readonly transferId: bigint;
  readonly route: number;
  readonly originChain: string;
  readonly nonce: bigint;
  readonly originTx: string;
  readonly destinationChain: string;
  readonly destination: string;
  readonly token: string;
  readonly grossAmount: string;
  readonly netAmount: string;
  readonly previousStatus: AttestationStatus | null;
  readonly nextStatus: AttestationStatus;
  readonly reason: string;
  readonly evidence: NormalizedRailTransitionEvidence;
  readonly reconciled: boolean;
  readonly recordedAt: Date;
}

export function sanitizePublicField(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const redacted = trimmed
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, "$1[redacted]@")
    .replace(/([?&](?:api[_-]?key|token|secret|password|auth|signature)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]");

  return redacted.length > MAX_PUBLIC_TEXT_LEN
    ? `${redacted.slice(0, MAX_PUBLIC_TEXT_LEN)}...`
    : redacted;
}

function parseKnownStatus(raw: string | null, column: string): AttestationStatus | null {
  if (raw === null) return null;
  return parseRequiredStatus(raw, column);
}

function parseRequiredStatus(raw: string, column: string): AttestationStatus {
  if (!(VALID_STATUSES as readonly string[]).includes(raw)) {
    throw new Error(`${column} holds unknown rail status '${raw}'`);
  }
  return raw as AttestationStatus;
}

/**
 * Determine whether moving from `previous` to `next` regresses lifecycle state and therefore
 * requires an explicit reconciliation reason.
 */
export function isBackwardRailTransition(
  previous: AttestationStatus | null,
  next: AttestationStatus,
): boolean {
  if (previous === null || previous === next) return false;
  if (previous === "delivered") {
    return true;
  }
  if (previous === "attested") {
    return next === "pending";
  }
  if (previous === "failed" || previous === "expired") {
    return next === "pending" || next === "attested";
  }
  return false;
}

async function hasVerifiedInboundDelivery(tx: Queryable, transferId: bigint): Promise<boolean> {
  const { rows } = await tx.query(
    `SELECT EXISTS (
       SELECT 1
         FROM outbound_transfer t
         JOIN inbound_delivery d
           ON d.destination_chain = t.destination_chain
          AND d.route = t.route
          AND d.source_chain = t.origin_chain
          AND d.source_nonce = t.nonce
        WHERE t.id = $1
     ) AS delivered`,
    [transferId.toString()],
  );
  return rows[0]?.delivered === true;
}

/**
 * Atomically persist the latest `rail_attestation` snapshot and append a normalized
 * `rail_lifecycle_transition` record only when lifecycle status, reason-backed reconciliation, or
 * public evidence materially changes.
 */
export async function commitRailTransition(
  tx: Queryable,
  input: CommitRailTransitionInput,
): Promise<CommitRailTransitionResult> {
  const existingAttRes = await tx.query(
    `SELECT status, rail_status, rail_reference
       FROM rail_attestation
      WHERE transfer_id = $1
      FOR UPDATE`,
    [input.transferId.toString()],
  );

  const existingAttRow = existingAttRes.rows[0];
  const previousStatus =
    existingAttRow === undefined
      ? null
      : parseKnownStatus(textOrNull(existingAttRow, "status"), "rail_attestation.status");

  const backward = isBackwardRailTransition(previousStatus, input.nextStatus);
  const reconciliationReason = sanitizePublicField(input.reconciliationReason);

  if (backward && reconciliationReason === null) {
    throw new InvalidRailTransitionError(
      input.transferId,
      previousStatus,
      input.nextStatus,
      "backward rail transition requires explicit reconciliation reason",
    );
  }

  if (input.nextStatus === "delivered") {
    const hasInbound = await hasVerifiedInboundDelivery(tx, input.transferId);
    if (!hasInbound) {
      throw new InvalidRailTransitionError(
        input.transferId,
        previousStatus,
        "delivered",
        "provider status alone cannot establish delivered without an inbound_delivery record",
      );
    }
  }

  const sanitizedRailStatus = sanitizePublicField(input.evidence?.railStatus);
  const sanitizedRailRef = sanitizePublicField(input.evidence?.railReference);
  const sanitizedDestTx = sanitizePublicField(input.evidence?.destinationTx);
  const sanitizedCommandId = sanitizePublicField(input.evidence?.commandId);
  const sanitizedMsgId = sanitizePublicField(input.evidence?.railMessageId);
  const sanitizedError = sanitizePublicField(input.lastError);

  const effectiveReason =
    reconciliationReason ?? sanitizePublicField(input.reason) ?? "status_update";

  const priorRailStatus =
    existingAttRow === undefined ? null : textOrNull(existingAttRow, "rail_status");
  const priorRailRef =
    existingAttRow === undefined ? null : textOrNull(existingAttRow, "rail_reference");

  const effectiveRailStatus = sanitizedRailStatus ?? priorRailStatus;
  const effectiveRailRef = sanitizedRailRef ?? priorRailRef;

  await writeAttestation(tx, {
    transferId: input.transferId,
    route: input.route,
    status: input.nextStatus,
    railStatus: sanitizedRailStatus,
    railReference: sanitizedRailRef,
    attestedAt: input.attestedAt ?? null,
    checkedAt: input.checkedAt,
    checkFailures: input.checkFailures,
    lastError: sanitizedError,
  });

  const latestTransitionRes = await tx.query(
    `SELECT next_status, reason, rail_status, rail_reference, destination_tx, command_id, rail_message_id
       FROM rail_lifecycle_transition
      WHERE transfer_id = $1
      ORDER BY id DESC
      LIMIT 1`,
    [input.transferId.toString()],
  );

  const latest = latestTransitionRes.rows[0];
  const effectiveDestTx =
    sanitizedDestTx ?? (latest === undefined ? null : textOrNull(latest, "destination_tx"));
  const effectiveCommandId =
    sanitizedCommandId ?? (latest === undefined ? null : textOrNull(latest, "command_id"));
  const effectiveMsgId =
    sanitizedMsgId ?? (latest === undefined ? null : textOrNull(latest, "rail_message_id"));

  const reconciled = reconciliationReason !== null;

  const isIdenticalPoll =
    !reconciled &&
    latest !== undefined &&
    text(latest, "next_status") === input.nextStatus &&
    (input.preserveIfUnchanged === true || text(latest, "reason") === effectiveReason) &&
    textOrNull(latest, "rail_status") === effectiveRailStatus &&
    textOrNull(latest, "rail_reference") === effectiveRailRef &&
    textOrNull(latest, "destination_tx") === effectiveDestTx &&
    textOrNull(latest, "command_id") === effectiveCommandId &&
    textOrNull(latest, "rail_message_id") === effectiveMsgId;

  if (isIdenticalPoll) {
    return {
      previousStatus,
      nextStatus: input.nextStatus,
      transitionRecorded: false,
      transitionId: null,
      reconciled: false,
    };
  }

  const inserted = await tx.query(
    `INSERT INTO rail_lifecycle_transition
       (transfer_id, route, previous_status, next_status, reason, rail_status, rail_reference,
        destination_tx, command_id, rail_message_id, reconciled, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      input.transferId.toString(),
      input.route,
      previousStatus,
      input.nextStatus,
      effectiveReason,
      effectiveRailStatus,
      effectiveRailRef,
      effectiveDestTx,
      effectiveCommandId,
      effectiveMsgId,
      reconciled,
      input.checkedAt,
    ],
  );

  const insertedRow = inserted.rows[0];
  return {
    previousStatus,
    nextStatus: input.nextStatus,
    transitionRecorded: true,
    transitionId: insertedRow === undefined ? null : bigintOf(insertedRow, "id"),
    reconciled,
  };
}

export async function reconcileRailTransition(
  db: Transactional,
  args: {
    readonly transferId: bigint;
    readonly nextStatus: AttestationStatus;
    readonly reconciliationReason: string;
    readonly evidence?: RailTransitionEvidence;
    readonly recordedAt?: Date;
  },
): Promise<CommitRailTransitionResult> {
  const sanitizedReason = sanitizePublicField(args.reconciliationReason);
  if (sanitizedReason === null) {
    throw new Error("Explicit reconciliation requires a non-empty reason");
  }

  return db.transaction(async (tx) => {
    const transferRes = await tx.query("SELECT route FROM outbound_transfer WHERE id = $1", [
      args.transferId.toString(),
    ]);
    const transferRow = transferRes.rows[0];
    if (transferRow === undefined) {
      throw new Error(
        `Cannot reconcile unknown outbound_transfer id ${args.transferId.toString()}`,
      );
    }
    const route = integer(transferRow, "route");
    const checkedAt = args.recordedAt ?? new Date();

    return commitRailTransition(tx, {
      transferId: args.transferId,
      route,
      nextStatus: args.nextStatus,
      reason: sanitizedReason,
      reconciliationReason: sanitizedReason,
      ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
      checkedAt,
      checkFailures: 0,
      lastError: null,
    });
  });
}

export interface ListTransitionsQuery {
  readonly transferId?: bigint;
  readonly originChain?: string;
  readonly nonce?: bigint;
  readonly limit?: number;
}

function mapJoinedTransitionRow(row: Record<string, unknown>): JoinedRailLifecycleTransition {
  return {
    id: bigintOf(row, "id"),
    transferId: bigintOf(row, "transfer_id"),
    route: integer(row, "route"),
    originChain: text(row, "origin_chain"),
    nonce: bigintOf(row, "nonce"),
    originTx: text(row, "origin_tx"),
    destinationChain: text(row, "destination_chain"),
    destination: text(row, "destination"),
    token: text(row, "token"),
    grossAmount: bigintOf(row, "gross_amount").toString(),
    netAmount: bigintOf(row, "net_amount").toString(),
    previousStatus: parseKnownStatus(
      textOrNull(row, "previous_status"),
      "rail_lifecycle_transition.previous_status",
    ),
    nextStatus: parseRequiredStatus(
      text(row, "next_status"),
      "rail_lifecycle_transition.next_status",
    ),
    reason: text(row, "reason"),
    evidence: {
      railStatus: textOrNull(row, "rail_status"),
      railReference: textOrNull(row, "rail_reference"),
      destinationTx: textOrNull(row, "destination_tx"),
      commandId: textOrNull(row, "command_id"),
      railMessageId: textOrNull(row, "rail_message_id"),
    },
    reconciled: boolean(row, "reconciled"),
    recordedAt: timestamp(row, "recorded_at"),
  };
}

/**
 * Read committed rail lifecycle transitions joined directly to their exact `outbound_transfer` row.
 */
export async function listRailLifecycleTransitions(
  db: Queryable,
  query: ListTransitionsQuery = {},
): Promise<readonly JoinedRailLifecycleTransition[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.transferId !== undefined) {
    params.push(query.transferId.toString());
    conditions.push(`h.transfer_id = $${String(params.length)}`);
  }
  if (query.originChain !== undefined) {
    params.push(query.originChain);
    conditions.push(`t.origin_chain = $${String(params.length)}`);
  }
  if (query.nonce !== undefined) {
    params.push(query.nonce.toString());
    conditions.push(`t.nonce = $${String(params.length)}`);
  }

  const boundedLimit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  params.push(boundedLimit);
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const { rows } = await db.query(
    `SELECT h.id,
            h.transfer_id,
            h.route,
            t.origin_chain,
            t.nonce,
            t.origin_tx,
            t.destination_chain,
            t.destination,
            t.token,
            t.gross_amount::text AS gross_amount,
            t.net_amount::text AS net_amount,
            h.previous_status,
            h.next_status,
            h.reason,
            h.rail_status,
            h.rail_reference,
            h.destination_tx,
            h.command_id,
            h.rail_message_id,
            h.reconciled,
            h.recorded_at
       FROM rail_lifecycle_transition h
       JOIN outbound_transfer t ON t.id = h.transfer_id
       ${whereClause}
      ORDER BY h.transfer_id ASC, h.id ASC
      LIMIT $${String(params.length)}`,
    params,
  );

  return rows.map((row) => mapJoinedTransitionRow(row));
}
