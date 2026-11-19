import { sanitizeDiagnosticText } from "../../logging/logger.js";
import { decodeEventLog, parseAbi, type Hex } from "viem";
export const ITS_ABI = parseAbi([
  "function registeredTokenAddress(bytes32 tokenId) view returns (address)",
  "function tokenManagerAddress(bytes32 tokenId) view returns (address)",
  "event InterchainTransferReceived(bytes32 indexed commandId, bytes32 indexed tokenId, string sourceChain, bytes sourceAddress, address indexed destinationAddress, uint256 amount, bytes32 dataHash)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
export interface DeliveryLog {
  address: Hex;
  topics: [] | [Hex, ...Hex[]];
  data: Hex;
  logIndex: number | null;
}
export interface ExpectedDelivery {
  its: string;
  token: string;
  tokenManager: string;
  commandId: string;
  tokenId: string;
  sourceChain: string;
  sourceAddress: string;
  recipient: string;
  amount: bigint;
}

export type VerificationMismatchCategory =
  "source_identity" | "command" | "token" | "recipient" | "amount" | "payment_evidence";

export interface VerificationDiagnostic {
  readonly category: VerificationMismatchCategory;
  readonly expected: string | null;
  readonly observed: string | null;
}

export interface PaymentInspection<T extends DeliveryLog> {
  readonly payment: T | null;
  readonly diagnostics: readonly VerificationDiagnostic[];
}

function bounded(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text =
    typeof value === "bigint" || typeof value === "string" || typeof value === "number"
      ? String(value)
      : Object.prototype.toString.call(value);
  const safe = sanitizeDiagnosticText(text);
  return safe.length <= 128 ? safe : `${safe.slice(0, 64)}…${safe.slice(-63)}`;
}

export interface DeliveryEvidence<T extends DeliveryLog = DeliveryLog> {
  readonly received: T | null;
  readonly payment: T | null;
}

interface DestinationInspection<T extends DeliveryLog> extends DeliveryEvidence<T> {
  readonly diagnostics: readonly VerificationDiagnostic[];
  readonly ambiguous: boolean;
}

function inspectDestinationLogs<T extends DeliveryLog>(
  logs: readonly T[],
  expected: ExpectedDelivery,
): DestinationInspection<T> {
  const diagnostics: VerificationDiagnostic[] = [];
  const add = (
    category: VerificationMismatchCategory,
    expectedValue: unknown,
    observedValue: unknown,
  ) => {
    if (!diagnostics.some((item) => item.category === category))
      diagnostics.push({
        category,
        expected: bounded(expectedValue),
        observed: bounded(observedValue),
      });
  };
  const received = new Map<string, T>();
  const payments = new Map<string, T>();
  for (const log of logs) {
    let event: ReturnType<
      typeof decodeEventLog<typeof ITS_ABI, undefined, [Hex, ...Hex[]], Hex, true>
    >;
    try {
      event = decodeEventLog({ abi: ITS_ABI, topics: log.topics, data: log.data });
    } catch {
      continue;
    }
    const identity = `${String(log.logIndex ?? "none")}:${log.topics.join("").toLowerCase()}:${log.data.toLowerCase()}`;
    if (
      event.eventName === "InterchainTransferReceived" &&
      log.address.toLowerCase() === expected.its.toLowerCase()
    ) {
      const args = event.args;
      const exact =
        args.commandId.toLowerCase() === expected.commandId.toLowerCase() &&
        args.tokenId.toLowerCase() === expected.tokenId.toLowerCase() &&
        args.sourceChain === expected.sourceChain &&
        args.sourceAddress.toLowerCase() === expected.sourceAddress.toLowerCase() &&
        args.destinationAddress.toLowerCase() === expected.recipient.toLowerCase() &&
        args.amount === expected.amount;
      if (exact) {
        if (!received.has(identity)) received.set(identity, log);
        continue;
      }
      if (args.commandId.toLowerCase() !== expected.commandId.toLowerCase())
        add("command", expected.commandId, args.commandId);
      if (args.tokenId.toLowerCase() !== expected.tokenId.toLowerCase())
        add("token", expected.tokenId, args.tokenId);
      if (
        args.sourceChain !== expected.sourceChain ||
        args.sourceAddress.toLowerCase() !== expected.sourceAddress.toLowerCase()
      )
        add(
          "source_identity",
          `${expected.sourceChain}:${expected.sourceAddress}`,
          `${args.sourceChain}:${args.sourceAddress}`,
        );
      if (args.destinationAddress.toLowerCase() !== expected.recipient.toLowerCase())
        add("recipient", expected.recipient, args.destinationAddress);
      if (args.amount !== expected.amount) add("amount", expected.amount, args.amount);
    }
    if (
      event.eventName === "Transfer" &&
      log.address.toLowerCase() === expected.token.toLowerCase()
    ) {
      const args = event.args;
      if (
        args.from.toLowerCase() === expected.tokenManager.toLowerCase() &&
        args.to.toLowerCase() === expected.recipient.toLowerCase() &&
        args.value === expected.amount &&
        log.logIndex !== null
      ) {
        if (!payments.has(identity)) payments.set(identity, log);
        continue;
      }
      if (args.from.toLowerCase() !== expected.tokenManager.toLowerCase())
        add("token", expected.tokenManager, args.from);
      if (args.to.toLowerCase() !== expected.recipient.toLowerCase())
        add("recipient", expected.recipient, args.to);
      if (args.value !== expected.amount) add("amount", expected.amount, args.value);
    }
  }
  const ambiguous = received.size > 1 || payments.size > 1;
  if (ambiguous)
    add(
      "payment_evidence",
      "exactly one matching ITS receipt and ERC-20 payment",
      `${String(received.size)} receipts and ${String(payments.size)} payments`,
    );
  return {
    received: ambiguous ? null : ([...received.values()][0] ?? null),
    payment: ambiguous ? null : ([...payments.values()][0] ?? null),
    diagnostics,
    ambiguous,
  };
}

/** Inspect the two independent destination proofs without collapsing a missing one into failure. */
export function inspectDeliveryEvidence<T extends DeliveryLog>(
  logs: readonly T[],
  expected: ExpectedDelivery,
): DeliveryEvidence<T> {
  const { received, payment } = inspectDestinationLogs(logs, expected);
  return { received, payment };
}

export function normalizeVerificationDiagnostics(
  items: readonly VerificationDiagnostic[],
): readonly VerificationDiagnostic[] {
  const categories: readonly VerificationMismatchCategory[] = [
    "source_identity",
    "command",
    "token",
    "recipient",
    "amount",
    "payment_evidence",
  ];
  const result: VerificationDiagnostic[] = [];
  for (const item of items) {
    if (
      !categories.includes(item.category) ||
      result.some((previous) => previous.category === item.category)
    )
      continue;
    result.push({
      category: item.category,
      expected: bounded(item.expected),
      observed: bounded(item.observed),
    });
    if (result.length === categories.length) break;
  }
  return result;
}

/** Return bounded public diagnostics only when no exact receipt/payment pair exists. */
export function inspectPayment<T extends DeliveryLog>(
  logs: readonly T[],
  expected: ExpectedDelivery,
): PaymentInspection<T> {
  const inspection = inspectDestinationLogs(logs, expected);
  if (inspection.received && inspection.payment)
    return { payment: inspection.payment, diagnostics: [] };
  const diagnostics = [...inspection.diagnostics];
  const add = (
    category: VerificationMismatchCategory,
    expectedValue: unknown,
    observedValue: unknown,
  ) => {
    if (!diagnostics.some((item) => item.category === category))
      diagnostics.push({
        category,
        expected: bounded(expectedValue),
        observed: bounded(observedValue),
      });
  };
  if (!inspection.received || !inspection.payment)
    add("payment_evidence", "canonical ITS receipt and matching ERC-20 payment", null);
  return { payment: null, diagnostics: normalizeVerificationDiagnostics(diagnostics) };
}

export function matchingPayment<T extends DeliveryLog>(
  logs: readonly T[],
  expected: ExpectedDelivery,
): T | null {
  const evidence = inspectDeliveryEvidence(logs, expected);
  return evidence.received === null ? null : evidence.payment;
}
