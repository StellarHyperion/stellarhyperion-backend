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
import type { CctpCandidateReport } from "../types.js";

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
  railRef?: string | null | undefined;
}

export interface VerifiedCctpBurn {
  readonly message: CctpMessage;
  readonly burn: CctpBurnMessage;
  readonly body: Hex;
  readonly amount: bigint;
}

export type CctpCandidateReconciliation =
  | {
      readonly kind: "matched";
      readonly raw: Hex;
      readonly verified: VerifiedCctpBurn;
      readonly candidate: CctpCandidateReport;
    }
  | {
      readonly kind: "none";
    }
  | {
      readonly kind: "ambiguous";
      readonly nonces: readonly Hex[];
    };

function hasSpecificNonceRef(railRef: string | null | undefined): railRef is string {
  return (
    typeof railRef === "string" && /^0x[0-9a-fA-F]{64}$/.test(railRef) && !/^0x0{64}$/.test(railRef)
  );
}

export function verifiedCctpMessage(
  raw: Hex,
  expected: ExpectedCctpTransfer,
): VerifiedCctpBurn | null {
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
    message.finalityThresholdExecuted < 2000 ||
    (hasSpecificNonceRef(expected.railRef) &&
      message.nonce.toLowerCase() !== expected.railRef.toLowerCase())
  ) {
    return null;
  }

  return { message, burn, body: toHex(body), amount: burn.amount - burn.feeExecuted };
}

/**
 * Reconciles all candidate Circle messages from a source transaction against a transfer's complete
 * source intent and burn fields.
 *
 * - Unrelated burns in the same transaction are ignored.
 * - Byte-identical duplicate records for the same message collapse cleanly.
 * - Two distinct messages (or conflicting byte payloads for the same nonce) matching the transfer
 *   intent are reported as `ambiguous` and never select an arbitrary winner.
 */
export function reconcileCctpCandidates(
  candidates: readonly CctpCandidateReport[],
  expected: ExpectedCctpTransfer,
): CctpCandidateReconciliation {
  const byNonce = new Map<
    string,
    {
      rawNormalized: string;
      raw: Hex;
      verified: VerifiedCctpBurn;
      candidate: CctpCandidateReport;
      conflictingBytes: boolean;
    }
  >();

  for (const candidate of candidates) {
    const rawStr = candidate.messageBytes ?? candidate.message ?? null;
    if (typeof rawStr !== "string" || !/^0x[0-9a-fA-F]+$/.test(rawStr)) continue;
    const raw = rawStr as Hex;
    const verified = verifiedCctpMessage(raw, expected);
    if (!verified) continue;

    const nonceKey = verified.message.nonce.toLowerCase();
    const rawNormalized = raw.toLowerCase();
    const existing = byNonce.get(nonceKey);
    if (!existing) {
      byNonce.set(nonceKey, {
        rawNormalized,
        raw,
        verified,
        candidate,
        conflictingBytes: false,
      });
      continue;
    }

    if (existing.rawNormalized !== rawNormalized) {
      existing.conflictingBytes = true;
      continue;
    }

    // Exact byte-identical duplicate: merge forwarding hash / attestation metadata if enriched.
    const mergedForwardTx = existing.candidate.forwardTxHash ?? candidate.forwardTxHash;
    const mergedStatus =
      existing.candidate.status === "attested" || candidate.status === "attested"
        ? "attested"
        : existing.candidate.status;
    existing.candidate = {
      ...existing.candidate,
      ...(mergedForwardTx !== undefined ? { forwardTxHash: mergedForwardTx } : {}),
      status: mergedStatus,
      reference: existing.candidate.reference ?? candidate.reference,
      attestedAt: existing.candidate.attestedAt ?? candidate.attestedAt,
      attestationSignature:
        existing.candidate.attestationSignature ?? candidate.attestationSignature ?? null,
    };
  }

  if (byNonce.size === 0) {
    return { kind: "none" };
  }

  const conflictingNonces = [...byNonce.values()]
    .filter((entry) => entry.conflictingBytes)
    .map((entry) => entry.verified.message.nonce);
  if (conflictingNonces.length > 0) {
    return { kind: "ambiguous", nonces: conflictingNonces };
  }

  if (byNonce.size > 1) {
    return {
      kind: "ambiguous",
      nonces: [...byNonce.values()].map((entry) => entry.verified.message.nonce),
    };
  }

  const single = [...byNonce.values()][0];
  if (!single) return { kind: "none" };
  return {
    kind: "matched",
    raw: single.raw,
    verified: single.verified,
    candidate: single.candidate,
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
