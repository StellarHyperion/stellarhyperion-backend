import { decodeEventLog, getAddress, parseAbi, type Hex } from "viem";
export const ITS_ABI = parseAbi([
  "function registeredTokenAddress(bytes32 tokenId) view returns (address)",
  "event InterchainTransferReceived(bytes32 indexed commandId, bytes32 indexed tokenId, string sourceChain, bytes sourceAddress, address indexed destinationAddress, uint256 amount, bytes32 dataHash)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const AXELAR_GAS_SERVICE_ABI = parseAbi([
  "event NativeGasPaidForContractCall(address indexed sourceAddress, string destinationChain, string destinationAddress, bytes32 indexed payloadHash, uint256 gasFeeAmount, address refundAddress)",
  "event GasPaidForContractCall(address indexed sourceAddress, string destinationChain, string destinationAddress, bytes32 indexed payloadHash, address gasToken, uint256 gasFeeAmount, address refundAddress)",
  "event NativeGasPaidForExpressCall(address indexed sourceAddress, string destinationChain, string destinationAddress, bytes32 indexed payloadHash, uint256 gasFeeAmount, address refundAddress)",
  "event NativeGasAdded(bytes32 indexed txHash, uint256 indexed logIndex, uint256 gasFeeAmount, address refundAddress)",
  "event GasAdded(bytes32 indexed txHash, uint256 indexed logIndex, address gasToken, uint256 gasFeeAmount, address refundAddress)",
  "event Refunded(bytes32 indexed txHash, uint256 indexed logIndex, address receiver, address token, uint256 amount)",
]);

const ZERO_EVM_ADDRESS = "0x0000000000000000000000000000000000000000";

export type AxelarGasEventKind = "gas_paid" | "gas_added" | "refunded";

export interface DecodedAxelarGasLog {
  readonly eventKind: AxelarGasEventKind;
  readonly isNative: boolean;
  readonly gasToken: string | null;
  readonly amount: bigint;
  readonly sender: string | null;
  readonly refundAddress: string;
  readonly sourceTxRef: string | null;
  readonly sourceLogIndexRef: bigint | null;
  readonly messageId: string | null;
  readonly payloadHash: string | null;
  readonly logIndex: number;
}
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
export function matchingPayment<T extends DeliveryLog>(
  logs: readonly T[],
  expected: ExpectedDelivery,
): T | null {
  let received = false;
  let payment: T | null = null;
  for (const log of logs) {
    try {
      const event = decodeEventLog({ abi: ITS_ABI, topics: log.topics, data: log.data });
      if (
        event.eventName === "InterchainTransferReceived" &&
        log.address.toLowerCase() === expected.its.toLowerCase()
      ) {
        const args = event.args;
        received ||=
          args.commandId.toLowerCase() === expected.commandId.toLowerCase() &&
          args.tokenId.toLowerCase() === expected.tokenId.toLowerCase() &&
          args.sourceChain === expected.sourceChain &&
          args.sourceAddress.toLowerCase() === expected.sourceAddress.toLowerCase() &&
          args.destinationAddress.toLowerCase() === expected.recipient.toLowerCase() &&
          args.amount === expected.amount;
      }
      if (
        event.eventName === "Transfer" &&
        log.address.toLowerCase() === expected.token.toLowerCase() &&
        event.args.to.toLowerCase() === expected.recipient.toLowerCase() &&
        event.args.value === expected.amount
      )
        payment = log;
    } catch {
      /* Receipts contain unrelated events; they cannot establish this delivery. */
    }
  }
  return received ? payment : null;
}

/**
 * Decodes a public EVM `IAxelarGasService` log emitted by `expectedGasService`.
 *
 * Preserves exact uint256 native/token amounts and exact EIP-55 checksummed refund recipient
 * addresses. Returns `null` for logs from other contracts or unrelated events.
 */
export function decodeAxelarGasServiceLog(
  log: DeliveryLog,
  expectedGasService: string,
  enclosingTxHash: string,
): DecodedAxelarGasLog | null {
  if (log.logIndex === null || log.logIndex < 0) {
    return null;
  }
  if (log.address.toLowerCase() !== expectedGasService.toLowerCase()) {
    return null;
  }

  try {
    const decoded = decodeEventLog({
      abi: AXELAR_GAS_SERVICE_ABI,
      topics: log.topics,
      data: log.data,
    });

    if (
      decoded.eventName === "NativeGasPaidForContractCall" ||
      decoded.eventName === "NativeGasPaidForExpressCall"
    ) {
      return {
        eventKind: "gas_paid",
        isNative: true,
        gasToken: null,
        amount: decoded.args.gasFeeAmount,
        sender: getAddress(decoded.args.sourceAddress),
        refundAddress: getAddress(decoded.args.refundAddress),
        sourceTxRef: enclosingTxHash,
        sourceLogIndexRef: null,
        messageId: null,
        payloadHash: decoded.args.payloadHash,
        logIndex: log.logIndex,
      };
    }

    if (decoded.eventName === "GasPaidForContractCall") {
      return {
        eventKind: "gas_paid",
        isNative: false,
        gasToken: getAddress(decoded.args.gasToken),
        amount: decoded.args.gasFeeAmount,
        sender: getAddress(decoded.args.sourceAddress),
        refundAddress: getAddress(decoded.args.refundAddress),
        sourceTxRef: enclosingTxHash,
        sourceLogIndexRef: null,
        messageId: null,
        payloadHash: decoded.args.payloadHash,
        logIndex: log.logIndex,
      };
    }

    if (decoded.eventName === "NativeGasAdded") {
      return {
        eventKind: "gas_added",
        isNative: true,
        gasToken: null,
        amount: decoded.args.gasFeeAmount,
        sender: null,
        refundAddress: getAddress(decoded.args.refundAddress),
        sourceTxRef: decoded.args.txHash,
        sourceLogIndexRef: decoded.args.logIndex,
        messageId: null,
        payloadHash: null,
        logIndex: log.logIndex,
      };
    }

    if (decoded.eventName === "GasAdded") {
      return {
        eventKind: "gas_added",
        isNative: false,
        gasToken: getAddress(decoded.args.gasToken),
        amount: decoded.args.gasFeeAmount,
        sender: null,
        refundAddress: getAddress(decoded.args.refundAddress),
        sourceTxRef: decoded.args.txHash,
        sourceLogIndexRef: decoded.args.logIndex,
        messageId: null,
        payloadHash: null,
        logIndex: log.logIndex,
      };
    }

    // Refunded(bytes32 indexed txHash, uint256 indexed logIndex, address payable receiver, address token, uint256 amount)
    const isNativeRefund = decoded.args.token.toLowerCase() === ZERO_EVM_ADDRESS;
    return {
      eventKind: "refunded",
      isNative: isNativeRefund,
      gasToken: isNativeRefund ? null : getAddress(decoded.args.token),
      amount: decoded.args.amount,
      sender: null,
      refundAddress: getAddress(decoded.args.receiver),
      sourceTxRef: decoded.args.txHash,
      sourceLogIndexRef: decoded.args.logIndex,
      messageId: null,
      payloadHash: null,
      logIndex: log.logIndex,
    };
  } catch {
    return null;
  }
}
