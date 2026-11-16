import type { Logger } from "pino";
import type { AppConfig } from "../config/config.js";
import type { Transactional } from "../db/pool.js";

export type KeeperJobName = "ttl-bump" | "claim-settlement";

export type RestoreCheckpointStatus = "pending_broadcast" | "uncertain" | "confirmed" | "failed";

export interface RestoreCheckpointRecord {
  readonly scopeKey: string;
  readonly chain: string;
  readonly jobKind: KeeperJobName;
  readonly claimId: bigint | null;
  readonly restoreTxHash: string;
  readonly footprintKeys: readonly string[];
  readonly minResourceFee: string;
  readonly status: RestoreCheckpointStatus;
  readonly recipientSnapshot: string | null;
  readonly amountSnapshot: string | null;
  readonly lastError: string | null;
}

export interface RestoreCheckpointStore {
  getUnresolved(scopeKey: string): Promise<RestoreCheckpointRecord | null>;
  savePending(record: Omit<RestoreCheckpointRecord, "status" | "lastError">): Promise<void>;
  markStatus(
    scopeKey: string,
    restoreTxHash: string,
    status: RestoreCheckpointStatus,
    lastError?: string | null,
  ): Promise<void>;
}

export interface RestoreExecutionSummary {
  readonly restoredFootprints: number;
  readonly restoredKeys: number;
  readonly restoreTxHashes: readonly string[];
  readonly pendingRestoreHashes: readonly string[];
}

export interface TtlBumpPayload {
  readonly maxClaims?: number | undefined;
  readonly maxTransfers?: number | undefined;
}

export interface ClaimSettlementPayload {
  readonly limit?: number | undefined;
}

export interface TtlBumpResult {
  readonly bumpedTokens: number;
  readonly bumpedClaims: number;
  readonly bumpedTransfers: number;
  readonly dryRun: boolean;
  readonly detail: string;
  readonly restoreSummary?: RestoreExecutionSummary | undefined;
}

export interface ClaimSettlementResult {
  readonly settled: number;
  readonly attempted: number;
  readonly pending: number;
  readonly dryRun: boolean;
  readonly detail: string;
  readonly restoredClaims?: readonly string[] | undefined;
  readonly archivedPendingClaims?: readonly string[] | undefined;
}

export type KeeperJobResult =
  | { readonly kind: "ttl-bump"; readonly result: TtlBumpResult }
  | { readonly kind: "claim-settlement"; readonly result: ClaimSettlementResult };

export interface KeeperContext {
  readonly db: Transactional;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly restoreStore?: RestoreCheckpointStore | undefined;
  readonly pollIntervalMs?: number | undefined;
}
