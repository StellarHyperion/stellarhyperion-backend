import type { Logger } from "pino";
import type { AppConfig } from "../config/config.js";
import type { Transactional } from "../db/pool.js";
import type { KeeperSignerManager } from "./stellar.js";

export type KeeperJobName = "ttl-bump" | "claim-settlement";

export type KeeperRotationPhase =
  "unconfigured" | "primary" | "draining_pending" | "awaiting_next_readiness" | "rotated";

export interface KeeperSignerAccountDiagnostic {
  readonly publicKey: string;
  readonly funded: boolean;
  readonly networkMatched: boolean;
  readonly balanceStroops: string;
  readonly reserveStroops: string;
  readonly spendableStroops: string;
  readonly minBalanceStroops: string;
  readonly ready: boolean;
  readonly reason: string | null;
}

export interface KeeperSignerReadinessSnapshot {
  readonly phase: KeeperRotationPhase;
  readonly activeSigner: string | null;
  readonly stagedSigner: string | null;
  readonly pendingTxHashes: readonly string[];
  readonly readyToSign: boolean;
  readonly detail: string;
  readonly activeAccount: KeeperSignerAccountDiagnostic | null;
  readonly stagedAccount: KeeperSignerAccountDiagnostic | null;
}

export interface TtlBumpPayload {
  readonly maxClaims?: number;
  readonly maxTransfers?: number;
}

export interface ClaimSettlementPayload {
  readonly limit?: number;
}

export interface TtlBumpResult {
  readonly bumpedTokens: number;
  readonly bumpedClaims: number;
  readonly bumpedTransfers: number;
  readonly dryRun: boolean;
  readonly detail: string;
  readonly signerPublicKey?: string | null;
}

export interface SettledClaimSummary {
  readonly claimId: string;
  readonly recipient: string | null;
  readonly settledBy: string | null;
  readonly txHash: string;
}

export interface ClaimSettlementResult {
  readonly settled: number;
  readonly attempted: number;
  readonly pending: number;
  readonly dryRun: boolean;
  readonly detail: string;
  readonly settledClaims?: readonly SettledClaimSummary[];
}

export type KeeperJobResult =
  | { readonly kind: "ttl-bump"; readonly result: TtlBumpResult }
  | { readonly kind: "claim-settlement"; readonly result: ClaimSettlementResult };

export interface KeeperContext {
  readonly db: Transactional;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly signerManager?: KeeperSignerManager;
}
