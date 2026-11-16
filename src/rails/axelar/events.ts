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

export interface MatchedItsReceipt<T extends DeliveryLog = DeliveryLog> {
  readonly commandLog: T;
  readonly paymentLog: T;
  readonly commandId: Hex;
  readonly tokenId: Hex;
  readonly sourceChain: string;
  readonly sourceAddress: Hex;
  readonly destinationAddress: Hex;
  readonly amount: bigint;
}

export function inspectItsReceiptLogs<T extends DeliveryLog>(
  logs: readonly T[],
  expected: ExpectedDelivery,
): MatchedItsReceipt<T> | null {
  let matchedCommand: {
    readonly log: T;
    readonly commandId: Hex;
    readonly tokenId: Hex;
    readonly sourceChain: string;
    readonly sourceAddress: Hex;
    readonly destinationAddress: Hex;
    readonly amount: bigint;
  } | null = null;
  let payment: T | null = null;

  for (const log of logs) {
    try {
      const event = decodeEventLog({ abi: ITS_ABI, topics: log.topics, data: log.data });
      if (
        event.eventName === "InterchainTransferReceived" &&
        log.address.toLowerCase() === expected.its.toLowerCase()
      ) {
        const args = event.args;
        const matches =
          args.commandId.toLowerCase() === expected.commandId.toLowerCase() &&
          args.tokenId.toLowerCase() === expected.tokenId.toLowerCase() &&
          args.sourceChain === expected.sourceChain &&
          args.sourceAddress.toLowerCase() === expected.sourceAddress.toLowerCase() &&
          args.destinationAddress.toLowerCase() === expected.recipient.toLowerCase() &&
          args.amount === expected.amount;
        if (matches && matchedCommand === null) {
          matchedCommand = {
            log,
            commandId: args.commandId,
            tokenId: args.tokenId,
            sourceChain: args.sourceChain,
            sourceAddress: args.sourceAddress,
            destinationAddress: args.destinationAddress,
            amount: args.amount,
          };
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

  if (matchedCommand === null || payment === null) {
    return null;
  }

  return {
    commandLog: matchedCommand.log,
    paymentLog: payment,
    commandId: matchedCommand.commandId,
    tokenId: matchedCommand.tokenId,
    sourceChain: matchedCommand.sourceChain,
    sourceAddress: matchedCommand.sourceAddress,
    destinationAddress: matchedCommand.destinationAddress,
    amount: matchedCommand.amount,
  };
}

export function matchingPayment<T extends DeliveryLog>(
  logs: readonly T[],
  expected: ExpectedDelivery,
): T | null {
  return inspectItsReceiptLogs(logs, expected)?.paymentLog ?? null;
}
