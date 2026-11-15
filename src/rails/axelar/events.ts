import {
  AddressKind,
  NOTE_VERSION,
  RouteKind,
  decodeInboundNote,
  encodeStellarAddress,
  fromHex,
  parseStellarAddress,
  toHex,
} from "@hyperion/protocol";
import { decodeEventLog, parseAbi, type Hex } from "viem";
import {
  decodeStellarEvent,
  type BridgeInEvent,
  type ClaimParkedEvent,
  type RawStellarEvent,
} from "../../chains/stellar/events.js";
import {
  scAddress,
  scBigInt,
  scBytes,
  scMap,
  scOptionalField,
  scString,
  scSymbol,
  scTag,
} from "../../chains/stellar/scval.js";
import type { SupportedItsTokenManagerType } from "../types.js";

export const ITS_ABI = parseAbi([
  "function registeredTokenAddress(bytes32 tokenId) view returns (address)",
  "function deployedTokenManager(bytes32 tokenId) view returns (address)",
  "event InterchainTransferReceived(bytes32 indexed commandId, bytes32 indexed tokenId, string sourceChain, bytes sourceAddress, address indexed destinationAddress, uint256 amount, bytes32 dataHash)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const EVM_ITS_TOKEN_MANAGER_ABI = parseAbi([
  "function implementationType() view returns (uint256)",
]);

export const SUPPORTED_ITS_TOKEN_MANAGER_TYPES: readonly SupportedItsTokenManagerType[] = [
  0, // NATIVE_INTERCHAIN_TOKEN
  1, // MINT_BURN_FROM
  2, // LOCK_UNLOCK
  4, // MINT_BURN
];

const SUPPORTED_TOKEN_MANAGER_NAMES = new Set([
  "native_interchain_token",
  "nativeinterchaintoken",
  "mint_burn_from",
  "mintburnfrom",
  "lock_unlock",
  "lockunlock",
  "mint_burn",
  "mintburn",
]);

/**
 * Check whether an Axelar ITS token-manager implementation type preserves deterministic 1:1
 * transfer amounts. Fee-on-transfer (`3` / `lock_unlock_fee`) and unknown variants return false.
 */
export function isSupportedTokenManagerType(value: unknown): boolean {
  if (typeof value === "number" && Number.isInteger(value)) {
    return (SUPPORTED_ITS_TOKEN_MANAGER_TYPES as readonly number[]).includes(value);
  }
  if (typeof value === "bigint") {
    return (
      value >= 0n &&
      value <= 4n &&
      (SUPPORTED_ITS_TOKEN_MANAGER_TYPES as readonly number[]).includes(Number(value))
    );
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (/^\d+$/.test(normalized)) {
      return (SUPPORTED_ITS_TOKEN_MANAGER_TYPES as readonly number[]).includes(Number(normalized));
    }
    return SUPPORTED_TOKEN_MANAGER_NAMES.has(normalized);
  }
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
    return isSupportedTokenManagerType(value[0]);
  }
  return false;
}

export interface CanonicalStellarRecipient {
  readonly strkey: string;
  readonly kind: AddressKind;
  readonly key: Hex;
  readonly muxedId: bigint;
}

/**
 * Parse and canonically re-encode a Stellar recipient strkey (`G...`, `C...`, or 69-char `M...`).
 * Preserves full muxed account `muxedId` and rejects non-canonical or corrupted strkeys.
 */
export function canonicalStellarRecipient(strkey: string): CanonicalStellarRecipient | null {
  try {
    const parsed = parseStellarAddress(strkey);
    const encoded = encodeStellarAddress(parsed.kind, parsed.key, parsed.muxedId);
    if (encoded !== strkey) return null;
    return {
      strkey: encoded,
      kind: parsed.kind,
      key: parsed.key,
      muxedId: parsed.muxedId,
    };
  } catch {
    return null;
  }
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

export interface ExpectedReverseItsDelivery {
  readonly originChain: string;
  readonly sourceAxelarChain: string;
  readonly sourceAdapter: Hex;
  readonly sourceNonce: bigint;
  readonly commandId: Hex;
  readonly tokenId: Hex;
  readonly its: string;
  readonly destinationAdapter: string;
  readonly router: string;
  readonly token: string;
  readonly recipient: string;
  readonly amount: bigint;
}

export type ReverseItsMatch =
  | {
      readonly kind: "delivered";
      readonly ledger: number;
      readonly closedAt: Date;
      readonly txHash: string;
      readonly recipient: string;
    }
  | {
      readonly kind: "parked";
      readonly ledger: number;
      readonly closedAt: Date;
      readonly txHash: string;
      readonly recipient: string;
      readonly claimId: bigint;
      readonly createdAt: Date;
    };

/**
 * Bind a reverse-direction (EVM -> Stellar) ITS callback, Soroban router `BridgeIn`, and actual
 * SAC token delivery to the indexed source transfer and full Stellar recipient strkey.
 *
 * Adapter custody alone (tokens minted or transferred to `destinationAdapter` without router
 * settlement and final recipient payout) never establishes final delivery.
 */
export function matchingReverseItsDelivery(
  events: readonly RawStellarEvent[],
  expected: ExpectedReverseItsDelivery,
): ReverseItsMatch | null {
  const recipient = canonicalStellarRecipient(expected.recipient);
  if (recipient === null || expected.amount <= 0n) return null;
  if (
    recipient.strkey === expected.destinationAdapter ||
    recipient.strkey === expected.router ||
    recipient.strkey === expected.its
  ) {
    return null;
  }

  let callbackMatched = false;
  let matchedBridgeIn: { readonly event: RawStellarEvent; readonly data: BridgeInEvent } | null =
    null;
  let matchedClaim: ClaimParkedEvent | null = null;
  let recipientPayoutMatched = false;
  let routerCustodyMatched = false;

  for (const event of events) {
    if (event.inSuccessfulContractCall === false) continue;

    if (event.contractId === expected.its) {
      if (matchesStellarItsCallback(event, expected, recipient)) {
        callbackMatched = true;
      }
      continue;
    }

    if (event.contractId === expected.router) {
      try {
        const decoded = decodeStellarEvent(event);
        if (
          decoded.kind === "bridgeIn" &&
          decoded.data.route === RouteKind.AxelarIts &&
          decoded.data.sourceChain === expected.originChain &&
          decoded.data.sourceNonce === expected.sourceNonce &&
          decoded.data.recipient === recipient.strkey &&
          decoded.data.token === expected.token &&
          decoded.data.amount === expected.amount
        ) {
          matchedBridgeIn = { event, data: decoded.data };
        } else if (
          decoded.kind === "claimParked" &&
          decoded.data.route === RouteKind.AxelarIts &&
          decoded.data.sourceChain === expected.originChain &&
          decoded.data.sourceNonce === expected.sourceNonce &&
          decoded.data.recipient === recipient.strkey &&
          decoded.data.token === expected.token &&
          decoded.data.amount === expected.amount &&
          !decoded.data.settled
        ) {
          matchedClaim = decoded.data;
        }
      } catch {
        /* Unrelated or malformed non-matching router event cannot establish delivery. */
      }
      continue;
    }

    if (event.contractId === expected.token) {
      const transfer = readSacTransfer(event);
      if (transfer?.amount !== expected.amount) continue;
      if (transfer.from === expected.router && transfer.recipient === recipient.strkey) {
        recipientPayoutMatched = true;
      } else if (
        (transfer.from === expected.destinationAdapter || transfer.from === expected.its) &&
        transfer.recipient === expected.router
      ) {
        routerCustodyMatched = true;
      }
    }
  }

  if (!callbackMatched || matchedBridgeIn === null) return null;

  const closedAt = new Date(matchedBridgeIn.event.ledgerClosedAt);
  if (Number.isNaN(closedAt.getTime())) return null;

  if (matchedBridgeIn.data.delivered) {
    if (matchedBridgeIn.data.claimId !== 0n || matchedClaim !== null) return null;
    if (!recipientPayoutMatched) return null;
    return {
      kind: "delivered",
      ledger: matchedBridgeIn.event.ledger,
      closedAt,
      txHash: matchedBridgeIn.event.txHash,
      recipient: recipient.strkey,
    };
  }

  if (
    matchedBridgeIn.data.claimId <= 0n ||
    matchedClaim?.claimId !== matchedBridgeIn.data.claimId ||
    recipientPayoutMatched ||
    !routerCustodyMatched
  ) {
    return null;
  }

  return {
    kind: "parked",
    ledger: matchedBridgeIn.event.ledger,
    closedAt,
    txHash: matchedBridgeIn.event.txHash,
    recipient: recipient.strkey,
    claimId: matchedClaim.claimId,
    createdAt: new Date(Number(matchedClaim.createdAt) * 1000),
  };
}

function matchesStellarItsCallback(
  event: RawStellarEvent,
  expected: ExpectedReverseItsDelivery,
  recipient: CanonicalStellarRecipient,
): boolean {
  try {
    const topicSymbols: string[] = [];
    for (const item of event.topicJson) {
      if (scTag(item) === "symbol") {
        topicSymbols.push(scSymbol(item));
      }
    }
    const hasItsTag = topicSymbols.some(
      (tag) =>
        tag === "interchain_transfer_received" ||
        tag === "interchain_transfer" ||
        tag === "execute_with_interchain_token",
    );
    if (!hasItsTag || scTag(event.valueJson) !== "map") return false;

    const map = scMap(event.valueJson, "its.value");
    const rawCommandId =
      scOptionalField(map, "command_id") ??
      scOptionalField(map, "commandId") ??
      findBytesTopic(event.topicJson, 0);
    const rawTokenId =
      scOptionalField(map, "token_id") ??
      scOptionalField(map, "tokenId") ??
      findBytesTopic(event.topicJson, 1);
    const rawSourceChain =
      scOptionalField(map, "source_chain") ?? scOptionalField(map, "sourceChain");
    const rawSourceAddress =
      scOptionalField(map, "source_address") ?? scOptionalField(map, "sourceAddress");
    const rawDestination =
      scOptionalField(map, "destination_address") ??
      scOptionalField(map, "destinationAddress") ??
      findAddressTopic(event.topicJson);
    const rawAmount = scOptionalField(map, "amount");
    const rawData = scOptionalField(map, "data") ?? scOptionalField(map, "payload");

    if (
      rawCommandId === undefined ||
      rawTokenId === undefined ||
      rawSourceChain === undefined ||
      rawSourceAddress === undefined ||
      rawDestination === undefined ||
      rawAmount === undefined ||
      rawData === undefined
    ) {
      return false;
    }

    const commandId = readWord32ScVal(rawCommandId);
    const tokenId = readWord32ScVal(rawTokenId);
    if (commandId === null || tokenId === null) return false;
    if (commandId !== expected.commandId.toLowerCase()) return false;
    if (tokenId !== expected.tokenId.toLowerCase()) return false;

    const sourceChain = scString(rawSourceChain, "its.source_chain");
    if (sourceChain !== expected.sourceAxelarChain) return false;

    if (!matchesEvmPeerAddress(rawSourceAddress, expected.sourceAdapter)) return false;

    const destinationAddress =
      scTag(rawDestination) === "address"
        ? scAddress(rawDestination, "its.destination_address")
        : scString(rawDestination, "its.destination_address");
    if (destinationAddress !== expected.destinationAdapter) return false;

    const amount = scBigInt(rawAmount, "its.amount");
    if (amount !== expected.amount) return false;

    const dataHex = scBytes(rawData, "its.data");
    const rawBytes = fromHex(dataHex);
    const noteBytes =
      rawBytes.length > 4 &&
      rawBytes[0] === 0 &&
      rawBytes[1] === 0 &&
      rawBytes[2] === 0 &&
      rawBytes[3] === 0 &&
      rawBytes[4] === NOTE_VERSION
        ? rawBytes.slice(4)
        : rawBytes;

    const note = decodeInboundNote(noteBytes);
    return (
      note.kind === recipient.kind &&
      note.strkey === recipient.strkey &&
      note.nonce === expected.sourceNonce
    );
  } catch {
    return false;
  }
}

function readSacTransfer(
  event: RawStellarEvent,
): { readonly from: string; readonly recipient: string; readonly amount: bigint } | null {
  try {
    const t0 = event.topicJson[0];
    const t1 = event.topicJson[1];
    const t2 = event.topicJson[2];
    if (t0 === undefined || t1 === undefined || t2 === undefined) return null;
    if (scTag(t0) !== "symbol" || scSymbol(t0) !== "transfer") return null;

    const from = scAddress(t1, "sac.from");
    const rawTo = scAddress(t2, "sac.to");

    let amount: bigint;
    let toMuxedId: bigint | null = null;
    if (scTag(event.valueJson) === "map") {
      const fields = scMap(event.valueJson, "sac.value");
      const rawAmount = scOptionalField(fields, "amount");
      if (rawAmount === undefined) return null;
      amount = scBigInt(rawAmount, "sac.value.amount");
      const rawMuxed = scOptionalField(fields, "to_muxed_id");
      if (rawMuxed !== undefined) {
        toMuxedId = scBigInt(rawMuxed, "sac.value.to_muxed_id");
      }
    } else {
      amount = scBigInt(event.valueJson, "sac.value");
    }

    const parsedTo = parseStellarAddress(rawTo);
    let recipient: string;
    if (parsedTo.kind === AddressKind.MuxedAccount) {
      if (toMuxedId !== null && toMuxedId !== parsedTo.muxedId) return null;
      recipient = encodeStellarAddress(AddressKind.MuxedAccount, parsedTo.key, parsedTo.muxedId);
    } else if (parsedTo.kind === AddressKind.Account && toMuxedId !== null) {
      recipient = encodeStellarAddress(AddressKind.MuxedAccount, parsedTo.key, toMuxedId);
    } else {
      if (toMuxedId !== null) return null;
      recipient = encodeStellarAddress(parsedTo.kind, parsedTo.key, 0n);
    }

    return { from, recipient, amount };
  } catch {
    return null;
  }
}

function readWord32ScVal(value: unknown): string | null {
  const tag = scTag(value);
  if (tag === "bytes") {
    const hex = scBytes(value);
    return hex.length === 66 ? hex.toLowerCase() : null;
  }
  if (tag === "string" || tag === "symbol") {
    const str = scString(value).trim();
    const clean = str.startsWith("0x") ? str.slice(2) : str;
    return /^[0-9a-fA-F]{64}$/.test(clean) ? `0x${clean.toLowerCase()}` : null;
  }
  return null;
}

function matchesEvmPeerAddress(value: unknown, expectedAdapter: Hex): boolean {
  const expectedLower = expectedAdapter.toLowerCase();
  const tag = scTag(value);
  if (tag === "string" || tag === "symbol") {
    const textValue = scString(value).trim().toLowerCase();
    const prefixed = textValue.startsWith("0x") ? textValue : `0x${textValue}`;
    return prefixed === expectedLower;
  }
  if (tag === "bytes") {
    const bytes = fromHex(scBytes(value));
    if (bytes.length === 20) {
      return toHex(bytes).toLowerCase() === expectedLower;
    }
    const ascii = new TextDecoder().decode(bytes).trim().toLowerCase();
    const prefixed = ascii.startsWith("0x") ? ascii : `0x${ascii}`;
    return prefixed === expectedLower;
  }
  return false;
}

function findBytesTopic(topics: readonly Record<string, unknown>[], ordinal: number): unknown {
  let seen = 0;
  for (const item of topics) {
    if (scTag(item) === "bytes") {
      if (seen === ordinal) return item;
      seen += 1;
    }
  }
  return undefined;
}

function findAddressTopic(topics: readonly Record<string, unknown>[]): unknown {
  for (const item of topics) {
    if (scTag(item) === "address") return item;
  }
  return undefined;
}
