import type { Logger } from "pino";
import type { AppConfig } from "../config/config.js";
import type { Transactional } from "../db/pool.js";

export type KeeperJobName = "ttl-bump" | "claim-settlement";

export interface ClaimMeasuredResources {
  readonly cpuInstructions: number;
  readonly readBytes: number;
  readonly writeBytes: number;
  readonly minResourceFeeStroops: string;
}

export type OnChainClaimDisposition =
  | {
      readonly status: "claimable";
      readonly recipient: string | null;
      readonly amount: string | null;
      readonly resources: ClaimMeasuredResources;
    }
  | {
      readonly status: "already_settled_on_chain";
      readonly detail: string;
    }
  | {
      readonly status: "missing_on_chain";
      readonly detail: string;
    }
  | {
      readonly status: "frozen_recipient";
      readonly authorizedToMaintainLiabilities: boolean;
      readonly detail: string;
    };

export interface CandidateClaimRecord {
  readonly claimId: bigint;
  readonly recipient: string | null;
  readonly token: string | null;
  readonly amount: string | null;
}

export interface ClaimStateInspector {
  inspectClaim(candidate: CandidateClaimRecord): Promise<OnChainClaimDisposition>;
  supportsVectorSettlement?(): Promise<boolean>;
  verifyPostBatchClaimSettled?(claimId: bigint): Promise<boolean>;
}

export interface ClaimBatchResourceLimits {
  readonly maxBatchItems: number;
  readonly maxBatchCpuInstructions: number;
  readonly maxBatchReadBytes: number;
  readonly maxBatchWriteBytes: number;
  readonly maxBatchFeeStroops: bigint;
  readonly maxBatchesPerRun: number;
}

export type ClaimItemOutcome =
  | "confirmed_settled"
  | "already_settled_on_chain"
  | "missing_on_chain"
  | "frozen_recipient"
  | "exceeds_resource_limit"
  | "deferred_by_batch_limit"
  | "submission_failed";

export interface ClaimItemAccounting {
  readonly claimId: string;
  readonly outcome: ClaimItemOutcome;
  readonly confirmed: boolean;
  readonly txHash: string | null;
  readonly batchIndex: number | null;
  readonly recipient: string | null;
  readonly amount: string | null;
  readonly detail: string;
}

export interface PlannedClaimBatchSummary {
  readonly batchIndex: number;
  readonly claimIds: readonly string[];
  readonly totalCpuInstructions: number;
  readonly totalReadBytes: number;
  readonly totalWriteBytes: number;
  readonly totalFeeStroops: string;
}

export interface TtlBumpPayload {
  readonly maxClaims?: number | undefined;
  readonly maxTransfers?: number | undefined;
}

export interface ClaimSettlementPayload {
  readonly limit?: number | undefined;
  readonly batchLimits?: Partial<ClaimBatchResourceLimits> | undefined;
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
  readonly batches?: readonly PlannedClaimBatchSummary[] | undefined;
  readonly items?: readonly ClaimItemAccounting[] | undefined;
}

export type KeeperJobResult =
  | { readonly kind: "ttl-bump"; readonly result: TtlBumpResult }
  | { readonly kind: "claim-settlement"; readonly result: ClaimSettlementResult };

export interface KeeperContext {
  readonly db: Transactional;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly claimInspector?: ClaimStateInspector | undefined;
}
