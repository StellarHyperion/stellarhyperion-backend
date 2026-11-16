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

export type ItsReceiptLogDiagnosis<T extends DeliveryLog = DeliveryLog> =
  | {
      readonly kind: "verified";
      readonly command: T;
      readonly payment: T;
    }
  | {
      readonly kind: "payout_unverified";
      readonly reason:
        | "missing_its_command_event"
        | "mismatched_its_command_fields"
        | "missing_erc20_transfer_event";
    };

export function diagnoseItsReceiptLogs<T extends DeliveryLog>(
  logs: readonly T[],
  expected: ExpectedDelivery,
): ItsReceiptLogDiagnosis<T> {
  let sawCommandIdOnIts = false;
  let matchedCommand: T | null = null;
  let payment: T | null = null;

  for (const log of logs) {
    try {
      const event = decodeEventLog({ abi: ITS_ABI, topics: log.topics, data: log.data });
      if (
        event.eventName === "InterchainTransferReceived" &&
        log.address.toLowerCase() === expected.its.toLowerCase()
      ) {
        const args = event.args;
        if (args.commandId.toLowerCase() === expected.commandId.toLowerCase()) {
          sawCommandIdOnIts = true;
          const exactMatch =
            args.tokenId.toLowerCase() === expected.tokenId.toLowerCase() &&
            args.sourceChain === expected.sourceChain &&
            args.sourceAddress.toLowerCase() === expected.sourceAddress.toLowerCase() &&
            args.destinationAddress.toLowerCase() === expected.recipient.toLowerCase() &&
            args.amount === expected.amount;
          if (exactMatch && matchedCommand === null) {
            matchedCommand = log;
          }
        }
      }
      if (
        event.eventName === "Transfer" &&
        log.address.toLowerCase() === expected.token.toLowerCase() &&
        event.args.to.toLowerCase() === expected.recipient.toLowerCase() &&
        event.args.value === expected.amount
      ) {
        payment = log;
      }
    } catch {
      /* Receipts contain unrelated events; they cannot establish this delivery. */
    }
  }

  if (matchedCommand === null) {
    return {
      kind: "payout_unverified",
      reason: sawCommandIdOnIts ? "mismatched_its_command_fields" : "missing_its_command_event",
    };
  }
  if (payment === null) {
    return {
      kind: "payout_unverified",
      reason: "missing_erc20_transfer_event",
    };
  }

  return {
    kind: "verified",
    command: matchedCommand,
    payment,
  };
}

export function matchingPayment<T extends DeliveryLog>(
  logs: readonly T[],
  expected: ExpectedDelivery,
): T | null {
  const diagnosis = diagnoseItsReceiptLogs(logs, expected);
  return diagnosis.kind === "verified" ? diagnosis.payment : null;
}
