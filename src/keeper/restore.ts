import { rpc, type xdr } from "@stellar/stellar-sdk";
import type { Queryable } from "../db/pool.js";
import { bigintOf, bigintOrNull, text, textOrNull } from "../db/rows.js";
import type {
  KeeperJobName,
  RestoreCheckpointRecord,
  RestoreCheckpointStatus,
  RestoreCheckpointStore,
} from "./types.js";

export class UncertainRestoreError extends Error {
  readonly scopeKey: string;
  readonly restoreTxHash: string;

  constructor(scopeKey: string, restoreTxHash: string, reason: string) {
    super(
      `Restore transaction ${restoreTxHash} for ${scopeKey} has uncertain outcome (${reason}); reconcile hash before retrying.`,
    );
    this.name = "UncertainRestoreError";
    this.scopeKey = scopeKey;
    this.restoreTxHash = restoreTxHash;
  }
}

export class ArchivedEntryDetectedError extends Error {
  readonly scopeKey: string;
  readonly footprintKeys: readonly string[];

  constructor(scopeKey: string, footprintKeys: readonly string[], reason: string) {
    super(`Archived Soroban ledger entries detected for ${scopeKey}: ${reason}`);
    this.name = "ArchivedEntryDetectedError";
    this.scopeKey = scopeKey;
    this.footprintKeys = footprintKeys;
  }
}

export function isArchivedLookupError(error: unknown): boolean {
  if (error instanceof ArchivedEntryDetectedError || error instanceof UncertainRestoreError) {
    return true;
  }
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("archived") ||
    message.includes("restorepreamble") ||
    message.includes("restore footprint") ||
    message.includes("entry expired") ||
    message.includes("expired ledger")
  );
}

export interface ExtractedRestorePreamble {
  readonly sorobanData: xdr.SorobanTransactionData;
  readonly footprintKeys: readonly string[];
  readonly minResourceFee: string;
}

export function extractRestorePreamble(
  sim: rpc.Api.SimulateTransactionRestoreResponse,
): ExtractedRestorePreamble {
  const sorobanData = sim.restorePreamble.transactionData.build();
  const readWriteKeys = sorobanData.resources.footprint.readWrite.map((key) => key.toXdr("base64"));
  const readOnlyKeys = sorobanData.resources.footprint.readOnly.map((key) => key.toXdr("base64"));
  const footprintKeys = [...readWriteKeys, ...readOnlyKeys];
  const minResourceFee = String(BigInt(sim.restorePreamble.minResourceFee));
  return {
    sorobanData,
    footprintKeys,
    minResourceFee,
  };
}

export function ttlRestoreScopeKey(chain: string): string {
  return `ttl-bump:${chain}`;
}

export function claimRestoreScopeKey(chain: string, claimId: bigint): string {
  return `claim-settlement:${chain}:${String(claimId)}`;
}

export class InMemoryRestoreCheckpointStore implements RestoreCheckpointStore {
  private readonly records = new Map<string, RestoreCheckpointRecord>();

  getUnresolved(scopeKey: string): Promise<RestoreCheckpointRecord | null> {
    const record = this.records.get(scopeKey);
    if (!record) return Promise.resolve(null);
    if (record.status === "pending_broadcast" || record.status === "uncertain") {
      return Promise.resolve(record);
    }
    return Promise.resolve(null);
  }

  savePending(record: Omit<RestoreCheckpointRecord, "status" | "lastError">): Promise<void> {
    this.records.set(record.scopeKey, {
      ...record,
      status: "pending_broadcast",
      lastError: null,
    });
    return Promise.resolve();
  }

  markStatus(
    scopeKey: string,
    restoreTxHash: string,
    status: RestoreCheckpointStatus,
    lastError?: string | null,
  ): Promise<void> {
    const existing = this.records.get(scopeKey);
    if (existing?.restoreTxHash !== restoreTxHash) {
      return Promise.resolve();
    }
    this.records.set(scopeKey, {
      ...existing,
      status,
      lastError: lastError ?? null,
    });
    return Promise.resolve();
  }

  getRecord(scopeKey: string): RestoreCheckpointRecord | null {
    return this.records.get(scopeKey) ?? null;
  }
}

function parseCheckpointRow(row: Record<string, unknown>): RestoreCheckpointRecord {
  const rawKeys = row.footprint_keys;
  let footprintKeys: string[] = [];
  if (Array.isArray(rawKeys)) {
    footprintKeys = rawKeys.map((item) => String(item));
  } else if (typeof rawKeys === "string") {
    const parsed = JSON.parse(rawKeys) as unknown;
    if (Array.isArray(parsed)) {
      footprintKeys = parsed.map((item) => String(item));
    }
  }
  const amountSnapshot = bigintOrNull(row, "amount_snapshot");
  return {
    scopeKey: text(row, "scope_key"),
    chain: text(row, "chain"),
    jobKind: text(row, "job_kind") as KeeperJobName,
    claimId: bigintOrNull(row, "claim_id"),
    restoreTxHash: text(row, "restore_tx_hash"),
    footprintKeys,
    minResourceFee: String(bigintOf(row, "min_resource_fee")),
    status: text(row, "status") as RestoreCheckpointStatus,
    recipientSnapshot: textOrNull(row, "recipient_snapshot"),
    amountSnapshot: amountSnapshot === null ? null : String(amountSnapshot),
    lastError: textOrNull(row, "last_error"),
  };
}

export class PostgresRestoreCheckpointStore implements RestoreCheckpointStore {
  constructor(private readonly db: Queryable) {}

  async getUnresolved(scopeKey: string): Promise<RestoreCheckpointRecord | null> {
    const { rows } = await this.db.query(
      `SELECT scope_key, chain, job_kind, claim_id, restore_tx_hash, footprint_keys,
              min_resource_fee, status, recipient_snapshot, amount_snapshot, last_error
         FROM keeper_restore_checkpoint
        WHERE scope_key = $1
          AND status IN ('pending_broadcast', 'uncertain')`,
      [scopeKey],
    );
    const first = rows[0];
    return first ? parseCheckpointRow(first) : null;
  }

  async savePending(record: Omit<RestoreCheckpointRecord, "status" | "lastError">): Promise<void> {
    await this.db.query(
      `INSERT INTO keeper_restore_checkpoint
         (scope_key, chain, job_kind, claim_id, restore_tx_hash, footprint_keys,
          min_resource_fee, status, recipient_snapshot, amount_snapshot, last_error, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'pending_broadcast', $8, $9, NULL, now())
       ON CONFLICT (scope_key) DO UPDATE SET
         chain = EXCLUDED.chain,
         job_kind = EXCLUDED.job_kind,
         claim_id = EXCLUDED.claim_id,
         restore_tx_hash = EXCLUDED.restore_tx_hash,
         footprint_keys = EXCLUDED.footprint_keys,
         min_resource_fee = EXCLUDED.min_resource_fee,
         status = 'pending_broadcast',
         recipient_snapshot = EXCLUDED.recipient_snapshot,
         amount_snapshot = EXCLUDED.amount_snapshot,
         last_error = NULL,
         updated_at = now()`,
      [
        record.scopeKey,
        record.chain,
        record.jobKind,
        record.claimId === null ? null : String(record.claimId),
        record.restoreTxHash,
        JSON.stringify(record.footprintKeys),
        record.minResourceFee,
        record.recipientSnapshot,
        record.amountSnapshot,
      ],
    );
  }

  async markStatus(
    scopeKey: string,
    restoreTxHash: string,
    status: RestoreCheckpointStatus,
    lastError?: string | null,
  ): Promise<void> {
    await this.db.query(
      `UPDATE keeper_restore_checkpoint
          SET status = $3,
              last_error = $4,
              updated_at = now()
        WHERE scope_key = $1
          AND restore_tx_hash = $2`,
      [scopeKey, restoreTxHash, status, lastError ?? null],
    );
  }
}

export interface ReconcileRestoreOutcome {
  readonly action: "none" | "confirmed_prior" | "failed_prior";
  readonly confirmedTxHash: string | null;
  readonly restoredKeys: number;
  readonly record: RestoreCheckpointRecord | null;
}

export async function reconcilePendingRestore(
  store: RestoreCheckpointStore,
  scopeKey: string,
  getTransaction: (hash: string) => Promise<Pick<rpc.Api.GetTransactionResponse, "status">>,
): Promise<ReconcileRestoreOutcome> {
  const pending = await store.getUnresolved(scopeKey);
  if (!pending) {
    return { action: "none", confirmedTxHash: null, restoredKeys: 0, record: null };
  }

  let txResult: Pick<rpc.Api.GetTransactionResponse, "status">;
  try {
    txResult = await getTransaction(pending.restoreTxHash);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.markStatus(scopeKey, pending.restoreTxHash, "uncertain", message);
    throw new UncertainRestoreError(scopeKey, pending.restoreTxHash, message);
  }

  if (txResult.status === rpc.Api.GetTransactionStatus.SUCCESS) {
    await store.markStatus(scopeKey, pending.restoreTxHash, "confirmed", null);
    return {
      action: "confirmed_prior",
      confirmedTxHash: pending.restoreTxHash,
      restoredKeys: pending.footprintKeys.length,
      record: pending,
    };
  }

  if (txResult.status === rpc.Api.GetTransactionStatus.FAILED) {
    await store.markStatus(
      scopeKey,
      pending.restoreTxHash,
      "failed",
      "Restore transaction failed on chain.",
    );
    return {
      action: "failed_prior",
      confirmedTxHash: null,
      restoredKeys: 0,
      record: pending,
    };
  }

  await store.markStatus(
    scopeKey,
    pending.restoreTxHash,
    "uncertain",
    "Restore transaction status is still NOT_FOUND on RPC.",
  );
  throw new UncertainRestoreError(scopeKey, pending.restoreTxHash, "status NOT_FOUND on RPC");
}
