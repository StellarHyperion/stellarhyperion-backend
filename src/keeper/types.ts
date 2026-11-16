import type { Logger } from "pino";
import type { AppConfig, KeeperBudgetConfig } from "../config/config.js";
import type { Transactional } from "../db/pool.js";

export type KeeperJobName = "ttl-bump" | "claim-settlement";

export interface SimulatedCostProfile {
  readonly baseFeeStroops: bigint;
  readonly minResourceFeeStroops: bigint;
  readonly totalFeeStroops: bigint;
  readonly cpuInstructions: number;
  readonly readBytes: number;
  readonly writeBytes: number;
  readonly footprintKeys: number;
}

export interface BudgetDiagnostic {
  readonly code: "keeper_budget_exceeded";
  readonly contract: string;
  readonly method: string;
  readonly exceededDimensions: readonly string[];
  readonly estimatedFeeStroops: string;
  readonly cpuInstructions: number;
  readonly readBytes: number;
  readonly writeBytes: number;
  readonly footprintKeys: number;
  readonly jobSubmittedStroops: string;
  readonly jobConfirmedStroops: string;
  readonly intervalSubmittedStroops: string;
  readonly intervalConfirmedStroops: string;
  readonly maxTxFeeStroops: string;
  readonly maxJobFeeStroops: string;
  readonly maxIntervalFeeStroops: string;
}

export interface JobBudgetAccountingSnapshot {
  readonly submittedStroops: string;
  readonly confirmedStroops: string;
  readonly pendingSubmittedStroops: string;
  readonly failedSubmittedStroops: string;
  readonly submittedTxCount: number;
  readonly confirmedTxCount: number;
  readonly blockedCount: number;
  readonly diagnostics: readonly BudgetDiagnostic[];
}

export interface IntervalBudgetAccountingSnapshot {
  readonly intervalIndex: number;
  readonly intervalStartedAtMs: number;
  readonly intervalMs: number;
  readonly maxIntervalFeeStroops: string;
  readonly submittedStroops: string;
  readonly confirmedStroops: string;
  readonly pendingSubmittedStroops: string;
  readonly failedSubmittedStroops: string;
  readonly submittedTxCount: number;
  readonly confirmedTxCount: number;
  readonly blockedCount: number;
  readonly exhausted: boolean;
  readonly lastDiagnostic: BudgetDiagnostic | null;
}

export interface BudgetTrackerPort {
  createJobSession(overrides?: Partial<KeeperBudgetConfig>): JobBudgetSessionPort;
  snapshot(nowMs?: number): IntervalBudgetAccountingSnapshot;
}

export interface JobBudgetSessionPort {
  evaluateBeforeSign(
    contract: string,
    method: string,
    cost: SimulatedCostProfile,
    nowMs?: number,
  ):
    { readonly allowed: true } | { readonly allowed: false; readonly diagnostic: BudgetDiagnostic };
  recordSubmitted(txHash: string, feeStroops: bigint, nowMs?: number): void;
  recordConfirmed(txHash: string, feeStroops: bigint, nowMs?: number): void;
  recordFailedAfterSubmit(txHash: string, feeStroops: bigint, nowMs?: number): void;
  snapshot(): JobBudgetAccountingSnapshot;
}

export interface TtlBumpPayload {
  readonly maxClaims?: number | undefined;
  readonly maxTransfers?: number | undefined;
  readonly budgetOverrides?: Partial<KeeperBudgetConfig> | undefined;
}

export interface ClaimSettlementPayload {
  readonly limit?: number | undefined;
  readonly budgetOverrides?: Partial<KeeperBudgetConfig> | undefined;
}

export interface TtlBumpResult {
  readonly bumpedTokens: number;
  readonly bumpedClaims: number;
  readonly bumpedTransfers: number;
  readonly dryRun: boolean;
  readonly detail: string;
  readonly budgetAccounting?: JobBudgetAccountingSnapshot | undefined;
}

export interface ClaimSettlementResult {
  readonly settled: number;
  readonly attempted: number;
  readonly pending: number;
  readonly dryRun: boolean;
  readonly detail: string;
  readonly budgetAccounting?: JobBudgetAccountingSnapshot | undefined;
}

export type KeeperJobResult =
  | { readonly kind: "ttl-bump"; readonly result: TtlBumpResult }
  | { readonly kind: "claim-settlement"; readonly result: ClaimSettlementResult };

export interface KeeperContext {
  readonly db: Transactional;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly budgetTracker?: BudgetTrackerPort | undefined;
  readonly pollIntervalMs?: number | undefined;
}
