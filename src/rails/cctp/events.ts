import { StrKey } from "@stellar/stellar-sdk";
import {
  BURN_MESSAGE_VERSION,
  FINALITY_THRESHOLD_FINALIZED,
  MESSAGE_VERSION,
  assertSupportedBurn,
  assertSupportedMessage,
  cctpBody,
  cctpHookData,
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

const ZERO_WORD = `0x${"0".repeat(64)}`;

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

export type CctpAttestationTier = "fast" | "finalized" | "unattested" | "unsupported";

export type CctpReplacementEquivalenceStatus =
  "original" | "equivalent_replacement" | "intent_mismatch" | "unsupported_semantics";

export interface InspectedCctpMessageVersion {
  readonly message: CctpMessage;
  readonly burn: CctpBurnMessage;
  readonly bodyHex: Hex;
  readonly hookHex: Hex;
  readonly fullNonce: Hex;
  readonly messageDigest: Hex;
  readonly bodyDigest: Hex;
  readonly tier: CctpAttestationTier;
}

export interface CctpReplacementCheckResult {
  readonly ok: boolean;
  readonly status: CctpReplacementEquivalenceStatus;
  readonly reason: string | null;
}

export function inspectCctpMessageVersion(
  raw: Hex,
  hasAttestationSignature = false,
): InspectedCctpMessageVersion | null {
  try {
    const message = parseCctpMessage(raw);
    const body = cctpBody(raw);
    const burn = parseCctpBurnMessage(body);
    const hook = cctpHookData(body);
    const normalizedRaw = raw.toLowerCase() as Hex;
    const bodyHex = toHex(body).toLowerCase() as Hex;
    const hookHex = toHex(hook).toLowerCase() as Hex;

    let tier: CctpAttestationTier;
    if (message.version !== MESSAGE_VERSION || burn.version !== BURN_MESSAGE_VERSION) {
      tier = "unsupported";
    } else if (message.finalityThresholdExecuted >= FINALITY_THRESHOLD_FINALIZED) {
      tier = "finalized";
    } else if (message.finalityThresholdExecuted > 0 || hasAttestationSignature) {
      tier = "fast";
    } else {
      tier = "unattested";
    }

    return {
      message,
      burn,
      bodyHex,
      hookHex,
      fullNonce: message.nonce.toLowerCase() as Hex,
      messageDigest: keccak256(normalizedRaw),
      bodyDigest: keccak256(bodyHex),
      tier,
    };
  } catch {
    return null;
  }
}

export function matchesSourceBurnIntent(
  inspected: InspectedCctpMessageVersion,
  expected: ExpectedCctpTransfer,
): {
  readonly ok: boolean;
  readonly status: CctpReplacementEquivalenceStatus;
  readonly reason: string | null;
} {
  if (
    inspected.message.version !== MESSAGE_VERSION ||
    inspected.burn.version !== BURN_MESSAGE_VERSION
  ) {
    return {
      ok: false,
      status: "unsupported_semantics",
      reason: `unsupported message/burn version (${String(inspected.message.version)}/${String(inspected.burn.version)})`,
    };
  }

  // Active Hyperion deployments have no EVM destination router/hook consumer; non-empty hook payloads are unsupported.
  if (inspected.hookHex !== "0x") {
    return {
      ok: false,
      status: "unsupported_semantics",
      reason: "non_empty_hook_payload",
    };
  }

  const word = (address: string) => `0x${address.slice(2).padStart(64, "0")}`.toLowerCase();
  if (inspected.message.sourceDomain !== 27) {
    return { ok: false, status: "intent_mismatch", reason: "source_domain_mismatch" };
  }
  if (inspected.message.destinationDomain !== expected.destinationDomain) {
    return { ok: false, status: "intent_mismatch", reason: "destination_domain_mismatch" };
  }
  if (
    inspected.message.sender.toLowerCase() !==
    toHex(StrKey.decodeContract(expected.sourceMessenger)).toLowerCase()
  ) {
    return { ok: false, status: "intent_mismatch", reason: "source_messenger_mismatch" };
  }
  if (inspected.message.recipient.toLowerCase() !== word(expected.destinationMessenger)) {
    return { ok: false, status: "intent_mismatch", reason: "destination_messenger_mismatch" };
  }
  if (
    inspected.burn.messageSender.toLowerCase() !==
    toHex(StrKey.decodeContract(expected.sourceAdapter)).toLowerCase()
  ) {
    return { ok: false, status: "intent_mismatch", reason: "source_adapter_mismatch" };
  }
  if (
    inspected.burn.burnToken.toLowerCase() !==
    toHex(StrKey.decodeContract(expected.sourceToken)).toLowerCase()
  ) {
    return { ok: false, status: "intent_mismatch", reason: "burn_token_mismatch" };
  }
  if (
    toEvmAddress(inspected.burn.mintRecipient).toLowerCase() !== expected.recipient.toLowerCase()
  ) {
    return { ok: false, status: "intent_mismatch", reason: "recipient_mutated" };
  }
  if (
    expected.sourceAmount <= 0n ||
    expected.sourceAmount % 10n !== 0n ||
    inspected.burn.amount !== expected.sourceAmount / 10n
  ) {
    return { ok: false, status: "intent_mismatch", reason: "burn_amount_mutated" };
  }
  if (
    inspected.burn.maxFee < 0n ||
    inspected.burn.maxFee >= inspected.burn.amount ||
    inspected.burn.feeExecuted < 0n ||
    inspected.burn.feeExecuted > inspected.burn.maxFee ||
    inspected.burn.feeExecuted >= inspected.burn.amount
  ) {
    return { ok: false, status: "unsupported_semantics", reason: "invalid_replacement_fee_bounds" };
  }
  if (
    inspected.message.destinationCaller.toLowerCase() !== ZERO_WORD &&
    toEvmAddress(inspected.message.destinationCaller).toLowerCase() !==
      expected.recipient.toLowerCase()
  ) {
    return {
      ok: false,
      status: "unsupported_semantics",
      reason: "unauthorized_destination_caller",
    };
  }

  return { ok: true, status: "original", reason: null };
}

/**
 * Verifies that `replacementRaw` is a valid CCTP v2 replacement/re-attestation of `originalRaw`
 * without silently mutating any source burn intent field, recipient, token, amount, or nonce,
 * and without introducing unsupported message/burn versions, hook mutations, or caller lock-ins.
 */
export function verifyCctpReplacementEquivalence(
  originalRaw: Hex,
  replacementRaw: Hex,
  expected: ExpectedCctpTransfer,
): CctpReplacementCheckResult {
  const original = inspectCctpMessageVersion(originalRaw);
  const replacement = inspectCctpMessageVersion(replacementRaw);
  if (!original || !replacement) {
    return {
      ok: false,
      status: "unsupported_semantics",
      reason: "malformed_replacement_message",
    };
  }

  if (
    replacement.message.version !== MESSAGE_VERSION ||
    replacement.burn.version !== BURN_MESSAGE_VERSION
  ) {
    return {
      ok: false,
      status: "unsupported_semantics",
      reason: `unsupported_version_${String(replacement.message.version)}_${String(replacement.burn.version)}`,
    };
  }

  if (replacement.hookHex !== original.hookHex || replacement.hookHex !== "0x") {
    return {
      ok: false,
      status: "unsupported_semantics",
      reason: "unsupported_hook_semantics",
    };
  }

  if (replacement.fullNonce !== original.fullNonce) {
    return {
      ok: false,
      status: "unsupported_semantics",
      reason: "replacement_nonce_changed",
    };
  }

  // Immutable burn intent fields must match BOTH the original message and the source transfer!
  if (
    replacement.message.sourceDomain !== original.message.sourceDomain ||
    replacement.message.destinationDomain !== original.message.destinationDomain
  ) {
    return {
      ok: false,
      status: "intent_mismatch",
      reason: "domain_mutated",
    };
  }
  if (
    replacement.message.sender.toLowerCase() !== original.message.sender.toLowerCase() ||
    replacement.message.recipient.toLowerCase() !== original.message.recipient.toLowerCase() ||
    replacement.burn.messageSender.toLowerCase() !== original.burn.messageSender.toLowerCase()
  ) {
    return {
      ok: false,
      status: "intent_mismatch",
      reason: "contract_binding_mutated",
    };
  }
  if (replacement.burn.burnToken.toLowerCase() !== original.burn.burnToken.toLowerCase()) {
    return {
      ok: false,
      status: "intent_mismatch",
      reason: "burn_token_mutated",
    };
  }
  if (replacement.burn.mintRecipient.toLowerCase() !== original.burn.mintRecipient.toLowerCase()) {
    return {
      ok: false,
      status: "intent_mismatch",
      reason: "recipient_mutated",
    };
  }
  if (replacement.burn.amount !== original.burn.amount) {
    return {
      ok: false,
      status: "intent_mismatch",
      reason: "burn_amount_mutated",
    };
  }

  // Destination caller cannot be silently restricted to a third party on replacement
  const nextCaller = replacement.message.destinationCaller.toLowerCase();
  const origCaller = original.message.destinationCaller.toLowerCase();
  if (nextCaller !== origCaller && nextCaller !== ZERO_WORD) {
    return {
      ok: false,
      status: "unsupported_semantics",
      reason: "unsupported_destination_caller_change",
    };
  }

  const intentCheck = matchesSourceBurnIntent(replacement, expected);
  if (!intentCheck.ok) {
    return intentCheck;
  }

  return {
    ok: true,
    status:
      replacement.messageDigest === original.messageDigest ? "original" : "equivalent_replacement",
    reason: null,
  };
}

export function verifiedCctpMessage(raw: Hex, expected: ExpectedCctpTransfer) {
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
  if (cctpHookData(body).length > 0) return null;

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
  return { message, burn, body: toHex(body), amount: burn.amount - burn.feeExecuted };
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
