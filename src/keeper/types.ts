import type { Logger } from "pino";
import type { AppConfig } from "../config/config.js";
import type { Transactional } from "../db/pool.js";
export type KeeperJobName = "ttl-bump" | "claim-settlement";
export interface TtlBumpPayload {
  readonly maxClaims?: number;
  readonly maxTransfers?: number;
}
export interface ClaimSettlementPayload {
  readonly limit?: number;
  /** Decimal-string IDs for an explicitly bounded maintenance batch. */
  readonly claimIds?: readonly string[];
}
export interface ClaimSettlementItemResult {
  readonly claimId: string;
  readonly outcome: "missing" | "already_settled" | "confirmed" | "pending";
  readonly transactionHash?: string;
}
export interface KeeperOperationPreview {
  readonly kind: "keep_alive" | "settle_claim";
  readonly contract: string;
  readonly method: "keep_alive" | "settle_claim";
  readonly targetKeys: readonly string[];
  readonly args: Readonly<Record<string, unknown>>;
  readonly estimatedFee: string;
  readonly unsigned: true;
}
export interface TtlBumpResult {
  readonly bumpedTokens: number;
  readonly bumpedClaims: number;
  readonly bumpedTransfers: number;
  readonly dryRun: boolean;
  readonly detail: string;
  readonly operations: readonly KeeperOperationPreview[];
  readonly targetKeys: readonly string[];
  readonly estimatedFee: string;
  readonly unsigned: boolean;
}
export interface ClaimSettlementResult {
  readonly settled: number;
  readonly attempted: number;
  readonly pending: number;
  readonly missing: number;
  readonly claims: readonly ClaimSettlementItemResult[];
  readonly dryRun: boolean;
  readonly detail: string;
  readonly operations: readonly KeeperOperationPreview[];
  readonly targetKeys: readonly string[];
  readonly estimatedFee: string;
  readonly unsigned: boolean;
}
export type KeeperJobResult =
  | { readonly kind: "ttl-bump"; readonly result: TtlBumpResult }
  | { readonly kind: "claim-settlement"; readonly result: ClaimSettlementResult };
export interface KeeperContext {
  readonly db: Transactional;
  readonly config: AppConfig;
  readonly logger: Logger;
}
