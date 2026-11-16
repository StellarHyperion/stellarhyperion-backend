import {
  RouteKind,
  decodeInboundNote,
  decodeOutboundNote,
  encodeInboundNote,
  encodeOutboundNote,
  toHex,
} from "@hyperion/protocol";
import {
  decodeAbiParameters,
  decodeEventLog,
  encodeAbiParameters,
  hexToBytes,
  keccak256,
  parseAbi,
  type Hex,
} from "viem";

import type { DeliveryLog } from "./events.js";

export const AXELAR_GMP_RECEIPT_ABI = parseAbi([
  "event ContractCallApproved(bytes32 indexed commandId, string sourceChain, string sourceAddress, address indexed contractAddress, bytes32 indexed payloadHash, bytes32 sourceTxHash, uint256 sourceEventIndex)",
  "event ContractCallExecuted(bytes32 indexed commandId)",
  "event BridgeIn(uint8 indexed route, address indexed recipient, address indexed token, uint256 amount, string sourceChain, uint64 sourceNonce, bytes32 messageId)",
  "event ClaimParked(uint64 indexed id, address indexed recipient, address indexed token, uint256 amount, uint8 route, string sourceChain, uint64 sourceNonce)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

const GMP_PAYLOAD_PARAMS = [
  { name: "note", type: "bytes" },
  { name: "destinationToken", type: "string" },
  { name: "destinationAmount", type: "uint256" },
] as const;

export interface DecodedGmpPayload {
  readonly recipient: string;
  readonly sourceNonce: bigint;
  readonly destinationToken: string;
  readonly destinationAmount: bigint;
  readonly payloadHash: Hex;
}

export function encodeGmpPayoutPayload(input: {
  readonly destinationFamily: "evm" | "stellar";
  readonly recipient: string;
  readonly sourceNonce: bigint;
  readonly destinationToken: string;
  readonly destinationAmount: bigint;
}): Hex {
  const noteBytes =
    input.destinationFamily === "evm"
      ? encodeOutboundNote(input.recipient as Hex, input.sourceNonce)
      : encodeInboundNote(input.recipient, input.sourceNonce);
  return encodeAbiParameters(GMP_PAYLOAD_PARAMS, [
    toHex(noteBytes),
    input.destinationToken,
    input.destinationAmount,
  ]);
}

export function decodeGmpPayoutPayload(
  rawPayload: Hex,
  destinationFamily: "evm" | "stellar",
): DecodedGmpPayload | null {
  try {
    const [noteHex, destinationToken, destinationAmount] = decodeAbiParameters(
      GMP_PAYLOAD_PARAMS,
      rawPayload,
    );
    const noteBytes = hexToBytes(noteHex);
    if (destinationFamily === "evm") {
      const note = decodeOutboundNote(noteBytes);
      return {
        recipient: note.recipient.toLowerCase(),
        sourceNonce: note.nonce,
        destinationToken,
        destinationAmount,
        payloadHash: keccak256(rawPayload),
      };
    }
    const note = decodeInboundNote(noteBytes);
    return {
      recipient: note.strkey,
      sourceNonce: note.nonce,
      destinationToken,
      destinationAmount,
      payloadHash: keccak256(rawPayload),
    };
  } catch {
    return null;
  }
}

export interface ExpectedGmpEvmPayout {
  readonly gateway: string;
  readonly destinationReceiver: string;
  readonly destinationRouter: string;
  readonly token: string;
  readonly commandId: Hex;
  readonly sourceAxelarChain: string;
  readonly sourceOriginChain: string;
  readonly sourceAdapter: string;
  readonly sourceNonce: bigint;
  readonly recipient: string;
  readonly amount: bigint;
  readonly payload: Hex;
}

/**
 * Verify that an EVM transaction receipt establishes authenticated Axelar GMP delivery:
 * 1. Gateway `ContractCallApproved` binds `commandId`, `sourceAxelarChain`, `sourceAdapter` peer,
 *    `destinationReceiver`, and `payloadHash == keccak256(payload)`.
 * 2. Gateway `ContractCallExecuted` confirms execution of that exact `commandId`.
 * 3. Decoded Hyperion GMP payload binds `recipient`, `sourceNonce`, `token`, and `amount`.
 * 4. Router `BridgeIn` (with no `ClaimParked` in the transaction) and canonical ERC-20 `Transfer`
 *    confirm actual payout of `amount` of `token` to `recipient` rather than receiver custody.
 */
export function matchingGmpPayment<T extends DeliveryLog>(
  logs: readonly T[],
  expected: ExpectedGmpEvmPayout,
): T | null {
  const decodedPayload = decodeGmpPayoutPayload(expected.payload, "evm");
  if (
    decodedPayload?.recipient.toLowerCase() !== expected.recipient.toLowerCase() ||
    decodedPayload.sourceNonce !== expected.sourceNonce ||
    decodedPayload.destinationToken.toLowerCase() !== expected.token.toLowerCase() ||
    decodedPayload.destinationAmount !== expected.amount ||
    expected.amount <= 0n
  ) {
    return null;
  }

  const gatewayLower = expected.gateway.toLowerCase();
  const receiverLower = expected.destinationReceiver.toLowerCase();
  const routerLower = expected.destinationRouter.toLowerCase();
  const tokenLower = expected.token.toLowerCase();
  const recipientLower = expected.recipient.toLowerCase();
  const commandLower = expected.commandId.toLowerCase();
  const sourcePeerLower = expected.sourceAdapter.toLowerCase();
  const expectedPayloadHash = decodedPayload.payloadHash.toLowerCase();

  let approved = false;
  let executed = false;
  let bridgeInMatched = false;
  let claimParked = false;
  let payoutLog: T | null = null;

  for (const log of logs) {
    try {
      const event = decodeEventLog({
        abi: AXELAR_GMP_RECEIPT_ABI,
        topics: log.topics,
        data: log.data,
      });
      const logAddr = log.address.toLowerCase();

      if (event.eventName === "ContractCallApproved" && logAddr === gatewayLower) {
        approved ||=
          event.args.commandId.toLowerCase() === commandLower &&
          event.args.sourceChain === expected.sourceAxelarChain &&
          event.args.sourceAddress.toLowerCase() === sourcePeerLower &&
          event.args.contractAddress.toLowerCase() === receiverLower &&
          event.args.payloadHash.toLowerCase() === expectedPayloadHash;
      }

      if (event.eventName === "ContractCallExecuted" && logAddr === gatewayLower) {
        executed ||= event.args.commandId.toLowerCase() === commandLower;
      }

      if (event.eventName === "ClaimParked" && logAddr === routerLower) {
        if (
          event.args.route === RouteKind.AxelarGmp &&
          event.args.sourceChain === expected.sourceOriginChain &&
          event.args.sourceNonce === expected.sourceNonce
        ) {
          claimParked = true;
        }
      }

      if (event.eventName === "BridgeIn" && logAddr === routerLower) {
        bridgeInMatched ||=
          event.args.route === RouteKind.AxelarGmp &&
          event.args.recipient.toLowerCase() === recipientLower &&
          event.args.token.toLowerCase() === tokenLower &&
          event.args.amount === expected.amount &&
          event.args.sourceChain === expected.sourceOriginChain &&
          event.args.sourceNonce === expected.sourceNonce &&
          event.args.messageId.toLowerCase() === commandLower;
      }

      if (event.eventName === "Transfer" && logAddr === tokenLower) {
        const fromLower = event.args.from.toLowerCase();
        const toLower = event.args.to.toLowerCase();
        if (
          (fromLower === routerLower || fromLower === receiverLower) &&
          toLower === recipientLower &&
          (recipientLower === receiverLower || toLower !== receiverLower) &&
          event.args.value === expected.amount
        ) {
          payoutLog = log;
        }
      }
    } catch {
      /* Receipts may include unrelated contract logs; ignore unknown event topics. */
    }
  }

  if (!approved || !executed || !bridgeInMatched || claimParked) {
    return null;
  }
  return payoutLog;
}
