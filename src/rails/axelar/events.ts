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

export interface ReceiptEvidenceInspection<T extends DeliveryLog = DeliveryLog> {
  readonly verified: boolean;
  readonly commandLog: T | null;
  readonly paymentLog: T | null;
  readonly paymentSender: Hex | null;
  readonly checklist: {
    readonly itsCommandMatched: boolean;
    readonly tokenContractMatched: boolean;
    readonly recipientMatched: boolean;
    readonly amountExactMatch: boolean;
    readonly erc20PaymentMatched: boolean;
  };
}

export function inspectReceiptEvidence<T extends DeliveryLog>(
  logs: readonly T[],
  expected: ExpectedDelivery,
): ReceiptEvidenceInspection<T> {
  let commandLog: T | null = null;
  let paymentLog: T | null = null;
  let paymentSender: Hex | null = null;
  let tokenContractMatched = false;
  let recipientMatched = false;
  let amountExactMatch = false;

  for (const log of logs) {
    try {
      const event = decodeEventLog({ abi: ITS_ABI, topics: log.topics, data: log.data });
      if (
        event.eventName === "InterchainTransferReceived" &&
        log.address.toLowerCase() === expected.its.toLowerCase()
      ) {
        const args = event.args;
        const matched =
          args.commandId.toLowerCase() === expected.commandId.toLowerCase() &&
          args.tokenId.toLowerCase() === expected.tokenId.toLowerCase() &&
          args.sourceChain === expected.sourceChain &&
          args.sourceAddress.toLowerCase() === expected.sourceAddress.toLowerCase() &&
          args.destinationAddress.toLowerCase() === expected.recipient.toLowerCase() &&
          args.amount === expected.amount;
        if (matched) {
          commandLog = log;
        }
      }
      if (event.eventName === "Transfer") {
        const sameToken = log.address.toLowerCase() === expected.token.toLowerCase();
        const sameRecipient = event.args.to.toLowerCase() === expected.recipient.toLowerCase();
        const sameAmount = event.args.value === expected.amount;
        if (sameToken) tokenContractMatched = true;
        if (sameToken && sameRecipient) recipientMatched = true;
        if (sameToken && sameRecipient && sameAmount) {
          amountExactMatch = true;
          paymentLog = log;
          paymentSender = event.args.from;
        }
      }
    } catch {
      /* Receipts contain unrelated events; they cannot establish this delivery. */
    }
  }

  const itsCommandMatched = commandLog !== null;
  const erc20PaymentMatched = paymentLog !== null;
  return {
    verified: itsCommandMatched && erc20PaymentMatched,
    commandLog,
    paymentLog,
    paymentSender,
    checklist: {
      itsCommandMatched,
      tokenContractMatched,
      recipientMatched,
      amountExactMatch,
      erc20PaymentMatched,
    },
  };
}

export function matchingPayment<T extends DeliveryLog>(
  logs: readonly T[],
  expected: ExpectedDelivery,
): T | null {
  const inspection = inspectReceiptEvidence(logs, expected);
  return inspection.verified ? inspection.paymentLog : null;
}
