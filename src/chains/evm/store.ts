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
import type { RawEvmLog } from "./client.js";
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

export const EVM_LOG_QUARANTINE_LIMIT = 10_000;

/** Save a log that cannot be decoded without pretending it was a transfer. */
export async function quarantineEvmLog(
  db: Queryable,
  at: Position,
  log: RawEvmLog,
  signature: string,
  reason: string,
  limit = EVM_LOG_QUARANTINE_LIMIT,
): Promise<void> {
  await db.query(
    `INSERT INTO evm_log_quarantine
       (chain_key, contract, block_number, transaction_hash, log_index, signature, data, topics, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     ON CONFLICT (chain_key, block_number, transaction_hash, log_index) DO UPDATE
       SET signature = EXCLUDED.signature,
           data = EXCLUDED.data,
           topics = EXCLUDED.topics,
           reason = EXCLUDED.reason,
           last_seen_at = now()`,
    [
      at.chainKey,
      log.address,
      log.blockNumber.toString(),
      log.transactionHash,
      log.logIndex,
      signature,
      log.data,
      JSON.stringify(log.topics),
      reason,
    ],
  );
  // Keep the newest evidence for this chain only. The limit is deliberately enforced in the same
  // transaction as the cursor, so an outage cannot turn an unknown event flood into unbounded DB
  // growth.
  await db.query(
    `DELETE FROM evm_log_quarantine
      WHERE chain_key = $1
        AND id NOT IN (
          SELECT id FROM evm_log_quarantine
           WHERE chain_key = $1
           ORDER BY block_number DESC, log_index DESC, id DESC
           LIMIT $2
        )`,
    [at.chainKey, limit],
  );
}

export interface QuarantinedEvmLog {
  readonly chainKey: string;
  readonly contract: string;
  readonly blockNumber: bigint;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly signature: string;
  readonly data: `0x${string}`;
  readonly topics: [] | [`0x${string}`, ...`0x${string}`[]];
  readonly reason: string;
}

/** Read a bounded batch of raw logs for replay after the router decoder is upgraded. */
export async function readQuarantinedEvmLogs(
  db: Queryable,
  chainKey: string,
  limit = 100,
): Promise<readonly QuarantinedEvmLog[]> {
  const { rows } = await db.query(
    `SELECT chain_key, contract, block_number, transaction_hash, log_index, signature, data, topics, reason
       FROM evm_log_quarantine
      WHERE chain_key = $1
      ORDER BY block_number, log_index
      LIMIT $2`,
    [chainKey, limit],
  );
  return rows.map((row) => ({
    chainKey: String(row.chain_key),
    contract: String(row.contract),
    blockNumber: BigInt(String(row.block_number)),
    transactionHash: String(row.transaction_hash),
    logIndex: Number(row.log_index),
    signature: String(row.signature),
    data: String(row.data) as `0x${string}`,
    topics: row.topics as [] | [`0x${string}`, ...`0x${string}`[]],
    reason: String(row.reason),
  }));
}

/** Replay raw quarantined logs through a newly deployed decoder without deleting the evidence. */
export async function replayQuarantinedEvmLogs(
  db: Queryable,
  chainKey: string,
  replay: (log: RawEvmLog) => Promise<void>,
  limit = 100,
): Promise<number> {
  const logs = await readQuarantinedEvmLogs(db, chainKey, limit);
  for (const log of logs) {
    await replay({
      address: log.contract as `0x${string}`,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash as `0x${string}`,
      logIndex: log.logIndex,
      data: log.data,
      topics: log.topics,
      removed: false,
    });
  }
  return logs.length;
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
