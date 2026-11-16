import type { Logger } from "pino";
import type { AppConfig } from "../config/config.js";
import type { Transactional } from "../db/pool.js";
import type { KeeperSpendingTracker } from "./spending.js";
import type { KeeperStellarRpcAdapter } from "./stellar.js";

export type KeeperJobName = "ttl-bump" | "claim-settlement";

export interface TtlBumpPayload {
  readonly maxClaims?: number;
  readonly maxTransfers?: number;
  readonly ledger?: number;
}

export interface ClaimSettlementPayload {
  readonly limit?: number;
  readonly ledger?: number;
}

export interface TtlBumpResult {
  readonly bumpedTokens: number;
  readonly bumpedClaims: number;
  readonly bumpedTransfers: number;
  readonly dryRun: boolean;
  readonly detail: string;
  readonly pausedByCap?: boolean;
}

export interface ClaimSettlementResult {
  readonly settled: number;
  readonly attempted: number;
  readonly pending: number;
  readonly dryRun: boolean;
  readonly detail: string;
  readonly pausedByCap?: boolean;
}

export type KeeperJobResult =
  | { readonly kind: "ttl-bump"; readonly result: TtlBumpResult }
  | { readonly kind: "claim-settlement"; readonly result: ClaimSettlementResult };

export interface KeeperContext {
  readonly db: Transactional;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly spendingTracker?: KeeperSpendingTracker;
  readonly rpcClient?: KeeperStellarRpcAdapter;
  readonly now?: () => Date;
  readonly estimatedAttemptFeeStroops?: bigint;
  readonly pollIntervalMs?: number;
}
