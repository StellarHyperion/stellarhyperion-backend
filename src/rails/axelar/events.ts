import { decodeEventLog, parseAbi, type Hex } from "viem";

export const ITS_ABI = parseAbi([
  "function registeredTokenAddress(bytes32 tokenId) view returns (address)",
  "event InterchainTransferReceived(bytes32 indexed commandId, bytes32 indexed tokenId, string sourceChain, bytes sourceAddress, address indexed destinationAddress, uint256 amount, bytes32 dataHash)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const MAX_DIAGNOSTIC_IDENTIFIER_LENGTH = 160;

export type ItsUnavailableCategory =
  | "execution_candidate_missing"
  | "receipt_unavailable"
  | "insufficient_confirmations"
  | "non_canonical_receipt_block";

export type ItsMismatchCategory =
  | "reverted_execution_receipt"
  | "source_identity_mismatch"
  | "command_mismatch"
  | "token_mismatch"
  | "recipient_mismatch"
  | "amount_mismatch"
  | "payment_evidence_missing";

export type ItsDiagnosticCategory = ItsUnavailableCategory | ItsMismatchCategory;

export interface DeliveryLog {
  address: Hex;
  topics: [] | [Hex, ...Hex[]];
  data: Hex;
  logIndex: number | null;
}

export interface ExpectedDelivery {
  its: string;
  token: string;
  commandId: string;
  tokenId: string;
  sourceChain: string;
  sourceAddress: string;
  recipient: string;
  amount: bigint;
}

export type ItsLogEvaluation<T extends DeliveryLog = DeliveryLog> =
  | {
      readonly kind: "matched";
      readonly paymentLog: T;
    }
  | {
      readonly kind: "mismatch";
      readonly category: Exclude<ItsMismatchCategory, "reverted_execution_receipt">;
      readonly expectedValue: string | null;
      readonly observedValue: string | null;
    };

/**
 * Sanitizes an identifier for diagnostic persistence and API exposure.
 * Strips URLs, query parameters, credentials, and control characters, and caps width.
 */
export function boundDiagnosticIdentifier(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ||
    /(bearer|apikey|api_key|password|secret|token=)/i.test(trimmed)
  ) {
    return "[redacted]";
  }
  const cleaned = trimmed.replace(/[^0-9a-zA-Z:_./@-]/g, "");
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, MAX_DIAGNOSTIC_IDENTIFIER_LENGTH);
}

interface DecodedReceived {
  readonly commandId: Hex;
  readonly tokenId: Hex;
  readonly sourceChain: string;
  readonly sourceAddress: Hex;
  readonly destinationAddress: Hex;
  readonly amount: bigint;
}

interface DecodedTransfer<T extends DeliveryLog> {
  readonly log: T;
  readonly tokenAddress: Hex;
  readonly to: Hex;
  readonly value: bigint;
}

export function evaluateItsDeliveryLogs<T extends DeliveryLog>(
  logs: readonly T[],
  expected: ExpectedDelivery,
): ItsLogEvaluation<T> {
  const receivedEvents: DecodedReceived[] = [];
  const otherItsAddressEvents: Hex[] = [];
  const tokenTransfers: DecodedTransfer<T>[] = [];
  let exactReceived = false;
  let exactPayment: T | null = null;

  for (const log of logs) {
    try {
      const event = decodeEventLog({ abi: ITS_ABI, topics: log.topics, data: log.data });
      if (event.eventName === "InterchainTransferReceived") {
        if (log.address.toLowerCase() === expected.its.toLowerCase()) {
          const args = event.args;
          receivedEvents.push({
            commandId: args.commandId,
            tokenId: args.tokenId,
            sourceChain: args.sourceChain,
            sourceAddress: args.sourceAddress,
            destinationAddress: args.destinationAddress,
            amount: args.amount,
          });
          if (
            args.commandId.toLowerCase() === expected.commandId.toLowerCase() &&
            args.tokenId.toLowerCase() === expected.tokenId.toLowerCase() &&
            args.sourceChain === expected.sourceChain &&
            args.sourceAddress.toLowerCase() === expected.sourceAddress.toLowerCase() &&
            args.destinationAddress.toLowerCase() === expected.recipient.toLowerCase() &&
            args.amount === expected.amount
          ) {
            exactReceived = true;
          }
        } else {
          otherItsAddressEvents.push(log.address);
        }
      } else {
        tokenTransfers.push({
          log,
          tokenAddress: log.address,
          to: event.args.to,
          value: event.args.value,
        });
        if (
          log.address.toLowerCase() === expected.token.toLowerCase() &&
          event.args.to.toLowerCase() === expected.recipient.toLowerCase() &&
          event.args.value === expected.amount
        ) {
          exactPayment = log;
        }
      }
    } catch {
      /* Receipts contain unrelated events; they cannot establish this delivery. */
    }
  }

  if (exactReceived && exactPayment !== null) {
    return { kind: "matched", paymentLog: exactPayment };
  }

  if (!exactReceived) {
    if (receivedEvents.length === 0) {
      return {
        kind: "mismatch",
        category: "command_mismatch",
        expectedValue: boundDiagnosticIdentifier(expected.commandId.toLowerCase()),
        observedValue: boundDiagnosticIdentifier(otherItsAddressEvents[0]?.toLowerCase() ?? null),
      };
    }

    const byCommand = receivedEvents.find(
      (item) => item.commandId.toLowerCase() === expected.commandId.toLowerCase(),
    );
    const candidate = byCommand ?? receivedEvents[0];
    if (!candidate) {
      return {
        kind: "mismatch",
        category: "command_mismatch",
        expectedValue: boundDiagnosticIdentifier(expected.commandId.toLowerCase()),
        observedValue: null,
      };
    }

    if (candidate.commandId.toLowerCase() !== expected.commandId.toLowerCase()) {
      return {
        kind: "mismatch",
        category: "command_mismatch",
        expectedValue: boundDiagnosticIdentifier(expected.commandId.toLowerCase()),
        observedValue: boundDiagnosticIdentifier(candidate.commandId.toLowerCase()),
      };
    }
    if (candidate.tokenId.toLowerCase() !== expected.tokenId.toLowerCase()) {
      return {
        kind: "mismatch",
        category: "token_mismatch",
        expectedValue: boundDiagnosticIdentifier(expected.tokenId.toLowerCase()),
        observedValue: boundDiagnosticIdentifier(candidate.tokenId.toLowerCase()),
      };
    }
    if (
      candidate.sourceChain !== expected.sourceChain ||
      candidate.sourceAddress.toLowerCase() !== expected.sourceAddress.toLowerCase()
    ) {
      return {
        kind: "mismatch",
        category: "source_identity_mismatch",
        expectedValue: boundDiagnosticIdentifier(
          `${expected.sourceChain}:${expected.sourceAddress.toLowerCase()}`,
        ),
        observedValue: boundDiagnosticIdentifier(
          `${candidate.sourceChain}:${candidate.sourceAddress.toLowerCase()}`,
        ),
      };
    }
    if (candidate.destinationAddress.toLowerCase() !== expected.recipient.toLowerCase()) {
      return {
        kind: "mismatch",
        category: "recipient_mismatch",
        expectedValue: boundDiagnosticIdentifier(expected.recipient.toLowerCase()),
        observedValue: boundDiagnosticIdentifier(candidate.destinationAddress.toLowerCase()),
      };
    }
    return {
      kind: "mismatch",
      category: "amount_mismatch",
      expectedValue: expected.amount.toString(),
      observedValue: candidate.amount.toString(),
    };
  }

  // Exact InterchainTransferReceived event was present, so classify why ERC-20 payment failed.
  const sameTokenTransfers = tokenTransfers.filter(
    (item) => item.tokenAddress.toLowerCase() === expected.token.toLowerCase(),
  );
  const sameTokenSameRecipient = sameTokenTransfers.find(
    (item) => item.to.toLowerCase() === expected.recipient.toLowerCase(),
  );
  if (sameTokenSameRecipient) {
    return {
      kind: "mismatch",
      category: "amount_mismatch",
      expectedValue: expected.amount.toString(),
      observedValue: sameTokenSameRecipient.value.toString(),
    };
  }

  const sameTokenWrongRecipient = sameTokenTransfers[0];
  if (sameTokenWrongRecipient) {
    return {
      kind: "mismatch",
      category: "recipient_mismatch",
      expectedValue: boundDiagnosticIdentifier(expected.recipient.toLowerCase()),
      observedValue: boundDiagnosticIdentifier(sameTokenWrongRecipient.to.toLowerCase()),
    };
  }

  const wrongTokenToRecipient = tokenTransfers.find(
    (item) => item.to.toLowerCase() === expected.recipient.toLowerCase(),
  );
  if (wrongTokenToRecipient) {
    return {
      kind: "mismatch",
      category: "token_mismatch",
      expectedValue: boundDiagnosticIdentifier(expected.token.toLowerCase()),
      observedValue: boundDiagnosticIdentifier(wrongTokenToRecipient.tokenAddress.toLowerCase()),
    };
  }

  return {
    kind: "mismatch",
    category: "payment_evidence_missing",
    expectedValue: boundDiagnosticIdentifier(
      `${expected.token.toLowerCase()}:${expected.amount.toString()}`,
    ),
    observedValue: null,
  };
}

export function matchingPayment<T extends DeliveryLog>(
  logs: readonly T[],
  expected: ExpectedDelivery,
): T | null {
  const result = evaluateItsDeliveryLogs(logs, expected);
  return result.kind === "matched" ? result.paymentLog : null;
}
