import type { Logger } from "pino";
import type { AppConfig } from "../config/config.js";
import type { Transactional } from "../db/pool.js";

export type KeeperJobName = "ttl-bump" | "claim-settlement";

export type KeeperCheckpointState =
  "signed_pending_broadcast" | "broadcast_unknown" | "confirmed" | "failed";

export interface KeeperIntendedOperation {
  readonly operationKey: string;
  readonly chain: string;
  readonly jobKind: KeeperJobName;
  readonly claimId: bigint | null;
  readonly contract: string;
  readonly method: string;
}

export interface SaveSignedCheckpointInput extends KeeperIntendedOperation {
  readonly txHash: string;
  readonly signerPublicKey: string;
  readonly sequenceNumber: bigint;
  readonly feeStroops: bigint;
}

export interface KeeperTxCheckpointRecord extends SaveSignedCheckpointInput {
  readonly state: KeeperCheckpointState;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TxCheckpointStorePort {
  getByOperationKey(operationKey: string): Promise<KeeperTxCheckpointRecord | null>;
  saveSignedBeforeBroadcast(input: SaveSignedCheckpointInput): Promise<KeeperTxCheckpointRecord>;
  markBroadcastUnknown(operationKey: string, txHash: string, reason: string): Promise<void>;
  markConfirmed(operationKey: string, txHash: string): Promise<void>;
  markFailed(operationKey: string, txHash: string, reason: string): Promise<void>;
  countUnresolved(chain?: string): Promise<number>;
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
}

export interface ClaimSettlementResult {
  readonly settled: number;
  readonly attempted: number;
  readonly pending: number;
  readonly dryRun: boolean;
  readonly detail: string;
  readonly uncertain?: number | undefined;
}

export type KeeperJobResult =
  | { readonly kind: "ttl-bump"; readonly result: TtlBumpResult }
  | { readonly kind: "claim-settlement"; readonly result: ClaimSettlementResult };

export interface KeeperContext {
  readonly db: Transactional;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly checkpointStore?: TxCheckpointStorePort | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly maxPollAttempts?: number | undefined;
}
