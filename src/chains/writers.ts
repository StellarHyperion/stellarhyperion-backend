import { bounded, safeString } from "../rails/axelar/gmp.js";
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
import { createHash } from "node:crypto";
import type { Queryable, Transactional } from "../db/pool.js";
import type { VerificationDiagnostic } from "../rails/axelar/events.js";
import {
  bigintOf,
  boolean,
  integer,
  integerOrNull,
  json,
  maybeOne,
  numericString,
  one,
  text,
  textOrNull,
  timestamp,
  timestampOrNull,
} from "../db/rows.js";
import type { RailRetryClass } from "../rails/types.js";

/** Where on a chain a row was observed. One shape for a ledger and for a block. */
export interface Position {
  readonly chainKey: string;
  /** Present for rows emitted by a watched router; rail evidence has no local router context. */
  readonly router?: string;
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
  /** Exact source row established by a receipt verifier, never by provider status alone. */
  readonly sourceTransferId?: bigint;
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
  const router = at.router ?? "";
  if (router) {
    // Preserve IDs, attestations and delivery links when replay proves a legacy row's deployment.
    await db.query(
      `UPDATE outbound_transfer SET origin_router = $1
        WHERE origin_chain = $2 AND nonce = $3 AND origin_router = ''
          AND origin_tx = $4 AND origin_block = $5
          AND origin_log_index IS NOT DISTINCT FROM $6
          AND sender = $7 AND token = $8 AND gross_amount = $9
          AND fee = $10 AND net_amount = $11 AND route = $12
          AND destination_chain = $13 AND destination = $14
          AND NOT EXISTS (SELECT 1 FROM outbound_transfer known
            WHERE known.origin_chain = $2 AND known.origin_router = $1 AND known.nonce = $3)`,
      [
        router,
        at.chainKey,
        row.nonce.toString(),
        at.txHash,
        at.block.toString(),
        at.logIndex,
        row.sender,
        row.token,
        row.grossAmount.toString(),
        row.fee.toString(),
        row.netAmount.toString(),
        row.route,
        row.destinationChain,
        row.destination,
      ],
    );
  }
  await db.query(
    `INSERT INTO outbound_transfer
       (origin_chain, origin_router, route, nonce, sender, token, gross_amount, fee, net_amount,
        destination_chain, destination, rail_ref, origin_block, origin_tx, origin_log_index,
        observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (origin_chain, origin_router, nonce) DO UPDATE
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
      router,
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
        observed_at, source_transfer_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (destination_chain, route, source_chain, source_nonce, source_transfer_id) DO UPDATE
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
      row.sourceTransferId?.toString() ?? null,
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
  readonly retryAttempts: number;
  readonly nextAttemptAt: Date | null;
  readonly retryClass: RailRetryClass | null;
  readonly diagnostics?: readonly VerificationDiagnostic[];
}

export interface AxelarQuarantineRow {
  readonly transferId: bigint;
  readonly sourceTxHash: string;
  readonly providerReference: string | null;
  readonly schema: string;
  readonly payload: unknown;
}

export interface AxelarDeliveryEvidenceRow {
  readonly transferId: bigint;
  readonly destinationChain: string;
  readonly commandId: string;
  readonly executionTxHash: string;
  readonly receiptBlock: bigint;
  readonly receiptBlockHash: string;
  readonly itsAddress: string;
  readonly tokenId: string;
  readonly registeredToken: string;
  readonly tokenManager: string;
  readonly tokenManagerBlock: bigint;
  readonly tokenManagerBlockHash: string;
  readonly paymentLogIndex: number;
  readonly paymentRecipient: string;
  readonly paymentAmount: bigint;
}

export async function writeAxelarQuarantine(
  db: Queryable,
  row: AxelarQuarantineRow,
): Promise<void> {
  await db.query(
    `INSERT INTO axelar_status_quarantine
       (transfer_id, source_tx_hash, provider_reference, provider_reference_key, schema, payload)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (transfer_id, source_tx_hash, provider_reference_key)
     DO UPDATE SET schema = EXCLUDED.schema,
                   payload = EXCLUDED.payload,
                   last_seen_at = now(),
                   replay_count = axelar_status_quarantine.replay_count + 1`,
    [
      row.transferId.toString(),
      row.sourceTxHash,
      row.providerReference === null ? null : safeString(row.providerReference),
      row.providerReference === null ? "" : safeString(row.providerReference),
      safeString(row.schema),
      JSON.stringify(bounded(row.payload)),
    ],
  );
}

export async function writeAxelarDeliveryEvidence(
  db: Queryable,
  row: AxelarDeliveryEvidenceRow,
): Promise<bigint> {
  await db.query(
    `UPDATE axelar_delivery_evidence
        SET status = 'superseded'
      WHERE transfer_id = $1 AND status = 'canonical'
        AND (command_id, execution_tx_hash, payment_log_index)
            IS DISTINCT FROM ($2, $3, $4)`,
    [row.transferId.toString(), row.commandId, row.executionTxHash, row.paymentLogIndex],
  );
  const { rows } = await db.query(
    `INSERT INTO axelar_delivery_evidence
       (transfer_id, destination_chain, status, command_id, execution_tx_hash, receipt_status,
        receipt_block, receipt_block_hash, its_address, token_id, registered_token, token_manager,
        token_manager_block, token_manager_block_hash, payment_log_index, payment_recipient,
        payment_amount, last_revalidated_at)
     VALUES ($1, $2, 'canonical', $3, $4, 'success', $5, $6, $7, $8, $9, $10, $11, $12,
             $13, $14, $15, now())
     ON CONFLICT (transfer_id, command_id, execution_tx_hash, payment_log_index) DO UPDATE
       SET status = 'canonical',
           destination_chain = EXCLUDED.destination_chain,
           receipt_status = EXCLUDED.receipt_status,
           receipt_block = EXCLUDED.receipt_block,
           receipt_block_hash = EXCLUDED.receipt_block_hash,
           its_address = EXCLUDED.its_address,
           token_id = EXCLUDED.token_id,
           registered_token = EXCLUDED.registered_token,
           token_manager = EXCLUDED.token_manager,
           token_manager_block = EXCLUDED.token_manager_block,
           token_manager_block_hash = EXCLUDED.token_manager_block_hash,
           payment_recipient = EXCLUDED.payment_recipient,
           payment_amount = EXCLUDED.payment_amount,
           last_revalidated_at = now()
     RETURNING id`,
    [
      row.transferId.toString(),
      row.destinationChain,
      row.commandId,
      row.executionTxHash,
      row.receiptBlock.toString(),
      row.receiptBlockHash,
      row.itsAddress,
      row.tokenId,
      row.registeredToken,
      row.tokenManager,
      row.tokenManagerBlock.toString(),
      row.tokenManagerBlockHash,
      row.paymentLogIndex,
      row.paymentRecipient,
      row.paymentAmount.toString(),
    ],
  );
  const id = rows[0]?.id;
  if (typeof id !== "string" && typeof id !== "number" && typeof id !== "bigint")
    throw new Error("Axelar delivery evidence insert did not return its id.");
  return BigInt(id);
}

export async function linkAxelarDeliveryEvidence(
  db: Queryable,
  row: AxelarDeliveryEvidenceRow,
  evidenceId: bigint,
): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE inbound_delivery
        SET axelar_evidence_id = $5
      WHERE destination_chain = $1 AND route = 1
        AND destination_block = $2 AND destination_tx = $3
        AND destination_log_index = $6
        AND delivered = true
        AND (source_chain, source_nonce) =
            (SELECT origin_chain, nonce FROM outbound_transfer WHERE id = $4)`,
    [
      row.destinationChain,
      row.receiptBlock.toString(),
      row.executionTxHash,
      row.transferId.toString(),
      evidenceId.toString(),
      row.paymentLogIndex,
    ],
  );
  if (rowCount !== 1) throw new Error("Axelar evidence did not match its inbound delivery.");
}

export async function writeAttestation(db: Queryable, row: AttestationRow): Promise<void> {
  await db.query(
    `INSERT INTO rail_attestation
       (transfer_id, route, status, rail_status, rail_reference, attested_at, last_checked_at,
        check_failures, last_error, next_attempt_at, retry_class, retry_attempts, diagnostics)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
           retry_attempts = EXCLUDED.retry_attempts,
           next_attempt_at = EXCLUDED.next_attempt_at,
           retry_class = EXCLUDED.retry_class,
           diagnostics = EXCLUDED.diagnostics,
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
      row.nextAttemptAt,
      row.retryClass,
      row.retryAttempts,
      JSON.stringify(row.diagnostics ?? []),
    ],
  );
}

export type DigestRecordKind = "outbound_transfer" | "inbound_delivery" | "pending_claim" | "all";

export interface TokenMonetarySummary {
  readonly outboundGross: string;
  readonly outboundFee: string;
  readonly outboundNet: string;
  readonly inboundAmount: string;
  readonly claimAmount: string;
}

export interface MonetarySummary {
  readonly outboundCount: number;
  readonly inboundCount: number;
  readonly claimCount: number;
  readonly tokens: Readonly<Record<string, TokenMonetarySummary>>;
}

export interface ComputeHistoryDigestOptions {
  readonly chainKey: string;
  readonly startBlock: bigint;
  readonly endBlock: bigint;
  readonly recordKind?: DigestRecordKind;
}

export interface HistoryDigestResult {
  readonly chainKey: string;
  readonly recordKind: DigestRecordKind;
  readonly startBlock: bigint;
  readonly endBlock: bigint;
  readonly rowCount: number;
  readonly digest: string;
  readonly monetarySummary: MonetarySummary;
}

export interface StoredHistoryDigest extends HistoryDigestResult {
  readonly id: bigint;
  readonly computedAt: Date;
}

export interface DigestVerificationResult {
  readonly matches: boolean;
  readonly expectedDigest: string | null;
  readonly actualDigest: string;
  readonly computed: HistoryDigestResult;
}

interface MutableTokenTotals {
  outboundGross: bigint;
  outboundFee: bigint;
  outboundNet: bigint;
  inboundAmount: bigint;
  claimAmount: bigint;
}

function getOrInitTokenTotals(
  map: Map<string, MutableTokenTotals>,
  token: string,
): MutableTokenTotals {
  let entry = map.get(token);
  if (entry === undefined) {
    entry = {
      outboundGross: 0n,
      outboundFee: 0n,
      outboundNet: 0n,
      inboundAmount: 0n,
      claimAmount: 0n,
    };
    map.set(token, entry);
  }
  return entry;
}

/**
 * Compute a deterministic SHA-256 range digest and integer-string monetary summary over indexed
 * event and monetary records in `[startBlock, endBlock]`.
 *
 * Excludes surrogate `id` and `observed_at` timestamps so backfills, replays, and restores
 * produce the exact same digest whenever the underlying chain facts match.
 */
export async function computeHistoryDigest(
  db: Queryable,
  options: ComputeHistoryDigestOptions,
): Promise<HistoryDigestResult> {
  if ("transaction" in db && typeof db.transaction === "function") {
    return (db as Transactional).transaction(async (tx) => {
      await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      return computeHistoryDigestSnapshot(tx, options);
    });
  }
  return computeHistoryDigestSnapshot(db, options);
}

async function* digestPages(
  db: Queryable,
  sql: string,
  params: readonly unknown[],
): AsyncGenerator<readonly Record<string, unknown>[]> {
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { rows } = await db.query(
      sql + ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    );
    if (rows.length === 0) return;
    yield rows;
    if (rows.length < pageSize) return;
  }
}

async function computeHistoryDigestSnapshot(
  db: Queryable,
  options: ComputeHistoryDigestOptions,
): Promise<HistoryDigestResult> {
  const { chainKey, startBlock, endBlock } = options;
  const recordKind: DigestRecordKind = options.recordKind ?? "all";
  if (startBlock < 0n || endBlock < startBlock) {
    throw new RangeError(
      `invalid digest block range [${startBlock.toString()}, ${endBlock.toString()}]`,
    );
  }

  const hash = createHash("sha256");
  hash.update(
    `${JSON.stringify({
      version: 1,
      chainKey,
      recordKind,
      startBlock: startBlock.toString(),
      endBlock: endBlock.toString(),
    })}\n`,
  );

  const tokenMap = new Map<string, MutableTokenTotals>();
  let outboundCount = 0;
  let inboundCount = 0;
  let claimCount = 0;
  let rowCount = 0;

  if (recordKind === "outbound_transfer" || recordKind === "all") {
    for await (const rows of digestPages(
      db,
      `SELECT origin_chain, origin_router, route, nonce, sender, token, gross_amount, fee, net_amount,
              destination_chain, destination, rail_ref, origin_block, origin_tx, origin_log_index
         FROM outbound_transfer
        WHERE origin_chain = $1
          AND origin_block BETWEEN $2 AND $3
        ORDER BY origin_block ASC, origin_router COLLATE "C" ASC, nonce ASC, origin_tx COLLATE "C" ASC, origin_log_index ASC NULLS LAST`,
      [chainKey, startBlock.toString(), endBlock.toString()],
    )) {
      for (const row of rows) {
        const token = text(row, "token");
        const grossAmount = bigintOf(row, "gross_amount");
        const fee = bigintOf(row, "fee");
        const netAmount = bigintOf(row, "net_amount");
        const totals = getOrInitTokenTotals(tokenMap, token);
        totals.outboundGross += grossAmount;
        totals.outboundFee += fee;
        totals.outboundNet += netAmount;
        outboundCount += 1;
        rowCount += 1;

        hash.update(
          `${JSON.stringify({
            kind: "outbound_transfer",
            originChain: text(row, "origin_chain"),
            originRouter: text(row, "origin_router"),
            route: integer(row, "route"),
            nonce: bigintOf(row, "nonce").toString(),
            sender: text(row, "sender"),
            token,
            grossAmount: grossAmount.toString(),
            fee: fee.toString(),
            netAmount: netAmount.toString(),
            destinationChain: text(row, "destination_chain"),
            destination: text(row, "destination"),
            railRef: textOrNull(row, "rail_ref"),
            originBlock: bigintOf(row, "origin_block").toString(),
            originTx: text(row, "origin_tx"),
            originLogIndex: integerOrNull(row, "origin_log_index"),
          })}\n`,
        );
      }
    }
  }

  if (recordKind === "inbound_delivery" || recordKind === "all") {
    for await (const rows of digestPages(
      db,
      `SELECT d.destination_chain, d.route, d.source_chain, d.source_nonce, d.rail_message_id,
              source.origin_router AS source_router, source.origin_tx AS source_origin_tx,
              d.recipient, d.token, d.amount, d.delivered, d.claim_id, d.destination_block, d.destination_tx,
              d.destination_log_index
         FROM inbound_delivery d LEFT JOIN outbound_transfer source ON source.id = d.source_transfer_id
        WHERE d.destination_chain = $1
          AND d.destination_block BETWEEN $2 AND $3
        ORDER BY d.destination_block ASC, d.route ASC, d.source_chain COLLATE "C" ASC, d.source_nonce ASC, source.origin_router COLLATE "C" ASC NULLS FIRST, d.destination_tx COLLATE "C" ASC, d.destination_log_index ASC NULLS LAST`,
      [chainKey, startBlock.toString(), endBlock.toString()],
    )) {
      for (const row of rows) {
        const token = text(row, "token");
        const amount = bigintOf(row, "amount");
        const totals = getOrInitTokenTotals(tokenMap, token);
        totals.inboundAmount += amount;
        inboundCount += 1;
        rowCount += 1;

        const claimIdRaw = row.claim_id;
        hash.update(
          `${JSON.stringify({
            kind: "inbound_delivery",
            destinationChain: text(row, "destination_chain"),
            route: integer(row, "route"),
            sourceChain: text(row, "source_chain"),
            sourceRouter: textOrNull(row, "source_router"),
            sourceOriginTx: textOrNull(row, "source_origin_tx"),
            sourceNonce: bigintOf(row, "source_nonce").toString(),
            railMessageId: textOrNull(row, "rail_message_id"),
            recipient: text(row, "recipient"),
            token,
            amount: amount.toString(),
            delivered: boolean(row, "delivered"),
            claimId:
              claimIdRaw === null || claimIdRaw === undefined
                ? null
                : bigintOf(row, "claim_id").toString(),
            destinationBlock: bigintOf(row, "destination_block").toString(),
            destinationTx: text(row, "destination_tx"),
            destinationLogIndex: integerOrNull(row, "destination_log_index"),
          })}\n`,
        );
      }
    }
  }

  if (recordKind === "pending_claim" || recordKind === "all") {
    for await (const rows of digestPages(
      db,
      `SELECT c.chain, c.claim_id, c.recipient, c.token, c.amount, c.route,
              source.origin_router AS source_router, source.origin_tx AS source_origin_tx,
              c.source_chain, c.source_nonce, c.created_at, c.settled,
              c.settled_at, c.settled_by, c.settled_tx
         FROM pending_claim c
         LEFT JOIN outbound_transfer source ON source.id = c.source_transfer_id
        WHERE c.chain = $1 AND EXISTS (
          SELECT 1 FROM inbound_delivery d
           WHERE d.destination_chain = c.chain AND d.claim_id = c.claim_id
             AND d.route = c.route AND d.source_chain = c.source_chain
             AND d.source_nonce = c.source_nonce
             AND (c.source_transfer_id IS NULL OR c.source_transfer_id = d.source_transfer_id)
             AND d.destination_block BETWEEN $2 AND $3
        )
        ORDER BY c.claim_id ASC`,
      [chainKey, startBlock.toString(), endBlock.toString()],
    )) {
      for (const row of rows) {
        const token = text(row, "token");
        const amount = bigintOf(row, "amount");
        const totals = getOrInitTokenTotals(tokenMap, token);
        totals.claimAmount += amount;
        claimCount += 1;
        rowCount += 1;

        const settledAt = timestampOrNull(row, "settled_at");
        hash.update(
          `${JSON.stringify({
            kind: "pending_claim",
            chain: text(row, "chain"),
            claimId: bigintOf(row, "claim_id").toString(),
            recipient: text(row, "recipient"),
            token,
            amount: amount.toString(),
            route: integer(row, "route"),
            sourceChain: text(row, "source_chain"),
            sourceRouter: textOrNull(row, "source_router"),
            sourceOriginTx: textOrNull(row, "source_origin_tx"),
            sourceNonce: bigintOf(row, "source_nonce").toString(),
            createdAt: timestamp(row, "created_at").toISOString(),
            settled: boolean(row, "settled"),
            settledAt: settledAt ? settledAt.toISOString() : null,
            settledBy: textOrNull(row, "settled_by"),
            settledTx: textOrNull(row, "settled_tx"),
          })}\n`,
        );
      }
    }
  }

  const tokens: Record<string, TokenMonetarySummary> = {};
  for (const token of Array.from(tokenMap.keys()).sort()) {
    const totals = tokenMap.get(token);
    if (totals === undefined) continue;
    tokens[token] = {
      outboundGross: totals.outboundGross.toString(),
      outboundFee: totals.outboundFee.toString(),
      outboundNet: totals.outboundNet.toString(),
      inboundAmount: totals.inboundAmount.toString(),
      claimAmount: totals.claimAmount.toString(),
    };
  }

  return {
    chainKey,
    recordKind,
    startBlock,
    endBlock,
    rowCount,
    digest: hash.digest("hex"),
    monetarySummary: {
      outboundCount,
      inboundCount,
      claimCount,
      tokens,
    },
  };
}

export async function recordHistoryDigest(
  db: Queryable,
  result: HistoryDigestResult,
): Promise<StoredHistoryDigest> {
  const { rows } = await db.query(
    `INSERT INTO indexed_history_digest
       (chain_key, record_kind, start_block, end_block, row_count, digest, monetary_summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (chain_key, record_kind, start_block, end_block) DO UPDATE
       SET row_count = EXCLUDED.row_count,
           digest = EXCLUDED.digest,
           monetary_summary = EXCLUDED.monetary_summary,
           computed_at = now()
     RETURNING id, chain_key, record_kind, start_block, end_block, row_count, digest,
               monetary_summary, computed_at`,
    [
      result.chainKey,
      result.recordKind,
      result.startBlock.toString(),
      result.endBlock.toString(),
      result.rowCount,
      result.digest,
      JSON.stringify(result.monetarySummary),
    ],
  );
  const row = one(rows, "recordHistoryDigest");
  return {
    id: bigintOf(row, "id"),
    chainKey: text(row, "chain_key"),
    recordKind: text(row, "record_kind") as DigestRecordKind,
    startBlock: bigintOf(row, "start_block"),
    endBlock: bigintOf(row, "end_block"),
    rowCount: integer(row, "row_count"),
    digest: text(row, "digest"),
    monetarySummary: json(row, "monetary_summary") as MonetarySummary,
    computedAt: timestamp(row, "computed_at"),
  };
}

export async function verifyHistoryDigest(
  db: Queryable,
  options: ComputeHistoryDigestOptions & { readonly expectedDigest?: string },
): Promise<DigestVerificationResult> {
  const computed = await computeHistoryDigest(db, options);
  let expectedDigest: string | null = options.expectedDigest ?? null;

  if (expectedDigest === null) {
    const { rows } = await db.query(
      `SELECT digest
         FROM indexed_history_digest
        WHERE chain_key = $1
          AND record_kind = $2
          AND start_block = $3
          AND end_block = $4
        LIMIT 1`,
      [
        computed.chainKey,
        computed.recordKind,
        computed.startBlock.toString(),
        computed.endBlock.toString(),
      ],
    );
    const stored = maybeOne(rows, "verifyHistoryDigest");
    expectedDigest = stored ? text(stored, "digest") : null;
  }

  return {
    matches: expectedDigest !== null && computed.digest === expectedDigest,
    expectedDigest,
    actualDigest: computed.digest,
    computed,
  };
}

// --------------------------------------------------------------------------------------------
// Bounded route-health sample compaction (#61)
// --------------------------------------------------------------------------------------------

export interface CompactRouteHealthOptions {
  /** Keep all samples newer than this many hours for recent diagnostic detail. Defaults to 24. */
  readonly retainRecentHours?: number;
  /** Maximum number of redundant interior samples to delete in one bounded pass. Defaults to 1000. */
  readonly batchSize?: number;
}

export interface RouteHealthCompactionResult {
  readonly deleted: number;
}

const DEFAULT_RETAIN_RECENT_HOURS = 24;
const DEFAULT_COMPACTION_BATCH_SIZE = 1_000;
const MAX_COMPACTION_BATCH_SIZE = 50_000;

/**
 * Compact old identical `route_health` samples in a single bounded batch while preserving every
 * configuration/status change boundary and all samples inside the recent diagnostic window.
 */
export async function compactRouteHealthSamples(
  db: Queryable,
  options: CompactRouteHealthOptions = {},
): Promise<RouteHealthCompactionResult> {
  const retainRecentHours = options.retainRecentHours ?? DEFAULT_RETAIN_RECENT_HOURS;
  const batchSize = options.batchSize ?? DEFAULT_COMPACTION_BATCH_SIZE;

  if (!Number.isFinite(retainRecentHours) || retainRecentHours < 0) {
    throw new RangeError(
      `retainRecentHours must be a non-negative finite number, got ${retainRecentHours}`,
    );
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_COMPACTION_BATCH_SIZE) {
    throw new RangeError(
      `batchSize must be an integer between 1 and ${MAX_COMPACTION_BATCH_SIZE}, got ${batchSize}`,
    );
  }

  const { rows } = await db.query(
    `WITH ordered AS (
       SELECT
         id,
         sampled_at,
         available,
         blocker,
         flow_available,
         median_seconds,
         LAG(available) OVER w AS prev_available,
         LAG(blocker) OVER w AS prev_blocker,
         LAG(flow_available) OVER w AS prev_flow_available,
         LAG(median_seconds) OVER w AS prev_median_seconds,
         LEAD(available) OVER w AS next_available,
         LEAD(blocker) OVER w AS next_blocker,
         LEAD(flow_available) OVER w AS next_flow_available,
         LEAD(median_seconds) OVER w AS next_median_seconds,
         ROW_NUMBER() OVER w AS rn
       FROM route_health
       WINDOW w AS (
         PARTITION BY origin_chain, destination_chain, route, token
         ORDER BY sampled_at ASC, id ASC
       )
     ),
     candidates AS (
       SELECT r.id
       FROM ordered
       JOIN route_health r USING (id)
       WHERE ordered.sampled_at < now() - ($1 * INTERVAL '1 hour')
         AND rn > 1
         AND prev_available IS NOT DISTINCT FROM ordered.available
         AND prev_blocker IS NOT DISTINCT FROM ordered.blocker
         AND prev_flow_available IS NOT DISTINCT FROM ordered.flow_available
         AND prev_median_seconds IS NOT DISTINCT FROM ordered.median_seconds
         AND next_available IS NOT DISTINCT FROM ordered.available
         AND next_blocker IS NOT DISTINCT FROM ordered.blocker
         AND next_flow_available IS NOT DISTINCT FROM ordered.flow_available
         AND next_median_seconds IS NOT DISTINCT FROM ordered.median_seconds
       ORDER BY ordered.sampled_at ASC, r.id ASC
       LIMIT $2
       FOR UPDATE OF r SKIP LOCKED
     ),
     deleted AS (
       DELETE FROM route_health
       WHERE id IN (SELECT id FROM candidates)
       RETURNING id
     )
     SELECT count(*)::int AS deleted FROM deleted`,
    [retainRecentHours, batchSize],
  );

  const row = one(rows, "compactRouteHealthSamples");
  return { deleted: integer(row, "deleted") };
}

// --------------------------------------------------------------------------------------------
// Read-only transfer and claim invariant auditor (#59)
// --------------------------------------------------------------------------------------------

export interface SourceAmountViolation {
  readonly kind: "outbound_amount_equation_mismatch" | "inbound_amount_mismatch";
  readonly chainKey: string;
  readonly rowId: string;
  readonly router: string;
  readonly inboundId?: string;
  readonly route: number;
  readonly nonce: string;
  readonly expectedAmount: string;
  readonly actualAmount: string;
  readonly detail: string;
}

export interface ClaimLiabilityViolation {
  readonly kind:
    "parked_delivery_missing_claim" | "parked_delivery_claim_mismatch" | "orphan_pending_claim";
  readonly chainKey: string;
  readonly claimId: string;
  readonly route: number;
  readonly sourceChain: string;
  readonly sourceNonce: string;
  readonly expectedAmount: string | null;
  readonly actualAmount: string | null;
  readonly detail: string;
}

export interface UnsettledClaimLiability {
  readonly chainKey: string;
  readonly token: string;
  readonly openCount: number;
  readonly totalAmount: string;
}

export interface DeliverySettlementViolation {
  readonly kind:
    | "delivered_attestation_without_inbound"
    | "settled_claim_incomplete_metadata"
    | "delivered_inbound_with_claim";
  readonly chainKey: string;
  readonly referenceId: string;
  readonly detail: string;
}

export interface TransferClaimAuditReport {
  readonly ok: boolean;
  readonly sourceAmountViolations: readonly SourceAmountViolation[];
  readonly claimLiabilityViolations: readonly ClaimLiabilityViolation[];
  readonly deliverySettlementViolations: readonly DeliverySettlementViolation[];
  readonly unsettledLiabilities: readonly UnsettledClaimLiability[];
}

/**
 * Run read-only SQL invariant audits for:
 * 1. Source amount conservation (`gross = fee + net`, non-negative amounts, `inbound.amount = outbound.net_amount`).
 * 2. Claim liabilities (parked deliveries <-> pending_claim 1:1 pairing, amounts, and unsettled totals).
 * 3. Delivery/settlement consistency (`rail_attestation.status = 'delivered'` backed by `inbound_delivery`,
 *    complete claim settlement metadata, and no delivered inbound paired with a claim).
 */
export async function auditTransferAndClaimInvariants(
  db: Queryable,
): Promise<TransferClaimAuditReport> {
  const sourceOutboundRes = await db.query(
    `SELECT id, origin_router, origin_chain, route, nonce, gross_amount, fee, net_amount
       FROM outbound_transfer
      WHERE gross_amount <> fee + net_amount
         OR gross_amount < 0
         OR fee < 0
         OR net_amount < 0
      ORDER BY origin_chain, nonce`,
  );

  const sourcePairRes = await db.query(
    `SELECT o.id, o.origin_router, i.id AS inbound_id, o.origin_chain, o.route, o.nonce, o.net_amount, i.amount AS inbound_amount
       FROM outbound_transfer o
       JOIN inbound_delivery i
         ON i.destination_chain = o.destination_chain
        AND i.route = o.route
        AND i.source_chain = o.origin_chain
        AND i.source_nonce = o.nonce
        AND (i.source_transfer_id = o.id OR (i.source_transfer_id IS NULL AND
             (SELECT count(*) FROM outbound_transfer legacy WHERE legacy.origin_chain = o.origin_chain
              AND legacy.route = o.route AND legacy.nonce = o.nonce
              AND legacy.destination_chain = o.destination_chain) = 1))
      WHERE i.amount <> o.net_amount
      ORDER BY o.origin_chain, o.nonce`,
  );

  const sourceAmountViolations: SourceAmountViolation[] = [
    ...sourceOutboundRes.rows.map((row) => ({
      kind: "outbound_amount_equation_mismatch" as const,
      chainKey: text(row, "origin_chain"),
      rowId: numericString(row, "id"),
      router: text(row, "origin_router"),
      route: integer(row, "route"),
      nonce: numericString(row, "nonce"),
      expectedAmount: numericString(row, "gross_amount"),
      actualAmount: `${numericString(row, "fee")}+${numericString(row, "net_amount")}`,
      detail: "outbound_transfer gross_amount must equal fee + net_amount with non-negative values",
    })),
    ...sourcePairRes.rows.map((row) => ({
      kind: "inbound_amount_mismatch" as const,
      inboundId: numericString(row, "inbound_id"),
      chainKey: text(row, "origin_chain"),
      rowId: numericString(row, "id"),
      router: text(row, "origin_router"),
      route: integer(row, "route"),
      nonce: numericString(row, "nonce"),
      expectedAmount: numericString(row, "net_amount"),
      actualAmount: numericString(row, "inbound_amount"),
      detail: "inbound_delivery amount does not match paired outbound_transfer net_amount",
    })),
  ];

  const missingClaimRes = await db.query(
    `SELECT i.destination_chain, i.claim_id, i.route, i.source_chain, i.source_nonce, i.amount
       FROM inbound_delivery i
       LEFT JOIN pending_claim c
         ON c.chain = i.destination_chain
        AND c.claim_id = i.claim_id
      WHERE NOT i.delivered
        AND c.claim_id IS NULL
      ORDER BY i.destination_chain, i.claim_id`,
  );

  const mismatchClaimRes = await db.query(
    `SELECT i.destination_chain, i.claim_id, i.route, i.source_chain, i.source_nonce,
            i.amount AS inbound_amount, c.amount AS claim_amount
       FROM inbound_delivery i
       JOIN pending_claim c
         ON c.chain = i.destination_chain
        AND c.claim_id = i.claim_id
      WHERE NOT i.delivered
        AND (
          c.amount <> i.amount
          OR c.route <> i.route
          OR c.source_chain <> i.source_chain
          OR c.source_nonce <> i.source_nonce
        )
      ORDER BY i.destination_chain, i.claim_id`,
  );

  const orphanClaimRes = await db.query(
    `SELECT c.chain, c.claim_id, c.route, c.source_chain, c.source_nonce, c.amount
       FROM pending_claim c
       LEFT JOIN inbound_delivery i
         ON i.destination_chain = c.chain
        AND i.claim_id = c.claim_id
        AND NOT i.delivered
      WHERE i.id IS NULL
      ORDER BY c.chain, c.claim_id`,
  );

  const claimLiabilityViolations: ClaimLiabilityViolation[] = [
    ...missingClaimRes.rows.map((row) => ({
      kind: "parked_delivery_missing_claim" as const,
      chainKey: text(row, "destination_chain"),
      claimId: numericString(row, "claim_id"),
      route: integer(row, "route"),
      sourceChain: text(row, "source_chain"),
      sourceNonce: numericString(row, "source_nonce"),
      expectedAmount: numericString(row, "amount"),
      actualAmount: null,
      detail: "parked inbound_delivery has no matching pending_claim row",
    })),
    ...mismatchClaimRes.rows.map((row) => ({
      kind: "parked_delivery_claim_mismatch" as const,
      chainKey: text(row, "destination_chain"),
      claimId: numericString(row, "claim_id"),
      route: integer(row, "route"),
      sourceChain: text(row, "source_chain"),
      sourceNonce: numericString(row, "source_nonce"),
      expectedAmount: numericString(row, "inbound_amount"),
      actualAmount: numericString(row, "claim_amount"),
      detail: "pending_claim hop or amount disagrees with parked inbound_delivery",
    })),
    ...orphanClaimRes.rows.map((row) => ({
      kind: "orphan_pending_claim" as const,
      chainKey: text(row, "chain"),
      claimId: numericString(row, "claim_id"),
      route: integer(row, "route"),
      sourceChain: text(row, "source_chain"),
      sourceNonce: numericString(row, "source_nonce"),
      expectedAmount: null,
      actualAmount: numericString(row, "amount"),
      detail: "pending_claim has no matching parked inbound_delivery",
    })),
  ];

  const unsettledRes = await db.query(
    `SELECT chain, token, count(*)::int AS open_count, COALESCE(sum(amount), 0)::numeric AS total_amount
       FROM pending_claim
      WHERE NOT settled
      GROUP BY chain, token
      ORDER BY chain, token`,
  );

  const unsettledLiabilities: UnsettledClaimLiability[] = unsettledRes.rows.map((row) => ({
    chainKey: text(row, "chain"),
    token: text(row, "token"),
    openCount: integer(row, "open_count"),
    totalAmount: numericString(row, "total_amount"),
  }));

  const deliveredAttestationRes = await db.query(
    `SELECT o.origin_chain, a.transfer_id
       FROM rail_attestation a
       JOIN outbound_transfer o ON o.id = a.transfer_id
       LEFT JOIN inbound_delivery i
         ON i.destination_chain = o.destination_chain
        AND i.route = o.route
        AND i.source_chain = o.origin_chain
        AND i.source_nonce = o.nonce
        AND i.delivered
        AND (i.source_transfer_id = o.id OR (i.source_transfer_id IS NULL AND
             (SELECT count(*) FROM outbound_transfer legacy WHERE legacy.origin_chain = o.origin_chain
              AND legacy.route = o.route AND legacy.nonce = o.nonce
              AND legacy.destination_chain = o.destination_chain) = 1))
      WHERE a.status = 'delivered'
        AND i.id IS NULL
      ORDER BY a.transfer_id`,
  );

  const settledClaimMetaRes = await db.query(
    `SELECT chain, claim_id
       FROM pending_claim
      WHERE (settled AND (settled_at IS NULL OR settled_by IS NULL OR settled_tx IS NULL))
         OR (NOT settled AND (settled_at IS NOT NULL OR settled_by IS NOT NULL OR settled_tx IS NOT NULL))
      ORDER BY chain, claim_id`,
  );

  const deliveredWithClaimRes = await db.query(
    `SELECT i.destination_chain, i.id
       FROM inbound_delivery i
      WHERE i.delivered
        AND (
          i.claim_id IS NOT NULL
          OR EXISTS (
            SELECT 1
              FROM pending_claim c
             WHERE c.chain = i.destination_chain
               AND c.route = i.route
               AND c.source_chain = i.source_chain
               AND c.source_nonce = i.source_nonce
          )
        )
      ORDER BY i.destination_chain, i.id`,
  );

  const deliverySettlementViolations: DeliverySettlementViolation[] = [
    ...deliveredAttestationRes.rows.map((row) => ({
      kind: "delivered_attestation_without_inbound" as const,
      chainKey: text(row, "origin_chain"),
      referenceId: numericString(row, "transfer_id"),
      detail: "rail_attestation status is delivered without a corresponding inbound_delivery",
    })),
    ...settledClaimMetaRes.rows.map((row) => ({
      kind: "settled_claim_incomplete_metadata" as const,
      chainKey: text(row, "chain"),
      referenceId: numericString(row, "claim_id"),
      detail:
        "pending_claim settlement flag and settled_at/settled_by/settled_tx metadata are inconsistent",
    })),
    ...deliveredWithClaimRes.rows.map((row) => ({
      kind: "delivered_inbound_with_claim" as const,
      chainKey: text(row, "destination_chain"),
      referenceId: numericString(row, "id"),
      detail: "delivered inbound_delivery is unexpectedly linked to a claim_id or pending_claim",
    })),
  ];

  const ok =
    sourceAmountViolations.length === 0 &&
    claimLiabilityViolations.length === 0 &&
    deliverySettlementViolations.length === 0;

  return {
    ok,
    sourceAmountViolations,
    claimLiabilityViolations,
    deliverySettlementViolations,
    unsettledLiabilities,
  };
}

// --------------------------------------------------------------------------------------------
// Per-deployment expiring database leases (shared across Stellar and EVM watchers, #31 / #46)
// --------------------------------------------------------------------------------------------

export class LeaseLostError extends Error {
  constructor(
    readonly chainKey: string,
    readonly contract: string,
    readonly ownerId: string,
  ) {
    super(`watcher lease lost for ${chainKey} (${contract}) held by ${ownerId}`);
    this.name = "LeaseLostError";
  }
}

export interface WatcherLease {
  readonly chainKey: string;
  readonly contract: string;
  readonly ownerId: string;
  readonly leaseUntil: Date;
}

export async function acquireLease(
  db: Queryable,
  params: {
    readonly chainKey: string;
    readonly contract: string;
    readonly ownerId: string;
    readonly ttlMs: number;
  },
): Promise<WatcherLease | null> {
  const { rows, rowCount } = await db.query(
    `INSERT INTO indexer_lease (chain_key, contract, owner_id, lease_until, updated_at)
     VALUES ($1, $2, $3, now() + ($4 * interval '1 millisecond'), now())
     ON CONFLICT (chain_key, contract) DO UPDATE
       SET owner_id = EXCLUDED.owner_id,
           lease_until = EXCLUDED.lease_until,
           updated_at = now()
       WHERE indexer_lease.lease_until <= now()
          OR indexer_lease.owner_id = EXCLUDED.owner_id
     RETURNING owner_id, lease_until`,
    [params.chainKey, params.contract, params.ownerId, params.ttlMs],
  );
  const row = rows[0];
  if (rowCount === 0 || row === undefined) return null;
  return {
    chainKey: params.chainKey,
    contract: params.contract,
    ownerId: text(row, "owner_id"),
    leaseUntil: timestamp(row, "lease_until"),
  };
}

export async function assertLeaseHeld(
  db: Queryable,
  params: {
    readonly chainKey: string;
    readonly contract: string;
    readonly ownerId: string;
    readonly ttlMs?: number;
  },
): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE indexer_lease
        SET lease_until = CASE
              WHEN $4::bigint IS NULL THEN lease_until
              ELSE clock_timestamp() + ($4 * interval '1 millisecond')
            END,
            updated_at = clock_timestamp()
      WHERE chain_key = $1
        AND contract = $2
        AND owner_id = $3
        AND lease_until > clock_timestamp()
     RETURNING owner_id`,
    [params.chainKey, params.contract, params.ownerId, params.ttlMs ?? null],
  );
  if (rowCount === 0) {
    throw new LeaseLostError(params.chainKey, params.contract, params.ownerId);
  }
}

export async function releaseLease(
  db: Queryable,
  params: {
    readonly chainKey: string;
    readonly contract: string;
    readonly ownerId: string;
  },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `DELETE FROM indexer_lease
      WHERE chain_key = $1 AND contract = $2 AND owner_id = $3`,
    [params.chainKey, params.contract, params.ownerId],
  );
  return rowCount > 0;
}

export { textOrNull };
