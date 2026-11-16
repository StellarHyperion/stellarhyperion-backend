/**
 * Read-only ITS source-to-payout reconciliation.
 *
 * Joins the outbound router departure, stored Axelar provider attestation reference, and
 * destination ITS/ERC-20 delivery proof into a single auditable report without mutating database
 * state, performing gas top-ups, or fabricating missing provider references.
 */
import {
  CHAINS,
  RouteKind,
  isChainKey,
  isEvmChain,
  toEvmAddress,
  type Hex,
} from "@hyperion/protocol";
import { decodeEventLog, stringToHex } from "viem";

import type { AppConfig } from "../../config/config.js";
import type { Queryable, QueryResultRows } from "../../db/pool.js";
import {
  bigintOf,
  bigintOrNull,
  boolean,
  integer,
  integerOrNull,
  maybeOne,
  text,
  textOrNull,
  timestamp,
  timestampOrNull,
  type Row,
} from "../../db/rows.js";
import { ITS_ABI, inspectItsReceiptLogs, type DeliveryLog } from "./events.js";

const MAX_DIAGNOSTIC_LENGTH = 512;
const ZERO_EVM_ADDRESS = `0x${"0".repeat(40)}`;

export class ItsReconcileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ItsReconcileValidationError";
  }
}

export class ReadOnlyViolationError extends Error {
  constructor(statement: string) {
    super(`read-only reconciliation refused non-SELECT statement: ${statement.slice(0, 80)}`);
    this.name = "ReadOnlyViolationError";
  }
}

export type ItsReconcileSelector =
  | { readonly transferId: bigint }
  | { readonly originChain: string; readonly nonce: bigint }
  | { readonly originTx: string };

export type MissingHistoryItem =
  | "outbound_transfer"
  | "rail_attestation"
  | "provider_reference"
  | "inbound_delivery"
  | "destination_command_id";

export type BindingCheckStatus = "matched" | "mismatch" | "unverified";

export interface ItsBindingCheck {
  readonly status: BindingCheckStatus;
  readonly expected: string | null;
  readonly observed: string | null;
  readonly detail: string;
}

export interface ItsReconciliationBindings {
  readonly route: ItsBindingCheck;
  readonly sourceAccount: ItsBindingCheck;
  readonly recipient: ItsBindingCheck;
  readonly token: ItsBindingCheck;
  readonly amount: ItsBindingCheck;
  readonly allAgreed: boolean;
}

export interface ItsHistoryPresence {
  readonly outboundTransfer: boolean;
  readonly railAttestation: boolean;
  readonly providerReference: boolean;
  readonly inboundDelivery: boolean;
  readonly pendingClaim: boolean;
}

export interface ItsReceiptProofInput {
  readonly txHash: Hex;
  readonly receiptStatus: "success" | "reverted";
  readonly blockNumber: bigint;
  readonly receiptBlockHash: Hex;
  readonly canonicalBlockHash: Hex;
  readonly headBlockNumber: bigint;
  readonly requiredConfirmations: number;
  readonly itsAddress: Hex;
  readonly commandId: Hex;
  readonly tokenId: Hex;
  readonly sourceChainName: string;
  readonly destinationToken: Hex;
  readonly logs: readonly DeliveryLog[];
}

export interface ItsReceiptInspectionSummary {
  readonly checked: boolean;
  readonly canonicalConfirmed: boolean;
  readonly matchedCommandAndPayment: boolean;
  readonly paymentLogIndex: number | null;
  readonly detail: string;
}

export type ItsReconciliationVerdict =
  | "reconciled_delivered"
  | "parked_claim"
  | "awaiting_destination_proof"
  | "missing_history"
  | "binding_mismatch";

export interface ItsReconciliationReport {
  readonly readOnly: true;
  readonly verdict: ItsReconciliationVerdict;
  readonly payoutVerified: boolean;
  readonly selector:
    | { readonly kind: "transferId"; readonly transferId: string }
    | { readonly kind: "hop"; readonly originChain: string; readonly nonce: string }
    | { readonly kind: "originTx"; readonly originTx: string };
  readonly historyPresence: ItsHistoryPresence;
  readonly missingHistory: readonly MissingHistoryItem[];
  readonly sourceTransfer: {
    readonly id: string;
    readonly originChain: string;
    readonly route: number;
    readonly nonce: string;
    readonly sender: string;
    readonly token: string;
    readonly grossAmount: string;
    readonly fee: string;
    readonly netAmount: string;
    readonly destinationChain: string;
    readonly destinationRaw: string;
    readonly expectedRecipient: string | null;
    readonly routerRailRef: string | null;
    readonly originBlock: string;
    readonly originTx: string;
    readonly observedAt: string;
  } | null;
  readonly provider: {
    readonly status: string | null;
    readonly railStatus: string | null;
    readonly reference: string | null;
    readonly referenceSource: "rail_attestation" | "outbound_transfer" | null;
    readonly referenceConflict: boolean;
    readonly attestedAt: string | null;
    readonly lastError: string | null;
    readonly sufficientForPayout: false;
  };
  readonly destinationProof: {
    readonly recorded: boolean;
    readonly destinationChain: string | null;
    readonly commandId: string | null;
    readonly recipient: string | null;
    readonly token: string | null;
    readonly amount: string | null;
    readonly delivered: boolean;
    readonly claimId: string | null;
    readonly claimSettled: boolean | null;
    readonly destinationBlock: string | null;
    readonly destinationTx: string | null;
    readonly destinationLogIndex: number | null;
    readonly observedAt: string | null;
    readonly receiptInspection: ItsReceiptInspectionSummary;
  };
  readonly bindings: ItsReconciliationBindings;
}

export interface ReconcileItsOptions {
  readonly config?: AppConfig | undefined;
  readonly expectedDestinationToken?: string | undefined;
  readonly expectedTokenId?: string | undefined;
  readonly expectedSourceChainName?: string | undefined;
  readonly tokenMappings?: Readonly<Record<string, string>> | undefined;
  readonly receiptProof?: ItsReceiptProofInput | undefined;
}

export interface ParsedItsReconcileCli {
  readonly selector: ItsReconcileSelector;
  readonly expectedDestinationToken?: string | undefined;
  readonly expectedTokenId?: string | undefined;
  readonly expectedSourceChainName?: string | undefined;
}

export interface ItsReconcileCommandResult {
  readonly exitCode: number;
  readonly output: ItsReconciliationReport | { readonly error: string; readonly message: string };
}

/**
 * Enforces read-only SQL execution so reconciliation cannot mutate tables even by mistake.
 */
export function wrapReadOnlyQueryable(db: Queryable): Queryable {
  return {
    async query(sql: string, params?: readonly unknown[]): Promise<QueryResultRows> {
      const normalized = sql
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/--.*$/gm, "")
        .trim();
      if (!/^(SELECT|WITH)\b/i.test(normalized)) {
        throw new ReadOnlyViolationError(normalized);
      }
      if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE)\b/i.test(normalized)) {
        throw new ReadOnlyViolationError(normalized);
      }
      return db.query(sql, params);
    },
  };
}

/**
 * Redacts embedded URL credentials, API tokens, bearer headers, and secret seeds.
 */
export function scrubDiagnosticText(value: string | null): string | null {
  if (value === null) return null;
  const scrubbed = value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+:[^/\s@]+)@/gi, "$1[REDACTED]@")
    .replace(/([?&](?:api[_-]?key|token|secret|password|auth|key)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 [REDACTED]")
    .replace(/\bS[A-Z2-7]{55}\b/g, "[REDACTED_SECRET]")
    .replace(/\b0x[0-9a-fA-F]{64}\b/g, (match) => match);
  if (scrubbed.length <= MAX_DIAGNOSTIC_LENGTH) return scrubbed;
  return `${scrubbed.slice(0, MAX_DIAGNOSTIC_LENGTH)}...[truncated]`;
}

export async function reconcileItsTransfer(
  rawDb: Queryable,
  selector: ItsReconcileSelector,
  options: ReconcileItsOptions = {},
): Promise<ItsReconciliationReport> {
  validateSelector(selector);
  const db = wrapReadOnlyQueryable(rawDb);
  const formattedSelector = formatSelector(selector);

  const outboundRow = await loadOutboundRow(db, selector);
  if (outboundRow === null) {
    const unverifiedBinding = (detail: string): ItsBindingCheck => ({
      status: "unverified",
      expected: null,
      observed: null,
      detail,
    });
    return {
      readOnly: true,
      verdict: "missing_history",
      payoutVerified: false,
      selector: formattedSelector,
      historyPresence: {
        outboundTransfer: false,
        railAttestation: false,
        providerReference: false,
        inboundDelivery: false,
        pendingClaim: false,
      },
      missingHistory: ["outbound_transfer"],
      sourceTransfer: null,
      provider: {
        status: null,
        railStatus: null,
        reference: null,
        referenceSource: null,
        referenceConflict: false,
        attestedAt: null,
        lastError: null,
        sufficientForPayout: false,
      },
      destinationProof: {
        recorded: false,
        destinationChain: null,
        commandId: null,
        recipient: null,
        token: null,
        amount: null,
        delivered: false,
        claimId: null,
        claimSettled: null,
        destinationBlock: null,
        destinationTx: null,
        destinationLogIndex: null,
        observedAt: null,
        receiptInspection: {
          checked: false,
          canonicalConfirmed: false,
          matchedCommandAndPayment: false,
          paymentLogIndex: null,
          detail: "outbound_transfer missing from backend history",
        },
      },
      bindings: {
        route: unverifiedBinding("outbound_transfer missing"),
        sourceAccount: unverifiedBinding("outbound_transfer missing"),
        recipient: unverifiedBinding("outbound_transfer missing"),
        token: unverifiedBinding("outbound_transfer missing"),
        amount: unverifiedBinding("outbound_transfer missing"),
        allAgreed: false,
      },
    };
  }

  const transferId = bigintOf(outboundRow, "id");
  const originChain = text(outboundRow, "origin_chain");
  const route = integer(outboundRow, "route");
  const nonce = bigintOf(outboundRow, "nonce");
  const sender = text(outboundRow, "sender");
  const sourceToken = text(outboundRow, "token");
  const grossAmount = bigintOf(outboundRow, "gross_amount");
  const fee = bigintOf(outboundRow, "fee");
  const netAmount = bigintOf(outboundRow, "net_amount");
  const destinationChain = text(outboundRow, "destination_chain");
  const destinationRaw = text(outboundRow, "destination");
  const routerRailRef = textOrNull(outboundRow, "rail_ref");
  const originBlock = bigintOf(outboundRow, "origin_block");
  const originTx = text(outboundRow, "origin_tx");
  const originObservedAt = timestamp(outboundRow, "observed_at");

  const attestationRow = await loadAttestationRow(db, transferId);
  const inboundRow = await loadInboundRow(db, destinationChain, route, originChain, nonce);
  const claimRow = await loadClaimRow(db, destinationChain, route, originChain, nonce);

  const attestationRef = attestationRow ? textOrNull(attestationRow, "rail_reference") : null;
  const referenceConflict =
    routerRailRef !== null && attestationRef !== null && routerRailRef !== attestationRef;
  const effectiveReference = attestationRef ?? routerRailRef ?? null;
  const referenceSource: "rail_attestation" | "outbound_transfer" | null =
    attestationRef !== null
      ? "rail_attestation"
      : routerRailRef !== null
        ? "outbound_transfer"
        : null;

  const missingHistory: MissingHistoryItem[] = [];
  if (attestationRow === null) {
    missingHistory.push("rail_attestation");
  }
  if (effectiveReference === null) {
    missingHistory.push("provider_reference");
  }
  if (inboundRow === null) {
    missingHistory.push("inbound_delivery");
  } else if (route === RouteKind.AxelarIts && textOrNull(inboundRow, "rail_message_id") === null) {
    missingHistory.push("destination_command_id");
  }

  const expectedRecipientResult = deriveExpectedEvmRecipient(destinationChain, destinationRaw);
  const expectedDestinationToken = resolveExpectedDestinationToken(
    sourceToken,
    originChain,
    destinationChain,
    options,
  );

  const receiptOutcome = evaluateReceiptProof(
    options.receiptProof,
    sender,
    expectedRecipientResult.address,
    expectedDestinationToken,
    netAmount,
    options,
  );

  const routeBinding: ItsBindingCheck =
    route === RouteKind.AxelarIts
      ? {
          status: "matched",
          expected: String(RouteKind.AxelarIts),
          observed: String(route),
          detail: "route matches Axelar ITS",
        }
      : {
          status: "mismatch",
          expected: String(RouteKind.AxelarIts),
          observed: String(route),
          detail: `transfer uses route ${String(route)}, not Axelar ITS (${String(RouteKind.AxelarIts)})`,
        };

  const sourceAccountBinding = evaluateSourceAccountBinding({
    originChain,
    nonce,
    sender,
    inboundRow,
    claimRow,
    receiptOutcome,
  });

  const recipientBinding = evaluateRecipientBinding({
    expectedRecipientResult,
    inboundRow,
    claimRow,
    receiptOutcome,
  });

  const tokenBinding = evaluateTokenBinding({
    sourceToken,
    originChain,
    expectedDestinationToken,
    inboundRow,
    claimRow,
    receiptOutcome,
    config: options.config,
  });

  const amountBinding = evaluateAmountBinding({
    grossAmount,
    fee,
    netAmount,
    inboundRow,
    claimRow,
    receiptOutcome,
  });

  const inboundReceiptConsistent = checkInboundAgainstReceiptProof(
    inboundRow,
    options.receiptProof,
  );

  const anyMismatch =
    referenceConflict ||
    !inboundReceiptConsistent.ok ||
    [routeBinding, sourceAccountBinding, recipientBinding, tokenBinding, amountBinding].some(
      (check) => check.status === "mismatch",
    ) ||
    (options.receiptProof !== undefined && !receiptOutcome.summary.matchedCommandAndPayment);

  const allBindingsMatched =
    !anyMismatch &&
    routeBinding.status === "matched" &&
    sourceAccountBinding.status === "matched" &&
    recipientBinding.status === "matched" &&
    tokenBinding.status === "matched" &&
    amountBinding.status === "matched";

  const inboundDelivered = inboundRow !== null ? boolean(inboundRow, "delivered") : false;
  const inboundClaimId = inboundRow !== null ? bigintOrNull(inboundRow, "claim_id") : null;
  const claimSettled = claimRow !== null ? boolean(claimRow, "settled") : null;

  let verdict: ItsReconciliationVerdict;
  let payoutVerified = false;

  if (anyMismatch) {
    verdict = "binding_mismatch";
  } else if (inboundRow === null) {
    verdict = "awaiting_destination_proof";
  } else if (inboundDelivered && inboundClaimId === null && allBindingsMatched) {
    payoutVerified = true;
    verdict = missingHistory.length === 0 ? "reconciled_delivered" : "missing_history";
  } else if (!inboundDelivered && inboundClaimId !== null && allBindingsMatched) {
    verdict = missingHistory.length === 0 ? "parked_claim" : "missing_history";
  } else {
    verdict = "binding_mismatch";
  }

  const receiptDetail = inboundReceiptConsistent.ok
    ? receiptOutcome.summary.detail
    : inboundReceiptConsistent.detail;

  return {
    readOnly: true,
    verdict,
    payoutVerified,
    selector: formattedSelector,
    historyPresence: {
      outboundTransfer: true,
      railAttestation: attestationRow !== null,
      providerReference: effectiveReference !== null,
      inboundDelivery: inboundRow !== null,
      pendingClaim: claimRow !== null,
    },
    missingHistory,
    sourceTransfer: {
      id: transferId.toString(),
      originChain,
      route,
      nonce: nonce.toString(),
      sender,
      token: sourceToken,
      grossAmount: grossAmount.toString(),
      fee: fee.toString(),
      netAmount: netAmount.toString(),
      destinationChain,
      destinationRaw,
      expectedRecipient: expectedRecipientResult.address,
      routerRailRef,
      originBlock: originBlock.toString(),
      originTx,
      observedAt: originObservedAt.toISOString(),
    },
    provider: {
      status: attestationRow ? text(attestationRow, "status") : null,
      railStatus: attestationRow ? textOrNull(attestationRow, "rail_status") : null,
      reference: effectiveReference,
      referenceSource,
      referenceConflict,
      attestedAt: attestationRow
        ? (timestampOrNull(attestationRow, "attested_at")?.toISOString() ?? null)
        : null,
      lastError: attestationRow
        ? scrubDiagnosticText(textOrNull(attestationRow, "last_error"))
        : null,
      sufficientForPayout: false,
    },
    destinationProof: {
      recorded: inboundRow !== null,
      destinationChain: inboundRow ? text(inboundRow, "destination_chain") : null,
      commandId: inboundRow ? textOrNull(inboundRow, "rail_message_id") : null,
      recipient: inboundRow ? text(inboundRow, "recipient") : null,
      token: inboundRow ? text(inboundRow, "token") : null,
      amount: inboundRow ? bigintOf(inboundRow, "amount").toString() : null,
      delivered: inboundDelivered,
      claimId:
        inboundClaimId !== null
          ? inboundClaimId.toString()
          : claimRow !== null
            ? bigintOf(claimRow, "claim_id").toString()
            : null,
      claimSettled,
      destinationBlock: inboundRow ? bigintOf(inboundRow, "destination_block").toString() : null,
      destinationTx: inboundRow ? text(inboundRow, "destination_tx") : null,
      destinationLogIndex: inboundRow ? integerOrNull(inboundRow, "destination_log_index") : null,
      observedAt: inboundRow ? timestamp(inboundRow, "observed_at").toISOString() : null,
      receiptInspection: {
        ...receiptOutcome.summary,
        detail: receiptDetail,
      },
    },
    bindings: {
      route: routeBinding,
      sourceAccount: sourceAccountBinding,
      recipient: recipientBinding,
      token: tokenBinding,
      amount: amountBinding,
      allAgreed: allBindingsMatched,
    },
  };
}

export function parseItsReconcileCliArgs(argv: readonly string[]): ParsedItsReconcileCli {
  let transferId: bigint | undefined;
  let originChain: string | undefined;
  let nonce: bigint | undefined;
  let originTx: string | undefined;
  let expectedDestinationToken: string | undefined;
  let expectedTokenId: string | undefined;
  let expectedSourceChainName: string | undefined;

  const takeValue = (flag: string, index: number): string => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new ItsReconcileValidationError(`${flag} requires a value`);
    }
    return next;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (
      arg === "--top-up" ||
      arg === "--pay-gas" ||
      arg === "--fabricate-reference" ||
      arg === "--write" ||
      arg === "--requeue"
    ) {
      throw new ItsReconcileValidationError(
        `flag ${arg} is forbidden: reconcile-its is strictly read-only and never performs gas top-ups, state writes, or reference fabrication`,
      );
    }

    switch (arg) {
      case "--transfer-id": {
        const raw = takeValue(arg, i);
        i += 1;
        if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n) {
          throw new ItsReconcileValidationError("--transfer-id must be a positive integer");
        }
        transferId = BigInt(raw);
        break;
      }
      case "--origin-chain": {
        originChain = takeValue(arg, i).trim();
        i += 1;
        if (originChain.length === 0) {
          throw new ItsReconcileValidationError("--origin-chain must be non-empty");
        }
        break;
      }
      case "--nonce": {
        const raw = takeValue(arg, i);
        i += 1;
        if (!/^\d+$/.test(raw)) {
          throw new ItsReconcileValidationError("--nonce must be a non-negative integer");
        }
        nonce = BigInt(raw);
        break;
      }
      case "--origin-tx": {
        originTx = takeValue(arg, i).trim();
        i += 1;
        if (originTx.length === 0) {
          throw new ItsReconcileValidationError("--origin-tx must be non-empty");
        }
        break;
      }
      case "--expected-destination-token": {
        expectedDestinationToken = takeValue(arg, i).trim();
        i += 1;
        if (!/^0x[0-9a-fA-F]{40}$/.test(expectedDestinationToken)) {
          throw new ItsReconcileValidationError(
            "--expected-destination-token must be a 20-byte 0x-prefixed EVM address",
          );
        }
        break;
      }
      case "--expected-token-id": {
        expectedTokenId = takeValue(arg, i).trim();
        i += 1;
        if (!/^0x[0-9a-fA-F]{64}$/.test(expectedTokenId)) {
          throw new ItsReconcileValidationError(
            "--expected-token-id must be a 32-byte 0x-prefixed hex identifier",
          );
        }
        break;
      }
      case "--expected-source-chain": {
        expectedSourceChainName = takeValue(arg, i).trim();
        i += 1;
        if (expectedSourceChainName.length === 0) {
          throw new ItsReconcileValidationError("--expected-source-chain must be non-empty");
        }
        break;
      }
      default:
        throw new ItsReconcileValidationError(`unknown flag: ${arg}`);
    }
  }

  const modeCount =
    (transferId !== undefined ? 1 : 0) +
    (originChain !== undefined || nonce !== undefined ? 1 : 0) +
    (originTx !== undefined ? 1 : 0);

  if (modeCount !== 1) {
    throw new ItsReconcileValidationError(
      "specify exactly one selector: --transfer-id <id>, --origin-chain <chain> --nonce <u64>, or --origin-tx <hash>",
    );
  }

  let selector: ItsReconcileSelector;
  if (transferId !== undefined) {
    selector = { transferId };
  } else if (originTx !== undefined) {
    selector = { originTx };
  } else {
    if (originChain === undefined || nonce === undefined) {
      throw new ItsReconcileValidationError("--origin-chain and --nonce must be provided together");
    }
    selector = { originChain, nonce };
  }

  return {
    selector,
    ...(expectedDestinationToken !== undefined ? { expectedDestinationToken } : {}),
    ...(expectedTokenId !== undefined ? { expectedTokenId } : {}),
    ...(expectedSourceChainName !== undefined ? { expectedSourceChainName } : {}),
  };
}

export async function executeItsReconcileCommand(
  argv: readonly string[],
  deps: { readonly db: Queryable; readonly config?: AppConfig | undefined },
): Promise<ItsReconcileCommandResult> {
  let parsed: ParsedItsReconcileCli;
  try {
    parsed = parseItsReconcileCliArgs(argv);
  } catch (error) {
    if (error instanceof ItsReconcileValidationError) {
      return {
        exitCode: 64,
        output: { error: "invalid_arguments", message: error.message },
      };
    }
    throw error;
  }

  const report = await reconcileItsTransfer(deps.db, parsed.selector, {
    ...(deps.config !== undefined ? { config: deps.config } : {}),
    ...(parsed.expectedDestinationToken !== undefined
      ? { expectedDestinationToken: parsed.expectedDestinationToken }
      : {}),
    ...(parsed.expectedTokenId !== undefined ? { expectedTokenId: parsed.expectedTokenId } : {}),
    ...(parsed.expectedSourceChainName !== undefined
      ? { expectedSourceChainName: parsed.expectedSourceChainName }
      : {}),
  });

  const exitCode =
    report.verdict === "reconciled_delivered" || report.verdict === "parked_claim"
      ? 0
      : report.verdict === "binding_mismatch"
        ? 3
        : 2;

  return { exitCode, output: report };
}

function validateSelector(selector: ItsReconcileSelector): void {
  if ("transferId" in selector) {
    if (selector.transferId <= 0n) {
      throw new ItsReconcileValidationError("transferId must be positive");
    }
    return;
  }
  if ("originTx" in selector) {
    if (selector.originTx.trim().length === 0) {
      throw new ItsReconcileValidationError("originTx must be non-empty");
    }
    return;
  }
  if (selector.originChain.trim().length === 0) {
    throw new ItsReconcileValidationError("originChain must be non-empty");
  }
  if (selector.nonce < 0n) {
    throw new ItsReconcileValidationError("nonce must be non-negative");
  }
}

function formatSelector(selector: ItsReconcileSelector): ItsReconciliationReport["selector"] {
  if ("transferId" in selector) {
    return { kind: "transferId", transferId: selector.transferId.toString() };
  }
  if ("originTx" in selector) {
    return { kind: "originTx", originTx: selector.originTx.trim() };
  }
  return {
    kind: "hop",
    originChain: selector.originChain.trim(),
    nonce: selector.nonce.toString(),
  };
}

async function loadOutboundRow(db: Queryable, selector: ItsReconcileSelector): Promise<Row | null> {
  if ("transferId" in selector) {
    const { rows } = await db.query(
      `SELECT id, origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
              destination_chain, destination, rail_ref, origin_block, origin_tx, observed_at
         FROM outbound_transfer
        WHERE id = $1`,
      [selector.transferId.toString()],
    );
    return maybeOne(rows, "reconcileItsTransfer.outboundById");
  }
  if ("originTx" in selector) {
    const { rows } = await db.query(
      `SELECT id, origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
              destination_chain, destination, rail_ref, origin_block, origin_tx, observed_at
         FROM outbound_transfer
        WHERE LOWER(origin_tx) = LOWER($1)
        ORDER BY id ASC
        LIMIT 1`,
      [selector.originTx.trim()],
    );
    return maybeOne(rows, "reconcileItsTransfer.outboundByTx");
  }
  const { rows } = await db.query(
    `SELECT id, origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
            destination_chain, destination, rail_ref, origin_block, origin_tx, observed_at
       FROM outbound_transfer
      WHERE origin_chain = $1 AND nonce = $2`,
    [selector.originChain.trim(), selector.nonce.toString()],
  );
  return maybeOne(rows, "reconcileItsTransfer.outboundByHop");
}

async function loadAttestationRow(db: Queryable, transferId: bigint): Promise<Row | null> {
  const { rows } = await db.query(
    `SELECT status, rail_status, rail_reference, attested_at, last_error
       FROM rail_attestation
      WHERE transfer_id = $1`,
    [transferId.toString()],
  );
  return maybeOne(rows, "reconcileItsTransfer.attestation");
}

async function loadInboundRow(
  db: Queryable,
  destinationChain: string,
  route: number,
  originChain: string,
  nonce: bigint,
): Promise<Row | null> {
  const { rows } = await db.query(
    `SELECT destination_chain, route, source_chain, source_nonce, rail_message_id, recipient,
            token, amount, delivered, claim_id, destination_block, destination_tx,
            destination_log_index, observed_at
       FROM inbound_delivery
      WHERE destination_chain = $1
        AND route = $2
        AND source_chain = $3
        AND source_nonce = $4`,
    [destinationChain, route, originChain, nonce.toString()],
  );
  return maybeOne(rows, "reconcileItsTransfer.inbound");
}

async function loadClaimRow(
  db: Queryable,
  destinationChain: string,
  route: number,
  originChain: string,
  nonce: bigint,
): Promise<Row | null> {
  const { rows } = await db.query(
    `SELECT claim_id, recipient, token, amount, settled
       FROM pending_claim
      WHERE chain = $1
        AND route = $2
        AND source_chain = $3
        AND source_nonce = $4
      ORDER BY claim_id DESC
      LIMIT 1`,
    [destinationChain, route, originChain, nonce.toString()],
  );
  return maybeOne(rows, "reconcileItsTransfer.claim");
}

function deriveExpectedEvmRecipient(
  destinationChain: string,
  destinationRaw: string,
): { readonly address: string | null; readonly error: string | null } {
  if (!isChainKey(destinationChain) || !isEvmChain(CHAINS[destinationChain])) {
    return {
      address: null,
      error: `destination chain ${destinationChain} is not an EVM chain`,
    };
  }
  if (/^0x[0-9a-fA-F]{40}$/.test(destinationRaw)) {
    return { address: destinationRaw.toLowerCase(), error: null };
  }
  if (/^0x[0-9a-fA-F]{64}$/.test(destinationRaw)) {
    try {
      const address = toEvmAddress(destinationRaw as Hex);
      return { address: address.toLowerCase(), error: null };
    } catch (error) {
      return {
        address: null,
        error: error instanceof Error ? error.message : "invalid 32-byte EVM destination word",
      };
    }
  }
  return {
    address: null,
    error: "outbound destination is not a valid 32-byte EVM word or 20-byte address",
  };
}

function resolveExpectedDestinationToken(
  sourceToken: string,
  originChain: string,
  destinationChain: string,
  options: ReconcileItsOptions,
): string | null {
  if (options.expectedDestinationToken !== undefined) {
    return options.expectedDestinationToken.toLowerCase();
  }
  if (options.receiptProof !== undefined) {
    return options.receiptProof.destinationToken.toLowerCase();
  }
  if (options.tokenMappings !== undefined) {
    const compositeKey = `${originChain}:${sourceToken.toLowerCase()}->${destinationChain}`;
    const mapped =
      options.tokenMappings[compositeKey] ??
      options.tokenMappings[sourceToken] ??
      options.tokenMappings[sourceToken.toLowerCase()];
    if (mapped !== undefined) {
      return mapped.toLowerCase();
    }
  }
  return null;
}

interface ReceiptEvaluationOutcome {
  readonly summary: ItsReceiptInspectionSummary;
  readonly observedSourceAddressHex: string | null;
  readonly observedSourceChain: string | null;
  readonly observedRecipient: string | null;
  readonly observedTokenId: string | null;
  readonly observedTokenAddress: string | null;
  readonly observedCommandAmount: bigint | null;
  readonly observedPaymentAmount: bigint | null;
}

function evaluateReceiptProof(
  proof: ItsReceiptProofInput | undefined,
  sender: string,
  expectedRecipient: string | null,
  expectedDestinationToken: string | null,
  expectedAmount: bigint,
  options: ReconcileItsOptions,
): ReceiptEvaluationOutcome {
  if (proof === undefined) {
    return {
      summary: {
        checked: false,
        canonicalConfirmed: false,
        matchedCommandAndPayment: false,
        paymentLogIndex: null,
        detail: "no live receipt proof supplied; relying on indexed backend records",
      },
      observedSourceAddressHex: null,
      observedSourceChain: null,
      observedRecipient: null,
      observedTokenId: null,
      observedTokenAddress: null,
      observedCommandAmount: null,
      observedPaymentAmount: null,
    };
  }

  if (proof.receiptStatus !== "success") {
    return {
      summary: {
        checked: true,
        canonicalConfirmed: false,
        matchedCommandAndPayment: false,
        paymentLogIndex: null,
        detail: "destination receipt status is reverted",
      },
      observedSourceAddressHex: null,
      observedSourceChain: null,
      observedRecipient: null,
      observedTokenId: null,
      observedTokenAddress: null,
      observedCommandAmount: null,
      observedPaymentAmount: null,
    };
  }

  if (proof.receiptBlockHash.toLowerCase() !== proof.canonicalBlockHash.toLowerCase()) {
    return {
      summary: {
        checked: true,
        canonicalConfirmed: false,
        matchedCommandAndPayment: false,
        paymentLogIndex: null,
        detail: "receipt block hash does not match canonical chain block hash",
      },
      observedSourceAddressHex: null,
      observedSourceChain: null,
      observedRecipient: null,
      observedTokenId: null,
      observedTokenAddress: null,
      observedCommandAmount: null,
      observedPaymentAmount: null,
    };
  }

  const confirmations = proof.headBlockNumber - proof.blockNumber + 1n;
  if (confirmations < BigInt(proof.requiredConfirmations)) {
    return {
      summary: {
        checked: true,
        canonicalConfirmed: false,
        matchedCommandAndPayment: false,
        paymentLogIndex: null,
        detail: `receipt has ${confirmations.toString()} confirmations; ${String(proof.requiredConfirmations)} required`,
      },
      observedSourceAddressHex: null,
      observedSourceChain: null,
      observedRecipient: null,
      observedTokenId: null,
      observedTokenAddress: null,
      observedCommandAmount: null,
      observedPaymentAmount: null,
    };
  }

  const targetToken = expectedDestinationToken ?? proof.destinationToken.toLowerCase();
  const targetTokenId = (options.expectedTokenId ?? proof.tokenId).toLowerCase();
  const targetSourceChain = options.expectedSourceChainName ?? proof.sourceChainName;

  if (expectedRecipient !== null) {
    const matched = inspectItsReceiptLogs(proof.logs, {
      its: proof.itsAddress,
      token: targetToken,
      commandId: proof.commandId,
      tokenId: targetTokenId,
      sourceChain: targetSourceChain,
      sourceAddress: stringToHex(sender),
      recipient: expectedRecipient,
      amount: expectedAmount,
    });

    if (matched !== null) {
      return {
        summary: {
          checked: true,
          canonicalConfirmed: true,
          matchedCommandAndPayment: true,
          paymentLogIndex: matched.paymentLog.logIndex,
          detail: "canonical receipt confirmed with matching ITS command and ERC-20 Transfer",
        },
        observedSourceAddressHex: matched.sourceAddress.toLowerCase(),
        observedSourceChain: matched.sourceChain,
        observedRecipient: matched.destinationAddress.toLowerCase(),
        observedTokenId: matched.tokenId.toLowerCase(),
        observedTokenAddress: matched.paymentLog.address.toLowerCase(),
        observedCommandAmount: matched.amount,
        observedPaymentAmount: matched.amount,
      };
    }
  }

  // Decode partial candidate events so binding checks can report exact field disagreements.
  let observedSourceAddressHex: string | null = null;
  let observedSourceChain: string | null = null;
  let observedRecipient: string | null = null;
  let observedTokenId: string | null = null;
  let observedTokenAddress: string | null = null;
  let observedCommandAmount: bigint | null = null;
  let observedPaymentAmount: bigint | null = null;

  for (const log of proof.logs) {
    try {
      const event = decodeEventLog({ abi: ITS_ABI, topics: log.topics, data: log.data });
      if (
        event.eventName === "InterchainTransferReceived" &&
        log.address.toLowerCase() === proof.itsAddress.toLowerCase() &&
        event.args.commandId.toLowerCase() === proof.commandId.toLowerCase()
      ) {
        observedSourceAddressHex = event.args.sourceAddress.toLowerCase();
        observedSourceChain = event.args.sourceChain;
        observedRecipient = event.args.destinationAddress.toLowerCase();
        observedTokenId = event.args.tokenId.toLowerCase();
        observedCommandAmount = event.args.amount;
      }
      if (event.eventName === "Transfer") {
        observedTokenAddress = log.address.toLowerCase();
        observedPaymentAmount = event.args.value;
        observedRecipient ??= event.args.to.toLowerCase();
      }
    } catch {
      // Unrelated receipt logs are ignored.
    }
  }

  return {
    summary: {
      checked: true,
      canonicalConfirmed: true,
      matchedCommandAndPayment: false,
      paymentLogIndex: null,
      detail: "receipt did not contain a matching ITS command and ERC-20 Transfer pair",
    },
    observedSourceAddressHex,
    observedSourceChain,
    observedRecipient,
    observedTokenId,
    observedTokenAddress,
    observedCommandAmount,
    observedPaymentAmount,
  };
}

function evaluateSourceAccountBinding(input: {
  readonly originChain: string;
  readonly nonce: bigint;
  readonly sender: string;
  readonly inboundRow: Row | null;
  readonly claimRow: Row | null;
  readonly receiptOutcome: ReceiptEvaluationOutcome;
}): ItsBindingCheck {
  const expectedSenderHex = stringToHex(input.sender).toLowerCase();

  if (input.receiptOutcome.observedSourceAddressHex !== null) {
    if (input.receiptOutcome.observedSourceAddressHex !== expectedSenderHex) {
      return {
        status: "mismatch",
        expected: `${input.sender} (${expectedSenderHex})`,
        observed: input.receiptOutcome.observedSourceAddressHex,
        detail: "ITS InterchainTransferReceived sourceAddress disagrees with outbound sender",
      };
    }
  }

  if (input.inboundRow === null && input.claimRow === null) {
    if (
      input.receiptOutcome.summary.matchedCommandAndPayment &&
      input.receiptOutcome.observedSourceAddressHex === expectedSenderHex
    ) {
      return {
        status: "matched",
        expected: input.sender,
        observed: input.sender,
        detail: "receipt ITS sourceAddress matches outbound sender",
      };
    }
    return {
      status: "unverified",
      expected: `${input.originChain}:${input.nonce.toString()}:${input.sender}`,
      observed: null,
      detail: "awaiting inbound_delivery record to bind source hop",
    };
  }

  if (input.inboundRow !== null) {
    const inboundSourceChain = text(input.inboundRow, "source_chain");
    const inboundSourceNonce = bigintOf(input.inboundRow, "source_nonce");
    if (inboundSourceChain !== input.originChain || inboundSourceNonce !== input.nonce) {
      return {
        status: "mismatch",
        expected: `${input.originChain}:${input.nonce.toString()}`,
        observed: `${inboundSourceChain}:${inboundSourceNonce.toString()}`,
        detail: "inbound_delivery source hop disagrees with outbound_transfer",
      };
    }
  }

  return {
    status: "matched",
    expected: `${input.originChain}:${input.nonce.toString()}:${input.sender}`,
    observed: `${input.originChain}:${input.nonce.toString()}:${input.sender}`,
    detail: "source transfer hop and sender binding verified",
  };
}

function evaluateRecipientBinding(input: {
  readonly expectedRecipientResult: {
    readonly address: string | null;
    readonly error: string | null;
  };
  readonly inboundRow: Row | null;
  readonly claimRow: Row | null;
  readonly receiptOutcome: ReceiptEvaluationOutcome;
}): ItsBindingCheck {
  const expected = input.expectedRecipientResult.address;
  if (expected === null) {
    return {
      status: "mismatch",
      expected: null,
      observed: null,
      detail: input.expectedRecipientResult.error ?? "invalid outbound destination encoding",
    };
  }
  if (expected === ZERO_EVM_ADDRESS) {
    return {
      status: "mismatch",
      expected,
      observed: null,
      detail: "outbound destination resolves to the zero EVM address",
    };
  }

  if (
    input.receiptOutcome.observedRecipient !== null &&
    input.receiptOutcome.observedRecipient !== expected
  ) {
    return {
      status: "mismatch",
      expected,
      observed: input.receiptOutcome.observedRecipient,
      detail: "receipt destination recipient disagrees with outbound destination",
    };
  }

  if (input.inboundRow === null && input.claimRow === null) {
    if (
      input.receiptOutcome.summary.matchedCommandAndPayment &&
      input.receiptOutcome.observedRecipient === expected
    ) {
      return {
        status: "matched",
        expected,
        observed: expected,
        detail: "receipt recipient matches outbound destination",
      };
    }
    return {
      status: "unverified",
      expected,
      observed: null,
      detail: "awaiting destination proof for recipient binding",
    };
  }

  const inboundRecipient =
    input.inboundRow !== null ? text(input.inboundRow, "recipient").toLowerCase() : null;
  const claimRecipient =
    input.claimRow !== null ? text(input.claimRow, "recipient").toLowerCase() : null;

  if (inboundRecipient !== null && inboundRecipient !== expected) {
    return {
      status: "mismatch",
      expected,
      observed: inboundRecipient,
      detail: "inbound_delivery recipient disagrees with outbound destination",
    };
  }
  if (claimRecipient !== null && claimRecipient !== expected) {
    return {
      status: "mismatch",
      expected,
      observed: claimRecipient,
      detail: "pending_claim recipient disagrees with outbound destination",
    };
  }

  return {
    status: "matched",
    expected,
    observed: inboundRecipient ?? claimRecipient ?? expected,
    detail: "destination recipient matches outbound destination",
  };
}

function evaluateTokenBinding(input: {
  readonly sourceToken: string;
  readonly originChain: string;
  readonly expectedDestinationToken: string | null;
  readonly inboundRow: Row | null;
  readonly claimRow: Row | null;
  readonly receiptOutcome: ReceiptEvaluationOutcome;
  readonly config: AppConfig | undefined;
}): ItsBindingCheck {
  if (input.sourceToken.trim().length === 0) {
    return {
      status: "mismatch",
      expected: null,
      observed: "",
      detail: "outbound source token is empty",
    };
  }

  if (input.config !== undefined && isChainKey(input.originChain)) {
    const deployment = input.config.deployments.networks[input.originChain];
    if (deployment !== undefined) {
      const configuredTokens = Object.values(
        deployment.tokens as Record<string, { sacId?: string; address?: string }>,
      );
      if (configuredTokens.length > 0) {
        const known = configuredTokens.some((entry) => {
          const id = entry.sacId ?? entry.address;
          return id?.toLowerCase() === input.sourceToken.toLowerCase();
        });
        if (!known) {
          return {
            status: "mismatch",
            expected: input.sourceToken,
            observed: input.sourceToken,
            detail: `source token ${input.sourceToken} is not registered in deployment config for ${input.originChain}`,
          };
        }
      }
    }
  }

  if (
    input.expectedDestinationToken !== null &&
    input.receiptOutcome.observedTokenAddress !== null &&
    input.receiptOutcome.observedTokenAddress !== input.expectedDestinationToken
  ) {
    return {
      status: "mismatch",
      expected: input.expectedDestinationToken,
      observed: input.receiptOutcome.observedTokenAddress,
      detail: "receipt ERC-20 token contract disagrees with expected ITS destination token",
    };
  }

  if (input.inboundRow === null && input.claimRow === null) {
    if (
      input.receiptOutcome.summary.matchedCommandAndPayment &&
      input.receiptOutcome.observedTokenAddress !== null
    ) {
      return {
        status: "matched",
        expected: input.expectedDestinationToken ?? input.receiptOutcome.observedTokenAddress,
        observed: input.receiptOutcome.observedTokenAddress,
        detail: "receipt ERC-20 token matches expected ITS destination token",
      };
    }
    return {
      status: "unverified",
      expected: input.expectedDestinationToken ?? input.sourceToken,
      observed: null,
      detail: "awaiting destination proof for token binding",
    };
  }

  const inboundToken =
    input.inboundRow !== null ? text(input.inboundRow, "token").toLowerCase() : null;
  const claimToken = input.claimRow !== null ? text(input.claimRow, "token").toLowerCase() : null;
  const observedToken = inboundToken ?? claimToken;

  if (
    observedToken === null ||
    !/^0x[0-9a-fA-F]{40}$/.test(observedToken) ||
    observedToken === ZERO_EVM_ADDRESS
  ) {
    return {
      status: "mismatch",
      expected: input.expectedDestinationToken ?? "valid non-zero 20-byte EVM token address",
      observed: observedToken,
      detail: "destination token is missing, malformed, or zero address",
    };
  }

  if (inboundToken !== null && claimToken !== null && inboundToken !== claimToken) {
    return {
      status: "mismatch",
      expected: inboundToken,
      observed: claimToken,
      detail: "inbound_delivery token disagrees with pending_claim token",
    };
  }

  if (input.expectedDestinationToken !== null && observedToken !== input.expectedDestinationToken) {
    return {
      status: "mismatch",
      expected: input.expectedDestinationToken,
      observed: observedToken,
      detail: "destination token disagrees with expected ITS token mapping",
    };
  }

  return {
    status: "matched",
    expected: input.expectedDestinationToken ?? observedToken,
    observed: observedToken,
    detail:
      input.expectedDestinationToken !== null
        ? "destination token matches expected ITS token mapping"
        : "destination token recorded and structurally valid",
  };
}

function evaluateAmountBinding(input: {
  readonly grossAmount: bigint;
  readonly fee: bigint;
  readonly netAmount: bigint;
  readonly inboundRow: Row | null;
  readonly claimRow: Row | null;
  readonly receiptOutcome: ReceiptEvaluationOutcome;
}): ItsBindingCheck {
  if (input.grossAmount !== input.fee + input.netAmount || input.netAmount <= 0n) {
    return {
      status: "mismatch",
      expected: input.netAmount.toString(),
      observed: `${input.grossAmount.toString()} - ${input.fee.toString()}`,
      detail: "outbound_transfer amounts violate gross = fee + net > 0",
    };
  }

  if (
    input.receiptOutcome.observedCommandAmount !== null &&
    input.receiptOutcome.observedCommandAmount !== input.netAmount
  ) {
    return {
      status: "mismatch",
      expected: input.netAmount.toString(),
      observed: input.receiptOutcome.observedCommandAmount.toString(),
      detail: "receipt ITS command amount disagrees with outbound net_amount",
    };
  }

  if (
    input.receiptOutcome.observedPaymentAmount !== null &&
    input.receiptOutcome.observedPaymentAmount !== input.netAmount
  ) {
    return {
      status: "mismatch",
      expected: input.netAmount.toString(),
      observed: input.receiptOutcome.observedPaymentAmount.toString(),
      detail: "receipt ERC-20 Transfer value disagrees with outbound net_amount",
    };
  }

  if (input.inboundRow === null && input.claimRow === null) {
    if (
      input.receiptOutcome.summary.matchedCommandAndPayment &&
      input.receiptOutcome.observedPaymentAmount === input.netAmount
    ) {
      return {
        status: "matched",
        expected: input.netAmount.toString(),
        observed: input.netAmount.toString(),
        detail: "receipt ERC-20 Transfer amount matches outbound net_amount",
      };
    }
    return {
      status: "unverified",
      expected: input.netAmount.toString(),
      observed: null,
      detail: "awaiting destination proof for exact net_amount binding",
    };
  }

  const inboundAmount = input.inboundRow !== null ? bigintOf(input.inboundRow, "amount") : null;
  const claimAmount = input.claimRow !== null ? bigintOf(input.claimRow, "amount") : null;

  if (inboundAmount !== null && inboundAmount !== input.netAmount) {
    return {
      status: "mismatch",
      expected: input.netAmount.toString(),
      observed: inboundAmount.toString(),
      detail: "inbound_delivery amount disagrees with outbound net_amount",
    };
  }

  if (claimAmount !== null && claimAmount !== input.netAmount) {
    return {
      status: "mismatch",
      expected: input.netAmount.toString(),
      observed: claimAmount.toString(),
      detail: "pending_claim amount disagrees with outbound net_amount",
    };
  }

  const observed = (inboundAmount ?? claimAmount ?? input.netAmount).toString();
  return {
    status: "matched",
    expected: input.netAmount.toString(),
    observed,
    detail: "destination payout amount matches outbound net_amount exactly",
  };
}

function checkInboundAgainstReceiptProof(
  inboundRow: Row | null,
  proof: ItsReceiptProofInput | undefined,
): { readonly ok: boolean; readonly detail: string } {
  if (inboundRow === null || proof === undefined) {
    return { ok: true, detail: "" };
  }
  const recordedTx = text(inboundRow, "destination_tx").toLowerCase();
  if (recordedTx !== proof.txHash.toLowerCase()) {
    return {
      ok: false,
      detail: `inbound_delivery destination_tx (${recordedTx}) disagrees with receipt txHash (${proof.txHash.toLowerCase()})`,
    };
  }
  const recordedBlock = bigintOf(inboundRow, "destination_block");
  if (recordedBlock !== proof.blockNumber) {
    return {
      ok: false,
      detail: `inbound_delivery destination_block (${recordedBlock.toString()}) disagrees with receipt block (${proof.blockNumber.toString()})`,
    };
  }
  const recordedCommandId = textOrNull(inboundRow, "rail_message_id");
  if (
    recordedCommandId !== null &&
    recordedCommandId.toLowerCase() !== proof.commandId.toLowerCase()
  ) {
    return {
      ok: false,
      detail: "inbound_delivery rail_message_id disagrees with receipt commandId",
    };
  }
  return { ok: true, detail: "" };
}
