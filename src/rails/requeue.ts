/**
 * Controlled operator-reviewed requeue for failed or expired rail transfers.
 *
 * A transfer that previously stopped in `failed` or `expired` may gain new public evidence later
 * (for example, a delayed attestation or gas-funded execution). Reopening it must:
 *   1. Leave `outbound_transfer` untouched so original amount, recipient, and source identity
 *      cannot drift.
 *   2. Record every reviewed transition (`prior_status` -> `pending`, actor, reason, optional
 *      public evidence reference) in `rail_requeue_audit`.
 *   3. Refuse any transfer that already reached `delivered` or already has an `inbound_delivery`
 *      row, and refuse non-terminal transfers so repeated requeue cannot duplicate a payout or
 *      audit trail.
 */
import type { Queryable, Transactional } from "../db/pool.js";
import {
  bigintOf,
  integer,
  integerOrNull,
  maybeOne,
  one,
  text,
  textOrNull,
  timestamp,
  type Row,
} from "../db/rows.js";
import {
  isRecoverableTerminalStatus,
  type AttestationStatus,
  type PreservedTransferIdentity,
  type RecoverableTerminalStatus,
  type RequeueAuditEntry,
  type RequeueSelector,
  type RequeueTransferOutcome,
  type RequeueTransferRequest,
} from "./types.js";

const STATUSES: readonly AttestationStatus[] = [
  "pending",
  "attested",
  "delivered",
  "failed",
  "expired",
];

const MAX_ACTOR_LENGTH = 128;
const MAX_REASON_LENGTH = 512;
const MAX_EVIDENCE_LENGTH = 256;

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /\b(api[_-]?key|secret|password|passwd|bearer|private[_-]?key)\s*[:=]/i,
  /\bAuthorization:\s*Bearer\b/i,
];

export class RailRequeueValidationError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "RailRequeueValidationError";
  }
}

interface ValidatedRequeueInput {
  readonly selector: RequeueSelector;
  readonly reviewedBy: string;
  readonly reason: string;
  readonly evidenceReference: string | null;
  readonly at: Date;
}

function assertCredentialFree(field: string, value: string): void {
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(value)) {
      throw new RailRequeueValidationError(
        `${field} must not contain credentials or secret material`,
      );
    }
  }
}

function validateRequeueInput(request: RequeueTransferRequest): ValidatedRequeueInput {
  const reviewedBy = request.reviewedBy.trim();
  if (reviewedBy.length === 0) {
    throw new RailRequeueValidationError("reviewedBy must be a non-empty operator identifier");
  }
  if (reviewedBy.length > MAX_ACTOR_LENGTH) {
    throw new RailRequeueValidationError(
      `reviewedBy exceeds maximum length of ${String(MAX_ACTOR_LENGTH)} characters`,
    );
  }
  assertCredentialFree("reviewedBy", reviewedBy);

  const reason = request.reason.trim();
  if (reason.length === 0) {
    throw new RailRequeueValidationError("reason must be a non-empty operator review explanation");
  }
  if (reason.length > MAX_REASON_LENGTH) {
    throw new RailRequeueValidationError(
      `reason exceeds maximum length of ${String(MAX_REASON_LENGTH)} characters`,
    );
  }
  assertCredentialFree("reason", reason);

  const rawEvidence = request.evidenceReference ?? null;
  let evidenceReference: string | null = null;
  if (rawEvidence !== null) {
    const trimmed = rawEvidence.trim();
    if (trimmed.length > MAX_EVIDENCE_LENGTH) {
      throw new RailRequeueValidationError(
        `evidenceReference exceeds maximum length of ${String(MAX_EVIDENCE_LENGTH)} characters`,
      );
    }
    if (trimmed.length > 0) {
      assertCredentialFree("evidenceReference", trimmed);
      evidenceReference = trimmed;
    }
  }

  if ("transferId" in request.selector) {
    if (request.selector.transferId <= 0n) {
      throw new RailRequeueValidationError("transferId must be a positive integer");
    }
  } else {
    const chain = request.selector.originChain.trim();
    if (chain.length === 0) {
      throw new RailRequeueValidationError("originChain must be non-empty");
    }
    if (request.selector.nonce < 0n) {
      throw new RailRequeueValidationError("nonce must be non-negative");
    }
  }

  return {
    selector:
      "transferId" in request.selector
        ? { transferId: request.selector.transferId }
        : { originChain: request.selector.originChain.trim(), nonce: request.selector.nonce },
    reviewedBy,
    reason,
    evidenceReference,
    at: request.at ?? new Date(),
  };
}

function parseAttestationStatus(value: string): AttestationStatus {
  const found = STATUSES.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new Error(`rail_attestation.status holds ${value}, which this build does not know`);
  }
  return found;
}

function parseRecoverableStatus(value: string): RecoverableTerminalStatus {
  if (value === "failed" || value === "expired") return value;
  throw new Error(`rail_requeue_audit.prior_status holds unexpected value ${value}`);
}

function readTransferIdentity(row: Row): PreservedTransferIdentity {
  return {
    transferId: bigintOf(row, "id"),
    originChain: text(row, "origin_chain"),
    route: integer(row, "route"),
    nonce: bigintOf(row, "nonce"),
    sender: text(row, "sender"),
    token: text(row, "token"),
    grossAmount: bigintOf(row, "gross_amount"),
    fee: bigintOf(row, "fee"),
    netAmount: bigintOf(row, "net_amount"),
    destinationChain: text(row, "destination_chain"),
    destination: text(row, "destination"),
    railRef: textOrNull(row, "rail_ref"),
    originBlock: bigintOf(row, "origin_block"),
    originTx: text(row, "origin_tx"),
    originLogIndex: integerOrNull(row, "origin_log_index"),
  };
}

function readAuditEntry(row: Row): RequeueAuditEntry {
  const newStatus = text(row, "new_status");
  if (newStatus !== "pending") {
    throw new Error(`rail_requeue_audit.new_status holds unexpected value ${newStatus}`);
  }
  return {
    id: bigintOf(row, "id"),
    transferId: bigintOf(row, "transfer_id"),
    route: integer(row, "route"),
    originChain: text(row, "origin_chain"),
    nonce: bigintOf(row, "nonce"),
    priorStatus: parseRecoverableStatus(text(row, "prior_status")),
    newStatus: "pending",
    priorRailStatus: textOrNull(row, "prior_rail_status"),
    priorRailReference: textOrNull(row, "prior_rail_reference"),
    priorCheckFailures: integer(row, "prior_check_failures"),
    reviewedBy: text(row, "reviewed_by"),
    reviewedReason: text(row, "reviewed_reason"),
    evidenceReference: textOrNull(row, "evidence_reference"),
    requeuedAt: timestamp(row, "requeued_at"),
  };
}

/**
 * Re-open a `failed` or `expired` rail transfer to `pending` inside a single locked transaction.
 *
 * `outbound_transfer` is read and locked (`FOR UPDATE`) to anchor source identity, recipient, and
 * amounts, and is never mutated. If an `inbound_delivery` hop row already exists or the attestation
 * is already `delivered`, the request is refused without altering state.
 */
export async function requeueTerminalTransfer(
  db: Transactional,
  request: RequeueTransferRequest,
): Promise<RequeueTransferOutcome> {
  const input = validateRequeueInput(request);

  return db.transaction(async (tx) => {
    const outboundResult =
      "transferId" in input.selector
        ? await tx.query(
            `SELECT id, origin_chain, route, nonce, sender, token,
                    gross_amount, fee, net_amount, destination_chain, destination,
                    rail_ref, origin_block, origin_tx, origin_log_index
               FROM outbound_transfer
              WHERE id = $1
              FOR UPDATE`,
            [input.selector.transferId.toString()],
          )
        : await tx.query(
            `SELECT id, origin_chain, route, nonce, sender, token,
                    gross_amount, fee, net_amount, destination_chain, destination,
                    rail_ref, origin_block, origin_tx, origin_log_index
               FROM outbound_transfer
              WHERE origin_chain = $1 AND nonce = $2
              FOR UPDATE`,
            [input.selector.originChain, input.selector.nonce.toString()],
          );

    const outboundRow = maybeOne(outboundResult.rows, "outbound_transfer");
    if (outboundRow === null) {
      return {
        kind: "refused",
        code: "not_found",
        detail: "no matching outbound_transfer row exists",
        currentStatus: null,
      };
    }

    const transfer = readTransferIdentity(outboundRow);

    const inboundResult = await tx.query(
      `SELECT id, destination_tx
         FROM inbound_delivery
        WHERE destination_chain = $1
          AND route = $2
          AND source_chain = $3
          AND source_nonce = $4
        FOR UPDATE`,
      [transfer.destinationChain, transfer.route, transfer.originChain, transfer.nonce.toString()],
    );
    const existingInbound = maybeOne(inboundResult.rows, "inbound_delivery");

    const attestationResult = await tx.query(
      `SELECT status, rail_status, rail_reference, check_failures
         FROM rail_attestation
        WHERE transfer_id = $1
        FOR UPDATE`,
      [transfer.transferId.toString()],
    );
    const attestationRow = maybeOne(attestationResult.rows, "rail_attestation");

    if (existingInbound !== null) {
      const currentStatus =
        attestationRow === null ? null : parseAttestationStatus(text(attestationRow, "status"));
      return {
        kind: "refused",
        code: "already_delivered",
        detail: `destination payout already recorded in inbound_delivery (tx ${text(existingInbound, "destination_tx")})`,
        currentStatus,
        transfer,
      };
    }

    if (attestationRow === null) {
      return {
        kind: "refused",
        code: "missing_attestation",
        detail: "transfer has no rail_attestation row and is already eligible for polling",
        currentStatus: null,
        transfer,
      };
    }

    const currentStatus = parseAttestationStatus(text(attestationRow, "status"));
    if (currentStatus === "delivered") {
      return {
        kind: "refused",
        code: "already_delivered",
        detail: "transfer is already marked delivered and cannot be requeued",
        currentStatus,
        transfer,
      };
    }

    if (!isRecoverableTerminalStatus(currentStatus)) {
      return {
        kind: "refused",
        code: "not_terminal",
        detail: `transfer status is ${currentStatus}; only failed or expired transfers may be requeued`,
        currentStatus,
        transfer,
      };
    }

    const priorRailStatus = textOrNull(attestationRow, "rail_status");
    const priorRailReference = textOrNull(attestationRow, "rail_reference");
    const priorCheckFailures = integer(attestationRow, "check_failures");

    await tx.query(
      `UPDATE rail_attestation
          SET status = 'pending',
              check_failures = 0,
              last_checked_at = NULL,
              last_error = NULL,
              updated_at = $2
        WHERE transfer_id = $1`,
      [transfer.transferId.toString(), input.at],
    );

    const auditInsert = await tx.query(
      `INSERT INTO rail_requeue_audit
         (transfer_id, route, origin_chain, nonce, prior_status, new_status,
          prior_rail_status, prior_rail_reference, prior_check_failures,
          reviewed_by, reviewed_reason, evidence_reference, requeued_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, transfer_id, route, origin_chain, nonce, prior_status, new_status,
                 prior_rail_status, prior_rail_reference, prior_check_failures,
                 reviewed_by, reviewed_reason, evidence_reference, requeued_at`,
      [
        transfer.transferId.toString(),
        transfer.route,
        transfer.originChain,
        transfer.nonce.toString(),
        currentStatus,
        priorRailStatus,
        priorRailReference,
        priorCheckFailures,
        input.reviewedBy,
        input.reason,
        input.evidenceReference,
        input.at,
      ],
    );

    return {
      kind: "requeued",
      audit: readAuditEntry(one(auditInsert.rows, "rail_requeue_audit")),
      transfer,
    };
  });
}

/** Read recorded operator requeue transitions for a transfer, oldest first. */
export async function listRequeueAudit(
  db: Queryable,
  transferId: bigint,
): Promise<readonly RequeueAuditEntry[]> {
  const { rows } = await db.query(
    `SELECT id, transfer_id, route, origin_chain, nonce, prior_status, new_status,
            prior_rail_status, prior_rail_reference, prior_check_failures,
            reviewed_by, reviewed_reason, evidence_reference, requeued_at
       FROM rail_requeue_audit
      WHERE transfer_id = $1
      ORDER BY requeued_at ASC, id ASC`,
    [transferId.toString()],
  );
  return rows.map((row) => readAuditEntry(row));
}

export interface ParsedRequeueCliArgs {
  readonly request: RequeueTransferRequest;
  readonly evaluateNow: boolean;
}

export function parseRequeueCliArgs(argv: readonly string[]): ParsedRequeueCliArgs {
  let transferId: bigint | null = null;
  let originChain: string | null = null;
  let nonce: bigint | null = null;
  let reviewedBy: string | null = null;
  let reason: string | null = null;
  let evidenceReference: string | null = null;
  let evaluateNow = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--evaluate-now") {
      evaluateNow = true;
      continue;
    }

    const nextValue = (): string => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new RailRequeueValidationError(`flag ${arg} requires a value`);
      }
      i += 1;
      return next;
    };

    switch (arg) {
      case "--transfer-id": {
        const raw = nextValue();
        if (!/^\d+$/.test(raw)) {
          throw new RailRequeueValidationError("--transfer-id must be an unsigned integer");
        }
        transferId = BigInt(raw);
        break;
      }
      case "--origin-chain":
        originChain = nextValue();
        break;
      case "--nonce": {
        const raw = nextValue();
        if (!/^\d+$/.test(raw)) {
          throw new RailRequeueValidationError("--nonce must be an unsigned integer");
        }
        nonce = BigInt(raw);
        break;
      }
      case "--reviewed-by":
        reviewedBy = nextValue();
        break;
      case "--reason":
        reason = nextValue();
        break;
      case "--evidence":
        evidenceReference = nextValue();
        break;
      default:
        throw new RailRequeueValidationError(`unknown flag: ${arg}`);
    }
  }

  let selector: RequeueSelector;
  if (transferId !== null) {
    if (originChain !== null || nonce !== null) {
      throw new RailRequeueValidationError(
        "specify either --transfer-id or (--origin-chain and --nonce), not both",
      );
    }
    selector = { transferId };
  } else if (originChain !== null && nonce !== null) {
    selector = { originChain, nonce };
  } else {
    throw new RailRequeueValidationError(
      "specify either --transfer-id <id> or --origin-chain <chain> --nonce <u64>",
    );
  }

  if (reviewedBy === null) {
    throw new RailRequeueValidationError("--reviewed-by is required");
  }
  if (reason === null) {
    throw new RailRequeueValidationError("--reason is required");
  }

  const request: RequeueTransferRequest = {
    selector,
    reviewedBy,
    reason,
    ...(evidenceReference !== null ? { evidenceReference } : {}),
  };
  validateRequeueInput(request);

  return { request, evaluateNow };
}

export function serializeRequeueOutcome(
  outcome: RequeueTransferOutcome,
  evaluated?: { readonly attempted: boolean; readonly settled: boolean },
): Record<string, unknown> {
  const serializeTransfer = (t: PreservedTransferIdentity): Record<string, unknown> => ({
    transferId: t.transferId.toString(),
    originChain: t.originChain,
    route: t.route,
    nonce: t.nonce.toString(),
    sender: t.sender,
    token: t.token,
    grossAmount: t.grossAmount.toString(),
    fee: t.fee.toString(),
    netAmount: t.netAmount.toString(),
    destinationChain: t.destinationChain,
    destination: t.destination,
    railRef: t.railRef,
    originBlock: t.originBlock.toString(),
    originTx: t.originTx,
    originLogIndex: t.originLogIndex,
  });

  if (outcome.kind === "requeued") {
    return {
      kind: "requeued",
      audit: {
        id: outcome.audit.id.toString(),
        transferId: outcome.audit.transferId.toString(),
        route: outcome.audit.route,
        originChain: outcome.audit.originChain,
        nonce: outcome.audit.nonce.toString(),
        priorStatus: outcome.audit.priorStatus,
        newStatus: outcome.audit.newStatus,
        priorRailStatus: outcome.audit.priorRailStatus,
        priorRailReference: outcome.audit.priorRailReference,
        priorCheckFailures: outcome.audit.priorCheckFailures,
        reviewedBy: outcome.audit.reviewedBy,
        reviewedReason: outcome.audit.reviewedReason,
        evidenceReference: outcome.audit.evidenceReference,
        requeuedAt: outcome.audit.requeuedAt.toISOString(),
      },
      transfer: serializeTransfer(outcome.transfer),
      ...(evaluated !== undefined ? { evaluation: evaluated } : {}),
    };
  }

  return {
    kind: "refused",
    code: outcome.code,
    detail: outcome.detail,
    currentStatus: outcome.currentStatus,
    ...(outcome.transfer !== undefined ? { transfer: serializeTransfer(outcome.transfer) } : {}),
  };
}

export interface RequeueCommandDeps {
  readonly db: Transactional;
  readonly evaluateTransfer?:
    ((route: number, transferId: bigint, signal?: AbortSignal) => Promise<boolean>) | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface RequeueCommandExecution {
  readonly exitCode: number;
  readonly output: Record<string, unknown>;
}

/** Execute the local admin requeue command against a transactional database handle. */
export async function executeRequeueCommand(
  argv: readonly string[],
  deps: RequeueCommandDeps,
): Promise<RequeueCommandExecution> {
  let parsed: ParsedRequeueCliArgs;
  try {
    parsed = parseRequeueCliArgs(argv);
  } catch (error) {
    if (error instanceof RailRequeueValidationError) {
      return {
        exitCode: 2,
        output: { kind: "invalid_arguments", detail: error.message },
      };
    }
    throw error;
  }

  const outcome = await requeueTerminalTransfer(deps.db, parsed.request);
  if (outcome.kind === "refused") {
    return {
      exitCode: 1,
      output: serializeRequeueOutcome(outcome),
    };
  }

  if (parsed.evaluateNow && deps.evaluateTransfer !== undefined) {
    const settled = await deps.evaluateTransfer(
      outcome.transfer.route,
      outcome.transfer.transferId,
      deps.signal,
    );
    return {
      exitCode: 0,
      output: serializeRequeueOutcome(outcome, { attempted: true, settled }),
    };
  }

  return {
    exitCode: 0,
    output: serializeRequeueOutcome(outcome, { attempted: false, settled: false }),
  };
}
