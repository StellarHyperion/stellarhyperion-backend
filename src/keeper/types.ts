import type { Logger } from "pino";
import type { AppConfig } from "../config/config.js";
import type { Transactional } from "../db/pool.js";
export type KeeperJobName = "ttl-bump" | "claim-settlement" | "restore";
export interface TtlBumpPayload {
  readonly maxClaims?: number;
  readonly maxTransfers?: number;
}
export interface ClaimSettlementPayload {
  readonly limit?: number;
}
export interface RestorePayload {
  readonly maxClaims?: number;
  readonly maxTransfers?: number;
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
}
export interface RestoreResult {
  readonly restoredClaims: number;
  readonly restoredTransfers: number;
  readonly dryRun: boolean;
  readonly detail: string;
}
export type KeeperJobResult =
  | { readonly kind: "ttl-bump"; readonly result: TtlBumpResult }
  | { readonly kind: "claim-settlement"; readonly result: ClaimSettlementResult }
  | { readonly kind: "restore"; readonly result: RestoreResult };
export interface KeeperContext {
  readonly db: Transactional;
  readonly config: AppConfig;
  readonly logger: Logger;
}
