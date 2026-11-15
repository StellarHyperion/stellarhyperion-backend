import { StrKey } from "@stellar/stellar-sdk";
import {
  AddressKind,
  FINALITY_THRESHOLD_FINALIZED,
  RouteKind,
  STELLAR_DOMAIN,
  assertSupportedBurn,
  assertSupportedMessage,
  cctpBody,
  cctpHookData,
  decodeCctpHook,
  encodeStellarAddress,
  parseCctpBurnMessage,
  parseCctpMessage,
  parseStellarAddress,
  toEvmAddress,
  toHex,
  toWord,
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
  scSymbol,
  scTag,
  scU32,
} from "../../chains/stellar/scval.js";
import type { DeliveryLog } from "../axelar/events.js";

const ZERO_WORD = `0x${"0".repeat(64)}`;

// Source: circlefin/evm-cctp-contracts/src/v2/MessageTransmitterV2.sol.
export const CCTP_RECEIPT_ABI = parseAbi([
  "event MessageReceived(address indexed caller,uint32 sourceDomain,bytes32 indexed nonce,bytes32 sender,uint32 indexed finalityThresholdExecuted,bytes messageBody)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);

export const EVM_CCTP_BURN_ABI = parseAbi([
  "event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)",
  "event MessageSent(bytes message)",
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

export function verifiedCctpMessage(raw: Hex, expected: ExpectedCctpTransfer) {
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
  )
    return null;
  return { message, body: toHex(body), amount: burn.amount - burn.feeExecuted };
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
      )
        payment = log;
    } catch {
      /* Unrelated receipt events do not establish this transfer's delivery. */
    }
  }
  return received ? payment : null;
}

export interface ExpectedReverseCctpTransfer {
  readonly originChain: string;
  readonly sourceNonce: bigint;
  readonly sourceDomain: number;
  readonly sourceToken: Hex;
  readonly sourceAdapter: Hex;
  readonly sourceMessenger: Hex;
  readonly sourceAmount: bigint;
  /** Optional 32-byte CCTP message nonce recorded on the source BridgeOut (`rail_ref`). */
  readonly expectedMessageNonce?: string | null;
  readonly destinationMessenger: string;
  readonly destinationTransmitter: string;
  readonly destinationAdapter: string;
  readonly destinationRouter: string;
  readonly destinationToken: string;
  readonly recipient: string;
}

export interface VerifiedReverseCctpMessage {
  readonly message: ReturnType<typeof parseCctpMessage>;
  readonly burn: ReturnType<typeof parseCctpBurnMessage>;
  readonly body: Hex;
  readonly hookRecipient: string;
  /** Net USDC burned after Circle's protocol fee (6 decimals). */
  readonly netUsdc6: bigint;
  /** Net USDC minted on Stellar (7 decimals, exact `* 10n` conversion). */
  readonly stellarAmount: bigint;
}

export type ReverseCctpMatch =
  | {
      readonly kind: "delivered";
      readonly ledger: number;
      readonly closedAt: Date;
      readonly txHash: string;
      readonly messageNonce: Hex;
      readonly recipient: string;
      readonly stellarAmount: bigint;
    }
  | {
      readonly kind: "parked";
      readonly ledger: number;
      readonly closedAt: Date;
      readonly txHash: string;
      readonly messageNonce: Hex;
      readonly recipient: string;
      readonly stellarAmount: bigint;
      readonly claimId: bigint;
      readonly createdAt: Date;
    };

/**
 * Validate a reverse-direction (EVM -> Stellar) CCTP V2 message and burn payload, binding source
 * domain, messenger, USDC token, Hyperion adapter, Stellar inbound messenger/adapter, burn amount,
 * protocol fee bounds, finality threshold, and hook recipient strkey.
 */
export function verifiedReverseCctpMessage(
  raw: Hex,
  expected: ExpectedReverseCctpTransfer,
): VerifiedReverseCctpMessage | null {
  try {
    const recipientCanonical = canonicalStrkey(expected.recipient);
    if (recipientCanonical === null) return null;

    const message = parseCctpMessage(raw);
    const body = cctpBody(raw);
    const burn = parseCctpBurnMessage(body);
    assertSupportedMessage(message);
    assertSupportedBurn(burn);

    const expectedSenderWord = toWord(expected.sourceMessenger).toLowerCase();
    const expectedBurnTokenWord = toWord(expected.sourceToken).toLowerCase();
    const expectedBurnSenderWord = toWord(expected.sourceAdapter).toLowerCase();
    const expectedDestMessengerWord = toHex(
      StrKey.decodeContract(expected.destinationMessenger),
    ).toLowerCase();
    const expectedMintRecipientWord = toHex(
      StrKey.decodeContract(expected.destinationAdapter),
    ).toLowerCase();
    const callerLower = message.destinationCaller.toLowerCase();

    if (
      expected.sourceDomain === STELLAR_DOMAIN ||
      message.sourceDomain !== expected.sourceDomain ||
      message.destinationDomain !== STELLAR_DOMAIN ||
      message.sender.toLowerCase() !== expectedSenderWord ||
      message.recipient.toLowerCase() !== expectedDestMessengerWord ||
      (callerLower !== ZERO_WORD && callerLower !== expectedMintRecipientWord) ||
      burn.burnToken.toLowerCase() !== expectedBurnTokenWord ||
      burn.messageSender.toLowerCase() !== expectedBurnSenderWord ||
      burn.mintRecipient.toLowerCase() !== expectedMintRecipientWord ||
      burn.amount !== expected.sourceAmount ||
      burn.feeExecuted < 0n ||
      burn.feeExecuted > burn.maxFee ||
      burn.feeExecuted >= burn.amount ||
      message.finalityThresholdExecuted < FINALITY_THRESHOLD_FINALIZED
    ) {
      return null;
    }

    if (
      expected.expectedMessageNonce !== undefined &&
      expected.expectedMessageNonce !== null &&
      expected.expectedMessageNonce.toLowerCase() !== ZERO_WORD &&
      message.nonce.toLowerCase() !== expected.expectedMessageNonce.toLowerCase()
    ) {
      return null;
    }

    const hook = decodeCctpHook(cctpHookData(body));
    const hookRecipient = encodeStellarAddress(hook.kind, hook.key, hook.muxedId);
    if (hookRecipient !== recipientCanonical) return null;

    const netUsdc6 = burn.amount - burn.feeExecuted;
    const stellarAmount = netUsdc6 * 10n;
    if (stellarAmount <= 0n) return null;

    return {
      message,
      burn,
      body: toHex(body),
      hookRecipient,
      netUsdc6,
      stellarAmount,
    };
  } catch {
    return null;
  }
}

/**
 * Verify a reverse-direction CCTP receive on Stellar, distinguishing completed SAC recipient
 * payout (`kind: "delivered"`) from a fixed-recipient parked claim (`kind: "parked"`).
 */
export function matchingReverseCctpDelivery(
  events: readonly RawStellarEvent[],
  raw: Hex,
  expected: ExpectedReverseCctpTransfer,
): ReverseCctpMatch | null {
  const verified = verifiedReverseCctpMessage(raw, expected);
  if (verified === null) return null;

  let receiveMatched = false;
  let matchedBridgeIn: { readonly event: RawStellarEvent; readonly data: BridgeInEvent } | null =
    null;
  let matchedClaim: ClaimParkedEvent | null = null;
  let recipientPaid = false;
  let routerCustodyFunded = false;

  for (const event of events) {
    if (event.inSuccessfulContractCall === false) continue;

    if (event.contractId === expected.destinationTransmitter) {
      if (matchesStellarCctpReceive(event, expected.sourceDomain, verified)) {
        receiveMatched = true;
      }
      continue;
    }

    if (event.contractId === expected.destinationRouter) {
      try {
        const decoded = decodeStellarEvent(event);
        if (
          decoded.kind === "bridgeIn" &&
          decoded.data.route === RouteKind.Cctp &&
          decoded.data.sourceChain === expected.originChain &&
          decoded.data.sourceNonce === expected.sourceNonce &&
          decoded.data.recipient === verified.hookRecipient &&
          decoded.data.token === expected.destinationToken &&
          decoded.data.amount === verified.stellarAmount
        ) {
          matchedBridgeIn = { event, data: decoded.data };
        } else if (
          decoded.kind === "claimParked" &&
          decoded.data.route === RouteKind.Cctp &&
          decoded.data.sourceChain === expected.originChain &&
          decoded.data.sourceNonce === expected.sourceNonce &&
          decoded.data.recipient === verified.hookRecipient &&
          decoded.data.token === expected.destinationToken &&
          decoded.data.amount === verified.stellarAmount &&
          !decoded.data.settled
        ) {
          matchedClaim = decoded.data;
        }
      } catch {
        /* Unrelated router events cannot establish delivery. */
      }
      continue;
    }

    if (event.contractId === expected.destinationToken) {
      const sac = readStellarSacMovement(event);
      if (sac?.amount !== verified.stellarAmount) continue;
      if (
        sac.kind === "transfer" &&
        sac.from === expected.destinationRouter &&
        sac.recipient === verified.hookRecipient
      ) {
        recipientPaid = true;
      } else if (
        sac.recipient === expected.destinationRouter &&
        (sac.from === expected.destinationAdapter ||
          sac.from === expected.destinationMessenger ||
          sac.kind === "mint")
      ) {
        routerCustodyFunded = true;
      }
    }
  }

  if (!receiveMatched || matchedBridgeIn === null) return null;

  const closedAt = new Date(matchedBridgeIn.event.ledgerClosedAt);
  if (Number.isNaN(closedAt.getTime())) return null;

  if (matchedBridgeIn.data.delivered) {
    if (matchedBridgeIn.data.claimId !== 0n || matchedClaim !== null) return null;
    if (!recipientPaid) return null;
    return {
      kind: "delivered",
      ledger: matchedBridgeIn.event.ledger,
      closedAt,
      txHash: matchedBridgeIn.event.txHash,
      messageNonce: verified.message.nonce.toLowerCase() as Hex,
      recipient: verified.hookRecipient,
      stellarAmount: verified.stellarAmount,
    };
  }

  if (
    matchedBridgeIn.data.claimId <= 0n ||
    matchedClaim?.claimId !== matchedBridgeIn.data.claimId ||
    recipientPaid ||
    !routerCustodyFunded
  ) {
    return null;
  }

  return {
    kind: "parked",
    ledger: matchedBridgeIn.event.ledger,
    closedAt,
    txHash: matchedBridgeIn.event.txHash,
    messageNonce: verified.message.nonce.toLowerCase() as Hex,
    recipient: verified.hookRecipient,
    stellarAmount: verified.stellarAmount,
    claimId: matchedClaim.claimId,
    createdAt: new Date(Number(matchedClaim.createdAt) * 1000),
  };
}

/** Verify that the source EVM burn transaction actually emitted the exact CCTP message bytes. */
export function matchesSourceCctpBurnLogs(logs: readonly DeliveryLog[], raw: Hex): boolean {
  const expectedLower = raw.toLowerCase();
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: EVM_CCTP_BURN_ABI,
        topics: log.topics,
        data: log.data,
      });
      if (
        decoded.eventName === "MessageSent" &&
        decoded.args.message.toLowerCase() === expectedLower
      ) {
        return true;
      }
    } catch {
      /* Ignore non-matching logs in the source receipt. */
    }
  }
  return false;
}

function matchesStellarCctpReceive(
  event: RawStellarEvent,
  expectedSourceDomain: number,
  verified: VerifiedReverseCctpMessage,
): boolean {
  try {
    const symbols: string[] = [];
    for (const item of event.topicJson) {
      if (scTag(item) === "symbol") symbols.push(scSymbol(item));
    }
    const isReceive = symbols.some(
      (tag) => tag === "message_received" || tag === "MessageReceived",
    );
    if (!isReceive || scTag(event.valueJson) !== "map") return false;

    const map = scMap(event.valueJson, "cctp.receive");
    const rawDomain = scOptionalField(map, "source_domain") ?? scOptionalField(map, "sourceDomain");
    const rawNonce = scOptionalField(map, "nonce") ?? findBytesInTopics(event.topicJson, 0);
    const rawSender = scOptionalField(map, "sender");
    const rawFinality =
      scOptionalField(map, "finality_threshold_executed") ??
      scOptionalField(map, "finalityThresholdExecuted");
    const rawBody = scOptionalField(map, "message_body") ?? scOptionalField(map, "messageBody");

    if (
      rawDomain === undefined ||
      rawNonce === undefined ||
      rawSender === undefined ||
      rawFinality === undefined ||
      rawBody === undefined
    ) {
      return false;
    }

    const sourceDomain = scU32(rawDomain, "cctp.source_domain");
    const nonce = scBytes(rawNonce, "cctp.nonce").toLowerCase();
    const sender = scBytes(rawSender, "cctp.sender").toLowerCase();
    const finality = scU32(rawFinality, "cctp.finality");
    const body = scBytes(rawBody, "cctp.body").toLowerCase();

    return (
      sourceDomain === expectedSourceDomain &&
      nonce === verified.message.nonce.toLowerCase() &&
      sender === verified.message.sender.toLowerCase() &&
      finality === verified.message.finalityThresholdExecuted &&
      body === verified.body.toLowerCase()
    );
  } catch {
    return false;
  }
}

function readStellarSacMovement(event: RawStellarEvent): {
  readonly kind: "transfer" | "mint";
  readonly from: string | null;
  readonly recipient: string;
  readonly amount: bigint;
} | null {
  try {
    const t0 = event.topicJson[0];
    if (t0 === undefined || scTag(t0) !== "symbol") return null;
    const tag = scSymbol(t0);
    if (tag !== "transfer" && tag !== "mint") return null;

    let from: string | null = null;
    let rawTo: string;
    if (tag === "transfer") {
      const t1 = event.topicJson[1];
      const t2 = event.topicJson[2];
      if (t1 === undefined || t2 === undefined) return null;
      from = scAddress(t1, "sac.from");
      rawTo = scAddress(t2, "sac.to");
    } else {
      const t1 = event.topicJson[1];
      const t2 = event.topicJson[2];
      if (t1 === undefined) return null;
      if (t2 !== undefined && scTag(t2) === "address") {
        from = scAddress(t1, "sac.admin");
        rawTo = scAddress(t2, "sac.to");
      } else {
        rawTo = scAddress(t1, "sac.to");
      }
    }

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

    const parsed = parseStellarAddress(rawTo);
    let recipient: string;
    if (parsed.kind === AddressKind.MuxedAccount) {
      if (toMuxedId !== null && toMuxedId !== parsed.muxedId) return null;
      recipient = encodeStellarAddress(AddressKind.MuxedAccount, parsed.key, parsed.muxedId);
    } else if (parsed.kind === AddressKind.Account && toMuxedId !== null) {
      recipient = encodeStellarAddress(AddressKind.MuxedAccount, parsed.key, toMuxedId);
    } else {
      if (toMuxedId !== null) return null;
      recipient = encodeStellarAddress(parsed.kind, parsed.key, 0n);
    }

    return { kind: tag, from, recipient, amount };
  } catch {
    return null;
  }
}

function canonicalStrkey(strkey: string): string | null {
  try {
    const parsed = parseStellarAddress(strkey);
    const encoded = encodeStellarAddress(parsed.kind, parsed.key, parsed.muxedId);
    return encoded === strkey ? encoded : null;
  } catch {
    return null;
  }
}

function findBytesInTopics(topics: readonly Record<string, unknown>[], ordinal: number): unknown {
  let seen = 0;
  for (const item of topics) {
    if (scTag(item) === "bytes") {
      if (seen === ordinal) return item;
      seen += 1;
    }
  }
  return undefined;
}
