/**
 * Every statement that writes an indexed row, in one file, for both chain families.
 *
 * The tables are shared and the two families are not. A Soroban `BridgeIn` carries no rail message
 * id and an EVM one does; an EVM `ClaimParked` carries no timestamp and a Soroban one does; an EVM
 * `ActionQueued` carries a real `kind` discriminant and a Soroban one carries a union with no
 * ordinal on the wire. Those differences belong in the per-family decoders. What does not belong
 * there is the SQL, because the constraints are shared: `inbound_delivery_claim` says a row claims
 * either a delivery or a claim id and never both, and two files writing that table would be two
 * chances to violate it on one side only and find out from a 23514 in production.
 *
 * Every writer takes a `Queryable`, so the caller decides the transaction. The indexer's restart
 * safety is the claim that a page of rows and the cursor advance past it land together, and that
 * claim is only as good as nobody being able to write one without the other.
 *
 * Conflicts update rather than do nothing. On Stellar a re-read writes identical values, so the
 * difference is invisible. On an EVM chain a re-read can follow a reorg and carry the corrected
 * version of a block, and `DO NOTHING` would keep the orphaned one forever while looking like it
 * had handled the case. `observed_at` is deliberately left out of every update: it records when
 * this indexer first saw the row, and a reorg does not change that.
 */
import type { Queryable, Transactional } from "../db/pool.js";
import {
  bigintOf,
  bigintOrNull,
  boolean,
  integer,
  integerOrNull,
  maybeOne,
  text,
  timestamp,
  timestampOrNull,
} from "../db/rows.js";

/** Where on a chain a row was observed. One shape for a ledger and for a block. */
export interface Position {
  readonly chainKey: string;
  /** Ledger sequence on Stellar, block number on an EVM chain. */
  readonly block: bigint;
  readonly txHash: string;
  /** Log index on an EVM chain. Null on Stellar, which orders events differently. */
  readonly logIndex: number | null;
  /** The chain's own timestamp, never ours. Lag measured against our clock hides a stall. */
  readonly observedAt: Date;
}

export interface OutboundRow {
  readonly route: number;
  readonly nonce: bigint;
  readonly sender: string;
  readonly token: string;
  readonly grossAmount: bigint;
  readonly fee: bigint;
  readonly netAmount: bigint;
  readonly destinationChain: string;
  /**
   * Who gets the money on the far side, as the emitting chain spells it.
   *
   * Not normalised here, and that is on purpose. The Soroban router emits a 32 byte word, the EVM
   * router emits the strkey as a string, and both are what their chain actually said. Collapsing
   * them to one spelling is a presentation decision, and making it in the writer would throw away
   * the only copy of what was emitted.
   */
  readonly destination: string;
  readonly railRef: string | null;
}

export interface InboundRow {
  readonly route: number;
  readonly sourceChain: string;
  readonly sourceNonce: bigint;
  /** The rail's own id for the message. EVM only; the Soroban event does not emit one. */
  readonly railMessageId: string | null;
  readonly recipient: string;
  readonly token: string;
  readonly amount: bigint;
  readonly delivered: boolean;
  /** Set when the delivery parked, null when it landed. The schema checks exactly that. */
  readonly claimId: bigint | null;
}

export interface ClaimRow {
  readonly claimId: bigint;
  readonly recipient: string;
  readonly token: string;
  readonly amount: bigint;
  readonly route: number;
  readonly sourceChain: string;
  readonly sourceNonce: bigint;
  readonly createdAt: Date;
}

export interface ActionRow {
  readonly actionId: bigint;
  /**
   * The chain's own discriminant where it has one.
   *
   * Zero on Stellar, because `AdminAction` is a union with payload variants and the wire carries
   * the variant name rather than an ordinal. The name goes in the payload instead, which is why
   * this column is not the thing to read to find out what an action does.
   */
  readonly kind: number;
  readonly payload: unknown;
  readonly eta: Date | null;
  readonly expiresAt: Date | null;
}

export interface HealthSample {
  readonly originChain: string;
  readonly destinationChain: string;
  readonly route: number;
  readonly token: string;
  readonly available: boolean;
  /** `QuoteBlocker` as the integer the router returns. Zero when nothing is blocking. */
  readonly blocker: number;
  readonly flowAvailable: bigint | null;
}

export async function writeOutbound(db: Queryable, at: Position, row: OutboundRow): Promise<void> {
  await db.query(
    `INSERT INTO outbound_transfer
       (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
        destination_chain, destination, rail_ref, origin_block, origin_tx, origin_log_index,
        observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (origin_chain, nonce) DO UPDATE
       SET route = EXCLUDED.route,
           sender = EXCLUDED.sender,
           token = EXCLUDED.token,
           gross_amount = EXCLUDED.gross_amount,
           fee = EXCLUDED.fee,
           net_amount = EXCLUDED.net_amount,
           destination_chain = EXCLUDED.destination_chain,
           destination = EXCLUDED.destination,
           rail_ref = COALESCE(EXCLUDED.rail_ref, outbound_transfer.rail_ref),
           origin_block = EXCLUDED.origin_block,
           origin_tx = EXCLUDED.origin_tx,
           origin_log_index = EXCLUDED.origin_log_index`,
    [
      at.chainKey,
      row.route,
      row.nonce.toString(),
      row.sender,
      row.token,
      row.grossAmount.toString(),
      row.fee.toString(),
      row.netAmount.toString(),
      row.destinationChain,
      row.destination,
      row.railRef,
      at.block.toString(),
      at.txHash,
      at.logIndex,
      at.observedAt,
    ],
  );
}

export async function writeInbound(db: Queryable, at: Position, row: InboundRow): Promise<void> {
  await db.query(
    `INSERT INTO inbound_delivery
       (destination_chain, route, source_chain, source_nonce, rail_message_id, recipient, token,
        amount, delivered, claim_id, destination_block, destination_tx, destination_log_index,
        observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (destination_chain, route, source_chain, source_nonce) DO UPDATE
       SET rail_message_id = COALESCE(EXCLUDED.rail_message_id, inbound_delivery.rail_message_id),
           recipient = EXCLUDED.recipient,
           token = EXCLUDED.token,
           amount = EXCLUDED.amount,
           delivered = EXCLUDED.delivered,
           claim_id = EXCLUDED.claim_id,
           destination_block = EXCLUDED.destination_block,
           destination_tx = EXCLUDED.destination_tx,
           destination_log_index = EXCLUDED.destination_log_index`,
    [
      at.chainKey,
      row.route,
      row.sourceChain,
      row.sourceNonce.toString(),
      row.railMessageId,
      row.recipient,
      row.token,
      row.amount.toString(),
      row.delivered,
      row.claimId === null ? null : row.claimId.toString(),
      at.block.toString(),
      at.txHash,
      at.logIndex,
      at.observedAt,
    ],
  );
}

export async function writeClaim(db: Queryable, at: Position, row: ClaimRow): Promise<void> {
  await db.query(
    `INSERT INTO pending_claim
       (chain, claim_id, recipient, token, amount, route, source_chain, source_nonce,
        created_at, settled, observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, $10)
     ON CONFLICT (chain, claim_id) DO UPDATE
       SET recipient = EXCLUDED.recipient,
           token = EXCLUDED.token,
           amount = EXCLUDED.amount,
           route = EXCLUDED.route,
           source_chain = EXCLUDED.source_chain,
           source_nonce = EXCLUDED.source_nonce,
           created_at = EXCLUDED.created_at`,
    [
      at.chainKey,
      row.claimId.toString(),
      row.recipient,
      row.token,
      row.amount.toString(),
      row.route,
      row.sourceChain,
      row.sourceNonce.toString(),
      row.createdAt,
      at.observedAt,
    ],
  );
}

/**
 * Mark a claim settled.
 *
 * An update rather than an upsert, and it deliberately does nothing when the claim is not already
 * there. A settlement for a claim this indexer never saw parked means the park event is older than
 * the retention window, and inventing a row from a settlement would record a claim with no origin
 * and a created_at nobody knows. Returns whether it matched, so the caller can say so.
 */
export async function settleClaim(
  db: Queryable,
  at: Position,
  claimId: bigint,
  settledBy: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE pending_claim
        SET settled = true, settled_at = $3, settled_by = $4, settled_tx = $5
      WHERE chain = $1 AND claim_id = $2 AND NOT settled`,
    [at.chainKey, claimId.toString(), at.observedAt, settledBy, at.txHash],
  );
  return rowCount > 0;
}

/**
 * Record an action entering the timelock.
 *
 * The conflict update does not touch `state`, and that is the whole point of writing it out rather
 * than letting it default. The lifecycle events own the state column. A re-read of the window
 * holding the queue event, after the action has already executed in a later window, would
 * otherwise set it back to queued and leave it there, because nothing re-reads the execution.
 */
export async function writeAction(db: Queryable, at: Position, row: ActionRow): Promise<void> {
  await db.query(
    `INSERT INTO admin_action
       (chain, action_id, kind, state, payload, eta, expires_at, queued_at, observed_at)
     VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7, $8)
     ON CONFLICT (chain, action_id) DO UPDATE
       SET kind = EXCLUDED.kind,
           payload = EXCLUDED.payload,
           eta = EXCLUDED.eta,
           expires_at = EXCLUDED.expires_at,
           queued_at = EXCLUDED.queued_at`,
    [
      at.chainKey,
      row.actionId.toString(),
      row.kind,
      JSON.stringify(row.payload),
      row.eta,
      row.expiresAt,
      at.observedAt,
      at.observedAt,
    ],
  );
}

/**
 * Settle an action, which only moves it out of `queued`.
 *
 * Guarded on the current state so a re-read cannot execute an action twice or cancel one that
 * already executed. `actor` is coalesced because only one of the two EVM events carries one and
 * neither Soroban execution event does.
 */
export async function settleAction(
  db: Queryable,
  at: Position,
  actionId: bigint,
  state: "executed" | "cancelled",
  actor: string | null,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE admin_action
        SET state = $3, settled_at = $4, actor = COALESCE($5, actor)
      WHERE chain = $1 AND action_id = $2 AND state = 'queued'`,
    [at.chainKey, actionId.toString(), state, at.observedAt, actor],
  );
  return rowCount > 0;
}

/**
 * Append a route health sample.
 *
 * Append only, with no natural key, because the useful question is how a route behaved over the
 * last hour rather than what it says this second. The consequence worth knowing is that a replayed
 * window appends a second copy of each sample. Both carry the chain's own timestamp, so they are
 * the same sample twice and any aggregate over them is unchanged; what grows is the row count.
 */
export async function writeHealthSample(
  db: Queryable,
  at: Position,
  sample: HealthSample,
): Promise<void> {
  await db.query(
    `INSERT INTO route_health
       (sampled_at, origin_chain, destination_chain, route, token, available, blocker,
        flow_available)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      at.observedAt,
      sample.originChain,
      sample.destinationChain,
      sample.route,
      sample.token,
      sample.available,
      sample.blocker,
      sample.flowAvailable === null ? null : sample.flowAvailable.toString(),
    ],
  );
}

/**
 * Where a transfer is while it exists only in a rail's API.
 *
 * `transfer_id` is the primary key and a foreign key onto `outbound_transfer` with
 * `ON DELETE CASCADE`, so there is deliberately no upsert on a business key here: the row is
 * identified by the transfer it belongs to and cannot exist without it. The conflict update is
 * what every poll does, and it is written out field by field because two of them must not be
 * clobbered by a later poll that found nothing new.
 */
export interface AttestationRow {
  readonly transferId: bigint;
  readonly route: number;
  readonly status: string;
  readonly railStatus: string | null;
  readonly railReference: string | null;
  readonly attestedAt: Date | null;
  readonly checkedAt: Date;
  /** Consecutive failures for this transfer, distinct from the poller's own backoff. */
  readonly checkFailures: number;
  readonly lastError: string | null;
}

export async function writeAttestation(db: Queryable, row: AttestationRow): Promise<void> {
  await db.query(
    `INSERT INTO rail_attestation
       (transfer_id, route, status, rail_status, rail_reference, attested_at, last_checked_at,
        check_failures, last_error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (transfer_id) DO UPDATE
       SET status = EXCLUDED.status,
           rail_status = COALESCE(EXCLUDED.rail_status, rail_attestation.rail_status),
           -- Both coalesced on purpose. A later poll that finds the transfer still pending must
           -- not erase the reference or the moment it was attested; a rail that stops echoing a
           -- field back is not a rail taking it away.
           rail_reference = COALESCE(EXCLUDED.rail_reference, rail_attestation.rail_reference),
           attested_at = COALESCE(rail_attestation.attested_at, EXCLUDED.attested_at),
           last_checked_at = EXCLUDED.last_checked_at,
           check_failures = EXCLUDED.check_failures,
           last_error = EXCLUDED.last_error,
           updated_at = now()`,
    [
      row.transferId.toString(),
      row.route,
      row.status,
      row.railStatus,
      row.railReference,
      row.attestedAt,
      row.checkedAt,
      row.checkFailures,
      row.lastError,
    ],
  );
}

export const DEFAULT_RAW_HEALTH_WINDOW_SECONDS = 24 * 60 * 60;
export const DEFAULT_HEALTH_COMPACTION_BATCH_SIZE = 500;
export const MAX_HEALTH_COMPACTION_BATCH_SIZE = 5_000;
export const DEFAULT_HEALTH_COMPACTION_MAX_BATCHES = 20;

export interface RouteHealthCompactionOptions {
  /** Raw diagnostic retention window in seconds before steady-state compaction applies. */
  readonly rawWindowSeconds?: number;
  /** Maximum redundant rows folded and deleted in one bounded transaction. */
  readonly batchSize?: number;
  /** Maximum bounded batches executed in a single compaction pass. */
  readonly maxBatches?: number;
  /** Per-batch lock acquisition timeout in milliseconds so ingestion is never blocked. */
  readonly lockTimeoutMs?: number;
  /** Clock override for deterministic testing. */
  readonly now?: () => Date;
  /** Optional hook invoked between bounded batches (for testing concurrent ingestion). */
  readonly onBatchComplete?: (batchIndex: number, deletedInBatch: number) => Promise<void> | void;
}

export interface RouteHealthCompactionResult {
  readonly deletedRows: number;
  readonly updatedBoundaryRows: number;
  readonly batchesRun: number;
  readonly hasMore: boolean;
  readonly compactedBefore: Date;
  readonly rawWindowSeconds: number;
}

export interface RouteHealthCompactionWatermark {
  readonly rawWindowSeconds: number;
  readonly compactedBefore: Date;
  readonly lastCompactedAt: Date;
  readonly totalRowsDeleted: bigint;
  readonly totalRuns: bigint;
}

export interface RouteHealthHistoryEntry {
  readonly id: bigint;
  readonly originChain: string;
  readonly destinationChain: string;
  readonly route: number;
  readonly token: string;
  readonly available: boolean;
  readonly blocker: number;
  readonly flowAvailable: string | null;
  readonly medianSeconds: number | null;
  readonly sampledAt: Date;
  readonly windowEndedAt: Date | null;
  readonly compactedCount: number;
  readonly resolution: "raw" | "compacted";
}

export interface RouteHealthCoverage {
  readonly rawFrom: Date | null;
  readonly compactedBefore: Date | null;
  readonly rawWindowSeconds: number | null;
  readonly lastCompactedAt: Date | null;
  readonly earliestSampleAt: Date | null;
  readonly latestSampleAt: Date | null;
  readonly storedRowCount: number;
  readonly representedSampleCount: number;
  readonly compactedBoundaryRowCount: number;
  readonly rawRowCount: number;
}

export interface RouteHealthHistoryResult {
  readonly samples: readonly RouteHealthHistoryEntry[];
  readonly coverage: RouteHealthCoverage;
}

interface LeaderFoldAggregate {
  addedCount: number;
  maxEndedAt: Date;
  latestMedianSeconds: number | null;
}

async function runCompactionBatch(
  db: Transactional,
  cutoff: Date,
  batchSize: number,
  lockTimeoutMs: number,
): Promise<{ readonly deletedRows: number; readonly updatedBoundaryRows: number }> {
  return db.transaction(async (tx) => {
    await tx.query(
      `SET LOCAL lock_timeout = '${String(Math.max(100, Math.trunc(lockTimeoutMs)))}ms'`,
    );

    const { rows } = await tx.query(
      `WITH ordered AS (
         SELECT id,
                origin_chain,
                destination_chain,
                route,
                token,
                sampled_at,
                available,
                blocker,
                flow_available,
                CASE
                  WHEN LAG(id) OVER w IS NULL THEN 1
                  WHEN available IS DISTINCT FROM LAG(available) OVER w THEN 1
                  WHEN blocker IS DISTINCT FROM LAG(blocker) OVER w THEN 1
                  WHEN flow_available IS DISTINCT FROM LAG(flow_available) OVER w THEN 1
                  ELSE 0
                END AS is_boundary
           FROM route_health
          WHERE sampled_at < $1
         WINDOW w AS (
           PARTITION BY origin_chain, destination_chain, route, token
           ORDER BY sampled_at ASC, id ASC
         )
       ),
       islands AS (
         SELECT id,
                origin_chain,
                destination_chain,
                route,
                token,
                sampled_at,
                is_boundary,
                SUM(is_boundary) OVER (
                  PARTITION BY origin_chain, destination_chain, route, token
                  ORDER BY sampled_at ASC, id ASC
                  ROWS UNBOUNDED PRECEDING
                ) AS island_id
           FROM ordered
       ),
       candidates AS (
         SELECT id,
                FIRST_VALUE(id) OVER (
                  PARTITION BY origin_chain, destination_chain, route, token, island_id
                  ORDER BY sampled_at ASC, id ASC
                ) AS leader_id,
                sampled_at
           FROM islands
       ),
       doomed_ids AS (
         SELECT id, leader_id
           FROM candidates
          WHERE id <> leader_id
          ORDER BY sampled_at ASC, id ASC
          LIMIT $2
       )
       SELECT rh.id,
              d.leader_id,
              rh.compacted_count,
              COALESCE(rh.window_ended_at, rh.sampled_at) AS effective_end,
              rh.median_seconds
         FROM doomed_ids d
         JOIN route_health rh ON rh.id = d.id
         JOIN route_health leader ON leader.id = d.leader_id
        WHERE rh.sampled_at < $1
          AND rh.available IS NOT DISTINCT FROM leader.available
          AND rh.blocker IS NOT DISTINCT FROM leader.blocker
          AND rh.flow_available IS NOT DISTINCT FROM leader.flow_available
        ORDER BY rh.id ASC
        FOR UPDATE OF rh, leader SKIP LOCKED`,
      [cutoff, batchSize],
    );

    if (rows.length === 0) {
      return { deletedRows: 0, updatedBoundaryRows: 0 };
    }

    const doomedIds: string[] = [];
    const byLeader = new Map<string, LeaderFoldAggregate>();

    for (const row of rows) {
      const id = bigintOf(row, "id").toString();
      const leaderId = bigintOf(row, "leader_id").toString();
      const count = integer(row, "compacted_count");
      const effectiveEnd = timestamp(row, "effective_end");
      const medianSeconds = integerOrNull(row, "median_seconds");

      doomedIds.push(id);
      const existing = byLeader.get(leaderId);
      if (existing === undefined) {
        byLeader.set(leaderId, {
          addedCount: count,
          maxEndedAt: effectiveEnd,
          latestMedianSeconds: medianSeconds,
        });
      } else {
        existing.addedCount += count;
        if (effectiveEnd.getTime() > existing.maxEndedAt.getTime()) {
          existing.maxEndedAt = effectiveEnd;
        }
        if (medianSeconds !== null) {
          existing.latestMedianSeconds = medianSeconds;
        }
      }
    }

    for (const [leaderId, agg] of byLeader.entries()) {
      await tx.query(
        `UPDATE route_health
            SET compacted_count = compacted_count + $2,
                window_ended_at = GREATEST(COALESCE(window_ended_at, sampled_at), $3),
                median_seconds = COALESCE(median_seconds, $4)
          WHERE id = $1`,
        [leaderId, agg.addedCount, agg.maxEndedAt, agg.latestMedianSeconds],
      );
    }

    const deleted = await tx.query(`DELETE FROM route_health WHERE id = ANY($1::bigint[])`, [
      doomedIds,
    ]);

    return {
      deletedRows: deleted.rowCount,
      updatedBoundaryRows: byLeader.size,
    };
  });
}

export async function compactRouteHealthSamples(
  db: Transactional,
  options: RouteHealthCompactionOptions = {},
): Promise<RouteHealthCompactionResult> {
  const rawWindowSeconds = Math.max(
    1,
    Math.trunc(options.rawWindowSeconds ?? DEFAULT_RAW_HEALTH_WINDOW_SECONDS),
  );
  const batchSize = Math.min(
    Math.max(1, Math.trunc(options.batchSize ?? DEFAULT_HEALTH_COMPACTION_BATCH_SIZE)),
    MAX_HEALTH_COMPACTION_BATCH_SIZE,
  );
  const maxBatches = Math.max(
    1,
    Math.trunc(options.maxBatches ?? DEFAULT_HEALTH_COMPACTION_MAX_BATCHES),
  );
  const lockTimeoutMs = options.lockTimeoutMs ?? 2_000;
  const now = options.now ? options.now() : new Date();
  const cutoff = new Date(now.getTime() - rawWindowSeconds * 1_000);

  let totalDeleted = 0;
  let totalUpdatedLeaders = 0;
  let batchesRun = 0;
  let hasMore = false;

  while (batchesRun < maxBatches) {
    const batchResult = await runCompactionBatch(db, cutoff, batchSize, lockTimeoutMs);
    batchesRun += 1;
    totalDeleted += batchResult.deletedRows;
    totalUpdatedLeaders += batchResult.updatedBoundaryRows;

    if (options.onBatchComplete !== undefined) {
      await options.onBatchComplete(batchesRun - 1, batchResult.deletedRows);
    }

    if (batchResult.deletedRows < batchSize) {
      hasMore = false;
      break;
    }

    hasMore = true;
    // Yield between bounded batches so concurrent ingestion queries are never starved.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }

  await db.query(
    `INSERT INTO health_sample_compaction
       (id, raw_window_seconds, compacted_before, last_compacted_at, total_rows_deleted, total_runs)
     VALUES (1, $1, $2, $3, $4, 1)
     ON CONFLICT (id) DO UPDATE
       SET raw_window_seconds = EXCLUDED.raw_window_seconds,
           compacted_before = GREATEST(health_sample_compaction.compacted_before, EXCLUDED.compacted_before),
           last_compacted_at = EXCLUDED.last_compacted_at,
           total_rows_deleted = health_sample_compaction.total_rows_deleted + $4,
           total_runs = health_sample_compaction.total_runs + 1`,
    [rawWindowSeconds, cutoff, now, String(totalDeleted)],
  );

  return {
    deletedRows: totalDeleted,
    updatedBoundaryRows: totalUpdatedLeaders,
    batchesRun,
    hasMore,
    compactedBefore: cutoff,
    rawWindowSeconds,
  };
}

export async function readRouteHealthCompactionWatermark(
  db: Queryable,
): Promise<RouteHealthCompactionWatermark | null> {
  const { rows } = await db.query(
    `SELECT raw_window_seconds, compacted_before, last_compacted_at, total_rows_deleted, total_runs
       FROM health_sample_compaction
      WHERE id = 1`,
  );
  const row = maybeOne(rows, "health_sample_compaction");
  if (row === null) return null;
  return {
    rawWindowSeconds: integer(row, "raw_window_seconds"),
    compactedBefore: timestamp(row, "compacted_before"),
    lastCompactedAt: timestamp(row, "last_compacted_at"),
    totalRowsDeleted: bigintOf(row, "total_rows_deleted"),
    totalRuns: bigintOf(row, "total_runs"),
  };
}

export async function queryRouteHealthHistory(
  db: Queryable,
  options: {
    readonly originChain?: string;
    readonly destinationChain?: string;
    readonly route?: number;
    readonly token?: string;
    readonly since?: Date;
    readonly limit?: number;
  } = {},
): Promise<RouteHealthHistoryResult> {
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 200)), 1_000);
  const filterParams = [
    options.originChain ?? null,
    options.destinationChain ?? null,
    options.route ?? null,
    options.token ?? null,
    options.since ?? null,
  ];

  const watermark = await readRouteHealthCompactionWatermark(db);

  const { rows } = await db.query(
    `SELECT id,
            origin_chain,
            destination_chain,
            route,
            token,
            available,
            blocker,
            flow_available,
            median_seconds,
            sampled_at,
            window_ended_at,
            compacted_count
       FROM route_health
      WHERE ($1::text IS NULL OR origin_chain = $1)
        AND ($2::text IS NULL OR destination_chain = $2)
        AND ($3::smallint IS NULL OR route = $3)
        AND ($4::text IS NULL OR token = $4)
        AND ($5::timestamptz IS NULL OR COALESCE(window_ended_at, sampled_at) >= $5)
      ORDER BY sampled_at ASC, id ASC
      LIMIT $6`,
    [...filterParams, limit],
  );

  const statsResult = await db.query(
    `SELECT COUNT(*)::int AS stored_rows,
            COALESCE(SUM(compacted_count), 0)::numeric(20, 0) AS represented_samples,
            COUNT(*) FILTER (WHERE compacted_count > 1)::int AS compacted_rows,
            COUNT(*) FILTER (WHERE compacted_count = 1)::int AS raw_rows,
            MIN(sampled_at) AS earliest_sample_at,
            MAX(COALESCE(window_ended_at, sampled_at)) AS latest_sample_at
       FROM route_health
      WHERE ($1::text IS NULL OR origin_chain = $1)
        AND ($2::text IS NULL OR destination_chain = $2)
        AND ($3::smallint IS NULL OR route = $3)
        AND ($4::text IS NULL OR token = $4)
        AND ($5::timestamptz IS NULL OR COALESCE(window_ended_at, sampled_at) >= $5)`,
    filterParams,
  );

  const samples: RouteHealthHistoryEntry[] = rows.map((row) => {
    const compactedCount = integerOrNull(row, "compacted_count") ?? 1;
    const flow = bigintOrNull(row, "flow_available");
    return {
      id: bigintOf(row, "id"),
      originChain: text(row, "origin_chain"),
      destinationChain: text(row, "destination_chain"),
      route: integer(row, "route"),
      token: text(row, "token"),
      available: boolean(row, "available"),
      blocker: integer(row, "blocker"),
      flowAvailable: flow === null ? null : flow.toString(),
      medianSeconds: integerOrNull(row, "median_seconds"),
      sampledAt: timestamp(row, "sampled_at"),
      windowEndedAt: timestampOrNull(row, "window_ended_at"),
      compactedCount,
      resolution: compactedCount > 1 ? "compacted" : "raw",
    };
  });

  const statsRow = maybeOne(statsResult.rows, "route_health coverage stats");
  const storedRowCount = statsRow === null ? 0 : (integerOrNull(statsRow, "stored_rows") ?? 0);
  const representedSampleCount =
    statsRow === null ? 0 : Number(bigintOrNull(statsRow, "represented_samples") ?? 0n);
  const compactedBoundaryRowCount =
    statsRow === null ? 0 : (integerOrNull(statsRow, "compacted_rows") ?? 0);
  const rawRowCount = statsRow === null ? 0 : (integerOrNull(statsRow, "raw_rows") ?? 0);
  const earliestSampleAt =
    statsRow === null ? null : timestampOrNull(statsRow, "earliest_sample_at");
  const latestSampleAt = statsRow === null ? null : timestampOrNull(statsRow, "latest_sample_at");

  return {
    samples,
    coverage: {
      rawFrom: watermark?.compactedBefore ?? earliestSampleAt,
      compactedBefore: watermark?.compactedBefore ?? null,
      rawWindowSeconds: watermark?.rawWindowSeconds ?? null,
      lastCompactedAt: watermark?.lastCompactedAt ?? null,
      earliestSampleAt,
      latestSampleAt,
      storedRowCount,
      representedSampleCount,
      compactedBoundaryRowCount,
      rawRowCount,
    },
  };
}
