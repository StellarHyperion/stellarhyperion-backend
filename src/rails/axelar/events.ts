import { decodeEventLog, parseAbi, type Hex } from "viem";

export const ITS_ABI = parseAbi([
  "function registeredTokenAddress(bytes32 tokenId) view returns (address)",
  "function deployedTokenManager(bytes32 tokenId) view returns (address)",
  "event InterchainTransferReceived(bytes32 indexed commandId, bytes32 indexed tokenId, string sourceChain, bytes sourceAddress, address indexed destinationAddress, uint256 amount, bytes32 dataHash)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const TOKEN_MANAGER_ABI = parseAbi([
  "function tokenAddress() view returns (address)",
  "function implementationType() view returns (uint256)",
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

export interface MatchedItsDelivery<T extends DeliveryLog = DeliveryLog> {
  readonly receivedLog: T;
  readonly paymentLog: T;
  readonly commandId: Hex;
  readonly tokenId: Hex;
  readonly sourceChain: string;
  readonly sourceAddress: Hex;
  readonly destinationAddress: Hex;
  readonly amount: bigint;
  readonly dataHash: Hex;
  readonly paymentFrom: Hex;
}

export function matchItsDelivery<T extends DeliveryLog>(
  logs: readonly T[],
  expected: ExpectedDelivery,
): MatchedItsDelivery<T> | null {
  let received: {
    readonly log: T;
    readonly commandId: Hex;
    readonly tokenId: Hex;
    readonly sourceChain: string;
    readonly sourceAddress: Hex;
    readonly destinationAddress: Hex;
    readonly amount: bigint;
    readonly dataHash: Hex;
  } | null = null;
  let payment: { readonly log: T; readonly from: Hex } | null = null;

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
        if (matches && received === null) {
          received = {
            log,
            commandId: args.commandId,
            tokenId: args.tokenId,
            sourceChain: args.sourceChain,
            sourceAddress: args.sourceAddress,
            destinationAddress: args.destinationAddress,
            amount: args.amount,
            dataHash: args.dataHash,
          };
        }
      }
      if (
        event.eventName === "Transfer" &&
        log.address.toLowerCase() === expected.token.toLowerCase() &&
        event.args.to.toLowerCase() === expected.recipient.toLowerCase() &&
        event.args.value === expected.amount
      ) {
        payment = { log, from: event.args.from };
      }
    } catch {
      /* Receipts contain unrelated events; they cannot establish this delivery. */
    }
  }

  if (!received || !payment) return null;
  return {
    receivedLog: received.log,
    paymentLog: payment.log,
    commandId: received.commandId,
    tokenId: received.tokenId,
    sourceChain: received.sourceChain,
    sourceAddress: received.sourceAddress,
    destinationAddress: received.destinationAddress,
    amount: received.amount,
    dataHash: received.dataHash,
    paymentFrom: payment.from,
  };
}

export function matchingPayment<T extends DeliveryLog>(
  logs: readonly T[],
  expected: ExpectedDelivery,
): T | null {
  return matchItsDelivery(logs, expected)?.paymentLog ?? null;
}
