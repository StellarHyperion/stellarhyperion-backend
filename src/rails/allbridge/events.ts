import {
  AddressKind,
  carriesPayload,
  encodeStellarAddress,
  parseStellarAddress,
  RouteKind,
  toWord,
} from "@hyperion/protocol";
import {
  decodeEventLog,
  encodePacked,
  keccak256,
  parseAbi,
  recoverAddress,
  stringToHex,
  type Hex,
} from "viem";

import type { AllbridgeValidatorTrustConfig } from "../../config/config.js";
import type { DeliveryLog } from "../axelar/events.js";
import type { AllbridgeValidatorTrustDisclosure } from "../types.js";

export const ALLBRIDGE_EVM_ABI = parseAbi([
  "event MessageReceived(bytes32 indexed messageHash, bytes32 indexed sourceNonce, string sourceChainSymbol)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export interface AllbridgeIntentInput {
  readonly sourceChainSymbol: string;
  readonly destinationChainSymbol: string;
  readonly sourceNonce: bigint;
  readonly recipient: string;
  readonly sourceAmount: bigint;
  readonly destinationPool: string;
}

export function normalizeAllbridgeWord(addressOrStrkey: string): Hex {
  if (/^0x[0-9a-fA-F]{64}$/.test(addressOrStrkey)) {
    return addressOrStrkey.toLowerCase() as Hex;
  }
  if (/^0x[0-9a-fA-F]{40}$/.test(addressOrStrkey)) {
    return toWord(addressOrStrkey.toLowerCase() as Hex);
  }
  const parsed = parseStellarAddress(addressOrStrkey);
  if (!carriesPayload(RouteKind.Allbridge) && parsed.kind === AddressKind.MuxedAccount) {
    throw new Error("Allbridge carries no payload and cannot represent muxed Stellar recipients");
  }
  const canonical = encodeStellarAddress(parsed.kind, parsed.key, parsed.muxedId);
  if (canonical !== addressOrStrkey) {
    throw new Error(`Non-canonical Stellar strkey for Allbridge word: ${addressOrStrkey}`);
  }
  return parsed.key.toLowerCase() as Hex;
}

export function nonceToWord(nonce: bigint): Hex {
  if (nonce < 0n || nonce > (1n << 64n) - 1n) {
    throw new RangeError(`Allbridge sourceNonce out of u64 range: ${nonce.toString()}`);
  }
  return `0x${nonce.toString(16).padStart(64, "0")}`;
}

/**
 * Compute the canonical 32-byte Allbridge intent digest binding origin/destination chain symbols,
 * router nonce, recipient identity, source net amount, and destination pool contract.
 */
export function computeAllbridgeIntentHash(input: AllbridgeIntentInput): Hex {
  const recipientWord = normalizeAllbridgeWord(input.recipient);
  const poolWord = normalizeAllbridgeWord(input.destinationPool);
  return keccak256(
    encodePacked(
      ["bytes", "string", "string", "uint64", "bytes32", "uint256", "bytes32"],
      [
        stringToHex("HYPERION_ALLBRIDGE_V1"),
        input.sourceChainSymbol,
        input.destinationChainSymbol,
        input.sourceNonce,
        recipientWord,
        input.sourceAmount,
        poolWord,
      ],
    ),
  );
}

/**
 * Recover unique configured validator signers over an Allbridge intent digest and produce an
 * explicit validator-quorum trust disclosure.
 */
export async function verifyAllbridgeValidatorQuorum(
  messageHash: Hex,
  signatures: readonly Hex[],
  trust: AllbridgeValidatorTrustConfig,
): Promise<AllbridgeValidatorTrustDisclosure> {
  const allowed = new Set(trust.validators.map((addr) => addr.toLowerCase()));
  const verifiedSigners: `0x${string}`[] = [];
  const seen = new Set<string>();

  for (const signature of signatures) {
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) continue;
    try {
      const recovered = (
        await recoverAddress({ hash: messageHash, signature })
      ).toLowerCase() as Hex;
      if (allowed.has(recovered) && !seen.has(recovered)) {
        seen.add(recovered);
        verifiedSigners.push(recovered);
      }
    } catch {
      /* Malformed or unrecoverable signature cannot contribute to validator quorum. */
    }
  }

  verifiedSigners.sort((a, b) => a.localeCompare(b));
  return {
    model: "configured-validator-quorum",
    configuredValidators: [...trust.validators],
    requiredSignatures: trust.requiredSignatures,
    verifiedSigners,
    quorumSatisfied: verifiedSigners.length >= trust.requiredSignatures,
  };
}

export function allbridgePayoutBounds(
  sourceNetAmount: bigint,
  fromDecimals: number,
  toDecimals: number,
  maxSlippageBps: number,
): { readonly minAmount: bigint; readonly maxAmount: bigint } {
  if (sourceNetAmount <= 0n) {
    throw new RangeError("sourceNetAmount must be positive");
  }
  const maxAmount =
    fromDecimals === toDecimals
      ? sourceNetAmount
      : fromDecimals < toDecimals
        ? sourceNetAmount * 10n ** BigInt(toDecimals - fromDecimals)
        : sourceNetAmount / 10n ** BigInt(fromDecimals - toDecimals);
  const minAmount = (maxAmount * BigInt(10_000 - maxSlippageBps)) / 10_000n;
  return { minAmount, maxAmount };
}

export interface ExpectedAllbridgeEvmPayment {
  readonly messenger: string;
  readonly destinationPool: string;
  readonly destinationBridge: string;
  readonly destinationAdapter: string;
  readonly destinationRouter: string;
  readonly token: string;
  readonly messageHash: Hex;
  readonly sourceNonce: bigint;
  readonly sourceChainSymbol: string;
  readonly recipient: string;
  readonly minAmount: bigint;
  readonly maxAmount: bigint;
}

export interface MatchedAllbridgePayment<T extends DeliveryLog> {
  readonly log: T;
  readonly paidAmount: bigint;
}

/**
 * Verify that a confirmed EVM receipt contains both the Allbridge messenger `MessageReceived` log
 * for the exact intent hash and an actual ERC-20 `Transfer` from the Allbridge pool/bridge/router
 * to the final recipient within the configured fee/slippage bounds.
 */
export function matchingAllbridgePayment<T extends DeliveryLog>(
  logs: readonly T[],
  expected: ExpectedAllbridgeEvmPayment,
): MatchedAllbridgePayment<T> | null {
  const expectedNonceWord = nonceToWord(expected.sourceNonce).toLowerCase();
  const messengerLower = expected.messenger.toLowerCase();
  const tokenLower = expected.token.toLowerCase();
  const recipientLower = expected.recipient.toLowerCase();
  const adapterLower = expected.destinationAdapter.toLowerCase();
  const allowedPayers = new Set([
    expected.destinationPool.toLowerCase(),
    expected.destinationBridge.toLowerCase(),
    expected.destinationRouter.toLowerCase(),
    adapterLower,
  ]);

  let messageConfirmed = false;
  let matchedTransfer: MatchedAllbridgePayment<T> | null = null;

  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: ALLBRIDGE_EVM_ABI,
        topics: log.topics,
        data: log.data,
      });
      if (decoded.eventName === "MessageReceived" && log.address.toLowerCase() === messengerLower) {
        messageConfirmed ||=
          decoded.args.messageHash.toLowerCase() === expected.messageHash.toLowerCase() &&
          decoded.args.sourceNonce.toLowerCase() === expectedNonceWord &&
          decoded.args.sourceChainSymbol === expected.sourceChainSymbol;
      }
      if (decoded.eventName === "Transfer" && log.address.toLowerCase() === tokenLower) {
        const fromLower = decoded.args.from.toLowerCase();
        const toLower = decoded.args.to.toLowerCase();
        const value = decoded.args.value;
        // Adapter custody alone cannot establish final payout unless the adapter itself was the
        // intended recipient, which is never true for user transfers.
        const paidToFinalRecipient =
          toLower === recipientLower &&
          (recipientLower === adapterLower || toLower !== adapterLower);
        if (
          paidToFinalRecipient &&
          allowedPayers.has(fromLower) &&
          value > 0n &&
          value >= expected.minAmount &&
          value <= expected.maxAmount
        ) {
          matchedTransfer = { log, paidAmount: value };
        }
      }
    } catch {
      /* Receipts routinely carry unrelated logs; ignore non-matching signatures. */
    }
  }

  return messageConfirmed ? matchedTransfer : null;
}
