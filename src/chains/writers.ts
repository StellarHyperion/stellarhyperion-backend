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
import type { Queryable } from "../db/pool.js";
import {
  bigintOf,
  boolean,
  integer,
  integerOrNull,
  json,
  maybeOne,
  one,
  text,
  textOrNull,
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
    const { rows } = await db.query(
      `SELECT origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
              destination_chain, destination, rail_ref, origin_block, origin_tx, origin_log_index
         FROM outbound_transfer
        WHERE origin_chain = $1
          AND origin_block BETWEEN $2 AND $3
        ORDER BY origin_block ASC, nonce ASC`,
      [chainKey, startBlock.toString(), endBlock.toString()],
    );
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

  if (recordKind === "inbound_delivery" || recordKind === "all") {
    const { rows } = await db.query(
      `SELECT destination_chain, route, source_chain, source_nonce, rail_message_id,
              recipient, token, amount, delivered, claim_id, destination_block, destination_tx,
              destination_log_index
         FROM inbound_delivery
        WHERE destination_chain = $1
          AND destination_block BETWEEN $2 AND $3
        ORDER BY destination_block ASC, route ASC, source_chain ASC, source_nonce ASC`,
      [chainKey, startBlock.toString(), endBlock.toString()],
    );
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

  if (recordKind === "pending_claim" || recordKind === "all") {
    const { rows } = await db.query(
      `SELECT c.chain, c.claim_id, c.recipient, c.token, c.amount, c.route,
              c.source_chain, c.source_nonce, c.created_at, c.settled,
              c.settled_at, c.settled_by, c.settled_tx
         FROM pending_claim c
         INNER JOIN inbound_delivery d
           ON d.destination_chain = c.chain
          AND d.claim_id = c.claim_id
        WHERE c.chain = $1
          AND d.destination_block BETWEEN $2 AND $3
        ORDER BY d.destination_block ASC, c.claim_id ASC`,
      [chainKey, startBlock.toString(), endBlock.toString()],
    );
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
