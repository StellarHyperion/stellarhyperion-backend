import { StrKey } from "@stellar/stellar-sdk";
import {
  assertSupportedBurn,
  assertSupportedMessage,
  cctpBody,
  parseCctpBurnMessage,
  parseCctpMessage,
  toHex,
  toEvmAddress,
} from "@hyperion/protocol";
import { decodeEventLog, parseAbi, type Hex } from "viem";
import type { DeliveryLog } from "../axelar/events.js";
import type { ProofRejectionReason } from "../proof-reasons.js";

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

export interface VerifiedCctpMessageResult {
  readonly message: ReturnType<typeof parseCctpMessage>;
  readonly body: Hex;
  readonly amount: bigint;
}

export type CctpMessageClassification =
  | { readonly ok: true; readonly verified: VerifiedCctpMessageResult }
  | { readonly ok: false; readonly reason: ProofRejectionReason };

export type CctpReceiptClassification<T extends DeliveryLog> =
  | { readonly ok: true; readonly verified: VerifiedCctpMessageResult; readonly payment: T }
  | { readonly ok: false; readonly reason: ProofRejectionReason };

export function classifyCctpMessage(
  raw: Hex,
  expected: ExpectedCctpTransfer,
): CctpMessageClassification {
  let message: ReturnType<typeof parseCctpMessage>;
  let body: Uint8Array;
  let burn: ReturnType<typeof parseCctpBurnMessage>;
  try {
    message = parseCctpMessage(raw);
    body = cctpBody(raw);
    burn = parseCctpBurnMessage(body);
    assertSupportedMessage(message);
    assertSupportedBurn(burn);
  } catch {
    return { ok: false, reason: "provider_inconsistency" };
  }

  const word = (address: string) => `0x${address.slice(2).padStart(64, "0")}`.toLowerCase();
  if (
    message.sourceDomain !== 27 ||
    message.destinationDomain !== expected.destinationDomain ||
    message.sender.toLowerCase() !==
      toHex(StrKey.decodeContract(expected.sourceMessenger)).toLowerCase() ||
    message.recipient.toLowerCase() !== word(expected.destinationMessenger) ||
    burn.messageSender.toLowerCase() !==
      toHex(StrKey.decodeContract(expected.sourceAdapter)).toLowerCase()
  ) {
    return { ok: false, reason: "provider_inconsistency" };
  }

  if (
    burn.burnToken.toLowerCase() !==
    toHex(StrKey.decodeContract(expected.sourceToken)).toLowerCase()
  ) {
    return { ok: false, reason: "token_mismatch" };
  }

  if (toEvmAddress(burn.mintRecipient).toLowerCase() !== expected.recipient.toLowerCase()) {
    return { ok: false, reason: "recipient_mismatch" };
  }

  if (
    expected.sourceAmount % 10n !== 0n ||
    burn.amount !== expected.sourceAmount / 10n ||
    burn.feeExecuted > burn.maxFee ||
    burn.feeExecuted < 0n ||
    burn.feeExecuted >= burn.amount
  ) {
    return { ok: false, reason: "amount_mismatch" };
  }

  if (message.finalityThresholdExecuted < 2000) {
    return { ok: false, reason: "insufficient_finality" };
  }

  return {
    ok: true,
    verified: {
      message,
      body: toHex(body),
      amount: burn.amount - burn.feeExecuted,
    },
  };
}

export function verifiedCctpMessage(
  raw: Hex,
  expected: ExpectedCctpTransfer,
): VerifiedCctpMessageResult | null {
  const message = parseCctpMessage(raw);
  const body = cctpBody(raw);
  const burn = parseCctpBurnMessage(body);
  assertSupportedMessage(message);
  assertSupportedBurn(burn);
  const outcome = classifyCctpMessage(raw, expected);
  return outcome.ok ? outcome.verified : null;
}

export function classifyCctpReceipt<T extends DeliveryLog>(
  logs: readonly T[],
  raw: Hex,
  expected: ExpectedCctpTransfer,
): CctpReceiptClassification<T> {
  const msgOutcome = classifyCctpMessage(raw, expected);
  if (!msgOutcome.ok) return msgOutcome;
  const { verified } = msgOutcome;

  let received = false;
  let payment: T | null = null;
  let sawMintAmountMismatch = false;
  let sawMintRecipientMismatch = false;
  let sawMintTokenMismatch = false;

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
      if (event.eventName === "Transfer" && /^0x0{40}$/.test(event.args.from)) {
        const tokenMatches = log.address.toLowerCase() === expected.token.toLowerCase();
        const recipientMatches = event.args.to.toLowerCase() === expected.recipient.toLowerCase();
        const amountMatches = event.args.value === verified.amount;

        if (tokenMatches && recipientMatches && amountMatches) {
          payment = log;
        } else if (!tokenMatches && recipientMatches) {
          sawMintTokenMismatch = true;
        } else if (tokenMatches && !recipientMatches) {
          sawMintRecipientMismatch = true;
        } else if (tokenMatches && recipientMatches && !amountMatches) {
          sawMintAmountMismatch = true;
        }
      }
    } catch {
      /* Unrelated receipt events do not establish this transfer's delivery. */
    }
  }

  if (!received) {
    return { ok: false, reason: "provider_inconsistency" };
  }
  if (payment !== null) {
    return { ok: true, verified, payment };
  }
  if (sawMintTokenMismatch) {
    return { ok: false, reason: "token_mismatch" };
  }
  if (sawMintRecipientMismatch) {
    return { ok: false, reason: "recipient_mismatch" };
  }
  if (sawMintAmountMismatch) {
    return { ok: false, reason: "amount_mismatch" };
  }
  return { ok: false, reason: "provider_inconsistency" };
}

export function matchingCctpPayment<T extends DeliveryLog>(
  logs: readonly T[],
  raw: Hex,
  expected: ExpectedCctpTransfer,
): T | null {
  if (!verifiedCctpMessage(raw, expected)) return null;
  const outcome = classifyCctpReceipt(logs, raw, expected);
  return outcome.ok ? outcome.payment : null;
}
