/**
 * Durable per-transfer retry classification, exponential backoff computation, and explicit
 * operator recovery rules for terminal evidence failures.
 *
 * Persisting `retry_class` and `next_attempt_at` on `rail_attestation` guarantees that worker
 * restarts do not reset per-transfer backoff into immediate retry storms, while never altering
 * `outbound_transfer` source intent or destination proof verification requirements.
 */
import { writeAttestation, type AttestationRow } from "../chains/writers.js";
import type { Queryable, Transactional } from "../db/pool.js";
import { integer, maybeOne, text, textOrNull, timestampOrNull } from "../db/rows.js";
import {
  RailError,
  isTerminal,
  type AttestationStatus,
  type RailRetryClass,
  type RetrySchedulePolicy,
  type TerminalRetryRecoveryOutcome,
  type TerminalRetryRecoveryRequest,
} from "./types.js";

export const DEFAULT_BASE_BACKOFF_MS = 5_000;
export const DEFAULT_MAX_BACKOFF_MS = 300_000;
export const DEFAULT_RATE_LIMIT_MS = 60_000;

const VALID_RETRY_CLASSES: readonly RailRetryClass[] = [
  "awaiting_index",
  "awaiting_delivery_proof",
  "transient_provider",
  "rate_limited",
  "terminal_evidence",
  "settled",
];

const VALID_STATUSES: readonly AttestationStatus[] = [
  "pending",
  "attested",
  "delivered",
  "failed",
  "expired",
];

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /\b(api[_-]?key|secret|password|passwd|bearer|private[_-]?key)\s*[:=]/i,
];

export interface ResolvedRetryPolicy {
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly defaultRateLimitMs: number;
}

export interface ComputedRetrySchedule {
  readonly retryClass: RailRetryClass;
  readonly nextAttemptAt: Date | null;
}

export function resolveRetryPolicy(policy?: RetrySchedulePolicy): ResolvedRetryPolicy {
  const baseBackoffMs = Math.max(1, policy?.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS);
  const maxBackoffMs = Math.max(baseBackoffMs, policy?.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS);
  const defaultRateLimitMs = Math.max(1, policy?.defaultRateLimitMs ?? DEFAULT_RATE_LIMIT_MS);
  return { baseBackoffMs, maxBackoffMs, defaultRateLimitMs };
}

export function parseRetryClass(value: string | null): RailRetryClass | null {
  if (value === null) return null;
  const found = VALID_RETRY_CLASSES.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new Error(`rail_attestation.retry_class holds unknown value ${value}`);
  }
  return found;
}

function parseStatus(value: string): AttestationStatus {
  const found = VALID_STATUSES.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new Error(`rail_attestation.status holds unknown value ${value}`);
  }
  return found;
}

export function computeHealthySchedule(
  status: AttestationStatus,
  lookupKind: "delivered" | "missing" | "found",
  now: Date,
  recheckAfterMs: number,
): ComputedRetrySchedule {
  if (lookupKind === "delivered" || status === "delivered") {
    return { retryClass: "settled", nextAttemptAt: null };
  }
  if (isTerminal(status)) {
    return { retryClass: "terminal_evidence", nextAttemptAt: null };
  }
  const waitMs = Math.max(0, recheckAfterMs);
  const nextAttemptAt = new Date(now.getTime() + waitMs);
  return {
    retryClass: lookupKind === "missing" ? "awaiting_index" : "awaiting_delivery_proof",
    nextAttemptAt,
  };
}

export function computeFailureSchedule(
  error: unknown,
  consecutiveFailures: number,
  maxCheckFailures: number,
  now: Date,
  policy?: RetrySchedulePolicy,
): ComputedRetrySchedule {
  const resolved = resolveRetryPolicy(policy);

  if (error instanceof RailError && error.kind === "permanent") {
    return { retryClass: "terminal_evidence", nextAttemptAt: null };
  }

  if (error instanceof RailError && error.kind === "rateLimited") {
    const waitMs = error.retryAfterMs ?? resolved.defaultRateLimitMs;
    return {
      retryClass: "rate_limited",
      nextAttemptAt: new Date(now.getTime() + Math.max(1, waitMs)),
    };
  }

  if (consecutiveFailures >= maxCheckFailures) {
    return { retryClass: "terminal_evidence", nextAttemptAt: null };
  }

  const exponent = Math.min(12, Math.max(0, consecutiveFailures - 1));
  const exponentialMs = Math.min(resolved.maxBackoffMs, resolved.baseBackoffMs * 2 ** exponent);
  const retryAfterMs = error instanceof RailError ? error.retryAfterMs : null;
  const delayMs =
    retryAfterMs !== null && retryAfterMs > exponentialMs ? retryAfterMs : exponentialMs;

  return {
    retryClass: "transient_provider",
    nextAttemptAt: new Date(now.getTime() + delayMs),
  };
}

export interface ScheduledAttestationRow extends AttestationRow {
  readonly retryClass: RailRetryClass;
  readonly nextAttemptAt: Date | null;
}

export async function writeScheduledAttestation(
  db: Queryable,
  row: ScheduledAttestationRow,
): Promise<void> {
  await writeAttestation(db, row);
  await db.query(
    `UPDATE rail_attestation
        SET retry_class = $2,
            next_attempt_at = $3,
            updated_at = now()
      WHERE transfer_id = $1`,
    [row.transferId.toString(), row.retryClass, row.nextAttemptAt],
  );
}

export interface PersistedRetrySchedule {
  readonly transferId: bigint;
  readonly status: AttestationStatus;
  readonly retryClass: RailRetryClass | null;
  readonly nextAttemptAt: Date | null;
  readonly checkFailures: number;
  readonly lastError: string | null;
  readonly recoveryNote: string | null;
  readonly recoveredAt: Date | null;
}

export async function readRetrySchedule(
  db: Queryable,
  transferId: bigint,
): Promise<PersistedRetrySchedule | null> {
  const res = await db.query(
    `SELECT status, retry_class, next_attempt_at, check_failures, last_error,
            recovery_note, recovered_at
       FROM rail_attestation
      WHERE transfer_id = $1`,
    [transferId.toString()],
  );
  const row = maybeOne(res.rows, "rail_attestation");
  if (row === null) return null;
  return {
    transferId,
    status: parseStatus(text(row, "status")),
    retryClass: parseRetryClass(textOrNull(row, "retry_class")),
    nextAttemptAt: timestampOrNull(row, "next_attempt_at"),
    checkFailures: integer(row, "check_failures"),
    lastError: textOrNull(row, "last_error"),
    recoveryNote: textOrNull(row, "recovery_note"),
    recoveredAt: timestampOrNull(row, "recovered_at"),
  };
}

function validateOperatorText(field: string, raw: string, maxLen: number): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (trimmed.length > maxLen) {
    throw new Error(`${field} exceeds maximum length of ${String(maxLen)} characters`);
  }
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new Error(`${field} must not contain credentials`);
    }
  }
  return trimmed;
}

/**
 * Explicit operator recovery rule for transfers halted by `terminal_evidence` (or terminal
 * `failed`/`expired` status). Never mutates `outbound_transfer` or relaxes proof checks.
 */
export async function recoverTerminalRetrySchedule(
  db: Transactional,
  request: TerminalRetryRecoveryRequest,
): Promise<TerminalRetryRecoveryOutcome> {
  if (request.transferId <= 0n) {
    throw new Error("transferId must be a positive integer");
  }
  const reviewedBy = validateOperatorText("reviewedBy", request.reviewedBy, 128);
  const reason = validateOperatorText("reason", request.reason, 512);
  const now = request.now ?? new Date();
  const nextAttemptAt = request.scheduleAt ?? now;

  return db.transaction(async (tx) => {
    const outboundRes = await tx.query(
      `SELECT id, route, origin_chain, destination_chain, nonce
         FROM outbound_transfer
        WHERE id = $1
        FOR UPDATE`,
      [request.transferId.toString()],
    );
    const outbound = maybeOne(outboundRes.rows, "outbound_transfer");
    if (outbound === null) {
      return {
        kind: "refused",
        code: "not_found",
        detail: "no matching outbound_transfer row exists",
      };
    }

    const inboundRes = await tx.query(
      `SELECT id
         FROM inbound_delivery
        WHERE destination_chain = $1
          AND route = $2
          AND source_chain = $3
          AND source_nonce = $4
        FOR UPDATE`,
      [
        text(outbound, "destination_chain"),
        integer(outbound, "route"),
        text(outbound, "origin_chain"),
        outbound.nonce,
      ],
    );
    if (inboundRes.rows.length > 0) {
      return {
        kind: "refused",
        code: "already_delivered",
        detail: "destination delivery proof already exists in inbound_delivery",
      };
    }

    const attRes = await tx.query(
      `SELECT status, retry_class, rail_reference
         FROM rail_attestation
        WHERE transfer_id = $1
        FOR UPDATE`,
      [request.transferId.toString()],
    );
    const att = maybeOne(attRes.rows, "rail_attestation");
    if (att === null) {
      return {
        kind: "refused",
        code: "not_terminal_evidence",
        detail: "transfer has no rail_attestation row and is already eligible for polling",
      };
    }

    const priorStatus = parseStatus(text(att, "status"));
    if (priorStatus === "delivered") {
      return {
        kind: "refused",
        code: "already_delivered",
        detail: "delivered transfers cannot be re-scheduled",
      };
    }

    const priorRetryClass = parseRetryClass(textOrNull(att, "retry_class"));
    const isTerminalState =
      priorRetryClass === "terminal_evidence" ||
      priorStatus === "failed" ||
      priorStatus === "expired";

    if (!isTerminalState) {
      return {
        kind: "refused",
        code: "not_terminal_evidence",
        detail: `transfer has status=${priorStatus} and retry_class=${priorRetryClass ?? "null"}; automatic retry schedule is still active`,
      };
    }

    const hasReference = textOrNull(att, "rail_reference") !== null;
    const newStatus: "pending" | "attested" = priorStatus === "attested" ? "attested" : "pending";
    const newRetryClass: "awaiting_index" | "awaiting_delivery_proof" = hasReference
      ? "awaiting_delivery_proof"
      : "awaiting_index";
    const recoveryNote = `${reviewedBy}: ${reason}`;

    await tx.query(
      `UPDATE rail_attestation
          SET status = $2,
              retry_class = $3,
              next_attempt_at = $4,
              check_failures = 0,
              last_error = NULL,
              recovery_note = $5,
              recovered_at = $6,
              updated_at = $6
        WHERE transfer_id = $1`,
      [request.transferId.toString(), newStatus, newRetryClass, nextAttemptAt, recoveryNote, now],
    );

    return {
      kind: "recovered",
      transferId: request.transferId,
      priorStatus,
      priorRetryClass,
      newStatus,
      newRetryClass,
      nextAttemptAt,
      recoveryNote,
    };
  });
}
