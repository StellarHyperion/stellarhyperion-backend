/**
 * Every statement that writes an indexed row, in one file, for both chain families.
 *
 * The tables are shared and the two families are not. A Soroban `BridgeIn` carries no rail message
 * id and an EVM one does; an EVM `ClaimParked` carries no timestamp and a Soroban one does; an EVM
 * `ActionQueued` carries a real `kind` discriminant and a Soroban one carries a union with no
 * ordinal on the wire. Those differences belong in the per-family decoders. What does not belong
 * there is the SQL, because the constraints are shared: `inbound_delivery_claim` says a row claims
 * either a delivery or a claim id and never both, and two files writing that table would be two
 * chances to violate it on one side only and find out from a 23514 in production.
 *
 * Every writer takes a `Queryable`, so the caller decides the transaction. The indexer's restart
 * safety is the claim that a page of rows and the cursor advance past it land together, and that
 * claim is only as good as nobody being able to write one without the other.
 *
 * Conflicts update rather than do nothing. On Stellar a re-read writes identical values, so the
 * difference is invisible. On an EVM chain a re-read can follow a reorg and carry the corrected
 * version of a block, and `DO NOTHING` would keep the orphaned one forever while looking like it
 * had handled the case. `observed_at` is deliberately left out of every update: it records when
 * this indexer first saw the row, and a reorg does not change that.
 */
import type { Queryable, Transactional } from "../db/pool.js";
import {
  bigintOf,
  boolean,
  enumText,
  integer,
  integerOrNull,
  maybeOne,
  text,
  textOrNull,
  timestamp,
  timestampOrNull,
} from "../db/rows.js";

/** Where on a chain a row was observed. One shape for a ledger and for a block. */
export interface Position {
  readonly chainKey: string;
  /** Ledger sequence on Stellar, block number on an EVM chain. */
  readonly block: bigint;
  readonly txHash: string;
  /** Log index on an EVM chain. Null on Stellar, which orders events differently. */
  readonly logIndex: number | null;
  /** The chain's own timestamp, never ours. Lag measured against our clock hides a stall. */
  readonly observedAt: Date;
}

export interface OutboundRow {
  readonly route: number;
  readonly nonce: bigint;
  readonly sender: string;
  readonly token: string;
  readonly grossAmount: bigint;
  readonly fee: bigint;
  readonly netAmount: bigint;
  readonly destinationChain: string;
  /**
   * Who gets the money on the far side, as the emitting chain spells it.
   *
   * Not normalised here, and that is on purpose. The Soroban router emits a 32 byte word, the EVM
   * router emits the strkey as a string, and both are what their chain actually said. Collapsing
   * them to one spelling is a presentation decision, and making it in the writer would throw away
   * the only copy of what was emitted.
   */
  readonly destination: string;
  readonly railRef: string | null;
}

export interface InboundRow {
  readonly route: number;
  readonly sourceChain: string;
  readonly sourceNonce: bigint;
  /** The rail's own id for the message. EVM only; the Soroban event does not emit one. */
  readonly railMessageId: string | null;
  readonly recipient: string;
  readonly token: string;
  readonly amount: bigint;
  readonly delivered: boolean;
  /** Set when the delivery parked, null when it landed. The schema checks exactly that. */
  readonly claimId: bigint | null;
}

export interface ClaimRow {
  readonly claimId: bigint;
  readonly recipient: string;
  readonly token: string;
  readonly amount: bigint;
  readonly route: number;
  readonly sourceChain: string;
  readonly sourceNonce: bigint;
  readonly createdAt: Date;
}

export interface ActionRow {
  readonly actionId: bigint;
  /**
   * The chain's own discriminant where it has one.
   *
   * Zero on Stellar, because `AdminAction` is a union with payload variants and the wire carries
   * the variant name rather than an ordinal. The name goes in the payload instead, which is why
   * this column is not the thing to read to find out what an action does.
   */
  readonly kind: number;
  readonly payload: unknown;
  readonly eta: Date | null;
  readonly expiresAt: Date | null;
}

export interface HealthSample {
  readonly originChain: string;
  readonly destinationChain: string;
  readonly route: number;
  readonly token: string;
  readonly available: boolean;
  /** `QuoteBlocker` as the integer the router returns. Zero when nothing is blocking. */
  readonly blocker: number;
  readonly flowAvailable: bigint | null;
}

export async function writeOutbound(db: Queryable, at: Position, row: OutboundRow): Promise<void> {
  await db.query(
    `INSERT INTO outbound_transfer
       (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
        destination_chain, destination, rail_ref, origin_block, origin_tx, origin_log_index,
        observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (origin_chain, nonce) DO UPDATE
       SET route = EXCLUDED.route,
           sender = EXCLUDED.sender,
           token = EXCLUDED.token,
           gross_amount = EXCLUDED.gross_amount,
           fee = EXCLUDED.fee,
           net_amount = EXCLUDED.net_amount,
           destination_chain = EXCLUDED.destination_chain,
           destination = EXCLUDED.destination,
           rail_ref = COALESCE(EXCLUDED.rail_ref, outbound_transfer.rail_ref),
           origin_block = EXCLUDED.origin_block,
           origin_tx = EXCLUDED.origin_tx,
           origin_log_index = EXCLUDED.origin_log_index`,
    [
      at.chainKey,
      row.route,
      row.nonce.toString(),
      row.sender,
      row.token,
      row.grossAmount.toString(),
      row.fee.toString(),
      row.netAmount.toString(),
      row.destinationChain,
      row.destination,
      row.railRef,
      at.block.toString(),
      at.txHash,
      at.logIndex,
      at.observedAt,
    ],
  );
}

export async function writeInbound(db: Queryable, at: Position, row: InboundRow): Promise<void> {
  await db.query(
    `INSERT INTO inbound_delivery
       (destination_chain, route, source_chain, source_nonce, rail_message_id, recipient, token,
        amount, delivered, claim_id, destination_block, destination_tx, destination_log_index,
        observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (destination_chain, route, source_chain, source_nonce) DO UPDATE
       SET rail_message_id = COALESCE(EXCLUDED.rail_message_id, inbound_delivery.rail_message_id),
           recipient = EXCLUDED.recipient,
           token = EXCLUDED.token,
           amount = EXCLUDED.amount,
           delivered = EXCLUDED.delivered,
           claim_id = EXCLUDED.claim_id,
           destination_block = EXCLUDED.destination_block,
           destination_tx = EXCLUDED.destination_tx,
           destination_log_index = EXCLUDED.destination_log_index`,
    [
      at.chainKey,
      row.route,
      row.sourceChain,
      row.sourceNonce.toString(),
      row.railMessageId,
      row.recipient,
      row.token,
      row.amount.toString(),
      row.delivered,
      row.claimId === null ? null : row.claimId.toString(),
      at.block.toString(),
      at.txHash,
      at.logIndex,
      at.observedAt,
    ],
  );
}

export async function writeClaim(db: Queryable, at: Position, row: ClaimRow): Promise<void> {
  await db.query(
    `INSERT INTO pending_claim
       (chain, claim_id, recipient, token, amount, route, source_chain, source_nonce,
        created_at, settled, observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, $10)
     ON CONFLICT (chain, claim_id) DO UPDATE
       SET recipient = EXCLUDED.recipient,
           token = EXCLUDED.token,
           amount = EXCLUDED.amount,
           route = EXCLUDED.route,
           source_chain = EXCLUDED.source_chain,
           source_nonce = EXCLUDED.source_nonce,
           created_at = EXCLUDED.created_at`,
    [
      at.chainKey,
      row.claimId.toString(),
      row.recipient,
      row.token,
      row.amount.toString(),
      row.route,
      row.sourceChain,
      row.sourceNonce.toString(),
      row.createdAt,
      at.observedAt,
    ],
  );
}

/**
 * Mark a claim settled.
 *
 * An update rather than an upsert, and it deliberately does nothing when the claim is not already
 * there. A settlement for a claim this indexer never saw parked means the park event is older than
 * the retention window, and inventing a row from a settlement would record a claim with no origin
 * and a created_at nobody knows. Returns whether it matched, so the caller can say so.
 */
export async function settleClaim(
  db: Queryable,
  at: Position,
  claimId: bigint,
  settledBy: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE pending_claim
        SET settled = true, settled_at = $3, settled_by = $4, settled_tx = $5
      WHERE chain = $1 AND claim_id = $2 AND NOT settled`,
    [at.chainKey, claimId.toString(), at.observedAt, settledBy, at.txHash],
  );
  return rowCount > 0;
}

/**
 * Record an action entering the timelock.
 *
 * The conflict update does not touch `state`, and that is the whole point of writing it out rather
 * than letting it default. The lifecycle events own the state column. A re-read of the window
 * holding the queue event, after the action has already executed in a later window, would
 * otherwise set it back to queued and leave it there, because nothing re-reads the execution.
 */
export async function writeAction(db: Queryable, at: Position, row: ActionRow): Promise<void> {
  await db.query(
    `INSERT INTO admin_action
       (chain, action_id, kind, state, payload, eta, expires_at, queued_at, observed_at)
     VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7, $8)
     ON CONFLICT (chain, action_id) DO UPDATE
       SET kind = EXCLUDED.kind,
           payload = EXCLUDED.payload,
           eta = EXCLUDED.eta,
           expires_at = EXCLUDED.expires_at,
           queued_at = EXCLUDED.queued_at`,
    [
      at.chainKey,
      row.actionId.toString(),
      row.kind,
      JSON.stringify(row.payload),
      row.eta,
      row.expiresAt,
      at.observedAt,
      at.observedAt,
    ],
  );
}

/**
 * Settle an action, which only moves it out of `queued`.
 *
 * Guarded on the current state so a re-read cannot execute an action twice or cancel one that
 * already executed. `actor` is coalesced because only one of the two EVM events carries one and
 * neither Soroban execution event does.
 */
export async function settleAction(
  db: Queryable,
  at: Position,
  actionId: bigint,
  state: "executed" | "cancelled",
  actor: string | null,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE admin_action
        SET state = $3, settled_at = $4, actor = COALESCE($5, actor)
      WHERE chain = $1 AND action_id = $2 AND state = 'queued'`,
    [at.chainKey, actionId.toString(), state, at.observedAt, actor],
  );
  return rowCount > 0;
}

/**
 * Append a route health sample.
 *
 * Append only, with no natural key, because the useful question is how a route behaved over the
 * last hour rather than what it says this second. The consequence worth knowing is that a replayed
 * window appends a second copy of each sample. Both carry the chain's own timestamp, so they are
 * the same sample twice and any aggregate over them is unchanged; what grows is the row count.
 */
export async function writeHealthSample(
  db: Queryable,
  at: Position,
  sample: HealthSample,
): Promise<void> {
  await db.query(
    `INSERT INTO route_health
       (sampled_at, origin_chain, destination_chain, route, token, available, blocker,
        flow_available)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      at.observedAt,
      sample.originChain,
      sample.destinationChain,
      sample.route,
      sample.token,
      sample.available,
      sample.blocker,
      sample.flowAvailable === null ? null : sample.flowAvailable.toString(),
    ],
  );
}

/**
 * Where a transfer is while it exists only in a rail's API.
 *
 * `transfer_id` is the primary key and a foreign key onto `outbound_transfer` with
 * `ON DELETE CASCADE`, so there is deliberately no upsert on a business key here: the row is
 * identified by the transfer it belongs to and cannot exist without it. The conflict update is
 * what every poll does, and it is written out field by field because two of them must not be
 * clobbered by a later poll that found nothing new.
 */
export interface AttestationRow {
  readonly transferId: bigint;
  readonly route: number;
  readonly status: string;
  readonly railStatus: string | null;
  readonly railReference: string | null;
  readonly attestedAt: Date | null;
  readonly checkedAt: Date;
  /** Consecutive failures for this transfer, distinct from the poller's own backoff. */
  readonly checkFailures: number;
  readonly lastError: string | null;
}

export async function writeAttestation(db: Queryable, row: AttestationRow): Promise<void> {
  await db.query(
    `INSERT INTO rail_attestation
       (transfer_id, route, status, rail_status, rail_reference, attested_at, last_checked_at,
        check_failures, last_error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (transfer_id) DO UPDATE
       SET status = EXCLUDED.status,
           rail_status = COALESCE(EXCLUDED.rail_status, rail_attestation.rail_status),
           -- Both coalesced on purpose. A later poll that finds the transfer still pending must
           -- not erase the reference or the moment it was attested; a rail that stops echoing a
           -- field back is not a rail taking it away.
           rail_reference = COALESCE(EXCLUDED.rail_reference, rail_attestation.rail_reference),
           attested_at = COALESCE(rail_attestation.attested_at, EXCLUDED.attested_at),
           last_checked_at = EXCLUDED.last_checked_at,
           check_failures = EXCLUDED.check_failures,
           last_error = EXCLUDED.last_error,
           updated_at = now()`,
    [
      row.transferId.toString(),
      row.route,
      row.status,
      row.railStatus,
      row.railReference,
      row.attestedAt,
      row.checkedAt,
      row.checkFailures,
      row.lastError,
    ],
  );
}

export const REJECTED_ERROR_CLASSES = [
  "decode_error",
  "shape_error",
  "constraint_violation",
  "state_mismatch",
  "transient_db_error",
  "unknown_error",
] as const;

export type RejectedErrorClass = (typeof REJECTED_ERROR_CLASSES)[number];

export const REJECTED_EVENT_STATUSES = ["rejected", "reconciled"] as const;
export type RejectedEventStatus = (typeof REJECTED_EVENT_STATUSES)[number];

export const REJECTED_FAMILIES = ["stellar", "evm"] as const;
export type RejectedChainFamily = (typeof REJECTED_FAMILIES)[number];

export const MAX_REJECTED_REF_LENGTH = 256;
export const MAX_REJECTED_TAG_LENGTH = 256;
export const MAX_REJECTED_CODE_LENGTH = 64;
export const MAX_REJECTED_ERROR_MESSAGE_LENGTH = 1_024;
export const MAX_REJECTED_PAYLOAD_PREVIEW_LENGTH = 4_096;
export const MAX_REJECTED_FAILURE_COUNT = 1_000_000;
export const DEFAULT_MAX_REPLAY_FAILURES = 25;

export interface NormalizedIngestionError {
  readonly errorClass: RejectedErrorClass;
  readonly errorCode: string | null;
  readonly errorMessage: string;
  readonly replayEligible: boolean;
}

export interface RejectedEventInput {
  readonly chainKey: string;
  readonly family: RejectedChainFamily;
  readonly contract: string;
  readonly blockNumber: bigint;
  readonly txHash: string;
  readonly eventRef: string;
  readonly logIndex: number | null;
  readonly eventTag: string | null;
  readonly error: unknown;
  readonly payload?: unknown;
  readonly replayEligible?: boolean;
  readonly maxReplayFailures?: number;
  readonly failedAt?: Date;
}

export interface RejectedEventRecord {
  readonly id: bigint;
  readonly chainKey: string;
  readonly family: RejectedChainFamily;
  readonly contract: string;
  readonly blockNumber: bigint;
  readonly txHash: string;
  readonly eventRef: string;
  readonly logIndex: number | null;
  readonly eventTag: string | null;
  readonly errorClass: RejectedErrorClass;
  readonly errorCode: string | null;
  readonly errorMessage: string;
  readonly replayEligible: boolean;
  readonly status: RejectedEventStatus;
  readonly payloadPreview: string | null;
  readonly payloadTruncated: boolean;
  readonly failureCount: number;
  readonly firstFailedAt: Date;
  readonly lastFailedAt: Date;
  readonly lastReplayAt: Date | null;
  readonly reconciledAt: Date | null;
  readonly reconciledTx: string | null;
}

const URL_CREDENTIALS_RE = /\b((?:postgres(?:ql)?|redis(?:s)?|https?|wss?):\/\/)([^/\s@]+@)/gi;
const QUERY_SECRET_RE =
  /([?&](?:api[_-]?key|apikey|token|access[_-]?token|secret|password|key|auth|signature)=)([^&\s"']+)/gi;
const AUTH_HEADER_RE = /(\bauthorization\s*[:=]\s*(?:bearer|basic)\s+)([^\s"',;}]+)/gi;
const KV_SECRET_RE =
  /(\b(?:x-api-key|api[_-]?key|secret|password|private[_-]?key|client[_-]?secret)\s*[:=]\s*["']?)([^\s"',;}]+)/gi;
const STELLAR_SECRET_SEED_RE = /\bS[A-Z2-7]{55}\b/g;

export function sanitizeRejectedDiagnostic(
  raw: string,
  maxLength: number,
): { readonly value: string; readonly truncated: boolean } {
  const scrubbed = raw
    .replace(URL_CREDENTIALS_RE, "$1[REDACTED]@")
    .replace(QUERY_SECRET_RE, "$1[REDACTED]")
    .replace(AUTH_HEADER_RE, "$1[REDACTED]")
    .replace(KV_SECRET_RE, "$1[REDACTED]")
    .replace(STELLAR_SECRET_SEED_RE, "[REDACTED_SEED]");

  if (scrubbed.length <= maxLength) {
    return { value: scrubbed, truncated: false };
  }
  const suffix = "...[truncated]";
  const budget = Math.max(0, maxLength - suffix.length);
  return {
    value: `${scrubbed.slice(0, budget)}${suffix}`.slice(0, maxLength),
    truncated: true,
  };
}

export function serializeRejectedPayload(payload: unknown): {
  readonly preview: string | null;
  readonly truncated: boolean;
} {
  if (payload === undefined || payload === null) {
    return { preview: null, truncated: false };
  }

  let serialized: string;
  try {
    serialized =
      typeof payload === "string"
        ? payload
        : JSON.stringify(payload, (_key, value: unknown) =>
            typeof value === "bigint" ? value.toString() : value,
          );
  } catch {
    serialized = "[unserializable_payload]";
  }

  const sanitized = sanitizeRejectedDiagnostic(serialized, MAX_REJECTED_PAYLOAD_PREVIEW_LENGTH);
  return { preview: sanitized.value, truncated: sanitized.truncated };
}

export function classifyIngestionError(error: unknown): NormalizedIngestionError {
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "unknown ingestion error";
  const sanitizedMessage =
    sanitizeRejectedDiagnostic(
      rawMessage || "unknown ingestion error",
      MAX_REJECTED_ERROR_MESSAGE_LENGTH,
    ).value || "unknown ingestion error";

  const name =
    typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
      ? error.name
      : null;
  const rawCode =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (typeof error.code === "string" || typeof error.code === "number")
      ? String(error.code)
      : null;
  const boundedCode =
    rawCode !== null
      ? sanitizeRejectedDiagnostic(rawCode, MAX_REJECTED_CODE_LENGTH).value
      : name !== null && name !== "Error"
        ? sanitizeRejectedDiagnostic(name, MAX_REJECTED_CODE_LENGTH).value
        : null;

  if (
    name === "ScValError" ||
    name === "StellarEventError" ||
    name === "AbiEncodingLengthMismatchError"
  ) {
    return {
      errorClass: "decode_error",
      errorCode: boundedCode,
      errorMessage: sanitizedMessage,
      replayEligible: true,
    };
  }

  if (
    name === "LogShapeError" ||
    name === "TypeError" ||
    name === "SyntaxError" ||
    name === "RangeError"
  ) {
    return {
      errorClass: "shape_error",
      errorCode: boundedCode,
      errorMessage: sanitizedMessage,
      replayEligible: true,
    };
  }

  if (name === "RowError") {
    return {
      errorClass: "state_mismatch",
      errorCode: boundedCode,
      errorMessage: sanitizedMessage,
      replayEligible: true,
    };
  }

  if (rawCode !== null) {
    if (
      rawCode === "40001" ||
      rawCode === "40P01" ||
      rawCode === "55P03" ||
      rawCode === "57014" ||
      rawCode.startsWith("08") ||
      rawCode.startsWith("53")
    ) {
      return {
        errorClass: "transient_db_error",
        errorCode: boundedCode,
        errorMessage: sanitizedMessage,
        replayEligible: true,
      };
    }

    if (rawCode.startsWith("22") || rawCode.startsWith("23")) {
      return {
        errorClass: "constraint_violation",
        errorCode: boundedCode,
        errorMessage: sanitizedMessage,
        replayEligible: false,
      };
    }
  }

  if (/deadlock|timeout|connection terminated|serialization failure/i.test(sanitizedMessage)) {
    return {
      errorClass: "transient_db_error",
      errorCode: boundedCode,
      errorMessage: sanitizedMessage,
      replayEligible: true,
    };
  }

  return {
    errorClass: "unknown_error",
    errorCode: boundedCode,
    errorMessage: sanitizedMessage,
    replayEligible: true,
  };
}

function parseRejectedEventRow(row: Record<string, unknown>): RejectedEventRecord {
  return {
    id: bigintOf(row, "id"),
    chainKey: text(row, "chain_key"),
    family: enumText(row, "family", REJECTED_FAMILIES),
    contract: text(row, "contract"),
    blockNumber: bigintOf(row, "block_number"),
    txHash: text(row, "tx_hash"),
    eventRef: text(row, "event_ref"),
    logIndex: integerOrNull(row, "log_index"),
    eventTag: textOrNull(row, "event_tag"),
    errorClass: enumText(row, "error_class", REJECTED_ERROR_CLASSES),
    errorCode: textOrNull(row, "error_code"),
    errorMessage: text(row, "error_message"),
    replayEligible: boolean(row, "replay_eligible"),
    status: enumText(row, "status", REJECTED_EVENT_STATUSES),
    payloadPreview: textOrNull(row, "payload_preview"),
    payloadTruncated: boolean(row, "payload_truncated"),
    failureCount: integer(row, "failure_count"),
    firstFailedAt: timestamp(row, "first_failed_at"),
    lastFailedAt: timestamp(row, "last_failed_at"),
    lastReplayAt: timestampOrNull(row, "last_replay_at"),
    reconciledAt: timestampOrNull(row, "reconciled_at"),
    reconciledTx: textOrNull(row, "reconciled_tx"),
  };
}

export async function writeRejectedEvent(db: Queryable, input: RejectedEventInput): Promise<void> {
  const classified = classifyIngestionError(input.error);
  const replayEligible = input.replayEligible ?? classified.replayEligible;
  const maxReplayFailures = Math.min(
    Math.max(input.maxReplayFailures ?? DEFAULT_MAX_REPLAY_FAILURES, 1),
    MAX_REJECTED_FAILURE_COUNT,
  );
  const payload = serializeRejectedPayload(input.payload);
  const boundedRef = sanitizeRejectedDiagnostic(input.eventRef, MAX_REJECTED_REF_LENGTH).value;
  if (boundedRef.length === 0) {
    throw new Error("rejected event reference must not be empty");
  }
  const boundedTag =
    input.eventTag !== null && input.eventTag.length > 0
      ? sanitizeRejectedDiagnostic(input.eventTag, MAX_REJECTED_TAG_LENGTH).value
      : null;
  const failedAt = input.failedAt ?? new Date();

  await db.query(
    `INSERT INTO rejected_event
       (chain_key, family, contract, block_number, tx_hash, event_ref, log_index, event_tag,
        error_class, error_code, error_message, replay_eligible, status, payload_preview,
        payload_truncated, failure_count, first_failed_at, last_failed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'rejected', $13, $14, 1, $15, $15)
     ON CONFLICT (chain_key, contract, event_ref) DO UPDATE
       SET family = EXCLUDED.family,
           block_number = EXCLUDED.block_number,
           tx_hash = EXCLUDED.tx_hash,
           log_index = EXCLUDED.log_index,
           event_tag = COALESCE(EXCLUDED.event_tag, rejected_event.event_tag),
           error_class = EXCLUDED.error_class,
           error_code = EXCLUDED.error_code,
           error_message = EXCLUDED.error_message,
           replay_eligible = CASE
             WHEN LEAST(rejected_event.failure_count + 1, ${String(MAX_REJECTED_FAILURE_COUNT)}) >= $16
               THEN false
             ELSE EXCLUDED.replay_eligible
           END,
           status = 'rejected',
           payload_preview = COALESCE(EXCLUDED.payload_preview, rejected_event.payload_preview),
           payload_truncated = EXCLUDED.payload_truncated OR rejected_event.payload_truncated,
           failure_count = LEAST(rejected_event.failure_count + 1, ${String(MAX_REJECTED_FAILURE_COUNT)}),
           last_failed_at = EXCLUDED.last_failed_at,
           reconciled_at = NULL,
           reconciled_tx = NULL`,
    [
      input.chainKey,
      input.family,
      input.contract,
      input.blockNumber.toString(),
      sanitizeRejectedDiagnostic(input.txHash, MAX_REJECTED_REF_LENGTH).value,
      boundedRef,
      input.logIndex,
      boundedTag,
      classified.errorClass,
      classified.errorCode,
      classified.errorMessage,
      replayEligible,
      payload.preview,
      payload.truncated,
      failedAt,
      maxReplayFailures,
    ],
  );
}

export async function reconcileRejectedEvents(
  db: Queryable,
  input: {
    readonly chainKey: string;
    readonly contract: string;
    readonly eventRefs: readonly string[];
    readonly reconciledAt?: Date;
    readonly reconciledTx?: string | null;
  },
): Promise<number> {
  if (input.eventRefs.length === 0) return 0;
  const boundedRefs = input.eventRefs.map(
    (ref) => sanitizeRejectedDiagnostic(ref, MAX_REJECTED_REF_LENGTH).value,
  );
  const reconciledAt = input.reconciledAt ?? new Date();
  const reconciledTx =
    input.reconciledTx !== undefined && input.reconciledTx !== null
      ? sanitizeRejectedDiagnostic(input.reconciledTx, MAX_REJECTED_REF_LENGTH).value
      : null;

  const { rowCount } = await db.query(
    `UPDATE rejected_event
        SET status = 'reconciled',
            reconciled_at = $4,
            reconciled_tx = COALESCE($5, tx_hash),
            last_replay_at = $4
      WHERE chain_key = $1
        AND contract = $2
        AND event_ref = ANY($3::text[])
        AND status = 'rejected'`,
    [input.chainKey, input.contract, boundedRefs, reconciledAt, reconciledTx],
  );
  return rowCount;
}

export async function readRejectedEvent(
  db: Queryable,
  chainKey: string,
  contract: string,
  eventRef: string,
): Promise<RejectedEventRecord | null> {
  const { rows } = await db.query(
    `SELECT * FROM rejected_event
      WHERE chain_key = $1 AND contract = $2 AND event_ref = $3`,
    [chainKey, contract, eventRef],
  );
  const row = maybeOne(rows, `rejected_event for ${chainKey}:${eventRef}`);
  return row === null ? null : parseRejectedEventRow(row);
}

export async function listRejectedEvents(
  db: Queryable,
  options: {
    readonly chainKey?: string;
    readonly contract?: string;
    readonly status?: RejectedEventStatus;
    readonly replayEligible?: boolean;
    readonly limit?: number;
  } = {},
): Promise<readonly RejectedEventRecord[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const { rows } = await db.query(
    `SELECT * FROM rejected_event
      WHERE ($1::text IS NULL OR chain_key = $1)
        AND ($2::text IS NULL OR contract = $2)
        AND ($3::text IS NULL OR status = $3)
        AND ($4::boolean IS NULL OR replay_eligible = $4)
      ORDER BY block_number ASC, id ASC
      LIMIT $5`,
    [
      options.chainKey ?? null,
      options.contract ?? null,
      options.status ?? null,
      options.replayEligible ?? null,
      limit,
    ],
  );
  return rows.map(parseRejectedEventRow);
}

export interface ReplayRejectedEventsResult {
  readonly attempted: number;
  readonly reconciled: number;
  readonly failed: number;
}

export async function replayRejectedEvents(
  db: Transactional,
  options: {
    readonly chainKey: string;
    readonly contract?: string;
    readonly limit?: number;
    readonly maxReplayFailures?: number;
    readonly now?: () => Date;
    readonly apply: (
      tx: Queryable,
      record: RejectedEventRecord,
    ) => Promise<{ readonly reconciledTx?: string | null } | undefined>;
  },
): Promise<ReplayRejectedEventsResult> {
  const candidates = await listRejectedEvents(db, {
    chainKey: options.chainKey,
    ...(options.contract === undefined ? {} : { contract: options.contract }),
    status: "rejected",
    replayEligible: true,
    limit: options.limit ?? 50,
  });

  const maxReplayFailures = Math.min(
    Math.max(options.maxReplayFailures ?? DEFAULT_MAX_REPLAY_FAILURES, 1),
    MAX_REJECTED_FAILURE_COUNT,
  );

  let attempted = 0;
  let reconciled = 0;
  let failed = 0;

  for (const record of candidates) {
    attempted += 1;
    const replayTime = options.now ? options.now() : new Date();
    try {
      await db.transaction(async (tx) => {
        const outcome = await options.apply(tx, record);
        await reconcileRejectedEvents(tx, {
          chainKey: record.chainKey,
          contract: record.contract,
          eventRefs: [record.eventRef],
          reconciledAt: replayTime,
          reconciledTx: outcome?.reconciledTx ?? record.txHash,
        });
      });
      reconciled += 1;
    } catch (error) {
      failed += 1;
      const classified = classifyIngestionError(error);
      await db.query(
        `UPDATE rejected_event
            SET error_class = $2,
                error_code = $3,
                error_message = $4,
                failure_count = LEAST(failure_count + 1, ${String(MAX_REJECTED_FAILURE_COUNT)}),
                replay_eligible = CASE
                  WHEN LEAST(failure_count + 1, ${String(MAX_REJECTED_FAILURE_COUNT)}) >= $6
                    THEN false
                  ELSE $5
                END,
                last_failed_at = $7,
                last_replay_at = $7
          WHERE id = $1`,
        [
          record.id.toString(),
          classified.errorClass,
          classified.errorCode,
          classified.errorMessage,
          classified.replayEligible,
          maxReplayFailures,
          replayTime,
        ],
      );
    }
  }

  return { attempted, reconciled, failed };
}
