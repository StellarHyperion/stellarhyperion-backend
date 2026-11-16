/**
 * EVM router logs mapped onto the shared row writers.
 *
 * The SQL is in `../writers.ts` and the per-event decisions are here. The one piece of real logic
 * in this file is the claim pairing: the router emits `ClaimParked` immediately before `BridgeIn`
 * in the same transaction when a delivery cannot be paid, and `BridgeIn` carries no flag saying so.
 * Reading a `BridgeIn` on its own would record every parked delivery as delivered, which is both
 * wrong and a check constraint violation waiting for the first frozen recipient.
 */
import { ROUTE_KINDS } from "@hyperion/protocol";

import type { Queryable } from "../../db/pool.js";
import { bigintOf, boolean, maybeOne, text, timestamp } from "../../db/rows.js";
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
  requireAddress,
  requireBigint,
  requireBool,
  requireNumber,
  requireString,
  requireTokenConfig,
  secondsOrNull,
  wordOrNull,
} from "./logs.js";

export interface EvmDeploymentLease {
  readonly chainKey: string;
  readonly contract: string;
  readonly ownerId: string;
  readonly epoch: bigint;
  readonly acquiredAt: Date;
  readonly heartbeatAt: Date;
  readonly expiresAt: Date;
  readonly acquired: boolean;
}

export class EvmLeaseLostError extends Error {
  readonly chainKey: string;
  readonly contract: string;
  readonly ownerId: string;
  readonly expectedEpoch: bigint;

  constructor(chainKey: string, contract: string, ownerId: string, expectedEpoch: bigint) {
    super(
      `lost EVM watcher lease for ${chainKey} (${contract.toLowerCase()}) held by ${ownerId} at epoch ${expectedEpoch.toString()}`,
    );
    this.name = "EvmLeaseLostError";
    this.chainKey = chainKey;
    this.contract = contract.toLowerCase();
    this.ownerId = ownerId;
    this.expectedEpoch = expectedEpoch;
  }
}

export async function acquireDeploymentLease(
  db: Queryable,
  input: {
    readonly chainKey: string;
    readonly contract: string;
    readonly ownerId: string;
    readonly now: Date;
    readonly ttlMs: number;
  },
): Promise<EvmDeploymentLease | null> {
  if (!Number.isInteger(input.ttlMs) || input.ttlMs <= 0) {
    throw new Error(`EVM lease ttlMs must be a positive integer, received ${String(input.ttlMs)}`);
  }
  const normalizedContract = input.contract.toLowerCase();
  const expiresAt = new Date(input.now.getTime() + input.ttlMs);
  const { rows } = await db.query(
    `SELECT owner_id, lease_epoch, acquired_at, heartbeat_at, expires_at, acquired
       FROM acquire_evm_watcher_lease($1, $2, $3, $4, $5)`,
    [input.chainKey, normalizedContract, input.ownerId, input.now, expiresAt],
  );
  const row = maybeOne(rows, `evm watcher lease for ${input.chainKey}`);
  // Recording test doubles that do not implement the lease function return zero rows.
  if (row === null) return null;
  return {
    chainKey: input.chainKey,
    contract: normalizedContract,
    ownerId: text(row, "owner_id"),
    epoch: bigintOf(row, "lease_epoch"),
    acquiredAt: timestamp(row, "acquired_at"),
    heartbeatAt: timestamp(row, "heartbeat_at"),
    expiresAt: timestamp(row, "expires_at"),
    acquired: boolean(row, "acquired"),
  };
}

export async function verifyDeploymentLease(
  db: Queryable,
  input: {
    readonly chainKey: string;
    readonly contract: string;
    readonly ownerId: string;
    readonly expectedEpoch: bigint;
    readonly now: Date;
    readonly ttlMs: number;
  },
): Promise<void> {
  const normalizedContract = input.contract.toLowerCase();
  const expiresAt = new Date(input.now.getTime() + input.ttlMs);
  const { rowCount } = await db.query(
    `UPDATE evm_watcher_lease
        SET heartbeat_at = $4,
            expires_at = $5
      WHERE chain_key = $1
        AND contract = $2
        AND owner_id = $3
        AND lease_epoch = $6
        AND expires_at > $4`,
    [
      input.chainKey,
      normalizedContract,
      input.ownerId,
      input.now,
      expiresAt,
      input.expectedEpoch.toString(),
    ],
  );
  if (rowCount === 0) {
    throw new EvmLeaseLostError(
      input.chainKey,
      normalizedContract,
      input.ownerId,
      input.expectedEpoch,
    );
  }
}

export async function releaseDeploymentLease(
  db: Queryable,
  input: {
    readonly chainKey: string;
    readonly contract: string;
    readonly ownerId: string;
    readonly expectedEpoch?: bigint | null;
  },
): Promise<boolean> {
  const normalizedContract = input.contract.toLowerCase();
  if (input.expectedEpoch !== undefined && input.expectedEpoch !== null) {
    const { rowCount } = await db.query(
      `DELETE FROM evm_watcher_lease
        WHERE chain_key = $1
          AND contract = $2
          AND owner_id = $3
          AND lease_epoch = $4`,
      [input.chainKey, normalizedContract, input.ownerId, input.expectedEpoch.toString()],
    );
    return rowCount > 0;
  }
  const { rowCount } = await db.query(
    `DELETE FROM evm_watcher_lease
      WHERE chain_key = $1
        AND contract = $2
        AND owner_id = $3`,
    [input.chainKey, normalizedContract, input.ownerId],
  );
  return rowCount > 0;
}

export async function readDeploymentLease(
  db: Queryable,
  chainKey: string,
  contract: string,
): Promise<Omit<EvmDeploymentLease, "acquired"> | null> {
  const normalizedContract = contract.toLowerCase();
  const { rows } = await db.query(
    `SELECT owner_id, lease_epoch, acquired_at, heartbeat_at, expires_at
       FROM evm_watcher_lease
      WHERE chain_key = $1 AND contract = $2`,
    [chainKey, normalizedContract],
  );
  const row = maybeOne(rows, `evm watcher lease state for ${chainKey}`);
  if (row === null) return null;
  return {
    chainKey,
    contract: normalizedContract,
    ownerId: text(row, "owner_id"),
    epoch: bigintOf(row, "lease_epoch"),
    acquiredAt: timestamp(row, "acquired_at"),
    heartbeatAt: timestamp(row, "heartbeat_at"),
    expiresAt: timestamp(row, "expires_at"),
  };
}

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
    case "BridgeOut":
      await writeOutbound(db, at, {
        route: requireNumber(args, "route"),
        nonce: requireBigint(args, "nonce"),
        sender: requireAddress(args, "sender"),
        token: requireAddress(args, "token"),
        grossAmount: requireBigint(args, "grossAmount"),
        fee: requireBigint(args, "fee"),
        netAmount: requireBigint(args, "netAmount"),
        destinationChain: requireString(args, "destinationChain"),
        // The strkey as a string, which is what this router emits. The Soroban router emits a
        // 32 byte word for the same field and neither is converted into the other here.
        destination: requireString(args, "destinationAddress"),
        railRef: wordOrNull(args.railRef),
      });
      return { kind: "written" };

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
