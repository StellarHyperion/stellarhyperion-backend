import type { Logger } from "pino";
import type { AppConfig } from "../config/config.js";
import type { Transactional } from "../db/pool.js";
import type { KeeperRecoveryLedger } from "./recovery.js";
import type { KeeperTxLookupClient } from "./stellar.js";

export type KeeperJobName = "ttl-bump" | "claim-settlement";

export interface TtlBumpPayload {
  readonly maxClaims?: number;
  readonly maxTransfers?: number;
  readonly idempotencyKey?: string;
}

export interface ClaimSettlementPayload {
  readonly limit?: number;
  readonly excludeClaimIds?: readonly string[];
  readonly idempotencyKey?: string;
}

export interface TtlBumpResult {
  readonly bumpedTokens: number;
  readonly bumpedClaims: number;
  readonly bumpedTransfers: number;
  readonly dryRun: boolean;
  readonly detail: string;
  readonly deduplicated?: boolean;
  readonly txHash?: string | null;
}

export interface ClaimSettlementResult {
  readonly settled: number;
  readonly attempted: number;
  readonly pending: number;
  readonly dryRun: boolean;
  readonly detail: string;
  readonly deduplicated?: boolean;
  readonly settledTxHashes?: readonly string[];
}

export type KeeperJobResult =
  | { readonly kind: "ttl-bump"; readonly result: TtlBumpResult }
  | { readonly kind: "claim-settlement"; readonly result: ClaimSettlementResult };

export interface KeeperContext {
  readonly db: Transactional;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly recoveryLedger?: KeeperRecoveryLedger;
  readonly txLookupClient?: KeeperTxLookupClient;
}
