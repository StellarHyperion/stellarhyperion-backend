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

import type { Queryable, Transactional } from "../../db/pool.js";
import {
  bigintOf,
  bigintOrNull,
  integer,
  text,
  textOrNull,
  timestamp,
  timestampOrNull,
} from "../../db/rows.js";
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

export interface EvmBlockAnchor {
  readonly chainKey: string;
  readonly contract: string;
  readonly blockNumber: bigint;
  readonly blockHash: string;
}

export interface EvmReorgRecovery {
  readonly id: bigint;
  readonly chainKey: string;
  readonly contract: string;
  readonly status: "open" | "resolved";
  readonly detectedAtBlock: bigint;
  readonly configuredReorgDepth: number;
  readonly recoveryFromBlock: bigint;
  readonly recoveryToBlock: bigint;
  readonly safeAnchorBlock: bigint | null;
  readonly safeAnchorHash: string | null;
  readonly mismatchedBlock: bigint;
  readonly expectedHash: string;
  readonly actualHash: string | null;
  readonly affectedDeliveries: number;
  readonly affectedTransfers: number;
  readonly detectedAt: Date;
  readonly resolvedAt: Date | null;
  readonly resolutionNote: string | null;
}

export async function readBlockAnchors(
  db: Queryable,
  chainKey: string,
  contract: string,
  limit: number,
): Promise<readonly EvmBlockAnchor[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`anchor limit must be a positive integer, got ${String(limit)}`);
  }
  const { rows } = await db.query(
    `SELECT chain_key, contract, block_number, block_hash
       FROM evm_block_anchor
      WHERE chain_key = $1
        AND lower(contract) = lower($2)
      ORDER BY block_number DESC
      LIMIT $3`,
    [chainKey, contract, limit],
  );
  return rows
    .map((row) => ({
      chainKey: text(row, "chain_key"),
      contract: text(row, "contract"),
      blockNumber: bigintOf(row, "block_number"),
      blockHash: text(row, "block_hash"),
    }))
    .reverse();
}

export async function writeBlockAnchors(
  db: Queryable,
  anchors: readonly EvmBlockAnchor[],
): Promise<void> {
  if (anchors.length === 0) return;

  const params: unknown[] = [];
  const tuples: string[] = [];
  for (const anchor of anchors) {
    const base = params.length;
    params.push(
      anchor.chainKey,
      anchor.contract.toLowerCase(),
      anchor.blockNumber.toString(),
      anchor.blockHash,
    );
    tuples.push(
      `($${String(base + 1)}, $${String(base + 2)}, $${String(base + 3)}, $${String(base + 4)}, now())`,
    );
  }

  await db.query(
    `INSERT INTO evm_block_anchor
       (chain_key, contract, block_number, block_hash, recorded_at)
     VALUES ${tuples.join(", ")}
     ON CONFLICT (chain_key, contract, block_number) DO UPDATE SET
       block_hash = EXCLUDED.block_hash,
       recorded_at = now()`,
    params,
  );
}

export async function pruneBlockAnchors(
  db: Queryable,
  chainKey: string,
  contract: string,
  minRetainedBlock: bigint,
): Promise<void> {
  await db.query(
    `DELETE FROM evm_block_anchor
      WHERE chain_key = $1
        AND lower(contract) = lower($2)
        AND block_number < $3`,
    [chainKey, contract, minRetainedBlock.toString()],
  );
}

export async function deleteBlockAnchorsAbove(
  db: Queryable,
  chainKey: string,
  contract: string,
  maxCanonicalBlock: bigint,
): Promise<void> {
  await db.query(
    `DELETE FROM evm_block_anchor
      WHERE chain_key = $1
        AND lower(contract) = lower($2)
        AND block_number > $3`,
    [chainKey, contract, maxCanonicalBlock.toString()],
  );
}

function parseRecoveryRow(row: Record<string, unknown>): EvmReorgRecovery {
  const statusRaw = text(row, "status");
  if (statusRaw !== "open" && statusRaw !== "resolved") {
    throw new Error(`unexpected recovery status: ${statusRaw}`);
  }
  return {
    id: bigintOf(row, "id"),
    chainKey: text(row, "chain_key"),
    contract: text(row, "contract"),
    status: statusRaw,
    detectedAtBlock: bigintOf(row, "detected_at_block"),
    configuredReorgDepth: integer(row, "configured_reorg_depth"),
    recoveryFromBlock: bigintOf(row, "recovery_from_block"),
    recoveryToBlock: bigintOf(row, "recovery_to_block"),
    safeAnchorBlock: bigintOrNull(row, "safe_anchor_block"),
    safeAnchorHash: textOrNull(row, "safe_anchor_hash"),
    mismatchedBlock: bigintOf(row, "mismatched_block"),
    expectedHash: text(row, "expected_hash"),
    actualHash: textOrNull(row, "actual_hash"),
    affectedDeliveries: integer(row, "affected_deliveries"),
    affectedTransfers: integer(row, "affected_transfers"),
    detectedAt: timestamp(row, "detected_at"),
    resolvedAt: timestampOrNull(row, "resolved_at"),
    resolutionNote: textOrNull(row, "resolution_note"),
  };
}

export async function readOpenReorgRecovery(
  db: Queryable,
  chainKey: string,
  contract: string,
): Promise<EvmReorgRecovery | null> {
  const { rows } = await db.query(
    `SELECT id, chain_key, contract, status, detected_at_block, configured_reorg_depth,
            recovery_from_block, recovery_to_block, safe_anchor_block, safe_anchor_hash,
            mismatched_block, expected_hash, actual_hash, affected_deliveries, affected_transfers,
            detected_at, resolved_at, resolution_note
       FROM evm_reorg_recovery
      WHERE chain_key = $1
        AND lower(contract) = lower($2)
        AND status = 'open'
      LIMIT 1`,
    [chainKey, contract],
  );
  const first = rows[0];
  return first === undefined ? null : parseRecoveryRow(first);
}

export interface EnterDeepReorgRecoveryInput {
  readonly chainKey: string;
  readonly contract: string;
  readonly detectedAtBlock: bigint;
  readonly configuredReorgDepth: number;
  readonly recoveryFromBlock: bigint;
  readonly recoveryToBlock: bigint;
  readonly safeAnchorBlock: bigint | null;
  readonly safeAnchorHash: string | null;
  readonly mismatchedBlock: bigint;
  readonly expectedHash: string;
  readonly actualHash: string | null;
}

/**
 * Atomically mark materialized transfers and deliveries in the bounded suspect interval as
 * non-canonical and open an operator-visible deep-reorg recovery record.
 */
export async function enterDeepReorgRecovery(
  db: Transactional,
  input: EnterDeepReorgRecoveryInput,
): Promise<EvmReorgRecovery> {
  return db.transaction(async (tx: Queryable) => {
    const existing = await readOpenReorgRecovery(tx, input.chainKey, input.contract);
    if (existing !== null) return existing;

    const deliveryUpdate = await tx.query(
      `UPDATE inbound_delivery
          SET canonical = false
        WHERE destination_chain = $1
          AND destination_block >= $2
          AND destination_block <= $3
          AND canonical = true`,
      [input.chainKey, input.recoveryFromBlock.toString(), input.recoveryToBlock.toString()],
    );

    const transferUpdate = await tx.query(
      `UPDATE outbound_transfer
          SET canonical = false
        WHERE origin_chain = $1
          AND origin_block >= $2
          AND origin_block <= $3
          AND canonical = true`,
      [input.chainKey, input.recoveryFromBlock.toString(), input.recoveryToBlock.toString()],
    );

    // Ensure rail attestations paired with demoted destination deliveries cannot remain marked delivered.
    await tx.query(
      `UPDATE rail_attestation a
          SET status = CASE WHEN a.attested_at IS NOT NULL THEN 'attested' ELSE 'pending' END,
              updated_at = now()
         FROM outbound_transfer t
         JOIN inbound_delivery d
           ON d.destination_chain = t.destination_chain
          AND d.route = t.route
          AND d.source_chain = t.origin_chain
          AND d.source_nonce = t.nonce
        WHERE a.transfer_id = t.id
          AND d.destination_chain = $1
          AND d.destination_block >= $2
          AND d.destination_block <= $3
          AND d.canonical = false
          AND a.status = 'delivered'`,
      [input.chainKey, input.recoveryFromBlock.toString(), input.recoveryToBlock.toString()],
    );

    const { rows } = await tx.query(
      `INSERT INTO evm_reorg_recovery
         (chain_key, contract, status, detected_at_block, configured_reorg_depth,
          recovery_from_block, recovery_to_block, safe_anchor_block, safe_anchor_hash,
          mismatched_block, expected_hash, actual_hash, affected_deliveries, affected_transfers)
       VALUES ($1, $2, 'open', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id, chain_key, contract, status, detected_at_block, configured_reorg_depth,
                 recovery_from_block, recovery_to_block, safe_anchor_block, safe_anchor_hash,
                 mismatched_block, expected_hash, actual_hash, affected_deliveries, affected_transfers,
                 detected_at, resolved_at, resolution_note`,
      [
        input.chainKey,
        input.contract.toLowerCase(),
        input.detectedAtBlock.toString(),
        input.configuredReorgDepth,
        input.recoveryFromBlock.toString(),
        input.recoveryToBlock.toString(),
        input.safeAnchorBlock === null ? null : input.safeAnchorBlock.toString(),
        input.safeAnchorHash,
        input.mismatchedBlock.toString(),
        input.expectedHash,
        input.actualHash,
        deliveryUpdate.rowCount,
        transferUpdate.rowCount,
      ],
    );
    const created = rows[0];
    if (created === undefined) {
      throw new Error("failed to create deep reorg recovery record");
    }
    return parseRecoveryRow(created);
  });
}

export interface ResolveReorgRecoveryInput {
  readonly chainKey: string;
  readonly contract: string;
  readonly startBlock: bigint;
  readonly note: string;
}

/**
 * Resolve an open deep-reorg recovery after operator review, rewinding the watcher cursor to the
 * verified safe anchor (or clearing it to restart from `startBlock` when no safe anchor remained).
 */
export async function resolveReorgRecovery(
  db: Transactional,
  input: ResolveReorgRecoveryInput,
): Promise<EvmReorgRecovery> {
  return db.transaction(async (tx: Queryable) => {
    const open = await readOpenReorgRecovery(tx, input.chainKey, input.contract);
    if (open === null) {
      throw new Error(
        `no open deep reorg recovery exists for ${input.chainKey} (${input.contract})`,
      );
    }

    if (open.safeAnchorBlock !== null && open.safeAnchorBlock >= input.startBlock) {
      await tx.query(
        `UPDATE indexer_cursor
            SET last_processed = $3,
                last_processed_hash = $4,
                updated_at = now()
          WHERE chain_key = $1
            AND lower(contract) = lower($2)`,
        [input.chainKey, input.contract, open.safeAnchorBlock.toString(), open.safeAnchorHash],
      );
      await deleteBlockAnchorsAbove(tx, input.chainKey, input.contract, open.safeAnchorBlock);
    } else {
      await tx.query(
        `DELETE FROM indexer_cursor
          WHERE chain_key = $1
            AND lower(contract) = lower($2)`,
        [input.chainKey, input.contract],
      );
      await tx.query(
        `DELETE FROM evm_block_anchor
          WHERE chain_key = $1
            AND lower(contract) = lower($2)`,
        [input.chainKey, input.contract],
      );
    }

    const { rows } = await tx.query(
      `UPDATE evm_reorg_recovery
          SET status = 'resolved',
              resolved_at = now(),
              resolution_note = $2
        WHERE id = $1
      RETURNING id, chain_key, contract, status, detected_at_block, configured_reorg_depth,
                recovery_from_block, recovery_to_block, safe_anchor_block, safe_anchor_hash,
                mismatched_block, expected_hash, actual_hash, affected_deliveries, affected_transfers,
                detected_at, resolved_at, resolution_note`,
      [open.id.toString(), input.note],
    );
    const updated = rows[0];
    if (updated === undefined) {
      throw new Error(`failed to mark recovery ${open.id.toString()} as resolved`);
    }
    return parseRecoveryRow(updated);
  });
}
