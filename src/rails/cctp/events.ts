import { StrKey } from "@stellar/stellar-sdk";
import {
  assertSupportedBurn,
  assertSupportedMessage,
  cctpBody,
  parseCctpBurnMessage,
  parseCctpMessage,
  toEvmAddress,
  toHex,
  type CctpMessage,
} from "@hyperion/protocol";
import { decodeEventLog, parseAbi, type Hex } from "viem";
import type { DeliveryLog } from "../axelar/events.js";
import { RailError, type CctpResourceLimitCode } from "../types.js";

// Source: circlefin/evm-cctp-contracts/src/v2/MessageTransmitterV2.sol.
export const CCTP_RECEIPT_ABI = parseAbi([
  "event MessageReceived(address indexed caller,uint32 sourceDomain,bytes32 indexed nonce,bytes32 sender,uint32 indexed finalityThresholdExecuted,bytes messageBody)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);

export interface CctpResourceLimits {
  readonly maxResponseBytes: number;
  readonly maxErrorBodyBytes: number;
  readonly maxJsonDepth: number;
  readonly maxJsonValues: number;
  readonly maxMessages: number;
  readonly maxMessageHexBytes: number;
  readonly maxAttestationHexBytes: number;
  readonly maxReceiptLogs: number;
}

export const DEFAULT_CCTP_RESOURCE_LIMITS: CctpResourceLimits = {
  maxResponseBytes: 256 * 1024,
  maxErrorBodyBytes: 8 * 1024,
  maxJsonDepth: 16,
  maxJsonValues: 4_096,
  maxMessages: 32,
  maxMessageHexBytes: 8_192,
  maxAttestationHexBytes: 2_048,
  maxReceiptLogs: 512,
};

export function resolveCctpResourceLimits(
  overrides?: Partial<CctpResourceLimits>,
): CctpResourceLimits {
  if (!overrides) return DEFAULT_CCTP_RESOURCE_LIMITS;
  return {
    maxResponseBytes: overrides.maxResponseBytes ?? DEFAULT_CCTP_RESOURCE_LIMITS.maxResponseBytes,
    maxErrorBodyBytes:
      overrides.maxErrorBodyBytes ?? DEFAULT_CCTP_RESOURCE_LIMITS.maxErrorBodyBytes,
    maxJsonDepth: overrides.maxJsonDepth ?? DEFAULT_CCTP_RESOURCE_LIMITS.maxJsonDepth,
    maxJsonValues: overrides.maxJsonValues ?? DEFAULT_CCTP_RESOURCE_LIMITS.maxJsonValues,
    maxMessages: overrides.maxMessages ?? DEFAULT_CCTP_RESOURCE_LIMITS.maxMessages,
    maxMessageHexBytes:
      overrides.maxMessageHexBytes ?? DEFAULT_CCTP_RESOURCE_LIMITS.maxMessageHexBytes,
    maxAttestationHexBytes:
      overrides.maxAttestationHexBytes ?? DEFAULT_CCTP_RESOURCE_LIMITS.maxAttestationHexBytes,
    maxReceiptLogs: overrides.maxReceiptLogs ?? DEFAULT_CCTP_RESOURCE_LIMITS.maxReceiptLogs,
  };
}

export function hexEncodedByteLength(value: string): number {
  const trimmed = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  return Math.ceil(trimmed.length / 2);
}

export function assertCctpHexByteLimit(
  value: string | null | undefined,
  maxBytes: number,
  code: CctpResourceLimitCode,
  label: string,
): void {
  if (typeof value !== "string") return;
  const byteLen = hexEncodedByteLength(value);
  if (byteLen > maxBytes) {
    throw new RailError(
      "cctp",
      "resourceLimit",
      `${label} size ${String(byteLen)} bytes exceeds limit ${String(maxBytes)} bytes`,
      null,
      code,
    );
  }
}

export function assertCctpReceiptResourceLimits(
  logs: readonly DeliveryLog[],
  limits: CctpResourceLimits = DEFAULT_CCTP_RESOURCE_LIMITS,
): void {
  if (logs.length > limits.maxReceiptLogs) {
    throw new RailError(
      "cctp",
      "resourceLimit",
      `receipt log count ${String(logs.length)} exceeds limit ${String(limits.maxReceiptLogs)}`,
      null,
      "receipt_logs_exceeded",
    );
  }
  const maxLogDataBytes = limits.maxMessageHexBytes + 512;
  for (const log of logs) {
    if (hexEncodedByteLength(log.data) > maxLogDataBytes) {
      throw new RailError(
        "cctp",
        "resourceLimit",
        `receipt log data exceeds limit ${String(maxLogDataBytes)} bytes`,
        null,
        "message_bytes_exceeded",
      );
    }
  }
}

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

export interface VerifiedCctpMessageResult {
  readonly message: CctpMessage;
  readonly body: Hex;
  readonly amount: bigint;
}

export type CctpEvidenceClassification<T extends DeliveryLog> =
  | {
      readonly outcome: "verified";
      readonly payment: T;
      readonly verified: VerifiedCctpMessageResult;
    }
  | { readonly outcome: "invalid_payment_evidence" }
  | {
      readonly outcome: "resource_limit";
      readonly code: CctpResourceLimitCode;
      readonly error: RailError;
    };

export function verifiedCctpMessage(
  raw: Hex,
  expected: ExpectedCctpTransfer,
  limits?: Partial<CctpResourceLimits>,
): VerifiedCctpMessageResult | null {
  const resolved = resolveCctpResourceLimits(limits);
  assertCctpHexByteLimit(raw, resolved.maxMessageHexBytes, "message_bytes_exceeded", "message");

  let message: CctpMessage;
  let body: Uint8Array;
  let burn: ReturnType<typeof parseCctpBurnMessage>;
  try {
    message = parseCctpMessage(raw);
    body = cctpBody(raw);
    burn = parseCctpBurnMessage(body);
    assertSupportedMessage(message);
    assertSupportedBurn(burn);
  } catch {
    return null;
  }

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
  return { message, body: toHex(body), amount: burn.amount - burn.feeExecuted };
}

export function matchingCctpPayment<T extends DeliveryLog>(
  logs: readonly T[],
  raw: Hex,
  expected: ExpectedCctpTransfer,
  limits?: Partial<CctpResourceLimits>,
): T | null {
  const resolved = resolveCctpResourceLimits(limits);
  assertCctpHexByteLimit(raw, resolved.maxMessageHexBytes, "message_bytes_exceeded", "message");
  assertCctpReceiptResourceLimits(logs, resolved);

  const verified = verifiedCctpMessage(raw, expected, resolved);
  if (!verified) return null;
  let received = false;
  let payment: T | null = null;
  for (const log of logs) {
    try {
      const event = decodeEventLog({ abi: CCTP_RECEIPT_ABI, topics: log.topics, data: log.data });
      if (
        event.eventName === "MessageReceived" &&
        log.address.toLowerCase() === expected.transmitter.toLowerCase()
      ) {
        received ||=
          event.args.sourceDomain === 27 &&
          event.args.nonce.toLowerCase() === verified.message.nonce.toLowerCase() &&
          event.args.sender.toLowerCase() === verified.message.sender.toLowerCase() &&
          event.args.finalityThresholdExecuted === verified.message.finalityThresholdExecuted &&
          event.args.messageBody.toLowerCase() === verified.body.toLowerCase();
      }
      if (
        event.eventName === "Transfer" &&
        log.address.toLowerCase() === expected.token.toLowerCase() &&
        /^0x0{40}$/.test(event.args.from) &&
        event.args.to.toLowerCase() === expected.recipient.toLowerCase() &&
        event.args.value === verified.amount
      ) {
        payment = log;
      }
    } catch {
      /* Unrelated receipt events do not establish this transfer's delivery. */
    }
  }
  return received ? payment : null;
}

export function classifyCctpPaymentEvidence<T extends DeliveryLog>(
  logs: readonly T[],
  raw: Hex,
  expected: ExpectedCctpTransfer,
  limits?: Partial<CctpResourceLimits>,
): CctpEvidenceClassification<T> {
  try {
    const resolved = resolveCctpResourceLimits(limits);
    assertCctpHexByteLimit(raw, resolved.maxMessageHexBytes, "message_bytes_exceeded", "message");
    assertCctpReceiptResourceLimits(logs, resolved);
    const verified = verifiedCctpMessage(raw, expected, resolved);
    if (!verified) return { outcome: "invalid_payment_evidence" };
    const payment = matchingCctpPayment(logs, raw, expected, resolved);
    if (!payment) return { outcome: "invalid_payment_evidence" };
    return { outcome: "verified", payment, verified };
  } catch (error) {
    if (error instanceof RailError && error.kind === "resourceLimit") {
      return {
        outcome: "resource_limit",
        code: error.limitCode ?? "message_bytes_exceeded",
        error,
      };
    }
    throw error;
  }
}
