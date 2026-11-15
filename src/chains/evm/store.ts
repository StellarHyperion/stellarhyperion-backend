/**
 * EVM router logs mapped onto the shared row writers.
 *
 * The SQL is in `../writers.ts` and the per-event decisions are here. The one piece of real logic
 * in this file is the claim pairing: the router emits `ClaimParked` immediately before `BridgeIn`
 * in the same transaction when a delivery cannot be paid, and `BridgeIn` carries no flag saying so.
 * Reading a `BridgeIn` on its own would record every parked delivery as delivered, which is both
 * wrong and a check constraint violation waiting for the first frozen recipient.
 */
import {
  CHAINS,
  ROUTE_KINDS,
  encodeStellarAddress,
  isChainKey,
  isEvmChain,
  isRouteKind,
  isStellarChain,
  parseStellarAddress,
  toEvmAddress,
} from "@hyperion/protocol";
import type { Hex } from "viem";

import type { Queryable } from "../../db/pool.js";
import type { Position } from "../writers.js";
import {
  settleAction,
  settleClaim,
  writeAction,
  writeClaim,
  writeHealthSample,
  writeInbound,
  writeOutbound,
} from "../writers.js";
import {
  type DecodedLog,
  LogShapeError,
  requireAddress,
  requireBigint,
  requireBool,
  requireNumber,
  requireString,
  requireTokenConfig,
  secondsOrNull,
  wordOrNull,
} from "./logs.js";

/** How a log was applied, so the watcher can count and report rather than guess. */
export type Applied =
  | { readonly kind: "written" }
  /** A known event with nothing to record, like a role grant. */
  | { readonly kind: "ignored" }
  /** A settlement for a row this indexer never saw created. */
  | { readonly kind: "unmatched"; readonly what: string };

/**
 * Claims parked earlier in the same transaction, keyed by the hop they belong to.
 *
 * Scoped to one pass, which is safe because `getLogs` ranges are block aligned: a transaction is
 * never split across two passes, so the pair is always in the same batch as each other.
 */
export class ClaimPairing {
  private readonly parked = new Map<string, bigint>();

  static key(txHash: string, route: number, sourceChain: string, sourceNonce: bigint): string {
    return `${txHash}|${String(route)}|${sourceChain}|${sourceNonce.toString()}`;
  }

  note(key: string, claimId: bigint): void {
    this.parked.set(key, claimId);
  }

  claimFor(key: string): bigint | null {
    return this.parked.get(key) ?? null;
  }
}

export async function applyRouterLog(
  db: Queryable,
  at: Position,
  log: DecodedLog,
  pairing: ClaimPairing,
): Promise<Applied> {
  const args = log.args;

  switch (log.name) {
    case "BridgeOut": {
      const route = requireNumber(args, "route");
      if (!isRouteKind(route)) {
        throw new LogShapeError("route", `is not a supported RouteKind (${String(route)})`);
      }
      const nonce = requireBigint(args, "nonce");
      if (nonce < 0n) {
        throw new LogShapeError("nonce", "cannot be negative");
      }
      const sender = requireCanonicalEvmAddress(args, "sender");
      const token = requireCanonicalEvmAddress(args, "token");
      const grossAmount = requireBigint(args, "grossAmount");
      const fee = requireBigint(args, "fee");
      const netAmount = requireBigint(args, "netAmount");
      if (grossAmount <= 0n || fee < 0n || netAmount <= 0n || grossAmount !== fee + netAmount) {
        throw new LogShapeError(
          "grossAmount",
          `must be positive and equal fee + netAmount (gross=${grossAmount.toString()}, fee=${fee.toString()}, net=${netAmount.toString()})`,
        );
      }
      const destinationChain = requireString(args, "destinationChain");
      if (destinationChain.trim() === "") {
        throw new LogShapeError("destinationChain", "cannot be empty");
      }
      const rawDestination = requireString(args, "destinationAddress");
      const destination = preserveDestinationIdentity(destinationChain, rawDestination);

      await writeOutbound(db, at, {
        route,
        nonce,
        sender,
        token,
        grossAmount,
        fee,
        netAmount,
        destinationChain,
        // The strkey as a string, which is what this router emits. The Soroban router emits a
        // 32 byte word for the same field and neither is converted into the other here.
        destination,
        railRef: wordOrNull(args.railRef),
      });
      return { kind: "written" };
    }

    case "ClaimParked": {
      const route = requireNumber(args, "route");
      const sourceChain = requireString(args, "sourceChain");
      const sourceNonce = requireBigint(args, "sourceNonce");
      const claimId = requireBigint(args, "id");
      await writeClaim(db, at, {
        claimId,
        recipient: requireAddress(args, "recipient"),
        token: requireAddress(args, "token"),
        amount: requireBigint(args, "amount"),
        route,
        sourceChain,
        sourceNonce,
        // The contract sets createdAt to block.timestamp, so this is the same number the chain
        // stored rather than an approximation of it.
        createdAt: at.observedAt,
      });
      pairing.note(ClaimPairing.key(at.txHash, route, sourceChain, sourceNonce), claimId);
      return { kind: "written" };
    }

    case "BridgeIn": {
      const route = requireNumber(args, "route");
      const sourceChain = requireString(args, "sourceChain");
      const sourceNonce = requireBigint(args, "sourceNonce");
      // A claim parked in this same transaction means the delivery did not land. Nothing in the
      // BridgeIn log itself says so.
      const claimId = pairing.claimFor(
        ClaimPairing.key(at.txHash, route, sourceChain, sourceNonce),
      );
      await writeInbound(db, at, {
        route,
        sourceChain,
        sourceNonce,
        railMessageId: wordOrNull(args.messageId),
        recipient: requireAddress(args, "recipient"),
        token: requireAddress(args, "token"),
        amount: requireBigint(args, "amount"),
        delivered: claimId === null,
        claimId,
      });
      return { kind: "written" };
    }

    case "ClaimSettled": {
      const claimId = requireBigint(args, "id");
      const matched = await settleClaim(db, at, claimId, requireAddress(args, "settledBy"));
      return matched
        ? { kind: "written" }
        : { kind: "unmatched", what: `claim ${String(claimId)}` };
    }

    case "ActionQueued":
      await writeAction(db, at, {
        actionId: requireBigint(args, "id"),
        // A real discriminant, unlike the Soroban side. The enum is indexed on the topic, so this
        // column means something on an EVM row and is always zero on a Stellar one.
        kind: requireNumber(args, "kind"),
        payload: { kind: requireNumber(args, "kind") },
        eta: secondsOrNull(args.eta),
        expiresAt: secondsOrNull(args.expiresAt),
      });
      return { kind: "written" };

    case "ActionExecuted": {
      const id = requireBigint(args, "id");
      // No actor on this event. The router emits the kind instead, which is already on the row.
      const matched = await settleAction(db, at, id, "executed", null);
      return matched
        ? { kind: "written" }
        : { kind: "unmatched", what: `action ${String(id)} executed` };
    }

    case "ActionCancelled": {
      const id = requireBigint(args, "id");
      const matched = await settleAction(db, at, id, "cancelled", requireAddress(args, "by"));
      return matched
        ? { kind: "written" }
        : { kind: "unmatched", what: `action ${String(id)} cancelled` };
    }

    case "TokenRegistered": {
      const config = requireTokenConfig(args);
      await writeHealthSample(db, at, {
        originChain: at.chainKey,
        destinationChain: at.chainKey,
        route: 0,
        token: requireAddress(args, "token"),
        available: config.enabled,
        blocker: 0,
        flowAvailable: config.flowLimit,
      });
      return { kind: "written" };
    }

    case "FlowLimitLowered":
      // Worth a sample rather than ignoring: a lowered limit is one of the two reasons a quote
      // that worked an hour ago stops working, and the other one already lands in this table.
      await writeHealthSample(db, at, {
        originChain: at.chainKey,
        destinationChain: at.chainKey,
        route: 0,
        token: requireAddress(args, "token"),
        available: true,
        blocker: 0,
        flowAvailable: requireBigint(args, "limit"),
      });
      return { kind: "written" };

    case "RouteConfigured": {
      const enabled = requireBool(args, "enabled");
      await writeHealthSample(db, at, {
        originChain: at.chainKey,
        destinationChain: at.chainKey,
        route: requireNumber(args, "route"),
        // This event names no token, so the sample is attributed to the chain itself. A route
        // being on or off is a property of the router rather than of one asset.
        token: at.chainKey,
        available: enabled,
        // QuoteBlocker.RouteDisabled is 2. Zero when the route is on.
        blocker: enabled ? 0 : 2,
        flowAvailable: null,
      });
      return { kind: "written" };
    }

    case "Paused":
    case "Unpaused": {
      // Two events here where Soroban has one carrying a bool. Recorded the same way on both
      // sides: a pause is the one operational state somebody needs to see in the same place they
      // are already looking at route health, rather than in a log they have to go and find.
      const paused = log.name === "Paused";
      for (const route of ROUTE_KINDS) {
        await writeHealthSample(db, at, {
          originChain: at.chainKey,
          destinationChain: at.chainKey,
          route,
          token: at.chainKey,
          available: !paused,
          // QuoteBlocker.Paused is 1, and zero when nothing is blocking.
          blocker: paused ? 1 : 0,
          flowAvailable: null,
        });
      }
      return { kind: "written" };
    }

    // Known, and nothing here reads them yet. Named individually rather than caught by a default,
    // so a new event arrives as an unknown signature and gets reported instead of being silently
    // swept in with these.
    case "AdapterSet":
    case "RailReceiverSet":
    case "ConfigChanged":
    case "RoleGranted":
    case "RoleRevoked":
    case "RoleAdminChanged":
      return { kind: "ignored" };

    default:
      return { kind: "ignored" };
  }
}

function requireCanonicalEvmAddress(args: Record<string, unknown>, name: string): string {
  const addr = requireAddress(args, name);
  if (!/^0x[0-9a-f]{40}$/.test(addr) || /^0x0{40}$/.test(addr)) {
    throw new LogShapeError(name, `is not a valid non-zero EVM address (${addr})`);
  }
  return addr;
}

/**
 * Validate and preserve chain-specific recipient identity without collapsing muxed Stellar strkeys
 * or rewriting cross-family encodings.
 */
function preserveDestinationIdentity(destinationChain: string, rawDestination: string): string {
  if (rawDestination === "") {
    throw new LogShapeError("destinationAddress", "cannot be empty");
  }
  if (!isChainKey(destinationChain)) {
    return rawDestination;
  }
  const chain = CHAINS[destinationChain];
  if (isStellarChain(chain)) {
    try {
      const parsed = parseStellarAddress(rawDestination);
      const canonical = encodeStellarAddress(parsed.kind, parsed.key, parsed.muxedId);
      if (canonical !== rawDestination) {
        throw new LogShapeError(
          "destinationAddress",
          `is not canonical SEP-23 strkey encoding (${rawDestination})`,
        );
      }
      return canonical;
    } catch (error) {
      if (error instanceof LogShapeError) throw error;
      throw new LogShapeError(
        "destinationAddress",
        `is not a valid Stellar strkey for ${destinationChain}: ${rawDestination}`,
      );
    }
  }
  if (isEvmChain(chain)) {
    if (/^0x[0-9a-fA-F]{40}$/.test(rawDestination)) {
      const lower = rawDestination.toLowerCase();
      if (/^0x0{40}$/.test(lower)) {
        throw new LogShapeError("destinationAddress", "cannot be the zero EVM address");
      }
      return lower;
    }
    if (/^0x[0-9a-fA-F]{64}$/.test(rawDestination)) {
      try {
        const addr = toEvmAddress(rawDestination as Hex);
        if (/^0x0{40}$/.test(addr.toLowerCase())) {
          throw new LogShapeError("destinationAddress", "cannot be the zero EVM address");
        }
        return rawDestination.toLowerCase();
      } catch (error) {
        if (error instanceof LogShapeError) throw error;
        throw new LogShapeError(
          "destinationAddress",
          `is not a valid padded EVM address word for ${destinationChain}: ${rawDestination}`,
        );
      }
    }
    throw new LogShapeError(
      "destinationAddress",
      `is not a valid EVM destination for ${destinationChain}: ${rawDestination}`,
    );
  }
  return rawDestination;
}
