import { decodeEventLog, parseAbi, type Hex } from "viem";

export const ITS_ABI = parseAbi([
  "function registeredTokenAddress(bytes32 tokenId) view returns (address)",
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
  commandId: string;
  tokenId: string;
  sourceChain: string;
  sourceAddress: string;
  recipient: string;
  amount: bigint;
}

export type CandidateReceiptMatch<T extends DeliveryLog = DeliveryLog> =
  | {
      readonly status: "matched";
      readonly commandLog: T;
      readonly paymentLog: T;
    }
  | {
      readonly status: "unmatched" | "ambiguous" | "conflicting";
      readonly reason: string;
    };

interface CanonicalLogEntry<T extends DeliveryLog> {
  readonly log: T;
  readonly originalIndex: number;
}

interface DecodedReception<T extends DeliveryLog> {
  readonly entry: CanonicalLogEntry<T>;
  readonly commandIdLower: string;
  readonly tokenIdLower: string;
  readonly sourceChain: string;
  readonly sourceAddressLower: string;
  readonly recipientLower: string;
  readonly amount: bigint;
}

/**
 * Deduplicates exact duplicate RPC log entries while preserving canonical `logIndex` ordering.
 */
function canonicalizeLogs<T extends DeliveryLog>(logs: readonly T[]): CanonicalLogEntry<T>[] {
  const indexed = logs.map((log, originalIndex) => ({ log, originalIndex }));
  indexed.sort((a, b) => {
    const aIdx = a.log.logIndex;
    const bIdx = b.log.logIndex;
    if (aIdx !== null && bIdx !== null && aIdx !== bIdx) {
      return aIdx - bIdx;
    }
    if (aIdx !== null && bIdx === null) return -1;
    if (aIdx === null && bIdx !== null) return 1;
    return a.originalIndex - b.originalIndex;
  });

  const seenFingerprints = new Set<string>();
  const deduped: CanonicalLogEntry<T>[] = [];
  for (const item of indexed) {
    const key = [
      item.log.logIndex === null ? "null" : String(item.log.logIndex),
      item.log.address.toLowerCase(),
      item.log.topics.map((topic) => topic.toLowerCase()).join(","),
      item.log.data.toLowerCase(),
    ].join("|");
    if (seenFingerprints.has(key)) {
      continue;
    }
    seenFingerprints.add(key);
    deduped.push(item);
  }
  return deduped;
}

/**
 * Matches a single ITS command and its corresponding ERC-20 payment within a potentially shared
 * destination transaction receipt.
 *
 * - Ignores unrelated ITS commands and ERC-20 transfers to other recipients, tokens, or amounts.
 * - Deduplicates identical log entries deterministically.
 * - Rejects conflicting `InterchainTransferReceived` records for the same `commandId` and
 *   ambiguous candidate payment pairings.
 */
export function matchItsCandidateInReceipt<T extends DeliveryLog>(
  logs: readonly T[],
  expected: ExpectedDelivery,
): CandidateReceiptMatch<T> {
  const canonical = canonicalizeLogs(logs);
  const expectedItsLower = expected.its.toLowerCase();
  const expectedTokenLower = expected.token.toLowerCase();
  const expectedCommandLower = expected.commandId.toLowerCase();
  const expectedTokenIdLower = expected.tokenId.toLowerCase();
  const expectedSourceAddressLower = expected.sourceAddress.toLowerCase();
  const expectedRecipientLower = expected.recipient.toLowerCase();

  const receptions: DecodedReception<T>[] = [];
  const candidatePayments: CanonicalLogEntry<T>[] = [];

  for (const entry of canonical) {
    const addressLower = entry.log.address.toLowerCase();
    try {
      const event = decodeEventLog({
        abi: ITS_ABI,
        topics: entry.log.topics,
        data: entry.log.data,
      });

      if (event.eventName === "InterchainTransferReceived" && addressLower === expectedItsLower) {
        receptions.push({
          entry,
          commandIdLower: event.args.commandId.toLowerCase(),
          tokenIdLower: event.args.tokenId.toLowerCase(),
          sourceChain: event.args.sourceChain,
          sourceAddressLower: event.args.sourceAddress.toLowerCase(),
          recipientLower: event.args.destinationAddress.toLowerCase(),
          amount: event.args.amount,
        });
      } else if (event.eventName === "Transfer" && addressLower === expectedTokenLower) {
        const fromLower = event.args.from.toLowerCase();
        const toLower = event.args.to.toLowerCase();
        // Self-transfers by the recipient cannot satisfy an inbound bridge delivery.
        if (
          toLower === expectedRecipientLower &&
          fromLower !== expectedRecipientLower &&
          event.args.value === expected.amount
        ) {
          candidatePayments.push(entry);
        }
      }
    } catch {
      /* Receipts contain unrelated events; they cannot establish this delivery. */
    }
  }

  const sameCommandLogs = receptions.filter((rec) => rec.commandIdLower === expectedCommandLower);
  if (sameCommandLogs.length === 0) {
    return { status: "unmatched", reason: "no matching InterchainTransferReceived event" };
  }
  if (sameCommandLogs.length > 1) {
    return {
      status: "conflicting",
      reason: "multiple distinct InterchainTransferReceived events share commandId",
    };
  }

  const targetReception = sameCommandLogs[0];
  if (targetReception === undefined) {
    return { status: "unmatched", reason: "no matching InterchainTransferReceived event" };
  }

  const targetMatchesExpected =
    targetReception.tokenIdLower === expectedTokenIdLower &&
    targetReception.sourceChain === expected.sourceChain &&
    targetReception.sourceAddressLower === expectedSourceAddressLower &&
    targetReception.recipientLower === expectedRecipientLower &&
    targetReception.amount === expected.amount;

  if (!targetMatchesExpected) {
    return {
      status: "unmatched",
      reason: "InterchainTransferReceived fields do not match expected transfer",
    };
  }

  // Find all ITS receptions in this receipt that deliver the exact same (tokenId, recipient, amount)
  // tuple and therefore compete for identical ERC-20 Transfer(to=recipient, value=amount) logs.
  const competingReceptions = receptions.filter(
    (rec) =>
      rec.tokenIdLower === expectedTokenIdLower &&
      rec.recipientLower === expectedRecipientLower &&
      rec.amount === expected.amount,
  );

  const uniqueCommandIds = new Set(competingReceptions.map((rec) => rec.commandIdLower));
  if (uniqueCommandIds.size !== competingReceptions.length) {
    return {
      status: "conflicting",
      reason: "duplicate commandId among competing ITS receptions",
    };
  }

  if (candidatePayments.length === 0) {
    return { status: "unmatched", reason: "no matching ERC-20 Transfer payment event" };
  }

  if (competingReceptions.length === 1) {
    if (candidatePayments.length > 1) {
      return {
        status: "ambiguous",
        reason: "multiple distinct ERC-20 Transfer events match a single ITS reception",
      };
    }
    const singlePayment = candidatePayments[0];
    if (singlePayment === undefined) {
      return { status: "unmatched", reason: "no matching ERC-20 Transfer payment event" };
    }
    return {
      status: "matched",
      commandLog: targetReception.entry.log,
      paymentLog: singlePayment.log,
    };
  }

  // Multiple ITS commands in one receipt share (tokenId, recipient, amount).
  // Require a strict 1-to-1 count and non-overlapping logIndex call-frame spans.
  if (candidatePayments.length !== competingReceptions.length) {
    return {
      status: "ambiguous",
      reason: "competing ITS reception count does not match ERC-20 Transfer count",
    };
  }

  const usedIndices = new Set<number>();
  const spans: { readonly minIdx: number; readonly maxIdx: number }[] = [];

  for (let i = 0; i < competingReceptions.length; i += 1) {
    const rec = competingReceptions[i];
    const pay = candidatePayments[i];
    const recIdx = rec?.entry.log.logIndex ?? null;
    const payIdx = pay?.log.logIndex ?? null;
    if (recIdx === null || payIdx === null || recIdx === payIdx) {
      return {
        status: "ambiguous",
        reason: "missing or colliding logIndex across multiple ITS candidates",
      };
    }
    if (usedIndices.has(recIdx) || usedIndices.has(payIdx)) {
      return {
        status: "ambiguous",
        reason: "colliding logIndex across multiple ITS candidates",
      };
    }
    usedIndices.add(recIdx);
    usedIndices.add(payIdx);
    spans.push({
      minIdx: Math.min(recIdx, payIdx),
      maxIdx: Math.max(recIdx, payIdx),
    });
  }

  for (let i = 0; i < spans.length - 1; i += 1) {
    const current = spans[i];
    const next = spans[i + 1];
    if (current !== undefined && next !== undefined && current.maxIdx >= next.minIdx) {
      return {
        status: "ambiguous",
        reason: "interleaved ITS command and ERC-20 Transfer log spans",
      };
    }
  }

  const targetIndex = competingReceptions.findIndex(
    (rec) => rec.commandIdLower === expectedCommandLower,
  );
  const matchedPayment = targetIndex >= 0 ? candidatePayments[targetIndex] : undefined;
  if (matchedPayment === undefined) {
    return { status: "unmatched", reason: "unable to pair ITS command with payment" };
  }

  return {
    status: "matched",
    commandLog: targetReception.entry.log,
    paymentLog: matchedPayment.log,
  };
}

export function matchingPayment<T extends DeliveryLog>(
  logs: readonly T[],
  expected: ExpectedDelivery,
): T | null {
  const result = matchItsCandidateInReceipt(logs, expected);
  return result.status === "matched" ? result.paymentLog : null;
}
