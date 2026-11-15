import type { KeeperRetentionConfig } from "../config/config.js";
import {
  reconcileStellarTransaction,
  sanitizeKeeperText,
  type KeeperTxLookupClient,
} from "./stellar.js";
import type {
  ClaimSettlementPayload,
  KeeperContext,
  KeeperJobName,
  KeeperJobResult,
  TtlBumpPayload,
} from "./types.js";

export function isSupportedKeeperJobName(name: string): name is KeeperJobName {
  return name === "ttl-bump" || name === "claim-settlement";
}

export interface UncertainTxRecord {
  readonly txHash: string;
  readonly contract: string;
  readonly method: string;
  readonly claimId?: string;
  readonly bumpedCounts?: {
    readonly bumpedTokens: number;
    readonly bumpedClaims: number;
    readonly bumpedTransfers: number;
  };
}

export interface FailedJobEvidence {
  readonly jobId: string;
  readonly jobName: KeeperJobName;
  readonly payload: TtlBumpPayload | ClaimSettlementPayload;
  readonly payloadKey: string;
  readonly failedAtMs: number;
  readonly reason: string;
  readonly pendingSubmissions: readonly UncertainTxRecord[];
  readonly uncertain: boolean;
}

export interface RetainableJobLike {
  readonly id?: string | undefined;
  readonly name: string;
  readonly data: unknown;
  readonly finishedOn?: number | undefined;
  readonly timestamp?: number | undefined;
  remove(): Promise<void>;
}

export interface RetainableQueueLike {
  getCompleted(start?: number, end?: number): Promise<RetainableJobLike[]>;
  getFailed(start?: number, end?: number): Promise<RetainableJobLike[]>;
  getJob(jobId: string): Promise<RetainableJobLike | undefined>;
  add(
    name: string,
    data: unknown,
    opts?: {
      readonly jobId?: string;
      readonly attempts?: number;
      readonly removeOnComplete?: { readonly count: number; readonly age: number };
      readonly removeOnFail?: boolean;
    },
  ): Promise<{ readonly id?: string | undefined }>;
}

export interface PruneKeeperHistorySummary {
  readonly removedCompleted: number;
  readonly removedFailed: number;
  readonly preservedUncertainJobIds: readonly string[];
}

export type KeeperRecoveryActionStatus =
  "held_pending" | "reconciled_confirmed" | "requeued" | "already_confirmed";

export interface KeeperRecoveryDecision {
  readonly status: KeeperRecoveryActionStatus;
  readonly jobId: string;
  readonly jobName: KeeperJobName;
  readonly pendingTxHashes: readonly string[];
  readonly confirmedTxHashes: readonly string[];
  readonly confirmedResult: KeeperJobResult | null;
  readonly requeuedJobId: string | null;
  readonly detail: string;
}

export function canonicalizeKeeperPayloadKey(
  jobName: KeeperJobName,
  payload: TtlBumpPayload | ClaimSettlementPayload,
): string {
  if (typeof payload.idempotencyKey === "string" && payload.idempotencyKey.trim() !== "") {
    return `${jobName}:idemp:${payload.idempotencyKey.trim()}`;
  }
  if (jobName === "ttl-bump") {
    const ttl = payload as TtlBumpPayload;
    return `ttl-bump:claims=${String(ttl.maxClaims ?? 50)}:transfers=${String(ttl.maxTransfers ?? 50)}`;
  }
  const claims = payload as ClaimSettlementPayload;
  const excluded = [...(claims.excludeClaimIds ?? [])].sort().join(",");
  return `claim-settlement:limit=${String(claims.limit ?? 20)}:exclude=${excluded}`;
}

export class KeeperRecoveryLedger {
  private readonly maxTrackedConfirmed: number;
  private readonly inFlightPayloadKeys = new Set<string>();
  private readonly confirmedPayloadResults = new Map<string, KeeperJobResult>();
  private readonly confirmedTxHashes = new Set<string>();
  private readonly confirmedClaims = new Map<string, string>();
  private readonly uncertainClaims = new Map<string, UncertainTxRecord>();
  private readonly evidenceByJobId = new Map<string, FailedJobEvidence>();

  constructor(maxTrackedConfirmed = 1000) {
    this.maxTrackedConfirmed = maxTrackedConfirmed;
  }

  tryAcquirePayloadExecution(
    payloadKey: string,
  ):
    | { readonly acquired: true }
    | { readonly acquired: false; readonly duplicateResult: KeeperJobResult | null } {
    const prior = this.confirmedPayloadResults.get(payloadKey);
    if (prior !== undefined) {
      return { acquired: false, duplicateResult: toDeduplicatedResult(prior) };
    }
    if (this.inFlightPayloadKeys.has(payloadKey)) {
      return { acquired: false, duplicateResult: null };
    }
    this.inFlightPayloadKeys.add(payloadKey);
    return { acquired: true };
  }

  releasePayloadExecution(payloadKey: string, confirmedResult?: KeeperJobResult): void {
    this.inFlightPayloadKeys.delete(payloadKey);
    if (confirmedResult !== undefined) {
      this.recordConfirmedPayload(payloadKey, confirmedResult);
    }
  }

  recordConfirmedPayload(payloadKey: string, result: KeeperJobResult): void {
    if (this.confirmedPayloadResults.has(payloadKey)) {
      this.confirmedPayloadResults.delete(payloadKey);
    }
    this.confirmedPayloadResults.set(payloadKey, result);
    while (this.confirmedPayloadResults.size > this.maxTrackedConfirmed) {
      const oldest = this.confirmedPayloadResults.keys().next().value;
      if (oldest === undefined) break;
      this.confirmedPayloadResults.delete(oldest);
    }
  }

  /**
   * Marks a public transaction hash confirmed and returns true only the first time
   * it transitions to confirmed, preventing duplicate confirmed accounting.
   */
  markTxConfirmedOnce(txHash: string): boolean {
    if (this.confirmedTxHashes.has(txHash)) {
      return false;
    }
    this.confirmedTxHashes.add(txHash);
    if (this.confirmedTxHashes.size > this.maxTrackedConfirmed) {
      const oldest = this.confirmedTxHashes.values().next().value;
      if (oldest !== undefined) {
        this.confirmedTxHashes.delete(oldest);
      }
    }
    return true;
  }

  isTxConfirmed(txHash: string): boolean {
    return this.confirmedTxHashes.has(txHash);
  }

  markClaimConfirmed(chain: string, claimId: string, txHash: string): boolean {
    const key = `${chain}:${claimId}`;
    this.uncertainClaims.delete(key);
    if (this.confirmedClaims.has(key)) {
      return false;
    }
    this.confirmedClaims.set(key, txHash);
    return true;
  }

  isClaimConfirmed(chain: string, claimId: string): boolean {
    return this.confirmedClaims.has(`${chain}:${claimId}`);
  }

  recordUncertainClaim(chain: string, claimId: string, record: UncertainTxRecord): void {
    this.uncertainClaims.set(`${chain}:${claimId}`, record);
  }

  getUncertainClaim(chain: string, claimId: string): UncertainTxRecord | undefined {
    return this.uncertainClaims.get(`${chain}:${claimId}`);
  }

  clearUncertainClaim(chain: string, claimId: string): void {
    this.uncertainClaims.delete(`${chain}:${claimId}`);
  }

  recordFailedJob(evidence: FailedJobEvidence): void {
    this.evidenceByJobId.set(evidence.jobId, {
      ...evidence,
      reason: sanitizeKeeperText(evidence.reason),
    });
  }

  getFailedJobEvidence(jobId: string): FailedJobEvidence | undefined {
    return this.evidenceByJobId.get(jobId);
  }

  allFailedJobEvidence(): readonly FailedJobEvidence[] {
    return [...this.evidenceByJobId.values()];
  }

  hasUncertainSubmission(jobId: string): boolean {
    const entry = this.evidenceByJobId.get(jobId);
    return Boolean(entry?.uncertain && entry.pendingSubmissions.length > 0);
  }

  pruneDeterministicEvidence(retention: KeeperRetentionConfig, nowMs = Date.now()): void {
    const maxAgeMs = retention.failedMaxAgeSeconds * 1000;
    const deterministic: FailedJobEvidence[] = [];

    for (const [jobId, ev] of this.evidenceByJobId.entries()) {
      if (ev.uncertain && ev.pendingSubmissions.length > 0) {
        // Never evict unresolved uncertain submission evidence.
        continue;
      }
      if (nowMs - ev.failedAtMs > maxAgeMs) {
        this.evidenceByJobId.delete(jobId);
      } else {
        deterministic.push(ev);
      }
    }

    deterministic.sort((a, b) => b.failedAtMs - a.failedAtMs);
    for (const stale of deterministic.slice(retention.maxFailedJobs)) {
      this.evidenceByJobId.delete(stale.jobId);
    }
  }

  updateFailedJobPending(
    jobId: string,
    remainingPending: readonly UncertainTxRecord[],
  ): FailedJobEvidence | undefined {
    const existing = this.evidenceByJobId.get(jobId);
    if (!existing) return undefined;
    const updated: FailedJobEvidence = {
      ...existing,
      pendingSubmissions: remainingPending,
      uncertain: remainingPending.length > 0,
    };
    this.evidenceByJobId.set(jobId, updated);
    return updated;
  }

  clearFailedJobEvidence(jobId: string): void {
    this.evidenceByJobId.delete(jobId);
  }
}

function toDeduplicatedResult(prior: KeeperJobResult): KeeperJobResult {
  if (prior.kind === "ttl-bump") {
    return {
      kind: "ttl-bump",
      result: {
        bumpedTokens: 0,
        bumpedClaims: 0,
        bumpedTransfers: 0,
        dryRun: prior.result.dryRun,
        deduplicated: true,
        txHash: prior.result.txHash ?? null,
        detail: "Duplicate queue payload skipped; maintenance window already confirmed.",
      },
    };
  }
  return {
    kind: "claim-settlement",
    result: {
      settled: 0,
      attempted: 0,
      pending: prior.result.pending,
      dryRun: prior.result.dryRun,
      deduplicated: true,
      settledTxHashes: [],
      detail: "Duplicate queue payload skipped; settlement batch already confirmed.",
    },
  };
}

export async function pruneKeeperJobHistory(
  queue: RetainableQueueLike,
  retention: KeeperRetentionConfig,
  ledger: KeeperRecoveryLedger,
  nowMs = Date.now(),
): Promise<PruneKeeperHistorySummary> {
  let removedCompleted = 0;
  let removedFailed = 0;
  const preservedUncertainJobIds: string[] = [];

  const completed = await queue.getCompleted(0, -1);
  const completedSorted = [...completed].sort(
    (a, b) => (b.finishedOn ?? b.timestamp ?? 0) - (a.finishedOn ?? a.timestamp ?? 0),
  );
  const completedCutoffMs = nowMs - retention.completedMaxAgeSeconds * 1000;
  for (let idx = 0; idx < completedSorted.length; idx += 1) {
    const job = completedSorted[idx];
    if (!job) continue;
    const finishedAt = job.finishedOn ?? job.timestamp ?? nowMs;
    if (idx >= retention.maxCompletedJobs || finishedAt < completedCutoffMs) {
      await job.remove();
      removedCompleted += 1;
    }
  }

  const failed = await queue.getFailed(0, -1);
  const failedSorted = [...failed].sort(
    (a, b) => (b.finishedOn ?? b.timestamp ?? 0) - (a.finishedOn ?? a.timestamp ?? 0),
  );
  const failedCutoffMs = nowMs - retention.failedMaxAgeSeconds * 1000;
  let keptDeterministicFailed = 0;
  for (const job of failedSorted) {
    const jobId = job.id ?? "";
    if (jobId !== "" && ledger.hasUncertainSubmission(jobId)) {
      preservedUncertainJobIds.push(jobId);
      continue;
    }
    const finishedAt = job.finishedOn ?? job.timestamp ?? nowMs;
    if (keptDeterministicFailed >= retention.maxFailedJobs || finishedAt < failedCutoffMs) {
      await job.remove();
      removedFailed += 1;
    } else {
      keptDeterministicFailed += 1;
    }
  }

  ledger.pruneDeterministicEvidence(retention, nowMs);
  return {
    removedCompleted,
    removedFailed,
    preservedUncertainJobIds,
  };
}

export async function recoverFailedKeeperJob(
  ctx: KeeperContext,
  queue: RetainableQueueLike,
  jobId: string,
  options: { readonly lookupClient?: KeeperTxLookupClient } = {},
): Promise<KeeperRecoveryDecision> {
  const ledger = ctx.recoveryLedger;
  if (!ledger) {
    throw new Error("Keeper recovery requires an active recovery ledger.");
  }

  const evidence = ledger.getFailedJobEvidence(jobId);
  const queuedJob = await queue.getJob(jobId);
  const rawName = evidence?.jobName ?? queuedJob?.name;
  if (rawName === undefined || !isSupportedKeeperJobName(rawName)) {
    throw new Error(`Unsupported or missing failed keeper job for recovery: ${jobId}`);
  }

  const payload: TtlBumpPayload | ClaimSettlementPayload =
    evidence?.payload ??
    (queuedJob?.data as TtlBumpPayload | ClaimSettlementPayload | undefined) ??
    {};
  const payloadKey = evidence?.payloadKey ?? canonicalizeKeeperPayloadKey(rawName, payload);

  const pendingRecords = evidence?.pendingSubmissions ?? [];
  const stillPending: UncertainTxRecord[] = [];
  const newlyConfirmedHashes: string[] = [];
  const confirmedClaimIds: string[] = [];
  let ttlConfirmedCounts: UncertainTxRecord["bumpedCounts"] | undefined;

  const lookup = options.lookupClient ?? ctx.txLookupClient;
  const chainKey = ctx.config.indexer.stellar?.chain ?? "stellar";

  for (const rec of pendingRecords) {
    const check = await reconcileStellarTransaction(ctx.config, rec.txHash, lookup);
    if (check.status === "pending") {
      stillPending.push(rec);
      continue;
    }
    if (check.status === "confirmed") {
      const firstTime = ledger.markTxConfirmedOnce(rec.txHash);
      if (firstTime) {
        newlyConfirmedHashes.push(rec.txHash);
      }
      if (rec.claimId !== undefined) {
        ledger.markClaimConfirmed(chainKey, rec.claimId, rec.txHash);
        confirmedClaimIds.push(rec.claimId);
      }
      if (rec.bumpedCounts !== undefined && firstTime) {
        ttlConfirmedCounts = rec.bumpedCounts;
      }
      continue;
    }
    // status === "failed" on-chain: clear uncertain lock so safe requeue can proceed.
    if (rec.claimId !== undefined) {
      ledger.clearUncertainClaim(chainKey, rec.claimId);
    }
  }

  if (stillPending.length > 0) {
    ledger.updateFailedJobPending(jobId, stillPending);
    return {
      status: "held_pending",
      jobId,
      jobName: rawName,
      pendingTxHashes: stillPending.map((item) => item.txHash),
      confirmedTxHashes: newlyConfirmedHashes,
      confirmedResult: null,
      requeuedJobId: null,
      detail: `Holding recovery for ${jobId}: ${String(stillPending.length)} public transaction(s) remain pending on chain.`,
    };
  }

  ledger.updateFailedJobPending(jobId, []);

  if (rawName === "ttl-bump" && pendingRecords.length > 0 && newlyConfirmedHashes.length > 0) {
    const txHash = newlyConfirmedHashes[0] ?? null;
    const confirmedResult: KeeperJobResult = {
      kind: "ttl-bump",
      result: {
        bumpedTokens: ttlConfirmedCounts?.bumpedTokens ?? 0,
        bumpedClaims: ttlConfirmedCounts?.bumpedClaims ?? 0,
        bumpedTransfers: ttlConfirmedCounts?.bumpedTransfers ?? 0,
        dryRun: false,
        txHash,
        detail: `Reconciled confirmed router maintenance without rebroadcast: ${txHash ?? "confirmed"}`,
      },
    };
    ledger.recordConfirmedPayload(payloadKey, confirmedResult);
    ledger.clearFailedJobEvidence(jobId);
    if (queuedJob) {
      await queuedJob.remove();
    }
    return {
      status: "reconciled_confirmed",
      jobId,
      jobName: rawName,
      pendingTxHashes: [],
      confirmedTxHashes: newlyConfirmedHashes,
      confirmedResult,
      requeuedJobId: null,
      detail: confirmedResult.result.detail,
    };
  }

  if (
    rawName === "ttl-bump" &&
    pendingRecords.length > 0 &&
    pendingRecords.every((rec) => ledger.isTxConfirmed(rec.txHash))
  ) {
    ledger.clearFailedJobEvidence(jobId);
    if (queuedJob) {
      await queuedJob.remove();
    }
    return {
      status: "already_confirmed",
      jobId,
      jobName: rawName,
      pendingTxHashes: [],
      confirmedTxHashes: [],
      confirmedResult: null,
      requeuedJobId: null,
      detail: `Job ${jobId} public transaction was already reconciled and accounted.`,
    };
  }

  let recoveryPayload: TtlBumpPayload | ClaimSettlementPayload = payload;
  if (rawName === "claim-settlement") {
    const claimPayload = payload as ClaimSettlementPayload;
    const mergedExcluded = new Set<string>([
      ...(claimPayload.excludeClaimIds ?? []),
      ...confirmedClaimIds,
    ]);
    recoveryPayload = {
      ...claimPayload,
      ...(mergedExcluded.size > 0 ? { excludeClaimIds: [...mergedExcluded] } : {}),
    };
  }

  const recoveryJobId = `recovery:${canonicalizeKeeperPayloadKey(rawName, recoveryPayload)}`;
  await queue.add(rawName, recoveryPayload, {
    jobId: recoveryJobId,
    attempts: 1,
    removeOnComplete: {
      count: ctx.config.keeper.retention.maxCompletedJobs,
      age: ctx.config.keeper.retention.completedMaxAgeSeconds,
    },
    removeOnFail: false,
  });

  ledger.clearFailedJobEvidence(jobId);
  if (queuedJob) {
    await queuedJob.remove();
  }

  return {
    status: "requeued",
    jobId,
    jobName: rawName,
    pendingTxHashes: [],
    confirmedTxHashes: newlyConfirmedHashes,
    confirmedResult: null,
    requeuedJobId: recoveryJobId,
    detail: `Reconciled prior submissions and requeued ${rawName} as ${recoveryJobId}.`,
  };
}
