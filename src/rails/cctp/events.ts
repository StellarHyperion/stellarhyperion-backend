import { StrKey } from "@stellar/stellar-sdk";
import {
  assertSupportedBurn,
  assertSupportedMessage,
  cctpBody,
  displayNonce,
  parseCctpBurnMessage,
  parseCctpMessage,
  toEvmAddress,
  toHex,
  type CctpBurnMessage,
  type CctpMessage,
} from "@hyperion/protocol";
import { decodeEventLog, keccak256, parseAbi, type Hex } from "viem";
import type { DeliveryLog } from "../axelar/events.js";
import type { CctpFullIdentitySummary } from "../types.js";

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

export interface VerifiedCctpFullMessage {
  readonly message: CctpMessage;
  readonly burn: CctpBurnMessage;
  readonly body: Hex;
  readonly amount: bigint;
  readonly identity: CctpFullIdentitySummary;
}

export function deriveCctpMessageIdentity(raw: Hex): CctpFullIdentitySummary | null {
  try {
    const message = parseCctpMessage(raw);
    const body = cctpBody(raw);
    parseCctpBurnMessage(body);
    const normalizedRaw = raw.toLowerCase() as Hex;
    const bodyHex = toHex(body).toLowerCase() as Hex;
    return {
      sourceDomain: message.sourceDomain,
      destinationDomain: message.destinationDomain,
      fullNonce: message.nonce.toLowerCase() as Hex,
      messageDigest: keccak256(normalizedRaw),
      bodyDigest: keccak256(bodyHex),
      displayedNonce: displayNonce(message).toString(),
    };
  } catch {
    return null;
  }
}

export function cctpIdentityKey(identity: CctpFullIdentitySummary): string {
  return `${String(identity.sourceDomain)}:${String(identity.destinationDomain)}:${identity.fullNonce.toLowerCase()}:${identity.messageDigest.toLowerCase()}`;
}

export function verifiedCctpMessage(
  raw: Hex,
  expected: ExpectedCctpTransfer,
): VerifiedCctpFullMessage | null {
  let message: CctpMessage;
  let body: Uint8Array;
  let burn: CctpBurnMessage;
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

  const bodyHex = toHex(body).toLowerCase() as Hex;
  const normalizedRaw = raw.toLowerCase() as Hex;
  return {
    message,
    burn,
    body: bodyHex,
    amount: burn.amount - burn.feeExecuted,
    identity: {
      sourceDomain: message.sourceDomain,
      destinationDomain: message.destinationDomain,
      fullNonce: message.nonce.toLowerCase() as Hex,
      messageDigest: keccak256(normalizedRaw),
      bodyDigest: keccak256(bodyHex),
      displayedNonce: displayNonce(message).toString(),
    },
  };
}

export function matchingCctpPayment<T extends DeliveryLog>(
  logs: readonly T[],
  raw: Hex,
  expected: ExpectedCctpTransfer,
): T | null {
  const verified = verifiedCctpMessage(raw, expected);
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
          event.args.nonce.toLowerCase() === verified.identity.fullNonce &&
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
