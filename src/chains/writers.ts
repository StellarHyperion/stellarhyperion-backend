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
import { bigintOf, maybeOne, readMaintenanceLeaseRow } from "../db/rows.js";
import type { MaintenanceLeaseRow } from "../db/rows.js";

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

export const MAINTENANCE_JOBS = {
  railAttestationRetention: "rail_attestation_retention",
  routeHealthRetention: "route_health_retention",
} as const;

export type MaintenanceJobName =
  (typeof MAINTENANCE_JOBS)[keyof typeof MAINTENANCE_JOBS] | (string & {});

const DEFAULT_BATCH_SIZE = 250;
const MAX_BATCH_SIZE = 5_000;
const DEFAULT_MAX_BATCHES = 20;
const DEFAULT_LEASE_DURATION_MS = 60_000;
const MS_PER_DAY = 86_400_000;

export interface AcquireMaintenanceLeaseInput {
  readonly jobName: MaintenanceJobName;
  readonly ownerId: string;
  readonly leaseDurationMs?: number;
  readonly now?: Date;
}

export type AcquireMaintenanceLeaseResult =
  | { readonly acquired: true; readonly lease: MaintenanceLeaseRow }
  | { readonly acquired: false; readonly lease: null };

export interface ReleaseMaintenanceLeaseInput {
  readonly jobName: MaintenanceJobName;
  readonly ownerId: string;
  readonly fenceToken: bigint;
  readonly now?: Date;
}

export interface FencedBatchInput {
  readonly jobName: MaintenanceJobName;
  readonly ownerId: string;
  readonly fenceToken: bigint;
  readonly olderThanDays: number;
  readonly batchSize?: number;
  readonly leaseDurationMs?: number;
  readonly now?: Date;
  readonly batchIndex?: number;
  readonly onBeforeCommit?: (tx: Queryable, batchIndex: number) => Promise<void> | void;
}

export interface AttestationBatchInput extends FencedBatchInput {
  readonly requireInboundProvenance?: boolean;
}

export interface MaintenanceBatchResult {
  readonly leaseLost: boolean;
  readonly deletedCount: number;
  readonly hasMore: boolean;
  readonly resumeCursor: bigint | null;
}

export interface MaintenanceBatchStepInfo {
  readonly batchIndex: number;
  readonly deletedCount: number;
  readonly hasMore: boolean;
  readonly resumeCursor: bigint;
  readonly fenceToken: bigint;
}

export interface MaintenanceJobRunOptions {
  readonly ownerId: string;
  readonly olderThanDays?: number;
  readonly batchSize?: number;
  readonly maxBatches?: number;
  readonly leaseDurationMs?: number;
  readonly releaseLeaseOnExit?: boolean;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
  readonly onBeforeBatchCommit?: (tx: Queryable, batchIndex: number) => Promise<void> | void;
  readonly onAfterBatch?: (info: MaintenanceBatchStepInfo) => Promise<boolean> | boolean;
}

export interface AttestationRetentionJobOptions extends MaintenanceJobRunOptions {
  readonly jobName?: MaintenanceJobName;
  readonly requireInboundProvenance?: boolean;
}

export interface RouteHealthRetentionJobOptions extends MaintenanceJobRunOptions {
  readonly jobName?: MaintenanceJobName;
}

export interface MaintenanceRunResult {
  readonly jobName: string;
  readonly ownerId: string;
  readonly acquired: boolean;
  readonly completed: boolean;
  readonly interrupted: boolean;
  readonly leaseLost: boolean;
  readonly fenceToken: bigint | null;
  readonly batchesRun: number;
  readonly deletedCount: number;
  readonly resumeCursor: bigint | null;
}

function validateNonEmptyIdentifier(label: string, value: string): void {
  if (value.trim().length === 0) {
    throw new RangeError(`${label} must be a non-empty string`);
  }
}

function validateOlderThanDays(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("olderThanDays must be a non-negative finite number");
  }
}

function validateBatchSize(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_BATCH_SIZE) {
    throw new RangeError(`batchSize must be an integer between 1 and ${MAX_BATCH_SIZE}`);
  }
}

function validateMaxBatches(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError("maxBatches must be a positive integer");
  }
}

function validateLeaseDurationMs(value: number): void {
  if (!Number.isFinite(value) || value < 1) {
    throw new RangeError("leaseDurationMs must be a positive finite number");
  }
}

export async function getMaintenanceLease(
  db: Queryable,
  jobName: MaintenanceJobName,
): Promise<MaintenanceLeaseRow | null> {
  validateNonEmptyIdentifier("jobName", jobName);
  const { rows } = await db.query(
    `SELECT job_name, owner_id, fence_token, lease_expires_at, resume_cursor,
            batches_completed, rows_pruned, last_batch_at, last_completed_at, updated_at
       FROM maintenance_job_lease
      WHERE job_name = $1`,
    [jobName],
  );
  const row = maybeOne(rows, "maintenance_job_lease get");
  return row === null ? null : readMaintenanceLeaseRow(row);
}

export async function acquireMaintenanceLease(
  db: Queryable,
  input: AcquireMaintenanceLeaseInput,
): Promise<AcquireMaintenanceLeaseResult> {
  validateNonEmptyIdentifier("jobName", input.jobName);
  validateNonEmptyIdentifier("ownerId", input.ownerId);
  const leaseDurationMs = input.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  validateLeaseDurationMs(leaseDurationMs);

  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + leaseDurationMs);

  const { rows } = await db.query(
    `INSERT INTO maintenance_job_lease
       (job_name, owner_id, fence_token, lease_expires_at, updated_at)
     VALUES ($1, $2, 1, $3::timestamptz, $4::timestamptz)
     ON CONFLICT (job_name) DO UPDATE
       SET owner_id = EXCLUDED.owner_id,
           fence_token = maintenance_job_lease.fence_token + 1,
           lease_expires_at = EXCLUDED.lease_expires_at,
           updated_at = EXCLUDED.updated_at
     WHERE maintenance_job_lease.owner_id IS NULL
        OR maintenance_job_lease.lease_expires_at <= $4::timestamptz
        OR maintenance_job_lease.owner_id = EXCLUDED.owner_id
     RETURNING job_name, owner_id, fence_token, lease_expires_at, resume_cursor,
               batches_completed, rows_pruned, last_batch_at, last_completed_at, updated_at`,
    [input.jobName, input.ownerId, expiresAt, now],
  );

  const row = maybeOne(rows, "maintenance_job_lease acquire");
  if (row === null) {
    return { acquired: false, lease: null };
  }
  return { acquired: true, lease: readMaintenanceLeaseRow(row) };
}

export async function releaseMaintenanceLease(
  db: Queryable,
  input: ReleaseMaintenanceLeaseInput,
): Promise<boolean> {
  validateNonEmptyIdentifier("jobName", input.jobName);
  validateNonEmptyIdentifier("ownerId", input.ownerId);
  const now = input.now ?? new Date();

  const { rowCount } = await db.query(
    `UPDATE maintenance_job_lease
        SET owner_id = NULL,
            lease_expires_at = NULL,
            updated_at = $4::timestamptz
      WHERE job_name = $1
        AND owner_id = $2
        AND fence_token = $3::numeric`,
    [input.jobName, input.ownerId, input.fenceToken.toString(), now],
  );
  return rowCount > 0;
}

async function executeFencedRetentionBatch(
  db: Transactional,
  input: FencedBatchInput,
  selectCandidates: (
    tx: Queryable,
    resumeCursor: bigint,
    cutoff: Date,
    limit: number,
  ) => Promise<readonly bigint[]>,
  deleteBatch: (tx: Queryable, ids: readonly bigint[]) => Promise<number>,
): Promise<MaintenanceBatchResult> {
  validateNonEmptyIdentifier("jobName", input.jobName);
  validateNonEmptyIdentifier("ownerId", input.ownerId);
  validateOlderThanDays(input.olderThanDays);
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
  validateBatchSize(batchSize);
  const leaseDurationMs = input.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  validateLeaseDurationMs(leaseDurationMs);

  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - input.olderThanDays * MS_PER_DAY);
  const batchIndex = input.batchIndex ?? 0;

  return db.transaction(async (tx) => {
    const leaseResult = await tx.query(
      `SELECT job_name, owner_id, fence_token, lease_expires_at, resume_cursor,
              batches_completed, rows_pruned, last_batch_at, last_completed_at, updated_at
         FROM maintenance_job_lease
        WHERE job_name = $1
          AND owner_id = $2
          AND fence_token = $3::numeric
          AND lease_expires_at > $4::timestamptz
        FOR UPDATE`,
      [input.jobName, input.ownerId, input.fenceToken.toString(), now],
    );
    const rawLease = maybeOne(leaseResult.rows, "maintenance_job_lease fence");
    if (rawLease === null) {
      return {
        leaseLost: true,
        deletedCount: 0,
        hasMore: false,
        resumeCursor: null,
      };
    }

    const currentLease = readMaintenanceLeaseRow(rawLease);
    const candidates = await selectCandidates(tx, currentLease.resumeCursor, cutoff, batchSize + 1);
    const hasMore = candidates.length > batchSize;
    const batchIds = hasMore ? candidates.slice(0, batchSize) : candidates;

    const deletedCount = batchIds.length > 0 ? await deleteBatch(tx, batchIds) : 0;
    const lastBatchId = batchIds[batchIds.length - 1];
    const nextCursor = hasMore && lastBatchId !== undefined ? lastBatchId : 0n;
    const renewedExpiresAt = new Date(now.getTime() + leaseDurationMs);
    const batchIncrement = batchIds.length > 0 ? 1 : 0;

    await tx.query(
      `UPDATE maintenance_job_lease
          SET lease_expires_at = $4::timestamptz,
              resume_cursor = $5::numeric,
              batches_completed = batches_completed + $6::integer,
              rows_pruned = rows_pruned + $7::numeric,
              last_batch_at = CASE WHEN $6::integer > 0 THEN $8::timestamptz ELSE last_batch_at END,
              last_completed_at = CASE WHEN $9::boolean THEN $8::timestamptz ELSE last_completed_at END,
              updated_at = $8::timestamptz
        WHERE job_name = $1
          AND owner_id = $2
          AND fence_token = $3::numeric`,
      [
        input.jobName,
        input.ownerId,
        input.fenceToken.toString(),
        renewedExpiresAt,
        nextCursor.toString(),
        batchIncrement,
        deletedCount.toString(),
        now,
        !hasMore,
      ],
    );

    if (input.onBeforeCommit !== undefined) {
      await input.onBeforeCommit(tx, batchIndex);
    }

    return {
      leaseLost: false,
      deletedCount,
      hasMore,
      resumeCursor: nextCursor,
    };
  });
}

export async function executeAttestationRetentionBatch(
  db: Transactional,
  input: AttestationBatchInput,
): Promise<MaintenanceBatchResult> {
  const requireInboundProvenance = input.requireInboundProvenance ?? false;

  return executeFencedRetentionBatch(
    db,
    input,
    async (tx, resumeCursor, cutoff, limit) => {
      const { rows } = await tx.query(
        `SELECT ra.transfer_id AS candidate_id
           FROM rail_attestation ra
          WHERE ra.transfer_id > $1::bigint
            AND ra.status = 'delivered'
            AND ra.updated_at < $2::timestamptz
            AND (ra.last_checked_at IS NULL OR ra.last_checked_at < $2::timestamptz)
            AND NOT EXISTS (
              SELECT 1
                FROM outbound_transfer ot
                JOIN pending_claim pc
                  ON pc.source_chain = ot.origin_chain
                 AND pc.route = ot.route
                 AND pc.source_nonce = ot.nonce
               WHERE ot.id = ra.transfer_id
                 AND NOT pc.settled
            )
            AND NOT EXISTS (
              SELECT 1
                FROM outbound_transfer ot
                JOIN inbound_delivery idel
                  ON idel.source_chain = ot.origin_chain
                 AND idel.route = ot.route
                 AND idel.source_nonce = ot.nonce
               WHERE ot.id = ra.transfer_id
                 AND NOT idel.delivered
                 AND NOT EXISTS (
                   SELECT 1
                     FROM pending_claim pc2
                    WHERE pc2.chain = idel.destination_chain
                      AND pc2.claim_id = idel.claim_id
                      AND pc2.settled
                 )
            )
            AND (
              NOT $3::boolean
              OR EXISTS (
                SELECT 1
                  FROM outbound_transfer ot
                  JOIN inbound_delivery idel
                    ON idel.source_chain = ot.origin_chain
                   AND idel.route = ot.route
                   AND idel.source_nonce = ot.nonce
                 WHERE ot.id = ra.transfer_id
                   AND idel.delivered
              )
            )
          ORDER BY ra.transfer_id ASC
          LIMIT $4::integer
          FOR UPDATE SKIP LOCKED`,
        [resumeCursor.toString(), cutoff, requireInboundProvenance, limit],
      );
      return rows.map((row) => bigintOf(row, "candidate_id"));
    },
    async (tx, ids) => {
      const placeholders = ids.map((_, index) => `$${index + 1}::bigint`).join(", ");
      const { rowCount } = await tx.query(
        `DELETE FROM rail_attestation WHERE transfer_id IN (${placeholders})`,
        ids.map((id) => id.toString()),
      );
      return rowCount;
    },
  );
}

export async function executeRouteHealthRetentionBatch(
  db: Transactional,
  input: FencedBatchInput,
): Promise<MaintenanceBatchResult> {
  return executeFencedRetentionBatch(
    db,
    input,
    async (tx, resumeCursor, cutoff, limit) => {
      const { rows } = await tx.query(
        `SELECT rh.id AS candidate_id
           FROM route_health rh
          WHERE rh.id > $1::bigint
            AND rh.sampled_at < $2::timestamptz
            AND EXISTS (
              SELECT 1
                FROM route_health newer
               WHERE newer.origin_chain = rh.origin_chain
                 AND newer.destination_chain = rh.destination_chain
                 AND newer.route = rh.route
                 AND newer.token = rh.token
                 AND (
                   newer.sampled_at > rh.sampled_at
                   OR (newer.sampled_at = rh.sampled_at AND newer.id > rh.id)
                 )
            )
          ORDER BY rh.id ASC
          LIMIT $3::integer
          FOR UPDATE SKIP LOCKED`,
        [resumeCursor.toString(), cutoff, limit],
      );
      return rows.map((row) => bigintOf(row, "candidate_id"));
    },
    async (tx, ids) => {
      const placeholders = ids.map((_, index) => `$${index + 1}::bigint`).join(", ");
      const { rowCount } = await tx.query(
        `DELETE FROM route_health WHERE id IN (${placeholders})`,
        ids.map((id) => id.toString()),
      );
      return rowCount;
    },
  );
}

async function runLeasedRetentionLoop(
  db: Transactional,
  jobName: MaintenanceJobName,
  defaultOlderThanDays: number,
  options: MaintenanceJobRunOptions,
  executeBatch: (
    fenceToken: bigint,
    olderThanDays: number,
    batchSize: number,
    leaseDurationMs: number,
    stepNow: Date,
    batchIndex: number,
  ) => Promise<MaintenanceBatchResult>,
): Promise<MaintenanceRunResult> {
  const olderThanDays = options.olderThanDays ?? defaultOlderThanDays;
  validateOlderThanDays(olderThanDays);
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  validateBatchSize(batchSize);
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;
  validateMaxBatches(maxBatches);
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  validateLeaseDurationMs(leaseDurationMs);
  const releaseLeaseOnExit = options.releaseLeaseOnExit ?? true;
  const clock = options.now ?? (() => new Date());

  const acquisition = await acquireMaintenanceLease(db, {
    jobName,
    ownerId: options.ownerId,
    leaseDurationMs,
    now: clock(),
  });

  if (!acquisition.acquired) {
    return {
      jobName,
      ownerId: options.ownerId,
      acquired: false,
      completed: false,
      interrupted: false,
      leaseLost: false,
      fenceToken: null,
      batchesRun: 0,
      deletedCount: 0,
      resumeCursor: null,
    };
  }

  const fenceToken = acquisition.lease.fenceToken;
  let resumeCursor = acquisition.lease.resumeCursor;
  let batchesRun = 0;
  let deletedCount = 0;
  let completed = false;
  let interrupted = false;
  let leaseLost = false;

  try {
    for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
      if (options.signal?.aborted === true) {
        interrupted = true;
        break;
      }

      const stepResult = await executeBatch(
        fenceToken,
        olderThanDays,
        batchSize,
        leaseDurationMs,
        clock(),
        batchIndex,
      );

      if (stepResult.leaseLost) {
        leaseLost = true;
        break;
      }

      batchesRun += 1;
      deletedCount += stepResult.deletedCount;
      resumeCursor = stepResult.resumeCursor ?? 0n;

      if (!stepResult.hasMore) {
        completed = true;
        break;
      }

      if (options.onAfterBatch !== undefined) {
        const shouldContinue = await options.onAfterBatch({
          batchIndex,
          deletedCount: stepResult.deletedCount,
          hasMore: stepResult.hasMore,
          resumeCursor,
          fenceToken,
        });
        if (!shouldContinue) {
          interrupted = true;
          break;
        }
      }
    }

    if (!completed && !leaseLost && !interrupted) {
      interrupted = true;
    }
  } finally {
    if (releaseLeaseOnExit && !leaseLost) {
      await releaseMaintenanceLease(db, {
        jobName,
        ownerId: options.ownerId,
        fenceToken,
        now: clock(),
      });
    }
  }

  return {
    jobName,
    ownerId: options.ownerId,
    acquired: true,
    completed,
    interrupted,
    leaseLost,
    fenceToken,
    batchesRun,
    deletedCount,
    resumeCursor,
  };
}

export async function runAttestationRetentionJob(
  db: Transactional,
  options: AttestationRetentionJobOptions,
): Promise<MaintenanceRunResult> {
  const jobName = options.jobName ?? MAINTENANCE_JOBS.railAttestationRetention;
  return runLeasedRetentionLoop(
    db,
    jobName,
    30,
    options,
    (fenceToken, olderThanDays, batchSize, leaseDurationMs, stepNow, batchIndex) =>
      executeAttestationRetentionBatch(db, {
        jobName,
        ownerId: options.ownerId,
        fenceToken,
        olderThanDays,
        batchSize,
        leaseDurationMs,
        now: stepNow,
        batchIndex,
        ...(options.requireInboundProvenance !== undefined
          ? { requireInboundProvenance: options.requireInboundProvenance }
          : {}),
        ...(options.onBeforeBatchCommit !== undefined
          ? { onBeforeCommit: options.onBeforeBatchCommit }
          : {}),
      }),
  );
}

export async function runRouteHealthRetentionJob(
  db: Transactional,
  options: RouteHealthRetentionJobOptions,
): Promise<MaintenanceRunResult> {
  const jobName = options.jobName ?? MAINTENANCE_JOBS.routeHealthRetention;
  return runLeasedRetentionLoop(
    db,
    jobName,
    14,
    options,
    (fenceToken, olderThanDays, batchSize, leaseDurationMs, stepNow, batchIndex) =>
      executeRouteHealthRetentionBatch(db, {
        jobName,
        ownerId: options.ownerId,
        fenceToken,
        olderThanDays,
        batchSize,
        leaseDurationMs,
        now: stepNow,
        batchIndex,
        ...(options.onBeforeBatchCommit !== undefined
          ? { onBeforeCommit: options.onBeforeBatchCommit }
          : {}),
      }),
  );
}
