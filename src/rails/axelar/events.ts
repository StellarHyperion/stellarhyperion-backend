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
  return text.length <= 128 ? text : `${text.slice(0, 64)}…${text.slice(-63)}`;
}

/** Inspect delivery evidence without exposing raw provider responses. */
export function inspectPayment<T extends DeliveryLog>(
  logs: readonly T[],
  expected: ExpectedDelivery,
): PaymentInspection<T> {
  let received = false;
  let payment: T | null = null;
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

  for (const log of logs) {
    try {
      const event = decodeEventLog({ abi: ITS_ABI, topics: log.topics, data: log.data });
      if (event.eventName === "InterchainTransferReceived") {
        if (log.address.toLowerCase() !== expected.its.toLowerCase()) continue;
        received = true;
        const args = event.args;
        if (args.commandId.toLowerCase() !== expected.commandId.toLowerCase())
          add("command", expected.commandId, args.commandId);
        if (args.tokenId.toLowerCase() !== expected.tokenId.toLowerCase())
          add("token", expected.tokenId, args.tokenId);
        if (args.sourceChain !== expected.sourceChain)
          add("source_identity", expected.sourceChain, args.sourceChain);
        if (args.sourceAddress.toLowerCase() !== expected.sourceAddress.toLowerCase())
          add("source_identity", expected.sourceAddress, args.sourceAddress);
        if (args.destinationAddress.toLowerCase() !== expected.recipient.toLowerCase())
          add("recipient", expected.recipient, args.destinationAddress);
        if (args.amount !== expected.amount) add("amount", expected.amount, args.amount);
      }
      if (
        event.eventName === "Transfer" &&
        log.address.toLowerCase() === expected.token.toLowerCase() &&
        event.args.from.toLowerCase() === expected.tokenManager.toLowerCase() &&
        event.args.to.toLowerCase() === expected.recipient.toLowerCase() &&
        event.args.value === expected.amount &&
        log.logIndex !== null
      )
        payment = log;
    } catch {
      /* Unrelated or malformed receipt events cannot establish delivery. */
    }
  }
  if (!received) add("payment_evidence", "InterchainTransferReceived", null);
  if (received && payment === null) add("payment_evidence", expected.amount, null);
  const mismatch = diagnostics.some((item) => item.category !== "payment_evidence");
  return { payment: received && !mismatch ? payment : null, diagnostics };
}

export function matchingPayment<T extends DeliveryLog>(
  logs: readonly T[],
  expected: ExpectedDelivery,
): T | null {
  return inspectPayment(logs, expected).payment;
}
