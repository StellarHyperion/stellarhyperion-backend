import type { Queryable } from "../db/pool.js";
import {
  bigintOf,
  bigintOrNull,
  integer,
  maybeOne,
  one,
  text,
  textOrNull,
  timestamp,
  type Row,
} from "../db/rows.js";
import type {
  KeeperCheckpointState,
  KeeperJobName,
  KeeperTxCheckpointRecord,
  SaveSignedCheckpointInput,
  TxCheckpointStorePort,
} from "./types.js";

const STELLAR_SECRET_RE = /\bS[A-Z2-7]{55}\b/g;
const HEX_PRIVATE_KEY_RE = /\b0x[0-9a-fA-F]{64}\b/g;
const BASE64_ENVELOPE_RE = /\b[A-Za-z0-9+/]{80,}={0,2}\b/g;

/**
 * Scrubs any accidental secret seed, private key or raw base64 signed envelope
 * from diagnostic strings before persisting or logging.
 */
export function sanitizeCheckpointError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unknown keeper submission error.";
  return raw
    .replace(STELLAR_SECRET_RE, "[REDACTED_STELLAR_SECRET]")
    .replace(HEX_PRIVATE_KEY_RE, "[REDACTED_PRIVATE_KEY]")
    .replace(BASE64_ENVELOPE_RE, "[REDACTED_SIGNED_ENVELOPE]");
}

export function buildKeeperOperationKey(
  jobKind: KeeperJobName,
  chain: string,
  claimId?: bigint | null,
): string {
  if (jobKind === "claim-settlement") {
    if (claimId === null || claimId === undefined) {
      throw new Error("claim-settlement operation key requires a claimId.");
    }
    return `claim-settlement:${chain}:${String(claimId)}`;
  }
  return `ttl-bump:${chain}`;
}

export class UncertainBroadcastError extends Error {
  readonly operationKey: string;
  readonly txHash: string;
  readonly state: "signed_pending_broadcast" | "broadcast_unknown";
  readonly reason: string;

  constructor(
    operationKey: string,
    txHash: string,
    state: "signed_pending_broadcast" | "broadcast_unknown",
    reason: string,
  ) {
    const safeReason = sanitizeCheckpointError(reason);
    super(
      `Keeper broadcast outcome uncertain for ${operationKey} (txHash=${txHash}, state=${state}): ${safeReason}`,
    );
    this.name = "UncertainBroadcastError";
    this.operationKey = operationKey;
    this.txHash = txHash;
    this.state = state;
    this.reason = safeReason;
  }
}

export class UnresolvedCheckpointConflictError extends Error {
  readonly operationKey: string;
  readonly existingTxHash: string;

  constructor(operationKey: string, existingTxHash: string) {
    super(
      `Cannot overwrite unresolved keeper checkpoint ${operationKey} (saved txHash=${existingTxHash}) before reconciling its on-chain outcome.`,
    );
    this.name = "UnresolvedCheckpointConflictError";
    this.operationKey = operationKey;
    this.existingTxHash = existingTxHash;
  }
}

function parseJobKind(raw: string): KeeperJobName {
  if (raw === "ttl-bump" || raw === "claim-settlement") {
    return raw;
  }
  throw new Error(`Invalid keeper checkpoint job_kind: ${raw}`);
}

function parseCheckpointState(raw: string): KeeperCheckpointState {
  if (
    raw === "signed_pending_broadcast" ||
    raw === "broadcast_unknown" ||
    raw === "confirmed" ||
    raw === "failed"
  ) {
    return raw;
  }
  throw new Error(`Invalid keeper checkpoint state: ${raw}`);
}

function parseCheckpointRow(row: Row): KeeperTxCheckpointRecord {
  return {
    operationKey: text(row, "operation_key"),
    txHash: text(row, "tx_hash"),
    chain: text(row, "chain"),
    jobKind: parseJobKind(text(row, "job_kind")),
    claimId: bigintOrNull(row, "claim_id"),
    contract: text(row, "contract"),
    method: text(row, "method"),
    signerPublicKey: text(row, "signer_public_key"),
    sequenceNumber: bigintOf(row, "sequence_number"),
    feeStroops: bigintOf(row, "fee_stroops"),
    state: parseCheckpointState(text(row, "state")),
    lastError: textOrNull(row, "last_error"),
    createdAt: timestamp(row, "created_at"),
    updatedAt: timestamp(row, "updated_at"),
  };
}

export class PostgresTxCheckpointStore implements TxCheckpointStorePort {
  constructor(private readonly db: Queryable) {}

  async getByOperationKey(operationKey: string): Promise<KeeperTxCheckpointRecord | null> {
    const { rows } = await this.db.query(
      `SELECT operation_key, tx_hash, chain, job_kind, claim_id, contract, method,
              signer_public_key, sequence_number, fee_stroops, state, last_error,
              created_at, updated_at
         FROM keeper_tx_checkpoint
        WHERE operation_key = $1`,
      [operationKey],
    );
    const row = maybeOne(rows, "keeper_tx_checkpoint.getByOperationKey");
    return row ? parseCheckpointRow(row) : null;
  }

  async saveSignedBeforeBroadcast(
    input: SaveSignedCheckpointInput,
  ): Promise<KeeperTxCheckpointRecord> {
    const { rows } = await this.db.query(
      `INSERT INTO keeper_tx_checkpoint (
         operation_key, tx_hash, chain, job_kind, claim_id, contract, method,
         signer_public_key, sequence_number, fee_stroops, state, last_error,
         created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'signed_pending_broadcast', NULL, now(), now())
       ON CONFLICT (operation_key) DO UPDATE SET
         tx_hash = EXCLUDED.tx_hash,
         chain = EXCLUDED.chain,
         job_kind = EXCLUDED.job_kind,
         claim_id = EXCLUDED.claim_id,
         contract = EXCLUDED.contract,
         method = EXCLUDED.method,
         signer_public_key = EXCLUDED.signer_public_key,
         sequence_number = EXCLUDED.sequence_number,
         fee_stroops = EXCLUDED.fee_stroops,
         state = 'signed_pending_broadcast',
         last_error = NULL,
         updated_at = now()
       WHERE keeper_tx_checkpoint.state NOT IN ('signed_pending_broadcast', 'broadcast_unknown')
          OR keeper_tx_checkpoint.tx_hash = EXCLUDED.tx_hash
       RETURNING operation_key, tx_hash, chain, job_kind, claim_id, contract, method,
                 signer_public_key, sequence_number, fee_stroops, state, last_error,
                 created_at, updated_at`,
      [
        input.operationKey,
        input.txHash,
        input.chain,
        input.jobKind,
        input.claimId === null ? null : String(input.claimId),
        input.contract,
        input.method,
        input.signerPublicKey,
        String(input.sequenceNumber),
        String(input.feeStroops),
      ],
    );
    if (rows.length === 0) {
      const existing = await this.getByOperationKey(input.operationKey);
      throw new UnresolvedCheckpointConflictError(
        input.operationKey,
        existing?.txHash ?? "unknown",
      );
    }
    return parseCheckpointRow(one(rows, "keeper_tx_checkpoint.saveSignedBeforeBroadcast"));
  }

  async markBroadcastUnknown(operationKey: string, txHash: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE keeper_tx_checkpoint
          SET state = 'broadcast_unknown',
              last_error = $3,
              updated_at = now()
        WHERE operation_key = $1 AND tx_hash = $2`,
      [operationKey, txHash, sanitizeCheckpointError(reason)],
    );
  }

  async markConfirmed(operationKey: string, txHash: string): Promise<void> {
    await this.db.query(
      `UPDATE keeper_tx_checkpoint
          SET state = 'confirmed',
              last_error = NULL,
              updated_at = now()
        WHERE operation_key = $1 AND tx_hash = $2`,
      [operationKey, txHash],
    );
  }

  async markFailed(operationKey: string, txHash: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE keeper_tx_checkpoint
          SET state = 'failed',
              last_error = $3,
              updated_at = now()
        WHERE operation_key = $1 AND tx_hash = $2`,
      [operationKey, txHash, sanitizeCheckpointError(reason)],
    );
  }

  async countUnresolved(chain?: string): Promise<number> {
    if (chain !== undefined) {
      const { rows } = await this.db.query(
        `SELECT COUNT(*)::int AS unresolved_count
           FROM keeper_tx_checkpoint
          WHERE chain = $1 AND state IN ('signed_pending_broadcast', 'broadcast_unknown')`,
        [chain],
      );
      return integer(one(rows, "keeper_tx_checkpoint.countUnresolved"), "unresolved_count");
    }
    const { rows } = await this.db.query(
      `SELECT COUNT(*)::int AS unresolved_count
         FROM keeper_tx_checkpoint
        WHERE state IN ('signed_pending_broadcast', 'broadcast_unknown')`,
    );
    return integer(one(rows, "keeper_tx_checkpoint.countUnresolved"), "unresolved_count");
  }
}

export class InMemoryTxCheckpointStore implements TxCheckpointStorePort {
  private readonly records = new Map<string, KeeperTxCheckpointRecord>();

  getByOperationKey(operationKey: string): Promise<KeeperTxCheckpointRecord | null> {
    return Promise.resolve(this.records.get(operationKey) ?? null);
  }

  saveSignedBeforeBroadcast(input: SaveSignedCheckpointInput): Promise<KeeperTxCheckpointRecord> {
    const existing = this.records.get(input.operationKey);
    if (
      existing &&
      (existing.state === "signed_pending_broadcast" || existing.state === "broadcast_unknown") &&
      existing.txHash !== input.txHash
    ) {
      return Promise.reject(
        new UnresolvedCheckpointConflictError(input.operationKey, existing.txHash),
      );
    }
    const now = new Date();
    const record: KeeperTxCheckpointRecord = {
      ...input,
      state: "signed_pending_broadcast",
      lastError: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.records.set(input.operationKey, record);
    return Promise.resolve(record);
  }

  markBroadcastUnknown(operationKey: string, txHash: string, reason: string): Promise<void> {
    const existing = this.records.get(operationKey);
    if (existing?.txHash === txHash) {
      this.records.set(operationKey, {
        ...existing,
        state: "broadcast_unknown",
        lastError: sanitizeCheckpointError(reason),
        updatedAt: new Date(),
      });
    }
    return Promise.resolve();
  }

  markConfirmed(operationKey: string, txHash: string): Promise<void> {
    const existing = this.records.get(operationKey);
    if (existing?.txHash === txHash) {
      this.records.set(operationKey, {
        ...existing,
        state: "confirmed",
        lastError: null,
        updatedAt: new Date(),
      });
    }
    return Promise.resolve();
  }

  markFailed(operationKey: string, txHash: string, reason: string): Promise<void> {
    const existing = this.records.get(operationKey);
    if (existing?.txHash === txHash) {
      this.records.set(operationKey, {
        ...existing,
        state: "failed",
        lastError: sanitizeCheckpointError(reason),
        updatedAt: new Date(),
      });
    }
    return Promise.resolve();
  }

  countUnresolved(chain?: string): Promise<number> {
    let count = 0;
    for (const record of this.records.values()) {
      if (chain !== undefined && record.chain !== chain) continue;
      if (record.state === "signed_pending_broadcast" || record.state === "broadcast_unknown") {
        count += 1;
      }
    }
    return Promise.resolve(count);
  }
}
