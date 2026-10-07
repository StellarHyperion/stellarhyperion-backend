/**
 * Types and interfaces for Hyperion's background keeper.
 *
 * The keeper is the scheduled job engine that moves transfers forward through the parts of their
 * journey that do not happen on their own:
 * 1. Pushing Soroban storage archival TTLs back before contract entries expire.
 * 2. Settling parked claims whose recipients are ready to receive them.
 * 3. Submitting the second leg on rails that require permissionless relay.
 * 4. Topping up gas on Axelar GMP transfers that ran short.
 *
 * None of these operations require a key that can move user funds. Everything the keeper executes
 * is a public call that anyone can submit.
 */
import type { Logger } from "pino";

import type { AppConfig } from "../config/config.js";
import type { Transactional } from "../db/pool.js";

export type KeeperJobName = "ttl-bump" | "claim-settlement" | "rail-second-step" | "gas-topup";

export interface TtlBumpPayload {
  readonly maxClaims?: number;
  readonly maxTransfers?: number;
}

export interface ClaimSettlementPayload {
  readonly limit?: number;
}

export interface RailSecondStepPayload {
  readonly limit?: number;
}

export interface GasTopupPayload {
  readonly limit?: number;
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

export interface RailSecondStepResult {
  readonly relayed: number;
  readonly pending: number;
  readonly dryRun: boolean;
  readonly detail: string;
}

export interface GasTopupResult {
  readonly toppedUp: number;
  readonly pending: number;
  readonly dryRun: boolean;
  readonly detail: string;
}

export type KeeperJobResult =
  | { readonly kind: "ttl-bump"; readonly result: TtlBumpResult }
  | { readonly kind: "claim-settlement"; readonly result: ClaimSettlementResult }
  | { readonly kind: "rail-second-step"; readonly result: RailSecondStepResult }
  | { readonly kind: "gas-topup"; readonly result: GasTopupResult };

export interface KeeperContext {
  readonly db: Transactional;
  readonly config: AppConfig;
  readonly logger: Logger;
}
