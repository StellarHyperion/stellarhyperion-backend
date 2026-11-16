/**
 * Read-only SQL invariant auditor for transfers, claims, and delivery/settlement state.
 *
 * Checks three accounting guarantees across indexed PostgreSQL tables without mutating rows:
 *   1. Source amount conservation (`outbound_transfer` gross/fee/net arithmetic, unique arrival per
 *      departure hop, route/destination consistency, and cross-chain amount bounds only when same-unit
 *      or explicit token scale metadata is supplied, never inventing token decimals).
 *   2. Claim liabilities (`inbound_delivery` parked arrivals vs `pending_claim` backing rows, exact
 *      same-chain token/recipient/hop/amount parity, and per-token integer-string liability rollups).
 *   3. Delivery and settlement consistency (`rail_attestation` `delivered` status must always be
 *      backed by a canonical `inbound_delivery` row so provider status alone never establishes
 *      destination delivery, route agreement, and complete settlement provenance on settled claims).
 */
import { pathToFileURL } from "node:url";

import { Database } from "./pool.js";
import type { Queryable, Transactional } from "./pool.js";
import {
  bigintOf,
  bigintOrNull,
  boolean,
  integer,
  one,
  text,
  textOrNull,
  timestamp,
  timestampOrNull,
} from "./rows.js";

export type InvariantCategory =
  "source_amount_conservation" | "claim_liabilities" | "delivery_settlement_consistency";

export type InvariantViolationCode =
  | "outbound_amount_split_mismatch"
  | "hop_route_or_chain_mismatch"
  | "hop_amount_exceeds_net"
  | "duplicate_inbound_for_outbound"
  | "inbound_delivery_claim_state_invalid"
  | "parked_delivery_missing_claim"
  | "delivered_inbound_has_claim_row"
  | "orphan_pending_claim"
  | "claim_liability_mismatch"
  | "attestation_delivered_without_canonical_inbound"
  | "attestation_route_mismatch"
  | "settled_claim_incomplete_provenance"
  | "unsettled_claim_has_settlement_fields";

export type AuditedRowIdentity =
  | {
      readonly table: "outbound_transfer";
      readonly id: string;
      readonly originChain: string;
      readonly route: number;
      readonly nonce: string;
      readonly originTx: string;
    }
  | {
      readonly table: "inbound_delivery";
      readonly id: string;
      readonly destinationChain: string;
      readonly route: number;
      readonly sourceChain: string;
      readonly sourceNonce: string;
      readonly destinationTx: string;
    }
  | {
      readonly table: "pending_claim";
      readonly chain: string;
      readonly claimId: string;
      readonly route: number;
      readonly sourceChain: string;
      readonly sourceNonce: string;
    }
  | {
      readonly table: "rail_attestation";
      readonly transferId: string;
      readonly route: number;
      readonly status: string;
    };

export interface InvariantViolation {
  readonly category: InvariantCategory;
  readonly code: InvariantViolationCode;
  readonly message: string;
  readonly rows: readonly AuditedRowIdentity[];
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

export interface TokenPrecisionMetadata {
  readonly chain: string;
  readonly token: string;
  /** Verified integer decimal places (`0..78`). Never inferred when absent. */
  readonly decimals: number;
}

export interface ClaimLiabilityRollup {
  readonly chain: string;
  readonly token: string;
  readonly unsettledCount: number;
  readonly unsettledAmount: string;
  readonly settledCount: number;
  readonly settledAmount: string;
}

export interface SourceTokenVolumeRollup {
  readonly originChain: string;
  readonly token: string;
  readonly transferCount: number;
  readonly totalGrossAmount: string;
  readonly totalFeeAmount: string;
  readonly totalNetAmount: string;
}

export interface InvariantAuditSummary {
  readonly outboundCount: number;
  readonly inboundCount: number;
  readonly pendingClaimCount: number;
  readonly railAttestationCount: number;
  readonly verifiedHopScaleChecks: number;
  readonly unscaledCrossChainHops: number;
  readonly violationCount: number;
  readonly byCategory: Readonly<Record<InvariantCategory, number>>;
  readonly sourceVolumes: readonly SourceTokenVolumeRollup[];
  readonly claimLiabilities: readonly ClaimLiabilityRollup[];
}

export interface InvariantAuditReport {
  readonly ok: boolean;
  readonly auditedAt: string;
  readonly readOnlyEnforced: boolean;
  readonly summary: InvariantAuditSummary;
  readonly violations: readonly InvariantViolation[];
}

export interface InvariantAuditOptions {
  /**
   * Optional verified token decimal metadata keyed by `(chain, token)`.
   * When omitted or incomplete for a cross-chain hop, cross-chain amount scaling is skipped
   * and counted under `summary.unscaledCrossChainHops` rather than guessing decimals.
   */
  readonly tokenMetadata?: readonly TokenPrecisionMetadata[];
  /** Upper bound on violations collected per query pass so reports stay bounded on corrupt dumps. */
  readonly maxViolationsPerCheck?: number;
}

interface ReadOnlyCapable extends Transactional {
  readOnlyTransaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
}

function hasReadOnlyTransaction(db: Queryable): db is ReadOnlyCapable {
  return (
    "readOnlyTransaction" in db &&
    typeof (db as { readOnlyTransaction?: unknown }).readOnlyTransaction === "function"
  );
}

function isTransactional(db: Queryable): db is Transactional {
  return "transaction" in db && typeof (db as { transaction?: unknown }).transaction === "function";
}

function normalizeTokenLookupKey(chain: string, token: string): string {
  const normalizedChain = chain.trim();
  const trimmedToken = token.trim();
  const normalizedToken = /^0x[0-9a-fA-F]+$/i.test(trimmedToken)
    ? trimmedToken.toLowerCase()
    : trimmedToken;
  return `${normalizedChain}::${normalizedToken}`;
}

function buildTokenMetadataMap(
  entries: readonly TokenPrecisionMetadata[] | undefined,
): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  if (!entries) return map;
  for (const entry of entries) {
    if (!Number.isInteger(entry.decimals) || entry.decimals < 0 || entry.decimals > 78) {
      throw new RangeError(
        `invalid token decimals for ${entry.chain}:${entry.token} (${String(entry.decimals)}); expected integer in 0..78`,
      );
    }
    map.set(normalizeTokenLookupKey(entry.chain, entry.token), entry.decimals);
  }
  return map;
}

/**
 * Redacts credentials from PostgreSQL connection strings or error messages before logging.
 */
export function redactAuditConnectionText(input: string): string {
  return input.replace(/\b(postgres(?:ql)?:\/\/[^:/\s@]+:)([^@\s]+)(@)/gi, "$1[REDACTED]$3");
}

/**
 * Execute all read-only SQL accounting and lifecycle audits inside a single read-only transaction
 * boundary whenever `db` supports transactions.
 */
export async function auditTransferAndClaimInvariants(
  db: Transactional | Queryable,
  options: InvariantAuditOptions = {},
): Promise<InvariantAuditReport> {
  const maxPerCheck = options.maxViolationsPerCheck ?? 500;
  if (!Number.isInteger(maxPerCheck) || maxPerCheck < 1 || maxPerCheck > 10_000) {
    throw new RangeError("maxViolationsPerCheck must be an integer between 1 and 10000");
  }
  const tokenDecimals = buildTokenMetadataMap(options.tokenMetadata);

  if (hasReadOnlyTransaction(db)) {
    return db.readOnlyTransaction((tx) => runAuditInScope(tx, tokenDecimals, maxPerCheck, true));
  }
  if (isTransactional(db)) {
    return db.transaction(async (tx) => {
      await tx.query("SET TRANSACTION READ ONLY");
      return runAuditInScope(tx, tokenDecimals, maxPerCheck, true);
    });
  }
  return runAuditInScope(db, tokenDecimals, maxPerCheck, false);
}

async function runAuditInScope(
  tx: Queryable,
  tokenDecimals: ReadonlyMap<string, number>,
  limit: number,
  readOnlyEnforced: boolean,
): Promise<InvariantAuditReport> {
  const violations: InvariantViolation[] = [];

  // ---------------------------------------------------------------------------
  // Counts and rollups (exact integer strings, zero assumed token precision)
  // ---------------------------------------------------------------------------
  const countsRow = one(
    (
      await tx.query(
        `SELECT
           (SELECT COUNT(*)::int FROM outbound_transfer) AS outbound_count,
           (SELECT COUNT(*)::int FROM inbound_delivery) AS inbound_count,
           (SELECT COUNT(*)::int FROM pending_claim) AS pending_claim_count,
           (SELECT COUNT(*)::int FROM rail_attestation) AS rail_attestation_count`,
      )
    ).rows,
    "audit table counts",
  );

  const sourceVolumeRows = (
    await tx.query(
      `SELECT
         origin_chain,
         token,
         COUNT(*)::int AS transfer_count,
         COALESCE(SUM(gross_amount), 0)::text AS total_gross_amount,
         COALESCE(SUM(fee), 0)::text AS total_fee_amount,
         COALESCE(SUM(net_amount), 0)::text AS total_net_amount
       FROM outbound_transfer
       GROUP BY origin_chain, token
       ORDER BY origin_chain ASC, token ASC`,
    )
  ).rows;

  const sourceVolumes: SourceTokenVolumeRollup[] = sourceVolumeRows.map((row) => ({
    originChain: text(row, "origin_chain"),
    token: text(row, "token"),
    transferCount: integer(row, "transfer_count"),
    totalGrossAmount: bigintOf(row, "total_gross_amount").toString(),
    totalFeeAmount: bigintOf(row, "total_fee_amount").toString(),
    totalNetAmount: bigintOf(row, "total_net_amount").toString(),
  }));

  const liabilityRows = (
    await tx.query(
      `SELECT
         chain,
         token,
         COUNT(*) FILTER (WHERE NOT settled)::int AS unsettled_count,
         COALESCE(SUM(amount) FILTER (WHERE NOT settled), 0)::text AS unsettled_amount,
         COUNT(*) FILTER (WHERE settled)::int AS settled_count,
         COALESCE(SUM(amount) FILTER (WHERE settled), 0)::text AS settled_amount
       FROM pending_claim
       GROUP BY chain, token
       ORDER BY chain ASC, token ASC`,
    )
  ).rows;

  const claimLiabilities: ClaimLiabilityRollup[] = liabilityRows.map((row) => ({
    chain: text(row, "chain"),
    token: text(row, "token"),
    unsettledCount: integer(row, "unsettled_count"),
    unsettledAmount: bigintOf(row, "unsettled_amount").toString(),
    settledCount: integer(row, "settled_count"),
    settledAmount: bigintOf(row, "settled_amount").toString(),
  }));

  // ---------------------------------------------------------------------------
  // 1. Source amount conservation
  // ---------------------------------------------------------------------------
  const splitRows = (
    await tx.query(
      `SELECT
         id::text AS id,
         origin_chain,
         route,
         nonce::text AS nonce,
         origin_tx,
         gross_amount::text AS gross_amount,
         fee::text AS fee,
         net_amount::text AS net_amount
       FROM outbound_transfer
       WHERE gross_amount <> fee + net_amount
          OR gross_amount <= 0
          OR fee < 0
          OR net_amount <= 0
       ORDER BY id ASC
       LIMIT $1`,
      [limit],
    )
  ).rows;

  for (const row of splitRows) {
    const id = text(row, "id");
    const originChain = text(row, "origin_chain");
    const route = integer(row, "route");
    const nonce = bigintOf(row, "nonce").toString();
    const originTx = text(row, "origin_tx");
    const grossAmount = bigintOf(row, "gross_amount").toString();
    const fee = bigintOf(row, "fee").toString();
    const netAmount = bigintOf(row, "net_amount").toString();
    violations.push({
      category: "source_amount_conservation",
      code: "outbound_amount_split_mismatch",
      message: `outbound_transfer ${originChain}#${nonce} (id=${id}) violates gross = fee + net or positive amount bounds`,
      rows: [
        {
          table: "outbound_transfer",
          id,
          originChain,
          route,
          nonce,
          originTx,
        },
      ],
      details: {
        grossAmount,
        fee,
        netAmount,
      },
    });
  }

  // Duplicate inbound arrivals claiming the same (source_chain, source_nonce)
  const duplicateHopGroups = (
    await tx.query(
      `SELECT source_chain, source_nonce::text AS source_nonce
       FROM inbound_delivery
       GROUP BY source_chain, source_nonce
       HAVING COUNT(*) > 1
       ORDER BY source_chain ASC, source_nonce::numeric ASC
       LIMIT $1`,
      [limit],
    )
  ).rows;

  for (const group of duplicateHopGroups) {
    const sourceChain = text(group, "source_chain");
    const sourceNonce = bigintOf(group, "source_nonce").toString();
    const inboundMatches = (
      await tx.query(
        `SELECT
           id::text AS id,
           destination_chain,
           route,
           source_chain,
           source_nonce::text AS source_nonce,
           destination_tx,
           amount::text AS amount
         FROM inbound_delivery
         WHERE source_chain = $1 AND source_nonce = $2::numeric
         ORDER BY id ASC`,
        [sourceChain, sourceNonce],
      )
    ).rows;

    const outboundMatches = (
      await tx.query(
        `SELECT
           id::text AS id,
           origin_chain,
           route,
           nonce::text AS nonce,
           origin_tx
         FROM outbound_transfer
         WHERE origin_chain = $1 AND nonce = $2::numeric
         ORDER BY id ASC`,
        [sourceChain, sourceNonce],
      )
    ).rows;

    const rowIdentities: AuditedRowIdentity[] = [];
    for (const outRow of outboundMatches) {
      rowIdentities.push({
        table: "outbound_transfer",
        id: text(outRow, "id"),
        originChain: text(outRow, "origin_chain"),
        route: integer(outRow, "route"),
        nonce: bigintOf(outRow, "nonce").toString(),
        originTx: text(outRow, "origin_tx"),
      });
    }
    for (const inRow of inboundMatches) {
      rowIdentities.push({
        table: "inbound_delivery",
        id: text(inRow, "id"),
        destinationChain: text(inRow, "destination_chain"),
        route: integer(inRow, "route"),
        sourceChain: text(inRow, "source_chain"),
        sourceNonce: bigintOf(inRow, "source_nonce").toString(),
        destinationTx: text(inRow, "destination_tx"),
      });
    }

    violations.push({
      category: "source_amount_conservation",
      code: "duplicate_inbound_for_outbound",
      message: `multiple inbound_delivery rows (${String(inboundMatches.length)}) claim departure ${sourceChain}#${sourceNonce}`,
      rows: rowIdentities,
      details: {
        sourceChain,
        sourceNonce,
        duplicateArrivalCount: inboundMatches.length,
      },
    });
  }

  // Paired hop checks (route/destination chain parity + metadata-safe amount conservation)
  const pairedHopRows = (
    await tx.query(
      `SELECT
         o.id::text AS outbound_id,
         o.origin_chain,
         o.route AS outbound_route,
         o.nonce::text AS nonce,
         o.origin_tx,
         o.token AS outbound_token,
         o.net_amount::text AS net_amount,
         o.destination_chain AS expected_destination_chain,
         i.id::text AS inbound_id,
         i.destination_chain AS actual_destination_chain,
         i.route AS inbound_route,
         i.source_chain,
         i.source_nonce::text AS source_nonce,
         i.destination_tx,
         i.token AS inbound_token,
         i.amount::text AS inbound_amount
       FROM outbound_transfer o
       JOIN inbound_delivery i
         ON i.source_chain = o.origin_chain
        AND i.source_nonce = o.nonce
       ORDER BY o.id ASC, i.id ASC`,
    )
  ).rows;

  let verifiedHopScaleChecks = 0;
  let unscaledCrossChainHops = 0;
  let hopAmountViolations = 0;
  let hopRouteViolations = 0;

  for (const hop of pairedHopRows) {
    const outboundIdentity: AuditedRowIdentity = {
      table: "outbound_transfer",
      id: text(hop, "outbound_id"),
      originChain: text(hop, "origin_chain"),
      route: integer(hop, "outbound_route"),
      nonce: bigintOf(hop, "nonce").toString(),
      originTx: text(hop, "origin_tx"),
    };
    const inboundIdentity: AuditedRowIdentity = {
      table: "inbound_delivery",
      id: text(hop, "inbound_id"),
      destinationChain: text(hop, "actual_destination_chain"),
      route: integer(hop, "inbound_route"),
      sourceChain: text(hop, "source_chain"),
      sourceNonce: bigintOf(hop, "source_nonce").toString(),
      destinationTx: text(hop, "destination_tx"),
    };

    const expectedDestination = text(hop, "expected_destination_chain");
    if (
      expectedDestination !== inboundIdentity.destinationChain ||
      outboundIdentity.route !== inboundIdentity.route
    ) {
      if (hopRouteViolations < limit) {
        hopRouteViolations += 1;
        violations.push({
          category: "source_amount_conservation",
          code: "hop_route_or_chain_mismatch",
          message: `paired hop ${outboundIdentity.originChain}#${outboundIdentity.nonce} disagrees on destination_chain or route`,
          rows: [outboundIdentity, inboundIdentity],
          details: {
            expectedDestinationChain: expectedDestination,
            actualDestinationChain: inboundIdentity.destinationChain,
            outboundRoute: outboundIdentity.route,
            inboundRoute: inboundIdentity.route,
          },
        });
      }
    }

    const outboundToken = text(hop, "outbound_token");
    const inboundToken = text(hop, "inbound_token");
    const outboundNet = bigintOf(hop, "net_amount");
    const inboundAmount = bigintOf(hop, "inbound_amount");

    const originKey = normalizeTokenLookupKey(outboundIdentity.originChain, outboundToken);
    const destKey = normalizeTokenLookupKey(inboundIdentity.destinationChain, inboundToken);

    if (originKey === destKey) {
      verifiedHopScaleChecks += 1;
      if (inboundAmount > outboundNet && hopAmountViolations < limit) {
        hopAmountViolations += 1;
        violations.push({
          category: "source_amount_conservation",
          code: "hop_amount_exceeds_net",
          message: `inbound_delivery id=${inboundIdentity.id} amount exceeds outbound_transfer id=${outboundIdentity.id} net_amount`,
          rows: [outboundIdentity, inboundIdentity],
          details: {
            outboundToken,
            inboundToken,
            outboundNetAmount: outboundNet.toString(),
            inboundAmount: inboundAmount.toString(),
            comparisonBasis: "same_chain_and_token",
          },
        });
      }
      continue;
    }

    const originDecimals = tokenDecimals.get(originKey);
    const destDecimals = tokenDecimals.get(destKey);
    if (originDecimals === undefined || destDecimals === undefined) {
      // Never invent token decimals when metadata is missing on a cross-chain/token hop.
      unscaledCrossChainHops += 1;
      continue;
    }

    verifiedHopScaleChecks += 1;
    const maxDecimals = Math.max(originDecimals, destDecimals);
    const scaledOutboundNet = outboundNet * 10n ** BigInt(maxDecimals - originDecimals);
    const scaledInbound = inboundAmount * 10n ** BigInt(maxDecimals - destDecimals);

    if (scaledInbound > scaledOutboundNet && hopAmountViolations < limit) {
      hopAmountViolations += 1;
      violations.push({
        category: "source_amount_conservation",
        code: "hop_amount_exceeds_net",
        message: `scaled inbound_delivery id=${inboundIdentity.id} exceeds scaled outbound_transfer id=${outboundIdentity.id} net_amount`,
        rows: [outboundIdentity, inboundIdentity],
        details: {
          outboundToken,
          inboundToken,
          originDecimals,
          destinationDecimals: destDecimals,
          outboundNetAmount: outboundNet.toString(),
          inboundAmount: inboundAmount.toString(),
          scaledOutboundNetAmount: scaledOutboundNet.toString(),
          scaledInboundAmount: scaledInbound.toString(),
          comparisonBasis: "verified_token_metadata",
        },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Claim liabilities
  // ---------------------------------------------------------------------------
  const invalidClaimStateRows = (
    await tx.query(
      `SELECT
         id::text AS id,
         destination_chain,
         route,
         source_chain,
         source_nonce::text AS source_nonce,
         destination_tx,
         delivered,
         claim_id::text AS claim_id
       FROM inbound_delivery
       WHERE (delivered AND claim_id IS NOT NULL)
          OR (NOT delivered AND claim_id IS NULL)
       ORDER BY id ASC
       LIMIT $1`,
      [limit],
    )
  ).rows;

  for (const row of invalidClaimStateRows) {
    const id = text(row, "id");
    const destinationChain = text(row, "destination_chain");
    const route = integer(row, "route");
    const sourceChain = text(row, "source_chain");
    const sourceNonce = bigintOf(row, "source_nonce").toString();
    const destinationTx = text(row, "destination_tx");
    const delivered = boolean(row, "delivered");
    const claimId = bigintOrNull(row, "claim_id");
    violations.push({
      category: "claim_liabilities",
      code: "inbound_delivery_claim_state_invalid",
      message: `inbound_delivery id=${id} has inconsistent delivered=${String(delivered)} and claim_id=${claimId === null ? "null" : claimId.toString()}`,
      rows: [
        {
          table: "inbound_delivery",
          id,
          destinationChain,
          route,
          sourceChain,
          sourceNonce,
          destinationTx,
        },
      ],
      details: {
        delivered,
        claimId: claimId === null ? null : claimId.toString(),
      },
    });
  }

  // Parked deliveries missing their pending_claim row
  const parkedMissingClaimRows = (
    await tx.query(
      `SELECT
         i.id::text AS id,
         i.destination_chain,
         i.route,
         i.source_chain,
         i.source_nonce::text AS source_nonce,
         i.destination_tx,
         i.claim_id::text AS claim_id,
         i.amount::text AS amount,
         i.token
       FROM inbound_delivery i
       LEFT JOIN pending_claim p
         ON p.chain = i.destination_chain
        AND p.claim_id = i.claim_id
       WHERE NOT i.delivered
         AND i.claim_id IS NOT NULL
         AND p.claim_id IS NULL
       ORDER BY i.id ASC
       LIMIT $1`,
      [limit],
    )
  ).rows;

  for (const row of parkedMissingClaimRows) {
    const id = text(row, "id");
    const destinationChain = text(row, "destination_chain");
    const route = integer(row, "route");
    const sourceChain = text(row, "source_chain");
    const sourceNonce = bigintOf(row, "source_nonce").toString();
    const destinationTx = text(row, "destination_tx");
    const claimId = bigintOf(row, "claim_id").toString();
    violations.push({
      category: "claim_liabilities",
      code: "parked_delivery_missing_claim",
      message: `parked inbound_delivery id=${id} references missing pending_claim ${destinationChain}#${claimId}`,
      rows: [
        {
          table: "inbound_delivery",
          id,
          destinationChain,
          route,
          sourceChain,
          sourceNonce,
          destinationTx,
        },
      ],
      details: {
        expectedClaimChain: destinationChain,
        expectedClaimId: claimId,
        amount: bigintOf(row, "amount").toString(),
        token: text(row, "token"),
      },
    });
  }

  // Delivered inbound rows that simultaneously have a pending_claim for the same hop
  const deliveredWithClaimRows = (
    await tx.query(
      `SELECT
         i.id::text AS inbound_id,
         i.destination_chain,
         i.route AS inbound_route,
         i.source_chain AS inbound_source_chain,
         i.source_nonce::text AS inbound_source_nonce,
         i.destination_tx,
         p.chain AS claim_chain,
         p.claim_id::text AS claim_id,
         p.route AS claim_route,
         p.source_chain AS claim_source_chain,
         p.source_nonce::text AS claim_source_nonce,
         p.amount::text AS claim_amount
       FROM inbound_delivery i
       JOIN pending_claim p
         ON p.chain = i.destination_chain
        AND p.route = i.route
        AND p.source_chain = i.source_chain
        AND p.source_nonce = i.source_nonce
       WHERE i.delivered = true
       ORDER BY i.id ASC, p.claim_id ASC
       LIMIT $1`,
      [limit],
    )
  ).rows;

  for (const row of deliveredWithClaimRows) {
    const inboundId = text(row, "inbound_id");
    const claimChain = text(row, "claim_chain");
    const claimId = bigintOf(row, "claim_id").toString();
    violations.push({
      category: "claim_liabilities",
      code: "delivered_inbound_has_claim_row",
      message: `delivered inbound_delivery id=${inboundId} collides with pending_claim ${claimChain}#${claimId} for the same hop`,
      rows: [
        {
          table: "inbound_delivery",
          id: inboundId,
          destinationChain: text(row, "destination_chain"),
          route: integer(row, "inbound_route"),
          sourceChain: text(row, "inbound_source_chain"),
          sourceNonce: bigintOf(row, "inbound_source_nonce").toString(),
          destinationTx: text(row, "destination_tx"),
        },
        {
          table: "pending_claim",
          chain: claimChain,
          claimId,
          route: integer(row, "claim_route"),
          sourceChain: text(row, "claim_source_chain"),
          sourceNonce: bigintOf(row, "claim_source_nonce").toString(),
        },
      ],
      details: {
        claimAmount: bigintOf(row, "claim_amount").toString(),
      },
    });
  }

  // Pending claims without a backing parked inbound_delivery
  const orphanClaimRows = (
    await tx.query(
      `SELECT
         p.chain,
         p.claim_id::text AS claim_id,
         p.route,
         p.source_chain,
         p.source_nonce::text AS source_nonce,
         p.amount::text AS amount,
         p.token
       FROM pending_claim p
       LEFT JOIN inbound_delivery i
         ON i.destination_chain = p.chain
        AND i.claim_id = p.claim_id
        AND NOT i.delivered
       WHERE i.id IS NULL
       ORDER BY p.chain ASC, p.claim_id ASC
       LIMIT $1`,
      [limit],
    )
  ).rows;

  for (const row of orphanClaimRows) {
    const chain = text(row, "chain");
    const claimId = bigintOf(row, "claim_id").toString();
    const route = integer(row, "route");
    const sourceChain = text(row, "source_chain");
    const sourceNonce = bigintOf(row, "source_nonce").toString();
    violations.push({
      category: "claim_liabilities",
      code: "orphan_pending_claim",
      message: `pending_claim ${chain}#${claimId} has no backing parked inbound_delivery row`,
      rows: [
        {
          table: "pending_claim",
          chain,
          claimId,
          route,
          sourceChain,
          sourceNonce,
        },
      ],
      details: {
        amount: bigintOf(row, "amount").toString(),
        token: text(row, "token"),
      },
    });
  }

  // Paired parked inbound_delivery and pending_claim field/amount mismatches
  const claimMismatchRows = (
    await tx.query(
      `SELECT
         i.id::text AS inbound_id,
         i.destination_chain,
         i.route AS inbound_route,
         i.source_chain AS inbound_source_chain,
         i.source_nonce::text AS inbound_source_nonce,
         i.destination_tx,
         i.recipient AS inbound_recipient,
         i.token AS inbound_token,
         i.amount::text AS inbound_amount,
         p.chain AS claim_chain,
         p.claim_id::text AS claim_id,
         p.route AS claim_route,
         p.source_chain AS claim_source_chain,
         p.source_nonce::text AS claim_source_nonce,
         p.recipient AS claim_recipient,
         p.token AS claim_token,
         p.amount::text AS claim_amount
       FROM inbound_delivery i
       JOIN pending_claim p
         ON p.chain = i.destination_chain
        AND p.claim_id = i.claim_id
       WHERE NOT i.delivered
         AND (
           p.amount <> i.amount
           OR p.token <> i.token
           OR p.recipient <> i.recipient
           OR p.route <> i.route
           OR p.source_chain <> i.source_chain
           OR p.source_nonce <> i.source_nonce
         )
       ORDER BY i.id ASC
       LIMIT $1`,
      [limit],
    )
  ).rows;

  for (const row of claimMismatchRows) {
    const inboundId = text(row, "inbound_id");
    const claimChain = text(row, "claim_chain");
    const claimId = bigintOf(row, "claim_id").toString();
    violations.push({
      category: "claim_liabilities",
      code: "claim_liability_mismatch",
      message: `pending_claim ${claimChain}#${claimId} disagrees with parked inbound_delivery id=${inboundId}`,
      rows: [
        {
          table: "inbound_delivery",
          id: inboundId,
          destinationChain: text(row, "destination_chain"),
          route: integer(row, "inbound_route"),
          sourceChain: text(row, "inbound_source_chain"),
          sourceNonce: bigintOf(row, "inbound_source_nonce").toString(),
          destinationTx: text(row, "destination_tx"),
        },
        {
          table: "pending_claim",
          chain: claimChain,
          claimId,
          route: integer(row, "claim_route"),
          sourceChain: text(row, "claim_source_chain"),
          sourceNonce: bigintOf(row, "claim_source_nonce").toString(),
        },
      ],
      details: {
        inboundAmount: bigintOf(row, "inbound_amount").toString(),
        claimAmount: bigintOf(row, "claim_amount").toString(),
        inboundToken: text(row, "inbound_token"),
        claimToken: text(row, "claim_token"),
        inboundRecipient: text(row, "inbound_recipient"),
        claimRecipient: text(row, "claim_recipient"),
      },
    });
  }

  // ---------------------------------------------------------------------------
  // 3. Delivery and settlement consistency
  // ---------------------------------------------------------------------------
  // Canonical rule: a rail/provider status alone must never establish destination delivery.
  const unbackedDeliveredAttestationRows = (
    await tx.query(
      `SELECT
         r.transfer_id::text AS transfer_id,
         r.route AS attestation_route,
         r.status,
         r.rail_status,
         r.rail_reference,
         o.origin_chain,
         o.route AS outbound_route,
         o.nonce::text AS nonce,
         o.destination_chain,
         o.origin_tx
       FROM rail_attestation r
       JOIN outbound_transfer o
         ON o.id = r.transfer_id
       LEFT JOIN inbound_delivery i
         ON i.source_chain = o.origin_chain
        AND i.source_nonce = o.nonce
        AND i.destination_chain = o.destination_chain
        AND i.route = o.route
       WHERE r.status = 'delivered'
         AND i.id IS NULL
       ORDER BY r.transfer_id ASC
       LIMIT $1`,
      [limit],
    )
  ).rows;

  for (const row of unbackedDeliveredAttestationRows) {
    const transferId = text(row, "transfer_id");
    const originChain = text(row, "origin_chain");
    const nonce = bigintOf(row, "nonce").toString();
    violations.push({
      category: "delivery_settlement_consistency",
      code: "attestation_delivered_without_canonical_inbound",
      message: `rail_attestation transfer_id=${transferId} (${originChain}#${nonce}) reports status='delivered' without a canonical inbound_delivery row`,
      rows: [
        {
          table: "rail_attestation",
          transferId,
          route: integer(row, "attestation_route"),
          status: text(row, "status"),
        },
        {
          table: "outbound_transfer",
          id: transferId,
          originChain,
          route: integer(row, "outbound_route"),
          nonce,
          originTx: text(row, "origin_tx"),
        },
      ],
      details: {
        expectedDestinationChain: text(row, "destination_chain"),
        railStatus: textOrNull(row, "rail_status"),
        railReference: textOrNull(row, "rail_reference"),
      },
    });
  }

  const attestationRouteMismatchRows = (
    await tx.query(
      `SELECT
         r.transfer_id::text AS transfer_id,
         r.route AS attestation_route,
         r.status,
         o.origin_chain,
         o.route AS outbound_route,
         o.nonce::text AS nonce,
         o.origin_tx
       FROM rail_attestation r
       JOIN outbound_transfer o
         ON o.id = r.transfer_id
       WHERE r.route <> o.route
       ORDER BY r.transfer_id ASC
       LIMIT $1`,
      [limit],
    )
  ).rows;

  for (const row of attestationRouteMismatchRows) {
    const transferId = text(row, "transfer_id");
    const attestationRoute = integer(row, "attestation_route");
    const outboundRoute = integer(row, "outbound_route");
    violations.push({
      category: "delivery_settlement_consistency",
      code: "attestation_route_mismatch",
      message: `rail_attestation transfer_id=${transferId} route=${String(attestationRoute)} disagrees with outbound_transfer route=${String(outboundRoute)}`,
      rows: [
        {
          table: "rail_attestation",
          transferId,
          route: attestationRoute,
          status: text(row, "status"),
        },
        {
          table: "outbound_transfer",
          id: transferId,
          originChain: text(row, "origin_chain"),
          route: outboundRoute,
          nonce: bigintOf(row, "nonce").toString(),
          originTx: text(row, "origin_tx"),
        },
      ],
      details: {
        attestationRoute,
        outboundRoute,
      },
    });
  }

  // Settlement provenance completeness on pending_claim
  const settlementRows = (
    await tx.query(
      `SELECT
         chain,
         claim_id::text AS claim_id,
         route,
         source_chain,
         source_nonce::text AS source_nonce,
         created_at,
         settled,
         settled_at,
         settled_by,
         settled_tx
       FROM pending_claim
       WHERE (
               settled = true
               AND (
                 settled_at IS NULL
                 OR settled_by IS NULL
                 OR btrim(settled_by) = ''
                 OR settled_tx IS NULL
                 OR btrim(settled_tx) = ''
                 OR settled_at < created_at
               )
             )
          OR (
               settled = false
               AND (
                 settled_at IS NOT NULL
                 OR settled_by IS NOT NULL
                 OR settled_tx IS NOT NULL
               )
             )
       ORDER BY chain ASC, claim_id ASC
       LIMIT $1`,
      [limit],
    )
  ).rows;

  for (const row of settlementRows) {
    const chain = text(row, "chain");
    const claimId = bigintOf(row, "claim_id").toString();
    const route = integer(row, "route");
    const sourceChain = text(row, "source_chain");
    const sourceNonce = bigintOf(row, "source_nonce").toString();
    const isSettled = boolean(row, "settled");
    const createdAt = timestamp(row, "created_at");
    const settledAt = timestampOrNull(row, "settled_at");
    const settledBy = textOrNull(row, "settled_by");
    const settledTx = textOrNull(row, "settled_tx");

    const identity: AuditedRowIdentity = {
      table: "pending_claim",
      chain,
      claimId,
      route,
      sourceChain,
      sourceNonce,
    };

    if (isSettled) {
      violations.push({
        category: "delivery_settlement_consistency",
        code: "settled_claim_incomplete_provenance",
        message: `settled pending_claim ${chain}#${claimId} lacks complete canonical settlement provenance`,
        rows: [identity],
        details: {
          createdAt: createdAt.toISOString(),
          settledAt: settledAt ? settledAt.toISOString() : null,
          settledBy,
          settledTx,
        },
      });
    } else {
      violations.push({
        category: "delivery_settlement_consistency",
        code: "unsettled_claim_has_settlement_fields",
        message: `unsettled pending_claim ${chain}#${claimId} carries non-null settlement fields`,
        rows: [identity],
        details: {
          settledAt: settledAt ? settledAt.toISOString() : null,
          settledBy,
          settledTx,
        },
      });
    }
  }

  const byCategory: Record<InvariantCategory, number> = {
    source_amount_conservation: 0,
    claim_liabilities: 0,
    delivery_settlement_consistency: 0,
  };
  for (const violation of violations) {
    byCategory[violation.category] += 1;
  }

  return {
    ok: violations.length === 0,
    auditedAt: new Date().toISOString(),
    readOnlyEnforced,
    summary: {
      outboundCount: integer(countsRow, "outbound_count"),
      inboundCount: integer(countsRow, "inbound_count"),
      pendingClaimCount: integer(countsRow, "pending_claim_count"),
      railAttestationCount: integer(countsRow, "rail_attestation_count"),
      verifiedHopScaleChecks,
      unscaledCrossChainHops,
      violationCount: violations.length,
      byCategory,
      sourceVolumes,
      claimLiabilities,
    },
    violations,
  };
}

export async function runInvariantAuditCli(
  env: Readonly<Record<string, string | undefined>> = process.env,
  writeStdout: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  writeStderr: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<number> {
  const connectionString = env.DATABASE_URL;
  if (!connectionString || connectionString.trim() === "") {
    writeStderr("DATABASE_URL is required to run the transfer and claim invariant auditor");
    return 2;
  }

  const db = Database.open(connectionString, {
    maxConnections: 2,
    applicationName: "hyperion-invariant-auditor",
  });
  try {
    const report = await auditTransferAndClaimInvariants(db);
    writeStdout(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    writeStderr(`invariant audit failed: ${redactAuditConnectionText(rawMessage)}`);
    return 2;
  } finally {
    await db.close();
  }
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  void runInvariantAuditCli().then((code) => {
    process.exitCode = code;
  });
}
