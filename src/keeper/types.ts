import type { Logger } from "pino";
import type { AppConfig } from "../config/config.js";
import type { Transactional } from "../db/pool.js";

export type KeeperJobName = "ttl-bump" | "claim-settlement";

export interface SignerLeaseRecord {
  readonly signerPublicKey: string;
  readonly chain: string;
  readonly holderId: string;
  readonly fenceToken: bigint;
  readonly lastReservedSequence: bigint | null;
  readonly lastConfirmedSequence: bigint | null;
  readonly inFlightTxHash: string | null;
  readonly acquiredAt: Date;
  readonly expiresAt: Date;
  readonly updatedAt: Date;
}

export interface SignerLeaseHandle extends SignerLeaseRecord {
  readonly tookOverExpiredLease: boolean;
}

export interface AcquireSignerLeaseInput {
  readonly signerPublicKey: string;
  readonly chain: string;
  readonly holderId: string;
  readonly leaseTtlMs: number;
  readonly nowMs?: number | undefined;
}

export interface ReconcileLeaseRecoveryInput {
  readonly signerPublicKey: string;
  readonly holderId: string;
  readonly fenceToken: bigint;
  readonly onChainSequence: bigint;
  readonly settledInFlightSequence?: bigint | null | undefined;
  readonly clearUnbroadcastReservation: boolean;
  readonly nowMs?: number | undefined;
}

export interface ReserveSequenceInput {
  readonly signerPublicKey: string;
  readonly holderId: string;
  readonly fenceToken: bigint;
  readonly onChainSequence: bigint;
  readonly leaseTtlMs: number;
  readonly nowMs?: number | undefined;
}

export interface SequenceReservation {
  readonly accountStartingSequence: bigint;
  readonly nextSequence: bigint;
  readonly fenceToken: bigint;
}

export interface BroadcastFenceInput {
  readonly signerPublicKey: string;
  readonly holderId: string;
  readonly fenceToken: bigint;
  readonly sequenceNumber: bigint;
  readonly txHash: string;
  readonly nowMs?: number | undefined;
}

export interface SequenceOutcomeInput {
  readonly signerPublicKey: string;
  readonly holderId: string;
  readonly fenceToken: bigint;
  readonly sequenceNumber: bigint;
  readonly outcome: "confirmed" | "aborted_or_failed";
  readonly nowMs?: number | undefined;
}

export interface SignerLeaseStorePort {
  inspect(signerPublicKey: string): Promise<SignerLeaseRecord | null>;
  acquireOrRenew(input: AcquireSignerLeaseInput): Promise<SignerLeaseHandle>;
  reconcileRecoveredState(input: ReconcileLeaseRecoveryInput): Promise<SignerLeaseRecord>;
  reserveNextSequence(input: ReserveSequenceInput): Promise<SequenceReservation>;
  assertFenceBeforeBroadcast(input: BroadcastFenceInput): Promise<void>;
  recordSequenceOutcome(input: SequenceOutcomeInput): Promise<void>;
  release(
    signerPublicKey: string,
    holderId: string,
    fenceToken?: bigint,
    nowMs?: number,
  ): Promise<boolean>;
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
  readonly leaseSkipped?: boolean | undefined;
}

export interface ClaimSettlementResult {
  readonly settled: number;
  readonly attempted: number;
  readonly pending: number;
  readonly dryRun: boolean;
  readonly detail: string;
  readonly leaseSkipped?: boolean | undefined;
}

export type KeeperJobResult =
  | { readonly kind: "ttl-bump"; readonly result: TtlBumpResult }
  | { readonly kind: "claim-settlement"; readonly result: ClaimSettlementResult };

export interface KeeperContext {
  readonly db: Transactional;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly leaseStore?: SignerLeaseStorePort | undefined;
  readonly holderId?: string | undefined;
  readonly leaseTtlMs?: number | undefined;
  readonly clock?: (() => number) | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly maxPollAttempts?: number | undefined;
}
