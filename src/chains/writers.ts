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
import type { Hash } from "node:crypto";
import type { Queryable } from "../db/pool.js";
import {
  HISTORY_DIGEST_KINDS,
  bigintOf,
  bigintOrNull,
  boolean,
  integer,
  integerOrNull,
  isHistoryDigestKind,
  json,
  maybeOne,
  one,
  readHistoryIntegrityDigestRow,
  text,
  textOrNull,
  timestamp,
  timestampOrNull,
} from "../db/rows.js";
import type { HistoryDigestKind, HistoryIntegrityDigestRow, Row } from "../db/rows.js";

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

export { HISTORY_DIGEST_KINDS };
export type { HistoryDigestKind, HistoryIntegrityDigestRow };

const DIGEST_PROTOCOL_VERSION = "hyperion:history-digest:v1";

export interface HistoryRangeKey {
  readonly chainKey: string;
  readonly recordKind: HistoryDigestKind;
  readonly rangeStart: bigint;
  readonly rangeEnd: bigint;
}

export interface BlockRangeInput {
  readonly chainKey: string;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}

export interface ClaimRangeInput {
  readonly chainKey: string;
  readonly fromClaimId: bigint;
  readonly toClaimId: bigint;
}

export interface ActionRangeInput {
  readonly chainKey: string;
  readonly fromActionId: bigint;
  readonly toActionId: bigint;
}

export interface HistoryRangeDigest {
  readonly chainKey: string;
  readonly recordKind: HistoryDigestKind;
  readonly rangeStart: bigint;
  readonly rangeEnd: bigint;
  readonly rowCount: bigint;
  readonly digestAlgorithm: "sha256";
  readonly digestHex: `0x${string}`;
}

export interface VerifyHistoryRangeInput extends HistoryRangeKey {
  readonly expectedDigestHex?: string;
  readonly expectedRowCount?: bigint;
}

export interface HistoryDigestVerificationResult {
  readonly matches: boolean;
  readonly reason: "matched" | "missing_checkpoint" | "row_count_mismatch" | "digest_mismatch";
  readonly expectedDigestHex: `0x${string}` | null;
  readonly actualDigestHex: `0x${string}`;
  readonly expectedRowCount: bigint | null;
  readonly actualRowCount: bigint;
  readonly computed: HistoryRangeDigest;
}

function validateHistoryRange(
  chainKey: string,
  recordKind: string,
  rangeStart: bigint,
  rangeEnd: bigint,
): asserts recordKind is HistoryDigestKind {
  if (chainKey.trim().length === 0) {
    throw new RangeError("chainKey must be a non-empty string");
  }
  if (!isHistoryDigestKind(recordKind)) {
    throw new RangeError(`Unsupported history digest recordKind: ${recordKind}`);
  }
  if (rangeStart < 0n) {
    throw new RangeError("rangeStart must be non-negative");
  }
  if (rangeEnd < rangeStart) {
    throw new RangeError("rangeEnd must be greater than or equal to rangeStart");
  }
}

function normalizeExpectedDigestHex(raw: string): `0x${string}` {
  const normalized = raw.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new RangeError(`expectedDigestHex must be a 32-byte 0x-prefixed hex string: ${raw}`);
  }
  return normalized as `0x${string}`;
}

/**
 * Deterministic JSON serialization with lexicographically sorted object keys so JSONB column
 * key order in PostgreSQL never alters a record's canonical fact digest.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RangeError("JSON payload cannot contain non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") {
    return JSON.stringify(value.toString(10));
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`Unsupported JSON value of type ${typeof value}`);
}

function appendFramedField(hash: Hash, value: string | null): void {
  if (value === null) {
    hash.update("N\n", "utf8");
    return;
  }
  const byteLength = Buffer.byteLength(value, "utf8");
  hash.update(`S${byteLength}:${value}\n`, "utf8");
}

function createRangeHasher(
  chainKey: string,
  recordKind: HistoryDigestKind,
  rangeStart: bigint,
  rangeEnd: bigint,
): Hash {
  const hash = createHash("sha256");
  appendFramedField(hash, DIGEST_PROTOCOL_VERSION);
  appendFramedField(hash, chainKey);
  appendFramedField(hash, recordKind);
  appendFramedField(hash, rangeStart.toString(10));
  appendFramedField(hash, rangeEnd.toString(10));
  return hash;
}

function finalizeRangeDigest(
  hash: Hash,
  key: HistoryRangeKey,
  rowCount: bigint,
): HistoryRangeDigest {
  hash.update(`C${rowCount.toString(10)}\n`, "utf8");
  const digestHex: `0x${string}` = `0x${hash.digest("hex")}`;
  return {
    chainKey: key.chainKey,
    recordKind: key.recordKind,
    rangeStart: key.rangeStart,
    rangeEnd: key.rangeEnd,
    rowCount,
    digestAlgorithm: "sha256",
    digestHex,
  };
}

function appendOutboundRowFields(hash: Hash, row: Row): void {
  const logIndex = integerOrNull(row, "origin_log_index");
  hash.update("R\n", "utf8");
  appendFramedField(hash, text(row, "origin_chain"));
  appendFramedField(hash, integer(row, "route").toString(10));
  appendFramedField(hash, bigintOf(row, "nonce").toString(10));
  appendFramedField(hash, text(row, "sender"));
  appendFramedField(hash, text(row, "token"));
  appendFramedField(hash, bigintOf(row, "gross_amount").toString(10));
  appendFramedField(hash, bigintOf(row, "fee").toString(10));
  appendFramedField(hash, bigintOf(row, "net_amount").toString(10));
  appendFramedField(hash, text(row, "destination_chain"));
  appendFramedField(hash, text(row, "destination"));
  appendFramedField(hash, textOrNull(row, "rail_ref"));
  appendFramedField(hash, bigintOf(row, "origin_block").toString(10));
  appendFramedField(hash, text(row, "origin_tx"));
  appendFramedField(hash, logIndex === null ? null : logIndex.toString(10));
}

function appendInboundRowFields(hash: Hash, row: Row): void {
  const claimId = bigintOrNull(row, "claim_id");
  const logIndex = integerOrNull(row, "destination_log_index");
  hash.update("R\n", "utf8");
  appendFramedField(hash, text(row, "destination_chain"));
  appendFramedField(hash, integer(row, "route").toString(10));
  appendFramedField(hash, text(row, "source_chain"));
  appendFramedField(hash, bigintOf(row, "source_nonce").toString(10));
  appendFramedField(hash, textOrNull(row, "rail_message_id"));
  appendFramedField(hash, text(row, "recipient"));
  appendFramedField(hash, text(row, "token"));
  appendFramedField(hash, bigintOf(row, "amount").toString(10));
  appendFramedField(hash, boolean(row, "delivered") ? "1" : "0");
  appendFramedField(hash, claimId === null ? null : claimId.toString(10));
  appendFramedField(hash, bigintOf(row, "destination_block").toString(10));
  appendFramedField(hash, text(row, "destination_tx"));
  appendFramedField(hash, logIndex === null ? null : logIndex.toString(10));
}

function appendPendingClaimRowFields(hash: Hash, row: Row): void {
  const settledAt = timestampOrNull(row, "settled_at");
  hash.update("R\n", "utf8");
  appendFramedField(hash, text(row, "chain"));
  appendFramedField(hash, bigintOf(row, "claim_id").toString(10));
  appendFramedField(hash, text(row, "recipient"));
  appendFramedField(hash, text(row, "token"));
  appendFramedField(hash, bigintOf(row, "amount").toString(10));
  appendFramedField(hash, integer(row, "route").toString(10));
  appendFramedField(hash, text(row, "source_chain"));
  appendFramedField(hash, bigintOf(row, "source_nonce").toString(10));
  appendFramedField(hash, timestamp(row, "created_at").getTime().toString(10));
  appendFramedField(hash, boolean(row, "settled") ? "1" : "0");
  appendFramedField(hash, settledAt === null ? null : settledAt.getTime().toString(10));
  appendFramedField(hash, textOrNull(row, "settled_by"));
  appendFramedField(hash, textOrNull(row, "settled_tx"));
}

function appendAdminActionRowFields(hash: Hash, row: Row): void {
  const eta = timestampOrNull(row, "eta");
  const expiresAt = timestampOrNull(row, "expires_at");
  const settledAt = timestampOrNull(row, "settled_at");
  hash.update("R\n", "utf8");
  appendFramedField(hash, text(row, "chain"));
  appendFramedField(hash, bigintOf(row, "action_id").toString(10));
  appendFramedField(hash, integer(row, "kind").toString(10));
  appendFramedField(hash, text(row, "state"));
  appendFramedField(hash, canonicalJson(json(row, "payload")));
  appendFramedField(hash, eta === null ? null : eta.getTime().toString(10));
  appendFramedField(hash, expiresAt === null ? null : expiresAt.getTime().toString(10));
  appendFramedField(hash, timestamp(row, "queued_at").getTime().toString(10));
  appendFramedField(hash, settledAt === null ? null : settledAt.getTime().toString(10));
  appendFramedField(hash, textOrNull(row, "actor"));
}

export async function computeOutboundRangeDigest(
  db: Queryable,
  input: BlockRangeInput,
): Promise<HistoryRangeDigest> {
  validateHistoryRange(input.chainKey, "outbound_transfer", input.fromBlock, input.toBlock);

  const { rows } = await db.query(
    `SELECT origin_chain, route, nonce::text AS nonce, sender, token,
            gross_amount::text AS gross_amount, fee::text AS fee, net_amount::text AS net_amount,
            destination_chain, destination, rail_ref,
            origin_block::text AS origin_block, origin_tx, origin_log_index
       FROM outbound_transfer
      WHERE origin_chain = $1
        AND origin_block >= $2::numeric
        AND origin_block <= $3::numeric
      ORDER BY origin_block ASC, nonce ASC`,
    [input.chainKey, input.fromBlock.toString(10), input.toBlock.toString(10)],
  );

  const hash = createRangeHasher(
    input.chainKey,
    "outbound_transfer",
    input.fromBlock,
    input.toBlock,
  );
  for (const row of rows) {
    appendOutboundRowFields(hash, row);
  }
  return finalizeRangeDigest(
    hash,
    {
      chainKey: input.chainKey,
      recordKind: "outbound_transfer",
      rangeStart: input.fromBlock,
      rangeEnd: input.toBlock,
    },
    BigInt(rows.length),
  );
}

export async function computeInboundRangeDigest(
  db: Queryable,
  input: BlockRangeInput,
): Promise<HistoryRangeDigest> {
  validateHistoryRange(input.chainKey, "inbound_delivery", input.fromBlock, input.toBlock);

  const { rows } = await db.query(
    `SELECT destination_chain, route, source_chain, source_nonce::text AS source_nonce,
            rail_message_id, recipient, token, amount::text AS amount, delivered,
            claim_id::text AS claim_id, destination_block::text AS destination_block,
            destination_tx, destination_log_index
       FROM inbound_delivery
      WHERE destination_chain = $1
        AND destination_block >= $2::numeric
        AND destination_block <= $3::numeric
      ORDER BY destination_block ASC, route ASC, source_chain ASC, source_nonce ASC`,
    [input.chainKey, input.fromBlock.toString(10), input.toBlock.toString(10)],
  );

  const hash = createRangeHasher(
    input.chainKey,
    "inbound_delivery",
    input.fromBlock,
    input.toBlock,
  );
  for (const row of rows) {
    appendInboundRowFields(hash, row);
  }
  return finalizeRangeDigest(
    hash,
    {
      chainKey: input.chainKey,
      recordKind: "inbound_delivery",
      rangeStart: input.fromBlock,
      rangeEnd: input.toBlock,
    },
    BigInt(rows.length),
  );
}

export async function computePendingClaimRangeDigest(
  db: Queryable,
  input: ClaimRangeInput,
): Promise<HistoryRangeDigest> {
  validateHistoryRange(input.chainKey, "pending_claim", input.fromClaimId, input.toClaimId);

  const { rows } = await db.query(
    `SELECT chain, claim_id::text AS claim_id, recipient, token, amount::text AS amount,
            route, source_chain, source_nonce::text AS source_nonce, created_at,
            settled, settled_at, settled_by, settled_tx
       FROM pending_claim
      WHERE chain = $1
        AND claim_id >= $2::numeric
        AND claim_id <= $3::numeric
      ORDER BY claim_id ASC`,
    [input.chainKey, input.fromClaimId.toString(10), input.toClaimId.toString(10)],
  );

  const hash = createRangeHasher(
    input.chainKey,
    "pending_claim",
    input.fromClaimId,
    input.toClaimId,
  );
  for (const row of rows) {
    appendPendingClaimRowFields(hash, row);
  }
  return finalizeRangeDigest(
    hash,
    {
      chainKey: input.chainKey,
      recordKind: "pending_claim",
      rangeStart: input.fromClaimId,
      rangeEnd: input.toClaimId,
    },
    BigInt(rows.length),
  );
}

export async function computeAdminActionRangeDigest(
  db: Queryable,
  input: ActionRangeInput,
): Promise<HistoryRangeDigest> {
  validateHistoryRange(input.chainKey, "admin_action", input.fromActionId, input.toActionId);

  const { rows } = await db.query(
    `SELECT chain, action_id::text AS action_id, kind, state, payload,
            eta, expires_at, queued_at, settled_at, actor
       FROM admin_action
      WHERE chain = $1
        AND action_id >= $2::numeric
        AND action_id <= $3::numeric
      ORDER BY action_id ASC`,
    [input.chainKey, input.fromActionId.toString(10), input.toActionId.toString(10)],
  );

  const hash = createRangeHasher(
    input.chainKey,
    "admin_action",
    input.fromActionId,
    input.toActionId,
  );
  for (const row of rows) {
    appendAdminActionRowFields(hash, row);
  }
  return finalizeRangeDigest(
    hash,
    {
      chainKey: input.chainKey,
      recordKind: "admin_action",
      rangeStart: input.fromActionId,
      rangeEnd: input.toActionId,
    },
    BigInt(rows.length),
  );
}

async function computeChainBlockRollupDigest(
  db: Queryable,
  input: BlockRangeInput,
): Promise<HistoryRangeDigest> {
  const outbound = await computeOutboundRangeDigest(db, input);
  const inbound = await computeInboundRangeDigest(db, input);

  const { rows: parkedClaims } = await db.query(
    `SELECT pc.chain, pc.claim_id::text AS claim_id, pc.recipient, pc.token,
            pc.amount::text AS amount, pc.route, pc.source_chain,
            pc.source_nonce::text AS source_nonce, pc.created_at,
            pc.settled, pc.settled_at, pc.settled_by, pc.settled_tx
       FROM pending_claim pc
      WHERE pc.chain = $1
        AND EXISTS (
          SELECT 1
            FROM inbound_delivery idel
           WHERE idel.destination_chain = pc.chain
             AND idel.claim_id = pc.claim_id
             AND idel.destination_block >= $2::numeric
             AND idel.destination_block <= $3::numeric
        )
      ORDER BY pc.claim_id ASC`,
    [input.chainKey, input.fromBlock.toString(10), input.toBlock.toString(10)],
  );

  const hash = createRangeHasher(input.chainKey, "chain_range", input.fromBlock, input.toBlock);
  appendFramedField(hash, outbound.digestHex);
  appendFramedField(hash, outbound.rowCount.toString(10));
  appendFramedField(hash, inbound.digestHex);
  appendFramedField(hash, inbound.rowCount.toString(10));
  for (const claimRow of parkedClaims) {
    appendPendingClaimRowFields(hash, claimRow);
  }

  const totalRows = outbound.rowCount + inbound.rowCount + BigInt(parkedClaims.length);
  return finalizeRangeDigest(
    hash,
    {
      chainKey: input.chainKey,
      recordKind: "chain_range",
      rangeStart: input.fromBlock,
      rangeEnd: input.toBlock,
    },
    totalRows,
  );
}

export async function computeHistoryRangeDigest(
  db: Queryable,
  key: HistoryRangeKey,
): Promise<HistoryRangeDigest> {
  validateHistoryRange(key.chainKey, key.recordKind, key.rangeStart, key.rangeEnd);

  switch (key.recordKind) {
    case "outbound_transfer":
      return computeOutboundRangeDigest(db, {
        chainKey: key.chainKey,
        fromBlock: key.rangeStart,
        toBlock: key.rangeEnd,
      });
    case "inbound_delivery":
      return computeInboundRangeDigest(db, {
        chainKey: key.chainKey,
        fromBlock: key.rangeStart,
        toBlock: key.rangeEnd,
      });
    case "pending_claim":
      return computePendingClaimRangeDigest(db, {
        chainKey: key.chainKey,
        fromClaimId: key.rangeStart,
        toClaimId: key.rangeEnd,
      });
    case "admin_action":
      return computeAdminActionRangeDigest(db, {
        chainKey: key.chainKey,
        fromActionId: key.rangeStart,
        toActionId: key.rangeEnd,
      });
    case "chain_range":
      return computeChainBlockRollupDigest(db, {
        chainKey: key.chainKey,
        fromBlock: key.rangeStart,
        toBlock: key.rangeEnd,
      });
  }
}

export async function writeHistoryIntegrityDigest(
  db: Queryable,
  digest: HistoryRangeDigest,
  computedAt: Date = new Date(),
): Promise<HistoryIntegrityDigestRow> {
  validateHistoryRange(digest.chainKey, digest.recordKind, digest.rangeStart, digest.rangeEnd);
  const normalizedDigest = normalizeExpectedDigestHex(digest.digestHex);

  const { rows } = await db.query(
    `INSERT INTO history_integrity_digest
       (chain_key, record_kind, range_start, range_end, row_count, digest_algorithm, digest_hex, computed_at)
     VALUES ($1, $2, $3::numeric, $4::numeric, $5::numeric, 'sha256', $6, $7::timestamptz)
     ON CONFLICT (chain_key, record_kind, range_start, range_end) DO UPDATE
       SET row_count = EXCLUDED.row_count,
           digest_algorithm = EXCLUDED.digest_algorithm,
           digest_hex = EXCLUDED.digest_hex,
           computed_at = EXCLUDED.computed_at
     RETURNING chain_key, record_kind, range_start::text AS range_start,
               range_end::text AS range_end, row_count::text AS row_count,
               digest_algorithm, digest_hex, computed_at`,
    [
      digest.chainKey,
      digest.recordKind,
      digest.rangeStart.toString(10),
      digest.rangeEnd.toString(10),
      digest.rowCount.toString(10),
      normalizedDigest,
      computedAt,
    ],
  );

  return readHistoryIntegrityDigestRow(one(rows, "history_integrity_digest upsert"));
}

export async function getHistoryIntegrityDigest(
  db: Queryable,
  key: HistoryRangeKey,
): Promise<HistoryIntegrityDigestRow | null> {
  validateHistoryRange(key.chainKey, key.recordKind, key.rangeStart, key.rangeEnd);

  const { rows } = await db.query(
    `SELECT chain_key, record_kind, range_start::text AS range_start,
            range_end::text AS range_end, row_count::text AS row_count,
            digest_algorithm, digest_hex, computed_at
       FROM history_integrity_digest
      WHERE chain_key = $1
        AND record_kind = $2
        AND range_start = $3::numeric
        AND range_end = $4::numeric`,
    [key.chainKey, key.recordKind, key.rangeStart.toString(10), key.rangeEnd.toString(10)],
  );

  const row = maybeOne(rows, "history_integrity_digest get");
  return row === null ? null : readHistoryIntegrityDigestRow(row);
}

export async function recordHistoryRangeDigest(
  db: Queryable,
  key: HistoryRangeKey,
  computedAt: Date = new Date(),
): Promise<HistoryIntegrityDigestRow> {
  const computed = await computeHistoryRangeDigest(db, key);
  return writeHistoryIntegrityDigest(db, computed, computedAt);
}

export async function verifyHistoryRangeDigest(
  db: Queryable,
  input: VerifyHistoryRangeInput,
): Promise<HistoryDigestVerificationResult> {
  const computed = await computeHistoryRangeDigest(db, input);

  let expectedDigestHex: `0x${string}` | null = null;
  let expectedRowCount: bigint | null = null;

  if (input.expectedDigestHex !== undefined) {
    expectedDigestHex = normalizeExpectedDigestHex(input.expectedDigestHex);
    expectedRowCount = input.expectedRowCount ?? null;
  } else {
    const stored = await getHistoryIntegrityDigest(db, input);
    if (stored === null) {
      return {
        matches: false,
        reason: "missing_checkpoint",
        expectedDigestHex: null,
        actualDigestHex: computed.digestHex,
        expectedRowCount: null,
        actualRowCount: computed.rowCount,
        computed,
      };
    }
    expectedDigestHex = stored.digestHex;
    expectedRowCount = input.expectedRowCount ?? stored.rowCount;
  }

  if (expectedRowCount !== null && expectedRowCount !== computed.rowCount) {
    return {
      matches: false,
      reason: "row_count_mismatch",
      expectedDigestHex,
      actualDigestHex: computed.digestHex,
      expectedRowCount,
      actualRowCount: computed.rowCount,
      computed,
    };
  }

  if (expectedDigestHex !== computed.digestHex) {
    return {
      matches: false,
      reason: "digest_mismatch",
      expectedDigestHex,
      actualDigestHex: computed.digestHex,
      expectedRowCount,
      actualRowCount: computed.rowCount,
      computed,
    };
  }

  return {
    matches: true,
    reason: "matched",
    expectedDigestHex,
    actualDigestHex: computed.digestHex,
    expectedRowCount,
    actualRowCount: computed.rowCount,
    computed,
  };
}
