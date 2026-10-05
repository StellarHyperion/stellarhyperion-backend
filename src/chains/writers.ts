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
import type { Queryable } from "../db/pool.js";

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
