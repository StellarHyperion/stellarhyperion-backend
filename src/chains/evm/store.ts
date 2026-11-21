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
import type { Hex } from "viem";
import { bigintOf, boolean, integer, text, textOrNull, timestamp } from "../../db/rows.js";
import type { Position } from "../writers.js";
import {
  acquireLease,
  assertLeaseHeld,
  LeaseLostError,
  releaseLease,
  settleAction,
  settleClaim,
  writeAction,
  writeClaim,
  writeHealthSample,
  writeInbound,
  writeOutbound,
  type WatcherLease,
} from "../writers.js";

export { acquireLease, assertLeaseHeld, LeaseLostError, releaseLease, type WatcherLease };
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

/**
 * Remove materialized state produced at or after an EVM reorg rewind point.
 *
 * This runs in the same transaction as the replacement range and keys cleanup through source
 * provenance. A replacement log can reuse the old position with a different payload, so leaving
 * the old source event in place would turn it into a provenance conflict. Settlements are reversed
 * when their creating event remains canonical; records whose creating event was orphaned are
 * deleted and let their foreign keys remove dependent evidence.
 */
export async function rewindEvmEvents(
  db: Queryable,
  chainKey: string,
  contract: string,
  fromBlock: bigint,
): Promise<void> {
  const source = await db.query(
    `SELECT id FROM source_event
      WHERE chain_key = $1 AND family = 'evm' AND lower(contract) = lower($2)
        AND block_number >= $3`,
    [chainKey, contract, fromBlock.toString()],
  );
  const sourceIds = source.rows.map((row) => String(row.id));

  if (sourceIds.length > 0) {
    const links = await db.query(
      `SELECT record_kind, record_key, role FROM source_event_link
        WHERE source_event_id = ANY($1::bigint[])`,
      [sourceIds],
    );
    const created = new Map<string, Set<string>>();
    const settled = new Map<string, Set<string>>();
    for (const row of links.rows) {
      const target = row.role === "settled" ? settled : created;
      const keys = target.get(String(row.record_kind)) ?? new Set<string>();
      keys.add(String(row.record_key));
      target.set(String(row.record_kind), keys);
    }

    const createdInbound = [...(created.get("inbound_delivery") ?? [])];
    if (createdInbound.length > 0)
      await db.query(`DELETE FROM inbound_delivery WHERE id = ANY($1::bigint[])`, [
        createdInbound,
      ]);
    const createdClaims = [...(created.get("pending_claim") ?? [])];
    if (createdClaims.length > 0)
      await db.query(
        `DELETE FROM pending_claim WHERE (chain, claim_id) IN (
           SELECT split_part(value, ':', 1), split_part(value, ':', 2)::numeric
             FROM unnest($1::text[]) AS value)`,
        [createdClaims],
      );
    const createdActions = [...(created.get("admin_action") ?? [])];
    if (createdActions.length > 0)
      await db.query(
        `DELETE FROM admin_action WHERE (chain, action_id) IN (
           SELECT split_part(value, ':', 1), split_part(value, ':', 2)::numeric
             FROM unnest($1::text[]) AS value)`,
        [createdActions],
      );
    const createdOutbound = [...(created.get("outbound_transfer") ?? [])];
    if (createdOutbound.length > 0)
      await db.query(`DELETE FROM outbound_transfer WHERE id = ANY($1::bigint[])`, [
        createdOutbound,
      ]);

    const settledClaims = [...(settled.get("pending_claim") ?? [])].filter(
      (key) => !createdClaims.includes(key),
    );
    if (settledClaims.length > 0)
      await db.query(
        `UPDATE pending_claim
            SET settled = false, settled_at = NULL, settled_by = NULL, settled_tx = NULL
          WHERE (chain, claim_id) IN (
            SELECT split_part(value, ':', 1), split_part(value, ':', 2)::numeric
              FROM unnest($1::text[]) AS value)`,
        [settledClaims],
      );
    const settledActions = [...(settled.get("admin_action") ?? [])].filter(
      (key) => !createdActions.includes(key),
    );
    if (settledActions.length > 0)
      await db.query(
        `UPDATE admin_action
            SET state = 'queued', settled_at = NULL, actor = NULL
          WHERE (chain, action_id) IN (
            SELECT split_part(value, ':', 1), split_part(value, ':', 2)::numeric
              FROM unnest($1::text[]) AS value)`,
        [settledActions],
      );

    await db.query(
      `DELETE FROM source_event_link WHERE source_event_id = ANY($1::bigint[])`,
      [sourceIds],
    );
  }

  await db.query(
    `DELETE FROM source_event_conflict WHERE source_event_id IN (
       SELECT id FROM source_event
        WHERE chain_key = $1 AND family = 'evm' AND lower(contract) = lower($2)
          AND block_number >= $3)`,
    [chainKey, contract, fromBlock.toString()],
  );
  await db.query(
    `DELETE FROM source_event
      WHERE chain_key = $1 AND family = 'evm' AND lower(contract) = lower($2)
        AND block_number >= $3`,
    [chainKey, contract, fromBlock.toString()],
  );
  await db.query(
    `DELETE FROM evm_applied_event
      WHERE chain_key = $1 AND lower(contract) = lower($2) AND block_number >= $3`,
    [chainKey, contract, fromBlock.toString()],
  );
  await db.query(
    `DELETE FROM ingestion_rejection
      WHERE chain_key = $1 AND family = 'evm' AND lower(contract) = lower($2)
        AND block_number >= $3`,
    [chainKey, contract, fromBlock.toString()],
  );
  await db.query(
    `DELETE FROM evm_log_quarantine
      WHERE chain_key = $1 AND block_number >= $2`,
    [chainKey, fromBlock.toString()],
  );
}

/** How a log was applied, so the watcher can count and report rather than guess. */
export type Applied =
  | { readonly kind: "written" }
  /** A known event with nothing to record, like a role grant. */
  | { readonly kind: "ignored" }
  /** A settlement for a row this indexer never saw created. */
  | { readonly kind: "unmatched"; readonly what: string };

export interface EvmLogQuarantine {
  readonly chainKey: string;
  readonly block: bigint;
  readonly txHash: string;
  readonly logIndex: number;
  readonly eventName: string;
  readonly reason: string;
  readonly raw?: RawEvmLog;
  readonly blockHash?: Hex;
}

/** Keep malformed ranges visible without allowing one bad provider response to fill the database. */
export async function quarantineEvmLog(
  db: Queryable,
  entry: EvmLogQuarantine,
  observedAt: Date,
): Promise<void> {
  const raw = entry.raw;
  const validTopics =
    raw !== undefined &&
    raw.topics.length <= 4 &&
    raw.topics.every((topic) => /^0x[0-9a-fA-F]{64}$/.test(topic));
  const bounded =
    raw !== undefined &&
    validTopics &&
    raw.data.length <= 131074 &&
    /^0x([0-9a-fA-F]{2})*$/.test(raw.data);
  // Serialize retention with insertion so concurrent replicas keep the same database bound.
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    "evm-quarantine:" + entry.chainKey,
  ]);
  await db.query(
    `INSERT INTO evm_log_quarantine
       (chain_key, block_number, transaction_hash, log_index, event_name, reason, observed_at,contract,block_hash,signature,data,topics)
     VALUES ($1, $2, $3, $4, $5, $6, $7,$8,$9,$10,$11,$12::jsonb)
     ON CONFLICT (chain_key, block_number, transaction_hash, log_index, reason) DO UPDATE SET
       contract=coalesce(evm_log_quarantine.contract,excluded.contract),
       block_hash=coalesce(evm_log_quarantine.block_hash,excluded.block_hash),
       signature=coalesce(evm_log_quarantine.signature,excluded.signature),
       data=coalesce(evm_log_quarantine.data,excluded.data),
       topics=coalesce(evm_log_quarantine.topics,excluded.topics)`,
    [
      entry.chainKey,
      entry.block.toString(),
      entry.txHash,
      entry.logIndex,
      entry.eventName,
      entry.reason,
      observedAt,
      raw?.address ?? null,
      entry.blockHash ?? null,
      validTopics ? (raw.topics[0] ?? null) : null,
      bounded ? raw.data : null,
      validTopics ? JSON.stringify(raw.topics) : null,
    ],
  );
  await db.query(
    `DELETE FROM evm_log_quarantine
      WHERE chain_key = $1 AND (block_number, transaction_hash, log_index, reason) IN (
        SELECT block_number, transaction_hash, log_index, reason FROM evm_log_quarantine
         WHERE chain_key = $1
         ORDER BY block_number DESC, transaction_hash, log_index, reason OFFSET 1000
      )`,
    [entry.chainKey],
  );
}

export interface QuarantinedEvmLog {
  readonly log: RawEvmLog;
  readonly blockHash: Hex;
}

/** Replay reads are bounded and scoped to the configured chain AND router deployment. */
export async function readQuarantinedEvmLogs(
  db: Queryable,
  chainKey: string,
  contract: Hex,
  limit = 100,
): Promise<readonly QuarantinedEvmLog[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError("Quarantine replay limit must be 1 to 100.");
  const result = await db.query(
    `SELECT DISTINCT ON(block_number,transaction_hash,log_index)
    block_number::text,transaction_hash,log_index,contract,block_hash,data,topics
    FROM evm_log_quarantine WHERE chain_key=$1 AND lower(contract)=lower($2) AND data IS NOT NULL AND topics IS NOT NULL AND block_hash IS NOT NULL
    ORDER BY block_number,transaction_hash,log_index,reason LIMIT $3`,
    [chainKey, contract, limit],
  );
  return result.rows.map((row) => {
    const topics = row.topics;
    if (
      !Array.isArray(topics) ||
      topics.length > 4 ||
      !topics.every(
        (topic: unknown) => typeof topic === "string" && /^0x[0-9a-fA-F]{64}$/.test(topic),
      )
    )
      throw new Error("Invalid quarantined event topics.");
    return {
      blockHash: text(row, "block_hash") as Hex,
      log: {
        address: text(row, "contract") as Hex,
        blockNumber: bigintOf(row, "block_number"),
        transactionHash: text(row, "transaction_hash") as Hex,
        logIndex: integer(row, "log_index"),
        data: text(row, "data") as Hex,
        topics: topics as [] | [Hex, ...Hex[]],
        removed: false,
      },
    };
  });
}

/**
 * Claims parked earlier in the same transaction, keyed by the hop they belong to.
 *
 * Scoped to one pass, which is safe because `getLogs` ranges are block aligned: a transaction is
 * never split across two passes, so the pair is always in the same batch as each other.
 */
export class ClaimPairing {
  private readonly parked = new Map<string, bigint>();

  static key(
    block: bigint,
    txHash: string,
    route: number,
    sourceChain: string,
    sourceNonce: bigint,
  ): string {
    return `${block.toString()}|${txHash}|${String(route)}|${sourceChain}|${sourceNonce.toString()}`;
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
      pairing.note(ClaimPairing.key(at.block, at.txHash, route, sourceChain, sourceNonce), claimId);
      return { kind: "written" };
    }

    case "BridgeIn": {
      const route = requireNumber(args, "route");
      const sourceChain = requireString(args, "sourceChain");
      const sourceNonce = requireBigint(args, "sourceNonce");
      // A claim parked in this same transaction means the delivery did not land. Nothing in the
      // BridgeIn log itself says so.
      const claimId = pairing.claimFor(
        ClaimPairing.key(at.block, at.txHash, route, sourceChain, sourceNonce),
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

// --------------------------------------------------------------------------------------------
// Finality-policy provenance (#47)
// --------------------------------------------------------------------------------------------

export interface EvmFinalityPolicy {
  readonly confirmations: number;
  readonly reorgDepth: number;
  readonly finalityMode?: "confirmations" | "finalized";
  readonly allowFinalityFallback?: boolean;
}

export interface EvmScanProvenanceEntry {
  readonly chainKey: string;
  readonly contract: string;
  readonly chainId: number;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly endBlockHash: string;
  readonly headBlock: bigint;
  readonly policy: EvmFinalityPolicy;
  readonly logsWritten: number;
  readonly logsIgnored: number;
  readonly reorgDetected: boolean;
  readonly ownerId: string | null;
  readonly evidenceKind?: "confirmations" | "finalized";
  readonly finalizedBlock?: bigint | null;
  readonly finalizedHash?: string | null;
}

export interface EvmFinalityPolicyChange {
  readonly id: bigint;
  readonly chainKey: string;
  readonly contract: string;
  readonly chainId: number;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly confirmations: number;
  readonly reorgDepth: number;
  readonly previousConfirmations: number;
  readonly previousReorgDepth: number;
  readonly finalityMode: string;
  readonly previousFinalityMode: string;
  readonly allowFinalityFallback: boolean;
  readonly previousAllowFinalityFallback: boolean;
  readonly committedAt: Date;
}

export interface EvmScanProvenanceRecord {
  readonly id: bigint;
  readonly chainKey: string;
  readonly contract: string;
  readonly chainId: number;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly endBlockHash: string;
  readonly headBlock: bigint;
  readonly confirmations: number;
  readonly reorgDepth: number;
  readonly logsWritten: number;
  readonly logsIgnored: number;
  readonly reorgDetected: boolean;
  readonly policyChanged: boolean;
  readonly previousConfirmations: number | null;
  readonly previousReorgDepth: number | null;
  readonly ownerId: string | null;
  readonly committedAt: Date;
  readonly finalityMode: string;
  readonly evidenceKind: string;
  readonly finalizedBlock: bigint | null;
  readonly finalizedHash: string | null;
}

/**
 * Record the finality policy used for a committed EVM scan inside the same transaction as the
 * indexed rows and cursor advance. Returns the policy-change record if the configured policy
 * differs from the previous committed scan for the same deployment.
 */
export async function recordEvmScanProvenance(
  db: Queryable,
  entry: EvmScanProvenanceEntry,
): Promise<EvmFinalityPolicyChange | null> {
  const { rows } = await db.query(
    `WITH prev AS (
       SELECT confirmations, reorg_depth, finality_mode, allow_finality_fallback
         FROM evm_scan_provenance
        WHERE chain_key = $1 AND lower(contract) = lower($2)
        ORDER BY id DESC
        LIMIT 1
     ),
     ins AS (
       INSERT INTO evm_scan_provenance (
         chain_key, contract, chain_id, from_block, to_block, end_block_hash, head_block,
         confirmations, reorg_depth, logs_written, logs_ignored, reorg_detected,
         policy_changed, previous_confirmations, previous_reorg_depth, previous_finality_mode, previous_allow_finality_fallback, owner_id,
         finality_mode, allow_finality_fallback, evidence_kind, finalized_block, finalized_hash
       )
       SELECT
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         COALESCE((SELECT confirmations <> $8 OR reorg_depth <> $9 OR finality_mode <> $14 OR allow_finality_fallback <> $15 FROM prev), false),
         CASE WHEN COALESCE((SELECT confirmations <> $8 OR reorg_depth <> $9 OR finality_mode <> $14 OR allow_finality_fallback <> $15 FROM prev), false)
              THEN (SELECT confirmations FROM prev)
              ELSE NULL END,
         CASE WHEN COALESCE((SELECT confirmations <> $8 OR reorg_depth <> $9 OR finality_mode <> $14 OR allow_finality_fallback <> $15 FROM prev), false)
              THEN (SELECT reorg_depth FROM prev)
              ELSE NULL END,
         CASE WHEN COALESCE((SELECT confirmations <> $8 OR reorg_depth <> $9 OR finality_mode <> $14 OR allow_finality_fallback <> $15 FROM prev), false) THEN (SELECT finality_mode FROM prev) ELSE NULL END,
         CASE WHEN COALESCE((SELECT confirmations <> $8 OR reorg_depth <> $9 OR finality_mode <> $14 OR allow_finality_fallback <> $15 FROM prev), false) THEN (SELECT allow_finality_fallback FROM prev) ELSE NULL END,
         $13, $14, $15, $16, $17, $18
       RETURNING id, chain_key, contract, chain_id, from_block, to_block,
                 confirmations, reorg_depth, policy_changed,
                 previous_confirmations, previous_reorg_depth, finality_mode, previous_finality_mode, allow_finality_fallback, previous_allow_finality_fallback, committed_at
     )
     SELECT * FROM ins`,
    [
      entry.chainKey,
      entry.contract.toLowerCase(),
      entry.chainId,
      entry.fromBlock.toString(),
      entry.toBlock.toString(),
      entry.endBlockHash,
      entry.headBlock.toString(),
      entry.policy.confirmations,
      entry.policy.reorgDepth,
      entry.logsWritten,
      entry.logsIgnored,
      entry.reorgDetected,
      entry.ownerId,
      entry.policy.finalityMode ?? "confirmations",
      entry.policy.allowFinalityFallback ?? false,
      entry.evidenceKind ?? "confirmations",
      entry.finalizedBlock?.toString() ?? null,
      entry.finalizedHash ?? null,
    ],
  );

  const row = rows[0];
  if (row === undefined || !boolean(row, "policy_changed")) {
    return null;
  }

  return {
    id: bigintOf(row, "id"),
    chainKey: text(row, "chain_key"),
    contract: text(row, "contract"),
    chainId: integer(row, "chain_id"),
    fromBlock: bigintOf(row, "from_block"),
    toBlock: bigintOf(row, "to_block"),
    confirmations: integer(row, "confirmations"),
    reorgDepth: integer(row, "reorg_depth"),
    previousConfirmations: integer(row, "previous_confirmations"),
    previousReorgDepth: integer(row, "previous_reorg_depth"),
    finalityMode: text(row, "finality_mode"),
    previousFinalityMode: text(row, "previous_finality_mode"),
    allowFinalityFallback: boolean(row, "allow_finality_fallback"),
    previousAllowFinalityFallback: boolean(row, "previous_allow_finality_fallback"),
    committedAt: timestamp(row, "committed_at"),
  };
}

/** Read finality-policy change events recorded in `evm_scan_provenance` (newest first). */
export async function readEvmFinalityPolicyChanges(
  db: Queryable,
  chainKey: string,
  contract?: string,
  limit = 50,
): Promise<readonly EvmFinalityPolicyChange[]> {
  const params: unknown[] = [chainKey];
  const contractFilter =
    contract === undefined ? "" : ` AND lower(contract) = lower($${params.push(contract)})`;
  const limitParam = `$${params.push(limit)}`;

  const { rows } = await db.query(
    `SELECT id, chain_key, contract, chain_id, from_block, to_block,
            confirmations, reorg_depth, previous_confirmations, previous_reorg_depth, finality_mode, previous_finality_mode, allow_finality_fallback, previous_allow_finality_fallback, committed_at
       FROM evm_scan_provenance
      WHERE chain_key = $1${contractFilter}
        AND policy_changed
      ORDER BY id DESC
      LIMIT ${limitParam}`,
    params,
  );

  return rows.map((row) => ({
    id: bigintOf(row, "id"),
    chainKey: text(row, "chain_key"),
    contract: text(row, "contract"),
    chainId: integer(row, "chain_id"),
    fromBlock: bigintOf(row, "from_block"),
    toBlock: bigintOf(row, "to_block"),
    confirmations: integer(row, "confirmations"),
    reorgDepth: integer(row, "reorg_depth"),
    previousConfirmations: integer(row, "previous_confirmations"),
    previousReorgDepth: integer(row, "previous_reorg_depth"),
    finalityMode: text(row, "finality_mode"),
    previousFinalityMode: text(row, "previous_finality_mode"),
    allowFinalityFallback: boolean(row, "allow_finality_fallback"),
    previousAllowFinalityFallback: boolean(row, "previous_allow_finality_fallback"),
    committedAt: timestamp(row, "committed_at"),
  }));
}

/** Read the latest committed EVM scan provenance record for a chain (and optional router). */
export async function readLatestEvmScanProvenance(
  db: Queryable,
  chainKey: string,
  contract?: string,
): Promise<EvmScanProvenanceRecord | null> {
  const params: unknown[] = [chainKey];
  const contractFilter =
    contract === undefined ? "" : ` AND lower(contract) = lower($${params.push(contract)})`;

  const { rows } = await db.query(
    `SELECT id, chain_key, contract, chain_id, from_block, to_block, end_block_hash, head_block,
            confirmations, reorg_depth, logs_written, logs_ignored, reorg_detected,
            policy_changed, previous_confirmations, previous_reorg_depth, owner_id, committed_at,
            finality_mode, evidence_kind, finalized_block, finalized_hash
       FROM evm_scan_provenance
      WHERE chain_key = $1${contractFilter}
      ORDER BY id DESC
      LIMIT 1`,
    params,
  );

  const row = rows[0];
  if (row === undefined) return null;

  return {
    id: bigintOf(row, "id"),
    chainKey: text(row, "chain_key"),
    contract: text(row, "contract"),
    chainId: integer(row, "chain_id"),
    fromBlock: bigintOf(row, "from_block"),
    toBlock: bigintOf(row, "to_block"),
    endBlockHash: text(row, "end_block_hash"),
    headBlock: bigintOf(row, "head_block"),
    confirmations: integer(row, "confirmations"),
    reorgDepth: integer(row, "reorg_depth"),
    logsWritten: integer(row, "logs_written"),
    logsIgnored: integer(row, "logs_ignored"),
    reorgDetected: boolean(row, "reorg_detected"),
    policyChanged: boolean(row, "policy_changed"),
    previousConfirmations:
      row.previous_confirmations === null ? null : integer(row, "previous_confirmations"),
    previousReorgDepth:
      row.previous_reorg_depth === null ? null : integer(row, "previous_reorg_depth"),
    ownerId: textOrNull(row, "owner_id"),
    committedAt: timestamp(row, "committed_at"),
    finalityMode: text(row, "finality_mode"),
    evidenceKind: text(row, "evidence_kind"),
    finalizedBlock: row.finalized_block === null ? null : bigintOf(row, "finalized_block"),
    finalizedHash: textOrNull(row, "finalized_hash"),
  };
}
