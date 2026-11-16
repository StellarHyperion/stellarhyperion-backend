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
import {
  bigintOf,
  bigintOrNull,
  boolean,
  booleanOrNull,
  integer,
  integerOrNull,
  maybeOne,
  text,
  textOrNull,
  timestamp,
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
import type { EvmFinalityTag } from "./client.js";
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

export type EvmFinalityMode = "confirmations" | "safe" | "finalized";

export type EvmFinalityEvidence = "confirmation_depth" | "safe_block" | "finalized_block";

export interface EvmFinalityPolicy {
  readonly mode: EvmFinalityMode;
  readonly confirmations: number;
  /**
   * When true, an endpoint that rejects `safe` or `finalized` falls back to
   * `head - confirmations` and records `usedFallback = true` with `confirmation_depth` evidence.
   * Defaults to false so unsupported tags fail closed.
   */
  readonly allowConfirmationFallback?: boolean;
}

export interface NormalizedFinalityPolicy {
  readonly mode: EvmFinalityMode;
  readonly confirmations: number;
  readonly allowConfirmationFallback: boolean;
}

export type FinalityPolicyChangeKind = "stronger" | "weaker";

export interface FinalityPolicyChange {
  readonly kind: FinalityPolicyChangeKind;
  readonly previous: NormalizedFinalityPolicy;
  readonly current: NormalizedFinalityPolicy;
}

export interface ScanFinalityProvenance {
  readonly chainKey: string;
  readonly contract: string;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly toBlockHash: string;
  readonly headBlock: bigint;
  readonly policy: NormalizedFinalityPolicy;
  readonly evidence: EvmFinalityEvidence;
  readonly finalityTag: EvmFinalityTag | null;
  readonly confirmationDepth: number | null;
  readonly boundaryBlock: bigint;
  readonly boundaryHash: string | null;
  readonly usedFallback: boolean;
  readonly policyChange: FinalityPolicyChange | null;
}

export interface PersistedScanProvenance {
  readonly id: bigint;
  readonly chainKey: string;
  readonly contract: string;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly toBlockHash: string;
  readonly headBlock: bigint;
  readonly configuredMode: EvmFinalityMode;
  readonly configuredConfirmations: number;
  readonly allowFallback: boolean;
  readonly evidence: EvmFinalityEvidence;
  readonly finalityTag: EvmFinalityTag | null;
  readonly confirmationDepth: number | null;
  readonly boundaryBlock: bigint;
  readonly boundaryHash: string | null;
  readonly usedFallback: boolean;
  readonly policyChanged: boolean;
  readonly policyChangeKind: FinalityPolicyChangeKind | null;
  readonly previousMode: EvmFinalityMode | null;
  readonly previousConfirmations: number | null;
  readonly previousAllowFallback: boolean | null;
  readonly committedAt: Date;
}

export interface DeliveryFinalityProvenance {
  readonly destinationChain: string;
  readonly route: number;
  readonly sourceChain: string;
  readonly sourceNonce: bigint;
  readonly delivered: boolean;
  readonly claimId: bigint | null;
  readonly destinationBlock: bigint;
  readonly destinationTx: string;
  readonly evidence: EvmFinalityEvidence | null;
  readonly confirmationDepth: number | null;
  readonly finalityTag: EvmFinalityTag | null;
  readonly boundaryBlock: bigint | null;
  readonly boundaryHash: string | null;
  readonly usedFallback: boolean | null;
}

export function normalizeFinalityPolicy(
  policy: EvmFinalityPolicy | undefined,
  defaultConfirmations: number,
): NormalizedFinalityPolicy {
  const mode = policy?.mode ?? "confirmations";
  const confirmations = policy?.confirmations ?? defaultConfirmations;
  if (!Number.isInteger(confirmations) || confirmations < 0) {
    throw new Error(
      `EVM finality confirmations must be a non-negative integer, received ${String(confirmations)}`,
    );
  }
  return {
    mode,
    confirmations,
    allowConfirmationFallback: policy?.allowConfirmationFallback ?? false,
  };
}

function finalityModeRank(mode: EvmFinalityMode): number {
  switch (mode) {
    case "finalized":
      return 3;
    case "safe":
      return 2;
    case "confirmations":
      return 1;
  }
}

export function compareFinalityPolicy(
  previous: NormalizedFinalityPolicy,
  current: NormalizedFinalityPolicy,
): FinalityPolicyChange | null {
  const previousRank = finalityModeRank(previous.mode);
  const currentRank = finalityModeRank(current.mode);
  if (currentRank > previousRank) {
    return { kind: "stronger", previous, current };
  }
  if (currentRank < previousRank) {
    return { kind: "weaker", previous, current };
  }
  if (current.mode === "confirmations") {
    if (current.confirmations > previous.confirmations) {
      return { kind: "stronger", previous, current };
    }
    if (current.confirmations < previous.confirmations) {
      return { kind: "weaker", previous, current };
    }
    return null;
  }
  if (previous.allowConfirmationFallback && !current.allowConfirmationFallback) {
    return { kind: "stronger", previous, current };
  }
  if (!previous.allowConfirmationFallback && current.allowConfirmationFallback) {
    return { kind: "weaker", previous, current };
  }
  if (current.confirmations > previous.confirmations) {
    return { kind: "stronger", previous, current };
  }
  if (current.confirmations < previous.confirmations) {
    return { kind: "weaker", previous, current };
  }
  return null;
}

export async function writeScanProvenance(
  db: Queryable,
  scan: ScanFinalityProvenance,
): Promise<void> {
  const change = scan.policyChange;
  await db.query(
    `INSERT INTO evm_scan_provenance
       (chain_key, contract, from_block, to_block, to_block_hash, head_block,
        configured_mode, configured_confirmations, allow_fallback,
        finality_evidence, finality_tag, confirmation_depth,
        finality_boundary_block, finality_boundary_hash, used_fallback,
        policy_changed, policy_change_kind, previous_mode,
        previous_confirmations, previous_allow_fallback)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
    [
      scan.chainKey,
      scan.contract,
      scan.fromBlock.toString(),
      scan.toBlock.toString(),
      scan.toBlockHash,
      scan.headBlock.toString(),
      scan.policy.mode,
      scan.policy.confirmations,
      scan.policy.allowConfirmationFallback,
      scan.evidence,
      scan.finalityTag,
      scan.confirmationDepth,
      scan.boundaryBlock.toString(),
      scan.boundaryHash,
      scan.usedFallback,
      change !== null,
      change?.kind ?? null,
      change?.previous.mode ?? null,
      change?.previous.confirmations ?? null,
      change?.previous.allowConfirmationFallback ?? null,
    ],
  );
}

function parseScanProvenanceRow(row: Record<string, unknown>): PersistedScanProvenance {
  const configuredMode = text(row, "configured_mode") as EvmFinalityMode;
  const evidence = text(row, "finality_evidence") as EvmFinalityEvidence;
  const rawTag = textOrNull(row, "finality_tag");
  const rawChangeKind = textOrNull(row, "policy_change_kind");
  const rawPrevMode = textOrNull(row, "previous_mode");
  return {
    id: bigintOf(row, "id"),
    chainKey: text(row, "chain_key"),
    contract: text(row, "contract"),
    fromBlock: bigintOf(row, "from_block"),
    toBlock: bigintOf(row, "to_block"),
    toBlockHash: text(row, "to_block_hash"),
    headBlock: bigintOf(row, "head_block"),
    configuredMode,
    configuredConfirmations: integer(row, "configured_confirmations"),
    allowFallback: boolean(row, "allow_fallback"),
    evidence,
    finalityTag: rawTag === "safe" || rawTag === "finalized" ? rawTag : null,
    confirmationDepth: integerOrNull(row, "confirmation_depth"),
    boundaryBlock: bigintOf(row, "finality_boundary_block"),
    boundaryHash: textOrNull(row, "finality_boundary_hash"),
    usedFallback: boolean(row, "used_fallback"),
    policyChanged: boolean(row, "policy_changed"),
    policyChangeKind:
      rawChangeKind === "stronger" || rawChangeKind === "weaker" ? rawChangeKind : null,
    previousMode:
      rawPrevMode === "confirmations" || rawPrevMode === "safe" || rawPrevMode === "finalized"
        ? rawPrevMode
        : null,
    previousConfirmations: integerOrNull(row, "previous_confirmations"),
    previousAllowFallback: booleanOrNull(row, "previous_allow_fallback"),
    committedAt: timestamp(row, "committed_at"),
  };
}

export async function readScanProvenance(
  db: Queryable,
  chainKey: string,
  limit = 50,
): Promise<readonly PersistedScanProvenance[]> {
  const { rows } = await db.query(
    `SELECT id, chain_key, contract, from_block, to_block, to_block_hash, head_block,
            configured_mode, configured_confirmations, allow_fallback,
            finality_evidence, finality_tag, confirmation_depth,
            finality_boundary_block, finality_boundary_hash, used_fallback,
            policy_changed, policy_change_kind, previous_mode,
            previous_confirmations, previous_allow_fallback, committed_at
       FROM evm_scan_provenance
      WHERE chain_key = $1
      ORDER BY id DESC
      LIMIT $2`,
    [chainKey, limit],
  );
  return rows.map((row) => parseScanProvenanceRow(row));
}

export async function readPolicyChanges(
  db: Queryable,
  chainKey: string,
): Promise<readonly PersistedScanProvenance[]> {
  const { rows } = await db.query(
    `SELECT id, chain_key, contract, from_block, to_block, to_block_hash, head_block,
            configured_mode, configured_confirmations, allow_fallback,
            finality_evidence, finality_tag, confirmation_depth,
            finality_boundary_block, finality_boundary_hash, used_fallback,
            policy_changed, policy_change_kind, previous_mode,
            previous_confirmations, previous_allow_fallback, committed_at
       FROM evm_scan_provenance
      WHERE chain_key = $1 AND policy_changed
      ORDER BY id ASC`,
    [chainKey],
  );
  return rows.map((row) => parseScanProvenanceRow(row));
}

export async function readDeliveryProvenance(
  db: Queryable,
  hop: {
    readonly destinationChain: string;
    readonly route: number;
    readonly sourceChain: string;
    readonly sourceNonce: bigint;
  },
): Promise<DeliveryFinalityProvenance | null> {
  const { rows } = await db.query(
    `SELECT destination_chain, route, source_chain, source_nonce, delivered, claim_id,
            destination_block, destination_tx, finality_evidence, finality_confirmations,
            finality_tag, finality_boundary_block, finality_boundary_hash, finality_used_fallback
       FROM inbound_delivery
      WHERE destination_chain = $1 AND route = $2 AND source_chain = $3 AND source_nonce = $4`,
    [hop.destinationChain, hop.route, hop.sourceChain, hop.sourceNonce.toString()],
  );
  const row = maybeOne(rows, "inbound delivery provenance");
  if (row === null) return null;
  const rawEvidence = textOrNull(row, "finality_evidence");
  const rawTag = textOrNull(row, "finality_tag");
  return {
    destinationChain: text(row, "destination_chain"),
    route: integer(row, "route"),
    sourceChain: text(row, "source_chain"),
    sourceNonce: bigintOf(row, "source_nonce"),
    delivered: boolean(row, "delivered"),
    claimId: bigintOrNull(row, "claim_id"),
    destinationBlock: bigintOf(row, "destination_block"),
    destinationTx: text(row, "destination_tx"),
    evidence:
      rawEvidence === "confirmation_depth" ||
      rawEvidence === "safe_block" ||
      rawEvidence === "finalized_block"
        ? rawEvidence
        : null,
    confirmationDepth: integerOrNull(row, "finality_confirmations"),
    finalityTag: rawTag === "safe" || rawTag === "finalized" ? rawTag : null,
    boundaryBlock: bigintOrNull(row, "finality_boundary_block"),
    boundaryHash: textOrNull(row, "finality_boundary_hash"),
    usedFallback: booleanOrNull(row, "finality_used_fallback"),
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
