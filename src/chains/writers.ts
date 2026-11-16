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
  integerOrNull,
  json,
  maybeOne,
  sha256Digest,
  text,
  textOrNull,
  timestamp,
} from "../db/rows.js";

/** Ceiling on stored JSON provenance envelopes (64 KiB) matching the SQL check constraint. */
export const MAX_PROVENANCE_ENVELOPE_BYTES = 65_536;

/** Hard upper bound on rows returned by a single provenance read query. */
export const MAX_PROVENANCE_QUERY_LIMIT = 100;

/** Hard upper bound on telemetry provenance rows pruned per maintenance batch. */
export const MAX_PROVENANCE_PRUNE_BATCH = 5_000;

export type ProvenanceRetentionClass = "monetary" | "telemetry";

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
  /** Optional immutable raw_event_provenance row id backing this materialized write. */
  readonly provenanceId?: bigint | null;
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

function provenanceIdParam(at: Position): string | null {
  return at.provenanceId === undefined || at.provenanceId === null
    ? null
    : at.provenanceId.toString();
}

export async function writeOutbound(db: Queryable, at: Position, row: OutboundRow): Promise<void> {
  await db.query(
    `INSERT INTO outbound_transfer
       (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
        destination_chain, destination, rail_ref, origin_block, origin_tx, origin_log_index,
        observed_at, provenance_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
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
           origin_log_index = EXCLUDED.origin_log_index,
           provenance_id = COALESCE(outbound_transfer.provenance_id, EXCLUDED.provenance_id)`,
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
      provenanceIdParam(at),
    ],
  );
}

export async function writeInbound(db: Queryable, at: Position, row: InboundRow): Promise<void> {
  await db.query(
    `INSERT INTO inbound_delivery
       (destination_chain, route, source_chain, source_nonce, rail_message_id, recipient, token,
        amount, delivered, claim_id, destination_block, destination_tx, destination_log_index,
        observed_at, provenance_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (destination_chain, route, source_chain, source_nonce) DO UPDATE
       SET rail_message_id = COALESCE(EXCLUDED.rail_message_id, inbound_delivery.rail_message_id),
           recipient = EXCLUDED.recipient,
           token = EXCLUDED.token,
           amount = EXCLUDED.amount,
           delivered = EXCLUDED.delivered,
           claim_id = EXCLUDED.claim_id,
           destination_block = EXCLUDED.destination_block,
           destination_tx = EXCLUDED.destination_tx,
           destination_log_index = EXCLUDED.destination_log_index,
           provenance_id = COALESCE(inbound_delivery.provenance_id, EXCLUDED.provenance_id)`,
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
      provenanceIdParam(at),
    ],
  );
}

export async function writeClaim(db: Queryable, at: Position, row: ClaimRow): Promise<void> {
  await db.query(
    `INSERT INTO pending_claim
       (chain, claim_id, recipient, token, amount, route, source_chain, source_nonce,
        created_at, settled, observed_at, provenance_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, $10, $11)
     ON CONFLICT (chain, claim_id) DO UPDATE
       SET recipient = EXCLUDED.recipient,
           token = EXCLUDED.token,
           amount = EXCLUDED.amount,
           route = EXCLUDED.route,
           source_chain = EXCLUDED.source_chain,
           source_nonce = EXCLUDED.source_nonce,
           created_at = EXCLUDED.created_at,
           provenance_id = COALESCE(pending_claim.provenance_id, EXCLUDED.provenance_id)`,
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
      provenanceIdParam(at),
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
       (chain, action_id, kind, state, payload, eta, expires_at, queued_at, observed_at,
        provenance_id)
     VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7, $8, $9)
     ON CONFLICT (chain, action_id) DO UPDATE
       SET kind = EXCLUDED.kind,
           payload = EXCLUDED.payload,
           eta = EXCLUDED.eta,
           expires_at = EXCLUDED.expires_at,
           queued_at = EXCLUDED.queued_at,
           provenance_id = COALESCE(admin_action.provenance_id, EXCLUDED.provenance_id)`,
    [
      at.chainKey,
      row.actionId.toString(),
      row.kind,
      JSON.stringify(row.payload),
      row.eta,
      row.expiresAt,
      at.observedAt,
      at.observedAt,
      provenanceIdParam(at),
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

const SENSITIVE_KEY_PATTERN = /^(?:authorization|api_?key|password|secret|private_?key)$/i;
const URL_CREDENTIALS_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+@)/gi;

function sanitizeProvenanceValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    return value.replace(URL_CREDENTIALS_PATTERN, "$1[REDACTED]@");
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeProvenanceValue(item));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    const normalized: Record<string, unknown> = {};
    for (const [key, entryValue] of entries) {
      if (entryValue === undefined) continue;
      normalized[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? "[REDACTED]"
        : sanitizeProvenanceValue(entryValue);
    }
    return normalized;
  }
  if (typeof value === "symbol") return value.toString();
  return "[unsupported]";
}

export interface CanonicalPayloadDigest {
  readonly digest: string;
  readonly envelopeJson: string;
  readonly truncated: boolean;
}

/**
 * Canonicalizes an event payload into a deterministic JSON envelope and SHA-256 hex digest.
 *
 * The digest always covers the full canonical payload, even when the stored JSON envelope is
 * truncated to fit within MAX_PROVENANCE_ENVELOPE_BYTES.
 */
export function canonicalizePayload(payload: unknown): CanonicalPayloadDigest {
  const normalized = sanitizeProvenanceValue(payload);
  const serialized = JSON.stringify(normalized);
  const digest = createHash("sha256").update(serialized, "utf8").digest("hex");
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength <= MAX_PROVENANCE_ENVELOPE_BYTES) {
    return { digest, envelopeJson: serialized, truncated: false };
  }

  let previewLength = 4_096;
  while (previewLength > 0) {
    const candidate = JSON.stringify({
      originalBytes: byteLength,
      preview: serialized.slice(0, previewLength),
      truncated: true,
    });
    if (Buffer.byteLength(candidate, "utf8") <= MAX_PROVENANCE_ENVELOPE_BYTES) {
      return { digest, envelopeJson: candidate, truncated: true };
    }
    previewLength = Math.floor(previewLength / 2);
  }

  return {
    digest,
    envelopeJson: JSON.stringify({ originalBytes: byteLength, preview: "", truncated: true }),
    truncated: true,
  };
}

export class ProvenanceConflictError extends Error {
  readonly provenanceId: bigint;
  readonly expectedDigest: string;
  readonly observedDigest: string;

  constructor(params: {
    readonly chainKey: string;
    readonly contract: string;
    readonly eventKey: string;
    readonly provenanceId: bigint;
    readonly expectedDigest: string;
    readonly observedDigest: string;
  }) {
    super(
      `conflicting payload digest for ${params.chainKey}/${params.contract}/${params.eventKey}: ` +
        `stored ${params.expectedDigest}, observed ${params.observedDigest}`,
    );
    this.name = "ProvenanceConflictError";
    this.provenanceId = params.provenanceId;
    this.expectedDigest = params.expectedDigest;
    this.observedDigest = params.observedDigest;
  }
}

export interface RawEventProvenanceInput {
  readonly chainKey: string;
  readonly family: "stellar" | "evm";
  readonly contract: string;
  readonly eventKey: string;
  readonly blockNumber: bigint;
  readonly blockHash: string | null;
  readonly txHash: string;
  readonly logIndex: number | null;
  readonly eventTag: string;
  readonly retentionClass: ProvenanceRetentionClass;
  readonly chainTimestamp: Date;
  readonly payload: unknown;
}

export type RawEventProvenanceResult =
  | {
      readonly status: "created" | "existing";
      readonly provenanceId: bigint;
      readonly payloadSha256: string;
    }
  | {
      readonly status: "untracked";
      readonly provenanceId: null;
      readonly payloadSha256: string;
    }
  | {
      readonly status: "conflict";
      readonly provenanceId: bigint;
      readonly payloadSha256: string;
      readonly observedPayloadSha256: string;
    };

/**
 * Persist source event identity and payload digest without allowing conflicting payloads to
 * overwrite original provenance.
 */
export async function recordRawEventProvenance(
  db: Queryable,
  input: RawEventProvenanceInput,
  options: { readonly throwOnConflict?: boolean } = {},
): Promise<RawEventProvenanceResult> {
  const { digest, envelopeJson } = canonicalizePayload(input.payload);
  const inserted = await db.query(
    `INSERT INTO raw_event_provenance
       (chain_key, family, contract, event_key, block_number, block_hash, tx_hash, log_index,
        event_tag, retention_class, payload_sha256, canonical_envelope, chain_timestamp)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
     ON CONFLICT (chain_key, contract, event_key) DO NOTHING
     RETURNING id, payload_sha256`,
    [
      input.chainKey,
      input.family,
      input.contract,
      input.eventKey,
      input.blockNumber.toString(),
      input.blockHash,
      input.txHash,
      input.logIndex,
      input.eventTag,
      input.retentionClass,
      digest,
      envelopeJson,
      input.chainTimestamp,
    ],
  );

  const createdRow = maybeOne(inserted.rows, "inserted raw_event_provenance");
  if (createdRow !== null) {
    return {
      status: "created",
      provenanceId: bigintOf(createdRow, "id"),
      payloadSha256: sha256Digest(createdRow, "payload_sha256"),
    };
  }

  const existing = await db.query(
    `SELECT id, payload_sha256
       FROM raw_event_provenance
      WHERE chain_key = $1 AND contract = $2 AND event_key = $3`,
    [input.chainKey, input.contract, input.eventKey],
  );
  const existingRow = maybeOne(existing.rows, "existing raw_event_provenance");
  if (existingRow === null) {
    return {
      status: "untracked",
      provenanceId: null,
      payloadSha256: digest,
    };
  }

  const provenanceId = bigintOf(existingRow, "id");
  const storedDigest = sha256Digest(existingRow, "payload_sha256");
  if (storedDigest === digest) {
    return {
      status: "existing",
      provenanceId,
      payloadSha256: storedDigest,
    };
  }

  await db.query(
    `INSERT INTO raw_event_provenance_conflict
       (provenance_id, chain_key, contract, event_key, expected_payload_sha256,
        observed_payload_sha256, observed_envelope)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (provenance_id, observed_payload_sha256) DO NOTHING`,
    [
      provenanceId.toString(),
      input.chainKey,
      input.contract,
      input.eventKey,
      storedDigest,
      digest,
      envelopeJson,
    ],
  );

  if (options.throwOnConflict === true) {
    throw new ProvenanceConflictError({
      chainKey: input.chainKey,
      contract: input.contract,
      eventKey: input.eventKey,
      provenanceId,
      expectedDigest: storedDigest,
      observedDigest: digest,
    });
  }

  return {
    status: "conflict",
    provenanceId,
    payloadSha256: storedDigest,
    observedPayloadSha256: digest,
  };
}

export interface ProvenanceQuery {
  readonly chainKey: string;
  readonly contract?: string;
  readonly txHash?: string;
  readonly retentionClass?: ProvenanceRetentionClass;
  readonly afterId?: bigint;
  readonly limit?: number;
  /** Envelopes are omitted by default so routine audit reads only transfer digests and metadata. */
  readonly includeEnvelope?: boolean;
}

export interface RawEventProvenanceRecord {
  readonly id: bigint;
  readonly chainKey: string;
  readonly family: string;
  readonly contract: string;
  readonly eventKey: string;
  readonly blockNumber: bigint;
  readonly blockHash: string | null;
  readonly txHash: string;
  readonly logIndex: number | null;
  readonly eventTag: string;
  readonly retentionClass: ProvenanceRetentionClass;
  readonly payloadSha256: string;
  readonly canonicalEnvelope: unknown;
  readonly chainTimestamp: Date;
  readonly firstObservedAt: Date;
}

/**
 * Bounded internal query helper for audit tools. Requires an explicit chainKey scope and enforces
 * MAX_PROVENANCE_QUERY_LIMIT per call.
 */
export async function listRawEventProvenance(
  db: Queryable,
  query: ProvenanceQuery,
): Promise<readonly RawEventProvenanceRecord[]> {
  if (query.chainKey.trim() === "") {
    throw new RangeError("provenance queries must specify a non-empty chainKey");
  }
  const limit = query.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PROVENANCE_QUERY_LIMIT) {
    throw new RangeError(
      `provenance query limit must be an integer between 1 and ${String(MAX_PROVENANCE_QUERY_LIMIT)}`,
    );
  }

  const conditions = ["chain_key = $1"];
  const params: unknown[] = [query.chainKey];

  if (query.contract !== undefined) {
    params.push(query.contract);
    conditions.push(`contract = $${String(params.length)}`);
  }
  if (query.txHash !== undefined) {
    params.push(query.txHash);
    conditions.push(`tx_hash = $${String(params.length)}`);
  }
  if (query.retentionClass !== undefined) {
    params.push(query.retentionClass);
    conditions.push(`retention_class = $${String(params.length)}`);
  }
  if (query.afterId !== undefined) {
    params.push(query.afterId.toString());
    conditions.push(`id > $${String(params.length)}`);
  }

  params.push(limit);
  const limitParam = `$${String(params.length)}`;
  const envelopeSelect =
    query.includeEnvelope === true ? "canonical_envelope" : "NULL::jsonb AS canonical_envelope";

  const { rows } = await db.query(
    `SELECT id, chain_key, family, contract, event_key, block_number, block_hash, tx_hash,
            log_index, event_tag, retention_class, payload_sha256, ${envelopeSelect},
            chain_timestamp, first_observed_at
       FROM raw_event_provenance
      WHERE ${conditions.join(" AND ")}
      ORDER BY id ASC
      LIMIT ${limitParam}`,
    params,
  );

  return rows.map((row) => {
    const retention = text(row, "retention_class");
    if (retention !== "monetary" && retention !== "telemetry") {
      throw new Error(`unexpected raw_event_provenance.retention_class: ${retention}`);
    }
    return {
      id: bigintOf(row, "id"),
      chainKey: text(row, "chain_key"),
      family: text(row, "family"),
      contract: text(row, "contract"),
      eventKey: text(row, "event_key"),
      blockNumber: bigintOf(row, "block_number"),
      blockHash: textOrNull(row, "block_hash"),
      txHash: text(row, "tx_hash"),
      logIndex: integerOrNull(row, "log_index"),
      eventTag: text(row, "event_tag"),
      retentionClass: retention,
      payloadSha256: sha256Digest(row, "payload_sha256"),
      canonicalEnvelope: query.includeEnvelope === true ? json(row, "canonical_envelope") : null,
      chainTimestamp: timestamp(row, "chain_timestamp"),
      firstObservedAt: timestamp(row, "first_observed_at"),
    };
  });
}

/**
 * Bounded retention cleanup for expired telemetry provenance rows.
 *
 * Monetary provenance rows (transfers, deliveries, claims, and governance actions) are permanently
 * excluded so financial history remains auditable across arbitrary horizons.
 */
export async function pruneRawEventProvenance(
  db: Queryable,
  options: { readonly olderThanDays?: number; readonly batchLimit?: number } = {},
): Promise<number> {
  const olderThanDays = options.olderThanDays ?? 30;
  const batchLimit = options.batchLimit ?? 1_000;
  if (!Number.isFinite(olderThanDays) || olderThanDays < 1) {
    throw new RangeError("olderThanDays must be at least 1");
  }
  if (!Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > MAX_PROVENANCE_PRUNE_BATCH) {
    throw new RangeError(
      `batchLimit must be an integer between 1 and ${String(MAX_PROVENANCE_PRUNE_BATCH)}`,
    );
  }

  const { rowCount } = await db.query(
    `DELETE FROM raw_event_provenance
      WHERE id IN (
        SELECT p.id
          FROM raw_event_provenance p
         WHERE p.retention_class = 'telemetry'
           AND p.first_observed_at < now() - ($1 * INTERVAL '1 day')
           AND NOT EXISTS (
             SELECT 1 FROM raw_event_provenance_conflict c WHERE c.provenance_id = p.id
           )
         ORDER BY p.first_observed_at ASC, p.id ASC
         LIMIT $2
      )`,
    [olderThanDays, batchLimit],
  );
  return rowCount;
}
