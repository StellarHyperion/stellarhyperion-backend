/**
 * Soroban router events, decoded into the rows the schema wants.
 *
 * The topic list is `[Symbol("hyperion"), Symbol(tag), ...indexed fields]`, so the second topic is
 * what decides which decoder runs. Filtering happens on `contractIds` and never on topics: the
 * RPC's topic filter matches on exact segment count, and these events have two, three and four
 * topics, so a topic filter needs one entry per shape and silently drops anything that does not
 * match. Silently is the problem.
 *
 * Only the events the indexer acts on are decoded. The rest are recognised by tag and skipped, and
 * that distinction matters: an unrecognised tag is a contract newer than this build and worth
 * logging, while a recognised one nobody reads yet is not news.
 */
import { RouteKind, isRouteKind } from "@hyperion/protocol";

import {
  type ScValJson,
  ScValError,
  scAddress,
  scBigInt,
  scBool,
  scField,
  scMap,
  scString,
  scSymbol,
  scU32,
  scUnion,
} from "./scval.js";

/** The envelope the RPC wraps every event in. */
export interface RawStellarEvent {
  readonly type: string;
  readonly ledger: number;
  readonly ledgerClosedAt: string;
  readonly contractId: string;
  /** Opaque and ordered, and the thing pagination resumes from. */
  readonly id: string;
  readonly txHash: string;
  readonly operationIndex: number;
  readonly transactionIndex: number;
  /**
   * Whether the call that emitted this actually succeeded.
   *
   * Load bearing. Soroban reports events from reverted calls too, and indexing one would record a
   * transfer that never happened. Nothing downstream can tell the difference afterwards.
   */
  readonly inSuccessfulContractCall: boolean;
  readonly topicJson: readonly ScValJson[];
  readonly valueJson: ScValJson;
}

export type StellarEvent =
  | { readonly kind: "bridgeOut"; readonly data: BridgeOutEvent }
  | { readonly kind: "bridgeIn"; readonly data: BridgeInEvent }
  | { readonly kind: "claimParked"; readonly data: ClaimParkedEvent }
  | { readonly kind: "claimSettled"; readonly data: ClaimSettledEvent }
  | { readonly kind: "actionQueued"; readonly data: ActionQueuedEvent }
  | { readonly kind: "actionExecuted"; readonly data: ActionLifecycleEvent }
  | { readonly kind: "actionCancelled"; readonly data: ActionLifecycleEvent }
  | { readonly kind: "tokenRegistered"; readonly data: TokenRegisteredEvent }
  | { readonly kind: "routeConfigured"; readonly data: RouteConfiguredEvent }
  | { readonly kind: "pauseSet"; readonly data: PauseSetEvent }
  /** A tag this build knows about and has nothing to do with yet. */
  | { readonly kind: "ignored"; readonly tag: string }
  /** A tag this build has never heard of, which means the contract is ahead of it. */
  | { readonly kind: "unknown"; readonly tag: string };

export interface BridgeOutEvent {
  readonly route: RouteKind;
  readonly nonce: bigint;
  readonly sender: string;
  readonly token: string;
  readonly grossAmount: bigint;
  readonly fee: bigint;
  readonly netAmount: bigint;
  readonly destinationChain: string;
  /** A 32 byte word. On an EVM destination the twenty real bytes are at the end. */
  readonly destination: string;
  readonly createdLedger: number;
  readonly createdAt: bigint;
}

export interface BridgeInEvent {
  readonly route: RouteKind;
  readonly recipient: string;
  readonly token: string;
  readonly amount: bigint;
  readonly sourceChain: string;
  readonly sourceNonce: bigint;
  readonly delivered: boolean;
  readonly claimId: bigint;
  readonly ledger: number;
}

export interface ClaimParkedEvent {
  readonly claimId: bigint;
  readonly recipient: string;
  readonly token: string;
  readonly amount: bigint;
  readonly route: RouteKind;
  readonly sourceChain: string;
  readonly sourceNonce: bigint;
  readonly createdAt: bigint;
  readonly settled: boolean;
}

export interface ClaimSettledEvent {
  readonly claimId: bigint;
  readonly recipient: string;
  readonly token: string;
  readonly amount: bigint;
  readonly settledBy: string;
}

export interface ActionQueuedEvent {
  readonly id: bigint;
  readonly variant: string;
  readonly eta: bigint;
  readonly expiresAt: bigint;
}

export interface ActionLifecycleEvent {
  readonly id: bigint;
  readonly variant: string | null;
  readonly actor: string | null;
}

export interface TokenRegisteredEvent {
  readonly token: string;
  readonly decimals: number;
  readonly flowLimit: bigint;
  readonly enabled: boolean;
}

export interface RouteConfiguredEvent {
  readonly route: RouteKind;
  readonly enabled: boolean;
}

export interface PauseSetEvent {
  readonly by: string;
  readonly paused: boolean;
}

/** Tags this build recognises and has no row for yet. */
const IGNORED_TAGS = new Set(["config", "flow"]);

/**
 * A `RouteKind` off the wire.
 *
 * A bare `u32`, because the Rust enum carries explicit discriminants and `#[repr(u32)]`. Refused
 * rather than clamped when it is out of range: a route tag this build does not know means the
 * contract has grown a rail, and guessing which existing one it resembles would file the transfer
 * under the wrong rail forever.
 */
function readRoute(value: unknown, path: string): RouteKind {
  const tag = scU32(value, path);
  if (!isRouteKind(tag)) {
    throw new ScValError(path, `route ${String(tag)} is not a rail this build knows about`);
  }
  return tag;
}

/**
 * Decode one event, or say why not.
 *
 * Never throws for an event it does not recognise, because a contract newer than the indexer is a
 * normal operational state and should produce a log line rather than a crash loop. It does throw
 * for an event it recognises and cannot read, because that is a decoder bug and quietly skipping
 * it would lose a transfer.
 */
export function decodeStellarEvent(event: RawStellarEvent): StellarEvent {
  const tag = event.topicJson[1] === undefined ? "" : scSymbol(event.topicJson[1], "topic[1]");
  const value = scMap(event.valueJson, "value");

  switch (tag) {
    case "out":
      return { kind: "bridgeOut", data: readBridgeOut(value) };
    case "in":
      return { kind: "bridgeIn", data: readBridgeIn(value) };
    case "park":
      return { kind: "claimParked", data: readClaimParked(value) };
    case "settled":
      return { kind: "claimSettled", data: readClaimSettled(value) };
    case "queued":
      return { kind: "actionQueued", data: readActionQueued(value) };
    case "executed":
      return {
        kind: "actionExecuted",
        data: {
          id: scBigInt(scField(value, "id", "value"), "value.id"),
          variant: readActionVariant(value),
          actor: null,
        },
      };
    case "cancelled":
      return {
        kind: "actionCancelled",
        data: {
          id: scBigInt(scField(value, "id", "value"), "value.id"),
          variant: null,
          // The canceller is the third topic rather than a field, because it is indexed.
          actor:
            event.topicJson[2] === undefined ? null : scAddress(event.topicJson[2], "topic[2]"),
        },
      };
    case "token":
      return { kind: "tokenRegistered", data: readTokenRegistered(event, value) };
    case "route":
      return { kind: "routeConfigured", data: readRouteConfigured(event, value) };
    case "pause":
      return {
        kind: "pauseSet",
        data: {
          by: event.topicJson[2] === undefined ? "" : scAddress(event.topicJson[2], "topic[2]"),
          paused: scBool(scField(value, "paused", "value"), "value.paused"),
        },
      };
    default:
      return IGNORED_TAGS.has(tag) ? { kind: "ignored", tag } : { kind: "unknown", tag };
  }
}

function readBridgeOut(value: Record<string, unknown>): BridgeOutEvent {
  const record = scMap(scField(value, "transfer", "value"), "value.transfer");
  const at = (name: string): unknown => scField(record, name, "value.transfer");
  return {
    route: readRoute(at("route"), "value.transfer.route"),
    nonce: scBigInt(at("nonce"), "value.transfer.nonce"),
    sender: scAddress(at("sender"), "value.transfer.sender"),
    token: scAddress(at("token"), "value.transfer.token"),
    grossAmount: scBigInt(at("gross_amount"), "value.transfer.gross_amount"),
    fee: scBigInt(at("fee"), "value.transfer.fee"),
    netAmount: scBigInt(at("net_amount"), "value.transfer.net_amount"),
    destinationChain: scString(at("destination_chain"), "value.transfer.destination_chain"),
    destination: readDestination(record),
    createdLedger: scU32(at("created_ledger"), "value.transfer.created_ledger"),
    createdAt: scBigInt(at("created_at"), "value.transfer.created_at"),
  };
}

/**
 * The destination word, which the RPC may render as bytes or as hex depending on its version.
 *
 * Both are accepted rather than one being assumed, because this is the field that names who gets
 * the money and a decoder that throws here on a cosmetic difference takes the indexer down.
 */
function readDestination(record: Record<string, unknown>): string {
  const raw = scField(record, "destination", "value.transfer");
  const tag = Object.keys(raw as Record<string, unknown>)[0];
  if (tag === "bytes") {
    const hex = String((raw as Record<string, unknown>).bytes);
    return hex.startsWith("0x") ? hex.toLowerCase() : `0x${hex.toLowerCase()}`;
  }
  return scString(raw, "value.transfer.destination");
}

function readBridgeIn(value: Record<string, unknown>): BridgeInEvent {
  const record = scMap(scField(value, "inbound", "value"), "value.inbound");
  const at = (name: string): unknown => scField(record, name, "value.inbound");
  return {
    route: readRoute(at("route"), "value.inbound.route"),
    recipient: scAddress(at("recipient"), "value.inbound.recipient"),
    token: scAddress(at("token"), "value.inbound.token"),
    amount: scBigInt(at("amount"), "value.inbound.amount"),
    sourceChain: scString(at("source_chain"), "value.inbound.source_chain"),
    sourceNonce: scBigInt(at("source_nonce"), "value.inbound.source_nonce"),
    delivered: scBool(at("delivered"), "value.inbound.delivered"),
    claimId: scBigInt(at("claim_id"), "value.inbound.claim_id"),
    ledger: scU32(at("ledger"), "value.inbound.ledger"),
  };
  // Note what is not here: a rail message id. The Soroban router guards replay on exactly that
  // value and does not emit it, so the only key this side can offer is the hop. The schema says so
  // too, in a comment on the nullable column.
}

function readClaimParked(value: Record<string, unknown>): ClaimParkedEvent {
  const claim = scMap(scField(value, "claim", "value"), "value.claim");
  const at = (name: string): unknown => scField(claim, name, "value.claim");
  return {
    claimId: scBigInt(at("id"), "value.claim.id"),
    recipient: scAddress(at("recipient"), "value.claim.recipient"),
    token: scAddress(at("token"), "value.claim.token"),
    amount: scBigInt(at("amount"), "value.claim.amount"),
    route: readRoute(at("route"), "value.claim.route"),
    sourceChain: scString(at("source_chain"), "value.claim.source_chain"),
    sourceNonce: scBigInt(at("source_nonce"), "value.claim.source_nonce"),
    createdAt: scBigInt(at("created_at"), "value.claim.created_at"),
    settled: scBool(at("settled"), "value.claim.settled"),
  };
}

function readClaimSettled(value: Record<string, unknown>): ClaimSettledEvent {
  return {
    claimId: scBigInt(scField(value, "claim_id", "value"), "value.claim_id"),
    recipient: scAddress(scField(value, "recipient", "value"), "value.recipient"),
    token: scAddress(scField(value, "token", "value"), "value.token"),
    amount: scBigInt(scField(value, "amount", "value"), "value.amount"),
    settledBy: scAddress(scField(value, "settled_by", "value"), "value.settled_by"),
  };
}

function readActionQueued(value: Record<string, unknown>): ActionQueuedEvent {
  return {
    id: scBigInt(scField(value, "id", "value"), "value.id"),
    variant: readActionVariant(value) ?? "unknown",
    eta: scBigInt(scField(value, "eta", "value"), "value.eta"),
    expiresAt: scBigInt(scField(value, "expires_at", "value"), "value.expires_at"),
  };
}

/**
 * Which administrative change this is, by name.
 *
 * `AdminAction` has payload variants so it encodes as a vec with the variant symbol at the head.
 * Only the name is taken: the payload differs per variant and the row keeps the whole action as
 * jsonb anyway, so a reviewer reads what the chain said rather than what a decoder made of it.
 */
function readActionVariant(value: Record<string, unknown>): string | null {
  const action = value.action;
  if (action === undefined) return null;
  try {
    return scUnion(action, "value.action").variant;
  } catch {
    return null;
  }
}

function readTokenRegistered(
  event: RawStellarEvent,
  value: Record<string, unknown>,
): TokenRegisteredEvent {
  const config = scMap(scField(value, "config", "value"), "value.config");
  return {
    // The token is the third topic, because it is indexed.
    token: event.topicJson[2] === undefined ? "" : scAddress(event.topicJson[2], "topic[2]"),
    decimals: scU32(scField(config, "decimals", "value.config"), "value.config.decimals"),
    flowLimit: scBigInt(scField(config, "flow_limit", "value.config"), "value.config.flow_limit"),
    enabled: scBool(scField(config, "enabled", "value.config"), "value.config.enabled"),
  };
}

function readRouteConfigured(
  event: RawStellarEvent,
  value: Record<string, unknown>,
): RouteConfiguredEvent {
  return {
    route:
      event.topicJson[2] === undefined ? RouteKind.Cctp : readRoute(event.topicJson[2], "topic[2]"),
    enabled: scBool(scField(value, "enabled", "value"), "value.enabled"),
  };
}
