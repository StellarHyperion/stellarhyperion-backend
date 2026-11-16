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
import { decodeEventLog, parseAbi, type Hex } from "viem";
import type { DeliveryLog } from "../axelar/events.js";

// Source: circlefin/evm-cctp-contracts/src/v2/MessageTransmitterV2.sol.
export const CCTP_RECEIPT_ABI = parseAbi([
  "event MessageReceived(address indexed caller,uint32 sourceDomain,bytes32 indexed nonce,bytes32 sender,uint32 indexed finalityThresholdExecuted,bytes messageBody)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);

const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export type CctpDiagnosticCategory =
  | "verified"
  | "missing_message_bytes"
  | "missing_forward_tx"
  | "receipt_unavailable"
  | "insufficient_confirmations"
  | "non_canonical_block"
  | "missing_message_event"
  | "missing_mint_event"
  | "reverted_receipt"
  | "malformed_message"
  | "domain_mismatch"
  | "messenger_mismatch"
  | "adapter_mismatch"
  | "token_mismatch"
  | "recipient_mismatch"
  | "amount_mismatch"
  | "fee_mismatch"
  | "finality_mismatch"
  | "nonce_or_body_mismatch";

export interface CctpDiagnosticReport {
  readonly outcome: "verified" | "mismatch" | "missing_evidence";
  readonly category: CctpDiagnosticCategory;
  readonly retryable: boolean;
  readonly fieldName: string | null;
  readonly expectedSummary: string | null;
  readonly observedSummary: string | null;
  readonly detail: string;
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

/**
 * Redacts URLs with credentials, bearer/basic auth headers, API key query parameters, and bounds
 * oversized hex blobs (> 32-byte words) so diagnostic storage and API responses never leak
 * provider credentials or raw payloads.
 */
export function sanitizeCctpDiagnosticText(raw: string, maxLength = 240): string {
  const redacted = raw
    // URL userinfo credentials: https://user:pass@host
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/\s:@]+:[^/\s@]+@)/g, "$1[redacted]@")
    // Bearer / Basic authorization values
    .replace(/\b(Bearer|Basic|ApiKey)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 [redacted]")
    // Query/header key=value secrets
    .replace(
      /\b(api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|token|key)=([^&\s"']+)/gi,
      "$1=[redacted]",
    )
    // Oversized hex payloads longer than a 32-byte word (0x + 64 hex chars = 66 chars)
    .replace(/\b0x[0-9a-fA-F]{66,}\b/g, (match) => {
      const byteLen = Math.floor((match.length - 2) / 2);
      return `${match.slice(0, 18)}...[len=${String(byteLen)}B]`;
    });

  if (redacted.length <= maxLength) {
    return redacted;
  }
  return `${redacted.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function sanitizeCctpSummaryField(value: string | null): string | null {
  if (value === null) return null;
  return sanitizeCctpDiagnosticText(value, 128);
}

function makeDiagnostic(input: {
  readonly outcome: CctpDiagnosticReport["outcome"];
  readonly category: CctpDiagnosticCategory;
  readonly retryable: boolean;
  readonly fieldName?: string | null;
  readonly expectedSummary?: string | null;
  readonly observedSummary?: string | null;
  readonly detail: string;
}): CctpDiagnosticReport {
  return {
    outcome: input.outcome,
    category: input.category,
    retryable: input.retryable,
    fieldName: input.fieldName ? sanitizeCctpDiagnosticText(input.fieldName, 64) : null,
    expectedSummary: sanitizeCctpSummaryField(input.expectedSummary ?? null),
    observedSummary: sanitizeCctpSummaryField(input.observedSummary ?? null),
    detail: sanitizeCctpDiagnosticText(input.detail, 240),
  };
}

export type CctpMessageInspection =
  | {
      readonly ok: true;
      readonly message: CctpMessage;
      readonly burn: CctpBurnMessage;
      readonly body: Hex;
      readonly amount: bigint;
    }
  | {
      readonly ok: false;
      readonly diagnostic: CctpDiagnosticReport;
    };

export function inspectCctpMessage(
  raw: Hex,
  expected: ExpectedCctpTransfer,
): CctpMessageInspection {
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
    return {
      ok: false,
      diagnostic: makeDiagnostic({
        outcome: "mismatch",
        category: "malformed_message",
        retryable: false,
        fieldName: "messageBytes",
        expectedSummary: "valid CCTP v2 burn message",
        observedSummary: raw,
        detail: "candidate CCTP message failed structural or version validation",
      }),
    };
  }

  const word = (address: string) => `0x${address.slice(2).padStart(64, "0")}`.toLowerCase();
  const expectedSourceMessenger = toHex(
    StrKey.decodeContract(expected.sourceMessenger),
  ).toLowerCase();
  const expectedDestinationMessenger = word(expected.destinationMessenger);
  const expectedSourceAdapter = toHex(StrKey.decodeContract(expected.sourceAdapter)).toLowerCase();
  const expectedSourceToken = toHex(StrKey.decodeContract(expected.sourceToken)).toLowerCase();

  if (message.sourceDomain !== 27) {
    return {
      ok: false,
      diagnostic: makeDiagnostic({
        outcome: "mismatch",
        category: "domain_mismatch",
        retryable: false,
        fieldName: "sourceDomain",
        expectedSummary: "27",
        observedSummary: String(message.sourceDomain),
        detail: "CCTP header sourceDomain did not match Stellar domain 27",
      }),
    };
  }
  if (message.destinationDomain !== expected.destinationDomain) {
    return {
      ok: false,
      diagnostic: makeDiagnostic({
        outcome: "mismatch",
        category: "domain_mismatch",
        retryable: false,
        fieldName: "destinationDomain",
        expectedSummary: String(expected.destinationDomain),
        observedSummary: String(message.destinationDomain),
        detail: "CCTP header destinationDomain disagreed with transfer destination chain",
      }),
    };
  }
  if (message.sender.toLowerCase() !== expectedSourceMessenger) {
    return {
      ok: false,
      diagnostic: makeDiagnostic({
        outcome: "mismatch",
        category: "messenger_mismatch",
        retryable: false,
        fieldName: "sender",
        expectedSummary: expectedSourceMessenger,
        observedSummary: message.sender.toLowerCase(),
        detail: "CCTP header sender did not match Stellar TokenMessenger contract",
      }),
    };
  }
  if (message.recipient.toLowerCase() !== expectedDestinationMessenger) {
    return {
      ok: false,
      diagnostic: makeDiagnostic({
        outcome: "mismatch",
        category: "messenger_mismatch",
        retryable: false,
        fieldName: "destinationMessenger",
        expectedSummary: expectedDestinationMessenger,
        observedSummary: message.recipient.toLowerCase(),
        detail: "CCTP header recipient did not match destination TokenMessengerV2",
      }),
    };
  }
  if (burn.messageSender.toLowerCase() !== expectedSourceAdapter) {
    return {
      ok: false,
      diagnostic: makeDiagnostic({
        outcome: "mismatch",
        category: "adapter_mismatch",
        retryable: false,
        fieldName: "messageSender",
        expectedSummary: expectedSourceAdapter,
        observedSummary: burn.messageSender.toLowerCase(),
        detail: "CCTP burn messageSender did not match indexed Stellar CCTP adapter",
      }),
    };
  }
  if (burn.burnToken.toLowerCase() !== expectedSourceToken) {
    return {
      ok: false,
      diagnostic: makeDiagnostic({
        outcome: "mismatch",
        category: "token_mismatch",
        retryable: false,
        fieldName: "burnToken",
        expectedSummary: expectedSourceToken,
        observedSummary: burn.burnToken.toLowerCase(),
        detail: "CCTP burnToken did not match indexed source USDC contract",
      }),
    };
  }

  const observedRecipient = toEvmAddress(burn.mintRecipient).toLowerCase();
  const expectedRecipient = expected.recipient.toLowerCase();
  if (observedRecipient !== expectedRecipient) {
    return {
      ok: false,
      diagnostic: makeDiagnostic({
        outcome: "mismatch",
        category: "recipient_mismatch",
        retryable: false,
        fieldName: "mintRecipient",
        expectedSummary: expectedRecipient,
        observedSummary: observedRecipient,
        detail: "CCTP burn mintRecipient disagreed with outbound transfer destination",
      }),
    };
  }

  if (expected.sourceAmount % 10n !== 0n || burn.amount !== expected.sourceAmount / 10n) {
    return {
      ok: false,
      diagnostic: makeDiagnostic({
        outcome: "mismatch",
        category: "amount_mismatch",
        retryable: false,
        fieldName: "burnAmount",
        expectedSummary: (expected.sourceAmount / 10n).toString(),
        observedSummary: burn.amount.toString(),
        detail: "CCTP burn amount disagreed with scaled outbound net amount",
      }),
    };
  }

  if (burn.feeExecuted > burn.maxFee || burn.feeExecuted < 0n || burn.feeExecuted >= burn.amount) {
    return {
      ok: false,
      diagnostic: makeDiagnostic({
        outcome: "mismatch",
        category: "fee_mismatch",
        retryable: false,
        fieldName: "feeExecuted",
        expectedSummary: `<= ${burn.maxFee.toString()}`,
        observedSummary: burn.feeExecuted.toString(),
        detail: "CCTP executed fee exceeded forwarding budget or burn amount",
      }),
    };
  }

  if (message.finalityThresholdExecuted < 2000) {
    return {
      ok: false,
      diagnostic: makeDiagnostic({
        outcome: "mismatch",
        category: "finality_mismatch",
        retryable: false,
        fieldName: "finalityThresholdExecuted",
        expectedSummary: ">= 2000",
        observedSummary: String(message.finalityThresholdExecuted),
        detail: "CCTP message finalityThresholdExecuted was below finalized threshold 2000",
      }),
    };
  }

  return {
    ok: true,
    message,
    burn,
    body: toHex(body),
    amount: burn.amount - burn.feeExecuted,
  };
}

export function verifiedCctpMessage(raw: Hex, expected: ExpectedCctpTransfer) {
  const inspected = inspectCctpMessage(raw, expected);
  if (!inspected.ok) return null;
  return {
    message: inspected.message,
    body: inspected.body,
    amount: inspected.amount,
  };
}

export type CctpPaymentInspection<T extends DeliveryLog> =
  | {
      readonly ok: true;
      readonly payment: T;
      readonly message: CctpMessage;
      readonly amount: bigint;
      readonly diagnostic: CctpDiagnosticReport;
    }
  | {
      readonly ok: false;
      readonly diagnostic: CctpDiagnosticReport;
    };

export function inspectCctpPaymentLogs<T extends DeliveryLog>(
  logs: readonly T[],
  raw: Hex,
  expected: ExpectedCctpTransfer,
): CctpPaymentInspection<T> {
  const msgCheck = inspectCctpMessage(raw, expected);
  if (!msgCheck.ok) return msgCheck;

  let exactMessageReceived = false;
  let mismatchedTransmitterMessage = false;
  let wrongTransmitterContract: string | null = null;

  let exactPayment: T | null = null;
  let wrongTokenAddress: string | null = null;
  let wrongMintRecipient: string | null = null;
  let wrongMintAmount: bigint | null = null;

  for (const log of logs) {
    try {
      const event = decodeEventLog({ abi: CCTP_RECEIPT_ABI, topics: log.topics, data: log.data });
      if (event.eventName === "MessageReceived") {
        if (log.address.toLowerCase() !== expected.transmitter.toLowerCase()) {
          wrongTransmitterContract = log.address.toLowerCase();
        } else if (
          event.args.sourceDomain === 27 &&
          event.args.nonce.toLowerCase() === msgCheck.message.nonce.toLowerCase() &&
          event.args.sender.toLowerCase() === msgCheck.message.sender.toLowerCase() &&
          event.args.finalityThresholdExecuted === msgCheck.message.finalityThresholdExecuted &&
          event.args.messageBody.toLowerCase() === msgCheck.body.toLowerCase()
        ) {
          exactMessageReceived = true;
        } else {
          mismatchedTransmitterMessage = true;
        }
      }
      if (event.eventName === "Transfer" && /^0x0{40}$/.test(event.args.from)) {
        const logAddr = log.address.toLowerCase();
        const expectedToken = expected.token.toLowerCase();
        const toAddr = event.args.to.toLowerCase();
        const expectedRecip = expected.recipient.toLowerCase();

        if (logAddr !== expectedToken) {
          wrongTokenAddress = logAddr;
        } else if (toAddr !== expectedRecip) {
          wrongMintRecipient = toAddr;
        } else if (event.args.value !== msgCheck.amount) {
          wrongMintAmount = event.args.value;
        } else {
          exactPayment = log;
        }
      }
    } catch {
      if (
        log.topics[0]?.toLowerCase() === TRANSFER_TOPIC0 &&
        log.address.toLowerCase() !== expected.token.toLowerCase()
      ) {
        wrongTokenAddress = log.address.toLowerCase();
      }
    }
  }

  if (!exactMessageReceived) {
    if (mismatchedTransmitterMessage) {
      return {
        ok: false,
        diagnostic: makeDiagnostic({
          outcome: "mismatch",
          category: "nonce_or_body_mismatch",
          retryable: false,
          fieldName: "MessageReceived",
          expectedSummary: msgCheck.message.nonce.toLowerCase(),
          observedSummary: "mismatched MessageReceived event fields",
          detail: "MessageReceived log on transmitter did not match attested nonce or body",
        }),
      };
    }
    if (wrongTransmitterContract !== null) {
      return {
        ok: false,
        diagnostic: makeDiagnostic({
          outcome: "mismatch",
          category: "messenger_mismatch",
          retryable: false,
          fieldName: "transmitter",
          expectedSummary: expected.transmitter.toLowerCase(),
          observedSummary: wrongTransmitterContract,
          detail: "MessageReceived event emitted by unexpected contract",
        }),
      };
    }
    return {
      ok: false,
      diagnostic: makeDiagnostic({
        outcome: "missing_evidence",
        category: "missing_message_event",
        retryable: true,
        fieldName: "MessageReceived",
        expectedSummary: expected.transmitter.toLowerCase(),
        observedSummary: null,
        detail: "destination receipt contained no canonical MessageReceived log",
      }),
    };
  }

  if (exactPayment === null) {
    if (wrongMintAmount !== null) {
      return {
        ok: false,
        diagnostic: makeDiagnostic({
          outcome: "mismatch",
          category: "amount_mismatch",
          retryable: false,
          fieldName: "mintAmount",
          expectedSummary: msgCheck.amount.toString(),
          observedSummary: wrongMintAmount.toString(),
          detail: "destination native USDC mint value disagreed with expected payout after fees",
        }),
      };
    }
    if (wrongMintRecipient !== null) {
      return {
        ok: false,
        diagnostic: makeDiagnostic({
          outcome: "mismatch",
          category: "recipient_mismatch",
          retryable: false,
          fieldName: "mintRecipient",
          expectedSummary: expected.recipient.toLowerCase(),
          observedSummary: wrongMintRecipient,
          detail: "destination native USDC mint recipient disagreed with transfer recipient",
        }),
      };
    }
    if (wrongTokenAddress !== null) {
      return {
        ok: false,
        diagnostic: makeDiagnostic({
          outcome: "mismatch",
          category: "token_mismatch",
          retryable: false,
          fieldName: "destinationToken",
          expectedSummary: expected.token.toLowerCase(),
          observedSummary: wrongTokenAddress,
          detail: "mint Transfer event came from non-canonical token contract",
        }),
      };
    }
    return {
      ok: false,
      diagnostic: makeDiagnostic({
        outcome: "missing_evidence",
        category: "missing_mint_event",
        retryable: true,
        fieldName: "Transfer",
        expectedSummary: expected.token.toLowerCase(),
        observedSummary: null,
        detail: "destination receipt lacked zero-address native USDC mint Transfer log",
      }),
    };
  }

  return {
    ok: true,
    payment: exactPayment,
    message: msgCheck.message,
    amount: msgCheck.amount,
    diagnostic: makeDiagnostic({
      outcome: "verified",
      category: "verified",
      retryable: false,
      fieldName: null,
      expectedSummary: msgCheck.amount.toString(),
      observedSummary: msgCheck.amount.toString(),
      detail: "canonical MessageReceived and native USDC mint verified",
    }),
  };
}

export function matchingCctpPayment<T extends DeliveryLog>(
  logs: readonly T[],
  raw: Hex,
  expected: ExpectedCctpTransfer,
): T | null {
  const result = inspectCctpPaymentLogs(logs, raw, expected);
  return result.ok ? result.payment : null;
}

export { makeDiagnostic as createCctpDiagnosticReport };
