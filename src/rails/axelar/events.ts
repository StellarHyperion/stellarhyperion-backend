import { decodeEventLog, parseAbi, type Hex } from "viem";
import type { ProofRejectionReason } from "../proof-reasons.js";

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

export type ItsReceiptClassification<T extends DeliveryLog> =
  | { readonly ok: true; readonly payment: T }
  | { readonly ok: false; readonly reason: ProofRejectionReason };

export function classifyItsReceipt<T extends DeliveryLog>(
  logs: readonly T[],
  expected: ExpectedDelivery,
): ItsReceiptClassification<T> {
  let received = false;
  let payment: T | null = null;

  let sawItsTokenMismatch = false;
  let sawItsRecipientMismatch = false;
  let sawItsAmountMismatch = false;
  let sawTransferTokenMismatch = false;
  let sawTransferRecipientMismatch = false;
  let sawTransferAmountMismatch = false;

  for (const log of logs) {
    try {
      const event = decodeEventLog({ abi: ITS_ABI, topics: log.topics, data: log.data });
      if (
        event.eventName === "InterchainTransferReceived" &&
        log.address.toLowerCase() === expected.its.toLowerCase()
      ) {
        const args = event.args;
        const commandMatches = args.commandId.toLowerCase() === expected.commandId.toLowerCase();
        const tokenMatches = args.tokenId.toLowerCase() === expected.tokenId.toLowerCase();
        const sourceMatches =
          args.sourceChain === expected.sourceChain &&
          args.sourceAddress.toLowerCase() === expected.sourceAddress.toLowerCase();
        const recipientMatches =
          args.destinationAddress.toLowerCase() === expected.recipient.toLowerCase();
        const amountMatches = args.amount === expected.amount;

        if (commandMatches && tokenMatches && sourceMatches && recipientMatches && amountMatches) {
          received = true;
        } else if (commandMatches && sourceMatches) {
          if (!tokenMatches) sawItsTokenMismatch = true;
          else if (!recipientMatches) sawItsRecipientMismatch = true;
          else if (!amountMatches) sawItsAmountMismatch = true;
        }
      }
      if (event.eventName === "Transfer") {
        const tokenMatches = log.address.toLowerCase() === expected.token.toLowerCase();
        const fromIts = event.args.from.toLowerCase() === expected.its.toLowerCase();
        const recipientMatches = event.args.to.toLowerCase() === expected.recipient.toLowerCase();
        const amountMatches = event.args.value === expected.amount;

        if (tokenMatches && recipientMatches && amountMatches) {
          payment = log;
        } else if (fromIts) {
          if (!tokenMatches && recipientMatches) sawTransferTokenMismatch = true;
          else if (tokenMatches && !recipientMatches) sawTransferRecipientMismatch = true;
          else if (tokenMatches && recipientMatches && !amountMatches) {
            sawTransferAmountMismatch = true;
          }
        }
      }
    } catch {
      /* Receipts contain unrelated events; they cannot establish this delivery. */
    }
  }

  if (received && payment !== null) {
    return { ok: true, payment };
  }
  if (sawItsTokenMismatch || (received && sawTransferTokenMismatch)) {
    return { ok: false, reason: "token_mismatch" };
  }
  if (sawItsRecipientMismatch || (received && sawTransferRecipientMismatch)) {
    return { ok: false, reason: "recipient_mismatch" };
  }
  if (sawItsAmountMismatch || (received && sawTransferAmountMismatch)) {
    return { ok: false, reason: "amount_mismatch" };
  }
  return { ok: false, reason: "provider_inconsistency" };
}

export function matchingPayment<T extends DeliveryLog>(
  logs: readonly T[],
  expected: ExpectedDelivery,
): T | null {
  const outcome = classifyItsReceipt(logs, expected);
  return outcome.ok ? outcome.payment : null;
}
