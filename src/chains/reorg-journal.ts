/**
 * Committed EVM reorganization recovery journal and observability metrics.
 *
 * Tracks detected depth, wind-back block work, affected canonical proof rows, and reconciliation
 * outcomes in PostgreSQL so metrics align strictly with committed recovery state and failed
 * rollbacks or deep reorgs never appear as healthy catch-up.
 */
import type { Queryable } from "../db/pool.js";

export type ReorgClassification = "shallow_automatic" | "deep_operator_required";

export type ReconciliationStatus =
  "winding_back" | "reconciled" | "rollback_failed" | "operator_intervention_required";

export interface AffectedCanonicalProofs {
  readonly outboundTransfers: number;
  readonly inboundDeliveries: number;
  readonly pendingClaims: number;
  readonly railAttestations: number;
}

export interface ActiveReorgRecovery {
  readonly id: string;
  readonly chainKey: string;
  readonly cursorBlock: bigint;
  readonly rewindToBlock: bigint;
  readonly detectedDepth: number;
  readonly rollbackBlocks: number;
  readonly classification: ReorgClassification;
  readonly status: ReconciliationStatus;
  readonly affectedProofs: AffectedCanonicalProofs;
  rewrittenCanonicalProofs: number;
}

export interface ReorgJournalEvent {
  readonly id: string;
  readonly chain: string;
  readonly cursorBlock: string;
  readonly rewindToBlock: string;
  readonly reindexedThroughBlock: string | null;
  readonly detectedDepth: number;
  readonly rollbackBlocks: number;
  readonly expectedHash: string;
  readonly observedHash: string | null;
  readonly classification: ReorgClassification;
  readonly reconciliationStatus: ReconciliationStatus;
  readonly affectedProofs: AffectedCanonicalProofs;
  readonly rewrittenCanonicalProofs: number;
  readonly lastError: string | null;
  readonly detectedAt: string;
  readonly updatedAt: string;
  readonly reconciledAt: string | null;
}

export interface ReorgRecoveryMetricsSnapshot {
  readonly totals: {
    readonly detected: number;
    readonly shallowAutomatic: number;
    readonly deepOperatorRequired: number;
    readonly windingBack: number;
    readonly reconciled: number;
    readonly rollbackFailed: number;
    readonly operatorInterventionRequired: number;
  };
  readonly affectedProofTotals: AffectedCanonicalProofs;
  readonly activeRecoveries: readonly ReorgJournalEvent[];
  readonly recentEvents: readonly ReorgJournalEvent[];
}

function isUndefinedTableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "42P01"
  );
}

function scalarString(value: unknown, fallback = "0"): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return fallback;
}

function sanitizeReorgError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/\b(?:postgres(?:ql)?|rediss?|https?):\/\/[^\s"'<>]+/gi, "[redacted-url]")
    .slice(0, 240);
}

/**
 * Count committed canonical proof rows on `chainKey` inside `[fromBlock, toBlock]`.
 */
export async function countAffectedCanonicalProofs(
  db: Queryable,
  chainKey: string,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<AffectedCanonicalProofs> {
  const fromStr = fromBlock.toString();
  const toStr = toBlock.toString();

  const outRes = await db.query(
    `SELECT count(*)::int AS count
       FROM outbound_transfer
      WHERE origin_chain = $1
        AND origin_block >= $2
        AND origin_block <= $3`,
    [chainKey, fromStr, toStr],
  );
  const outboundTransfers = Number(outRes.rows[0]?.count ?? 0);

  const inRes = await db.query(
    `SELECT count(*)::int AS count
       FROM inbound_delivery
      WHERE destination_chain = $1
        AND destination_block >= $2
        AND destination_block <= $3`,
    [chainKey, fromStr, toStr],
  );
  const inboundDeliveries = Number(inRes.rows[0]?.count ?? 0);

  const claimRes = await db.query(
    `SELECT count(*)::int AS count
       FROM pending_claim
      WHERE chain = $1
        AND claim_id IN (
          SELECT claim_id
            FROM inbound_delivery
           WHERE destination_chain = $1
             AND destination_block >= $2
             AND destination_block <= $3
             AND claim_id IS NOT NULL
        )`,
    [chainKey, fromStr, toStr],
  );
  const pendingClaims = Number(claimRes.rows[0]?.count ?? 0);

  const railRes = await db.query(
    `SELECT count(*)::int AS count
       FROM rail_attestation
      WHERE transfer_id IN (
        SELECT id
          FROM outbound_transfer
         WHERE origin_chain = $1
           AND origin_block >= $2
           AND origin_block <= $3
      )`,
    [chainKey, fromStr, toStr],
  );
  const railAttestations = Number(railRes.rows[0]?.count ?? 0);

  return {
    outboundTransfers,
    inboundDeliveries,
    pendingClaims,
    railAttestations,
  };
}

export interface RecordDetectedReorgInput {
  readonly chainKey: string;
  readonly cursorBlock: bigint;
  readonly rewindToBlock: bigint;
  readonly detectedDepth: number;
  readonly rollbackBlocks: number;
  readonly expectedHash: string;
  readonly observedHash: string | null;
  readonly exceedsSafeWindow: boolean;
  readonly now?: Date;
}

export class ReorgRecoveryJournal {
  constructor(private readonly db: Queryable) {}

  async loadUnresolvedForChain(chainKey: string): Promise<ActiveReorgRecovery | null> {
    try {
      const res = await this.db.query(
        `SELECT id, chain_key, cursor_block, rewind_to_block, detected_depth, rollback_blocks,
                classification, reconciliation_status,
                affected_outbound_transfers, affected_inbound_deliveries,
                affected_pending_claims, affected_rail_attestations,
                rewritten_canonical_proofs
           FROM reorg_recovery_journal
          WHERE chain_key = $1
            AND reconciliation_status <> 'reconciled'
          ORDER BY id DESC
          LIMIT 1`,
        [chainKey],
      );
      const row = res.rows[0];
      if (!row || typeof row.chain_key !== "string") return null;
      const classification = row.classification;
      if (classification !== "shallow_automatic" && classification !== "deep_operator_required") {
        return null;
      }
      const status = row.reconciliation_status;
      if (
        status !== "winding_back" &&
        status !== "rollback_failed" &&
        status !== "operator_intervention_required"
      ) {
        return null;
      }
      return {
        id: scalarString(row.id),
        chainKey: row.chain_key,
        cursorBlock: BigInt(scalarString(row.cursor_block)),
        rewindToBlock: BigInt(scalarString(row.rewind_to_block)),
        detectedDepth: Number(row.detected_depth ?? 1),
        rollbackBlocks: Number(row.rollback_blocks ?? 0),
        classification,
        status,
        affectedProofs: {
          outboundTransfers: Number(row.affected_outbound_transfers ?? 0),
          inboundDeliveries: Number(row.affected_inbound_deliveries ?? 0),
          pendingClaims: Number(row.affected_pending_claims ?? 0),
          railAttestations: Number(row.affected_rail_attestations ?? 0),
        },
        rewrittenCanonicalProofs: Number(row.rewritten_canonical_proofs ?? 0),
      };
    } catch (error) {
      if (isUndefinedTableError(error)) return null;
      throw error;
    }
  }

  async recordDetectedReorg(input: RecordDetectedReorgInput): Promise<ActiveReorgRecovery> {
    const at = input.now ?? new Date();
    const affectedProofs = await countAffectedCanonicalProofs(
      this.db,
      input.chainKey,
      input.rewindToBlock,
      input.cursorBlock,
    );

    const classification: ReorgClassification = input.exceedsSafeWindow
      ? "deep_operator_required"
      : "shallow_automatic";
    const status: ReconciliationStatus = input.exceedsSafeWindow
      ? "operator_intervention_required"
      : "winding_back";
    const lastError = input.exceedsSafeWindow
      ? "reorganization exceeded configured automatic reorgDepth window; operator review required"
      : null;

    let id = "0";
    try {
      const inserted = await this.db.query(
        `INSERT INTO reorg_recovery_journal (
           chain_key, cursor_block, rewind_to_block, detected_depth, rollback_blocks,
           expected_hash, observed_hash, classification, reconciliation_status,
           affected_outbound_transfers, affected_inbound_deliveries,
           affected_pending_claims, affected_rail_attestations,
           last_error, detected_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8, $9,
           $10, $11, $12, $13,
           $14, $15, $15
         ) RETURNING id`,
        [
          input.chainKey,
          input.cursorBlock.toString(),
          input.rewindToBlock.toString(),
          input.detectedDepth,
          input.rollbackBlocks,
          input.expectedHash,
          input.observedHash,
          classification,
          status,
          affectedProofs.outboundTransfers,
          affectedProofs.inboundDeliveries,
          affectedProofs.pendingClaims,
          affectedProofs.railAttestations,
          lastError,
          at,
        ],
      );
      id = scalarString(inserted.rows[0]?.id, "0");
    } catch (error) {
      if (!isUndefinedTableError(error)) throw error;
    }

    return {
      id,
      chainKey: input.chainKey,
      cursorBlock: input.cursorBlock,
      rewindToBlock: input.rewindToBlock,
      detectedDepth: input.detectedDepth,
      rollbackBlocks: input.rollbackBlocks,
      classification,
      status,
      affectedProofs,
      rewrittenCanonicalProofs: 0,
    };
  }

  /**
   * Advance recovery progress inside the exact same DB transaction as the re-scanned range commit
   * so an uncommitted or aborted rollback never appears reconciled in `reorg_recovery_journal`.
   */
  async advanceRecoveryInTx(
    tx: Queryable,
    active: ActiveReorgRecovery,
    progress: {
      readonly toBlock: bigint;
      readonly rewrittenCanonicalProofsInBatch: number;
      readonly now?: Date;
    },
  ): Promise<{
    readonly nextStatus: ReconciliationStatus;
    readonly nextClassification: ReorgClassification;
    readonly detail: string | null;
  }> {
    const at = progress.now ?? new Date();
    const totalRewritten =
      active.rewrittenCanonicalProofs + progress.rewrittenCanonicalProofsInBatch;

    if (progress.toBlock < active.cursorBlock) {
      try {
        await tx.query(
          `UPDATE reorg_recovery_journal
              SET reindexed_through_block = $2,
                  rewritten_canonical_proofs = $3,
                  reconciliation_status = 'winding_back',
                  last_error = NULL,
                  updated_at = $4
            WHERE id = $1`,
          [active.id, progress.toBlock.toString(), totalRewritten, at],
        );
      } catch (error) {
        if (!isUndefinedTableError(error)) throw error;
      }
      return {
        nextStatus: "winding_back",
        nextClassification: active.classification,
        detail: `reorg wind-back in progress through block ${progress.toBlock.toString()} of ${active.cursorBlock.toString()}`,
      };
    }

    const expectedCanonical =
      active.affectedProofs.outboundTransfers + active.affectedProofs.inboundDeliveries;

    if (totalRewritten < expectedCanonical) {
      // One or more canonical transfers/deliveries disappeared rather than being re-mined.
      // Because EvmWatcher never silently deletes money records, flag operator intervention!
      const detail = `reorg orphaned ${String(expectedCanonical - totalRewritten)} canonical proof row(s) without replacement; operator reconciliation required`;
      try {
        await tx.query(
          `UPDATE reorg_recovery_journal
              SET reindexed_through_block = $2,
                  rewritten_canonical_proofs = $3,
                  classification = 'deep_operator_required',
                  reconciliation_status = 'operator_intervention_required',
                  last_error = $4,
                  updated_at = $5
            WHERE id = $1`,
          [active.id, progress.toBlock.toString(), totalRewritten, detail, at],
        );
      } catch (error) {
        if (!isUndefinedTableError(error)) throw error;
      }
      return {
        nextStatus: "operator_intervention_required",
        nextClassification: "deep_operator_required",
        detail,
      };
    }

    try {
      await tx.query(
        `UPDATE reorg_recovery_journal
            SET reindexed_through_block = $2,
                rewritten_canonical_proofs = $3,
                reconciliation_status = 'reconciled',
                last_error = NULL,
                updated_at = $4,
                reconciled_at = $4
          WHERE id = $1`,
        [active.id, progress.toBlock.toString(), totalRewritten, at],
      );
    } catch (error) {
      if (!isUndefinedTableError(error)) throw error;
    }

    return {
      nextStatus: "reconciled",
      nextClassification: active.classification,
      detail: null,
    };
  }

  /**
   * Commit a rollback failure outside the aborted range transaction so `/v1/metrics` and `/ready`
   * reflect the failed rollback immediately.
   */
  async recordRollbackFailure(
    active: ActiveReorgRecovery,
    error: unknown,
    now: Date = new Date(),
  ): Promise<string> {
    const reason = sanitizeReorgError(error);
    try {
      await this.db.query(
        `UPDATE reorg_recovery_journal
            SET reconciliation_status = 'rollback_failed',
                last_error = $2,
                updated_at = $3
          WHERE id = $1`,
        [active.id, reason, now],
      );
    } catch (dbErr) {
      if (!isUndefinedTableError(dbErr)) throw dbErr;
    }
    return `reorg rollback failed at cursor block ${active.cursorBlock.toString()}: ${reason}`;
  }
}

function emptyMetricsSnapshot(): ReorgRecoveryMetricsSnapshot {
  return {
    totals: {
      detected: 0,
      shallowAutomatic: 0,
      deepOperatorRequired: 0,
      windingBack: 0,
      reconciled: 0,
      rollbackFailed: 0,
      operatorInterventionRequired: 0,
    },
    affectedProofTotals: {
      outboundTransfers: 0,
      inboundDeliveries: 0,
      pendingClaims: 0,
      railAttestations: 0,
    },
    activeRecoveries: [],
    recentEvents: [],
  };
}

function parseJournalRow(row: Record<string, unknown>): ReorgJournalEvent | null {
  if (typeof row.chain_key !== "string") return null;
  const classification = row.classification;
  if (classification !== "shallow_automatic" && classification !== "deep_operator_required") {
    return null;
  }
  const status = row.reconciliation_status;
  if (
    status !== "winding_back" &&
    status !== "reconciled" &&
    status !== "rollback_failed" &&
    status !== "operator_intervention_required"
  ) {
    return null;
  }

  return {
    id: scalarString(row.id),
    chain: row.chain_key,
    cursorBlock: scalarString(row.cursor_block),
    rewindToBlock: scalarString(row.rewind_to_block),
    reindexedThroughBlock:
      row.reindexed_through_block !== null && row.reindexed_through_block !== undefined
        ? scalarString(row.reindexed_through_block)
        : null,
    detectedDepth: Number(row.detected_depth ?? 0),
    rollbackBlocks: Number(row.rollback_blocks ?? 0),
    expectedHash: typeof row.expected_hash === "string" ? row.expected_hash : "",
    observedHash: typeof row.observed_hash === "string" ? row.observed_hash : null,
    classification,
    reconciliationStatus: status,
    affectedProofs: {
      outboundTransfers: Number(row.affected_outbound_transfers ?? 0),
      inboundDeliveries: Number(row.affected_inbound_deliveries ?? 0),
      pendingClaims: Number(row.affected_pending_claims ?? 0),
      railAttestations: Number(row.affected_rail_attestations ?? 0),
    },
    rewrittenCanonicalProofs: Number(row.rewritten_canonical_proofs ?? 0),
    lastError: typeof row.last_error === "string" ? row.last_error : null,
    detectedAt: new Date(row.detected_at as string | number | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | number | Date).toISOString(),
    reconciledAt:
      row.reconciled_at !== null && row.reconciled_at !== undefined
        ? new Date(row.reconciled_at as string | number | Date).toISOString()
        : null,
  };
}

/**
 * Read committed reorg recovery metrics strictly from `reorg_recovery_journal`.
 */
export async function readReorgRecoveryMetrics(
  db: Queryable,
  limit = 20,
): Promise<ReorgRecoveryMetricsSnapshot> {
  try {
    const aggRes = await db.query(
      `SELECT count(*)::int AS detected,
              count(*) FILTER (WHERE classification = 'shallow_automatic')::int AS shallow_automatic,
              count(*) FILTER (WHERE classification = 'deep_operator_required')::int AS deep_operator_required,
              count(*) FILTER (WHERE reconciliation_status = 'winding_back')::int AS winding_back,
              count(*) FILTER (WHERE reconciliation_status = 'reconciled')::int AS reconciled,
              count(*) FILTER (WHERE reconciliation_status = 'rollback_failed')::int AS rollback_failed,
              count(*) FILTER (WHERE reconciliation_status = 'operator_intervention_required')::int AS operator_intervention_required,
              COALESCE(sum(affected_outbound_transfers), 0)::int AS outbound_transfers,
              COALESCE(sum(affected_inbound_deliveries), 0)::int AS inbound_deliveries,
              COALESCE(sum(affected_pending_claims), 0)::int AS pending_claims,
              COALESCE(sum(affected_rail_attestations), 0)::int AS rail_attestations
         FROM reorg_recovery_journal`,
    );
    const agg = aggRes.rows[0];
    if (agg?.detected === undefined) {
      return emptyMetricsSnapshot();
    }

    const recentRes = await db.query(
      `SELECT id, chain_key, cursor_block, rewind_to_block, reindexed_through_block,
              detected_depth, rollback_blocks, expected_hash, observed_hash,
              classification, reconciliation_status,
              affected_outbound_transfers, affected_inbound_deliveries,
              affected_pending_claims, affected_rail_attestations,
              rewritten_canonical_proofs, last_error,
              detected_at, updated_at, reconciled_at
         FROM reorg_recovery_journal
        ORDER BY id DESC
        LIMIT $1`,
      [limit],
    );
    const recentEvents: ReorgJournalEvent[] = [];
    for (const raw of recentRes.rows) {
      const parsed = parseJournalRow(raw);
      if (parsed !== null) recentEvents.push(parsed);
    }

    const activeRes = await db.query(
      `SELECT id, chain_key, cursor_block, rewind_to_block, reindexed_through_block,
              detected_depth, rollback_blocks, expected_hash, observed_hash,
              classification, reconciliation_status,
              affected_outbound_transfers, affected_inbound_deliveries,
              affected_pending_claims, affected_rail_attestations,
              rewritten_canonical_proofs, last_error,
              detected_at, updated_at, reconciled_at
         FROM reorg_recovery_journal
        WHERE reconciliation_status <> 'reconciled'
        ORDER BY id DESC
        LIMIT $1`,
      [limit],
    );
    const activeRecoveries: ReorgJournalEvent[] = [];
    for (const raw of activeRes.rows) {
      const parsed = parseJournalRow(raw);
      if (parsed !== null) activeRecoveries.push(parsed);
    }

    return {
      totals: {
        detected: Number(agg.detected ?? 0),
        shallowAutomatic: Number(agg.shallow_automatic ?? 0),
        deepOperatorRequired: Number(agg.deep_operator_required ?? 0),
        windingBack: Number(agg.winding_back ?? 0),
        reconciled: Number(agg.reconciled ?? 0),
        rollbackFailed: Number(agg.rollback_failed ?? 0),
        operatorInterventionRequired: Number(agg.operator_intervention_required ?? 0),
      },
      affectedProofTotals: {
        outboundTransfers: Number(agg.outbound_transfers ?? 0),
        inboundDeliveries: Number(agg.inbound_deliveries ?? 0),
        pendingClaims: Number(agg.pending_claims ?? 0),
        railAttestations: Number(agg.rail_attestations ?? 0),
      },
      activeRecoveries,
      recentEvents,
    };
  } catch (error) {
    if (isUndefinedTableError(error)) {
      return emptyMetricsSnapshot();
    }
    throw error;
  }
}
