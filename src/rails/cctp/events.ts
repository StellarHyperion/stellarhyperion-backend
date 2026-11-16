import { StrKey } from "@stellar/stellar-sdk";
import {
  assertSupportedBurn,
  assertSupportedMessage,
  cctpBody,
  parseCctpBurnMessage,
  parseCctpMessage,
  toEvmAddress,
  toHex,
  type CctpBurnMessage,
  type CctpMessage,
} from "@hyperion/protocol";
import { decodeEventLog, keccak256, parseAbi, type Hex } from "viem";
import type { DeliveryLog } from "../axelar/events.js";

// Source: circlefin/evm-cctp-contracts/src/v2/MessageTransmitterV2.sol.
export const CCTP_RECEIPT_ABI = parseAbi([
  "event MessageReceived(address indexed caller,uint32 sourceDomain,bytes32 indexed nonce,bytes32 sender,uint32 indexed finalityThresholdExecuted,bytes messageBody)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);

export interface ExpectedCctpTransfer {
  sourceToken: string;
  sourceAdapter: string;
  sourceMessenger: string;
  destinationDomain: number;
  destinationMessenger: string;
  transmitter: string;
  token: string;
  recipient: string;
  sourceAmount: bigint;
}

export interface VerifiedCctpMessageDetail {
  readonly message: CctpMessage;
  readonly burn: CctpBurnMessage;
  readonly body: Hex;
  readonly amount: bigint;
  readonly messageHash: Hex;
  readonly bodyHash: Hex;
}

export interface MatchedCctpReceiptEvidence<T extends DeliveryLog> {
  readonly verified: VerifiedCctpMessageDetail;
  readonly messageLog: T;
  readonly paymentLog: T;
}

export function verifiedCctpMessage(
  raw: Hex,
  expected: ExpectedCctpTransfer,
): VerifiedCctpMessageDetail | null {
  const message = parseCctpMessage(raw);
  const body = cctpBody(raw);
  const burn = parseCctpBurnMessage(body);
  assertSupportedMessage(message);
  assertSupportedBurn(burn);
  const word = (address: string) => `0x${address.slice(2).padStart(64, "0")}`.toLowerCase();
  if (
    message.sourceDomain !== 27 ||
    message.destinationDomain !== expected.destinationDomain ||
    message.sender.toLowerCase() !==
      toHex(StrKey.decodeContract(expected.sourceMessenger)).toLowerCase() ||
    message.recipient.toLowerCase() !== word(expected.destinationMessenger) ||
    burn.messageSender.toLowerCase() !==
      toHex(StrKey.decodeContract(expected.sourceAdapter)).toLowerCase() ||
    burn.burnToken.toLowerCase() !==
      toHex(StrKey.decodeContract(expected.sourceToken)).toLowerCase() ||
    toEvmAddress(burn.mintRecipient).toLowerCase() !== expected.recipient.toLowerCase() ||
    expected.sourceAmount % 10n !== 0n ||
    burn.amount !== expected.sourceAmount / 10n ||
    burn.feeExecuted > burn.maxFee ||
    burn.feeExecuted < 0n ||
    burn.feeExecuted >= burn.amount ||
    message.finalityThresholdExecuted < 2000
  ) {
    return null;
  }
  const bodyHex = toHex(body);
  return {
    message,
    burn,
    body: bodyHex,
    amount: burn.amount - burn.feeExecuted,
    messageHash: keccak256(raw),
    bodyHash: keccak256(bodyHex),
  };
}

export function matchCctpReceiptEvidence<T extends DeliveryLog>(
  logs: readonly T[],
  raw: Hex,
  expected: ExpectedCctpTransfer,
): MatchedCctpReceiptEvidence<T> | null {
  const verified = verifiedCctpMessage(raw, expected);
  if (!verified) return null;
  let messageLog: T | null = null;
  let paymentLog: T | null = null;
  for (const log of logs) {
    try {
      const event = decodeEventLog({ abi: CCTP_RECEIPT_ABI, topics: log.topics, data: log.data });
      if (
        event.eventName === "MessageReceived" &&
        log.address.toLowerCase() === expected.transmitter.toLowerCase() &&
        event.args.sourceDomain === 27 &&
        event.args.nonce.toLowerCase() === verified.message.nonce.toLowerCase() &&
        event.args.sender.toLowerCase() === verified.message.sender.toLowerCase() &&
        event.args.finalityThresholdExecuted === verified.message.finalityThresholdExecuted &&
        event.args.messageBody.toLowerCase() === verified.body.toLowerCase()
      ) {
        messageLog = log;
      }
      if (
        event.eventName === "Transfer" &&
        log.address.toLowerCase() === expected.token.toLowerCase() &&
        /^0x0{40}$/.test(event.args.from) &&
        event.args.to.toLowerCase() === expected.recipient.toLowerCase() &&
        event.args.value === verified.amount
      ) {
        paymentLog = log;
      }
    } catch {
      /* Unrelated receipt events do not establish this transfer's delivery. */
    }
  }
  if (!messageLog || !paymentLog) return null;
  return {
    verified,
    messageLog,
    paymentLog,
  };
}

export function matchingCctpPayment<T extends DeliveryLog>(
  logs: readonly T[],
  raw: Hex,
  expected: ExpectedCctpTransfer,
): T | null {
  return matchCctpReceiptEvidence(logs, raw, expected)?.paymentLog ?? null;
}
