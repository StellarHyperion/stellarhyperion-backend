import type { Logger } from "pino";
import type { AppConfig } from "../config/config.js";
import type { Transactional } from "../db/pool.js";
import type { KeeperSimulationClient } from "./stellar.js";

export type KeeperJobName = "ttl-bump" | "claim-settlement";

export interface KeeperSimulatedFeeEstimate {
  readonly baseFeeStroops: string;
  readonly minResourceFeeStroops: string;
  readonly totalEstimatedFeeStroops: string;
  readonly simulated: boolean;
  readonly latestLedger: number | null;
  readonly restoreRequired: boolean;
  readonly simulationError: string | null;
}

export interface KeeperClaimPreview {
  readonly claimId: string;
  readonly recipient: string;
  readonly token: string | null;
  readonly amount: string;
  readonly route: number | null;
}

export interface KeeperOperationPreview {
  readonly chain: string;
  readonly contract: string;
  readonly method: "keep_alive" | "settle_claim";
  readonly unsigned: true;
  readonly signed: false;
  readonly broadcast: false;
  readonly targetKeys: readonly string[];
  readonly argsSummary: Readonly<Record<string, unknown>>;
  readonly operationXdr: string;
  readonly feeEstimate: KeeperSimulatedFeeEstimate;
  readonly claimPreview?: KeeperClaimPreview;
}

export interface KeeperDryRunPlan {
  readonly mode: "dry-run";
  readonly unsigned: true;
  readonly signed: false;
  readonly broadcast: false;
  readonly totalEstimatedFeeStroops: string;
  readonly operations: readonly KeeperOperationPreview[];
}

export interface TtlBumpPayload {
  readonly maxClaims?: number;
  readonly maxTransfers?: number;
  readonly dryRun?: boolean;
  readonly simulateViaRpc?: boolean;
}

export interface ClaimSettlementPayload {
  readonly limit?: number;
  readonly dryRun?: boolean;
  readonly simulateViaRpc?: boolean;
}

export interface TtlBumpResult {
  readonly bumpedTokens: number;
  readonly bumpedClaims: number;
  readonly bumpedTransfers: number;
  readonly dryRun: boolean;
  readonly detail: string;
  readonly plan?: KeeperDryRunPlan;
}

export interface ClaimSettlementResult {
  readonly settled: number;
  readonly attempted: number;
  readonly pending: number;
  readonly dryRun: boolean;
  readonly detail: string;
  readonly plan?: KeeperDryRunPlan;
}

export type KeeperJobResult =
  | { readonly kind: "ttl-bump"; readonly result: TtlBumpResult }
  | { readonly kind: "claim-settlement"; readonly result: ClaimSettlementResult };

export interface KeeperContext {
  readonly db: Transactional;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly simulationClient?: KeeperSimulationClient;
}
