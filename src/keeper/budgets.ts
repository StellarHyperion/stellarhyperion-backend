import type { rpc } from "@stellar/stellar-sdk";
import { BASE_FEE } from "@stellar/stellar-sdk";
import type { KeeperBudgetConfig } from "../config/config.js";
import type {
  BudgetDiagnostic,
  BudgetTrackerPort,
  IntervalBudgetAccountingSnapshot,
  JobBudgetSessionPort,
  SimulatedCostProfile,
} from "./types.js";

export class KeeperBudgetExceededError extends Error {
  readonly diagnostic: BudgetDiagnostic;

  constructor(diagnostic: BudgetDiagnostic) {
    super(
      `Keeper transaction blocked before signing (${diagnostic.contract}.${diagnostic.method}): exceeded [${diagnostic.exceededDimensions.join(", ")}].`,
    );
    this.name = "KeeperBudgetExceededError";
    this.diagnostic = diagnostic;
  }
}

export class ClaimRecipientOverrideError extends Error {
  readonly fieldPath: string;

  constructor(fieldPath: string) {
    super(
      `Manual configuration field "${fieldPath}" is forbidden: claim payout recipients are fixed on-chain in router storage and cannot be redirected.`,
    );
    this.name = "ClaimRecipientOverrideError";
    this.fieldPath = fieldPath;
  }
}

const FORBIDDEN_PAYLOAD_RECIPIENT_KEYS = [
  "recipient",
  "recipients",
  "recipientOverride",
  "payoutRecipient",
  "destination",
  "redirectTo",
  "to",
  "beneficiary",
] as const;

export function assertNoClaimRecipientOverride(payload: unknown): void {
  if (typeof payload !== "object" || payload === null) return;
  const record = payload as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const normalized = key.toLowerCase();
    const matchesExplicit = (FORBIDDEN_PAYLOAD_RECIPIENT_KEYS as readonly string[]).some(
      (forbidden) => forbidden.toLowerCase() === normalized,
    );
    const matchesSubstring =
      normalized.includes("recipient") ||
      normalized.includes("beneficiary") ||
      normalized.includes("redirect") ||
      normalized.includes("payout");
    if ((matchesExplicit || matchesSubstring) && record[key] !== undefined) {
      throw new ClaimRecipientOverrideError(`payload.${key}`);
    }
  }
}

export function extractSimulatedCostProfile(
  sim: rpc.Api.SimulateTransactionSuccessResponse,
  baseFeeStroops = BigInt(BASE_FEE),
): SimulatedCostProfile {
  const txData = sim.transactionData.build();
  const minResourceFeeStroops = BigInt(sim.minResourceFee);
  const totalFeeStroops = baseFeeStroops + minResourceFeeStroops;
  const footprintKeys =
    txData.resources.footprint.readOnly.length + txData.resources.footprint.readWrite.length;
  return {
    baseFeeStroops,
    minResourceFeeStroops,
    totalFeeStroops,
    cpuInstructions: txData.resources.instructions,
    readBytes: txData.resources.diskReadBytes,
    writeBytes: txData.resources.writeBytes,
    footprintKeys,
  };
}

interface SubmittedTxEntry {
  readonly feeStroops: bigint;
  status: "pending" | "confirmed" | "failed";
}

interface IntervalBucket {
  intervalIndex: number;
  intervalStartedAtMs: number;
  submittedStroops: bigint;
  confirmedStroops: bigint;
  failedSubmittedStroops: bigint;
  submittedTxCount: number;
  confirmedTxCount: number;
  blockedCount: number;
  lastDiagnostic: BudgetDiagnostic | null;
  readonly txs: Map<string, SubmittedTxEntry>;
}

export class KeeperBudgetTracker implements BudgetTrackerPort {
  private bucket: IntervalBucket;

  constructor(
    private readonly baseConfig: KeeperBudgetConfig,
    private readonly clock: () => number = () => Date.now(),
  ) {
    const now = this.clock();
    const index = Math.floor(now / this.baseConfig.intervalMs);
    this.bucket = this.freshBucket(index);
  }

  private freshBucket(intervalIndex: number): IntervalBucket {
    return {
      intervalIndex,
      intervalStartedAtMs: intervalIndex * this.baseConfig.intervalMs,
      submittedStroops: 0n,
      confirmedStroops: 0n,
      failedSubmittedStroops: 0n,
      submittedTxCount: 0,
      confirmedTxCount: 0,
      blockedCount: 0,
      lastDiagnostic: null,
      txs: new Map(),
    };
  }

  private currentBucket(nowMs = this.clock()): IntervalBucket {
    const index = Math.floor(nowMs / this.baseConfig.intervalMs);
    if (index !== this.bucket.intervalIndex) {
      this.bucket = this.freshBucket(index);
    }
    return this.bucket;
  }

  snapshot(nowMs = this.clock()): IntervalBudgetAccountingSnapshot {
    const active = this.currentBucket(nowMs);
    const pendingSubmitted =
      active.submittedStroops - active.confirmedStroops - active.failedSubmittedStroops;
    return {
      intervalIndex: active.intervalIndex,
      intervalStartedAtMs: active.intervalStartedAtMs,
      intervalMs: this.baseConfig.intervalMs,
      maxIntervalFeeStroops: String(this.baseConfig.maxIntervalFeeStroops),
      submittedStroops: String(active.submittedStroops),
      confirmedStroops: String(active.confirmedStroops),
      pendingSubmittedStroops: String(pendingSubmitted < 0n ? 0n : pendingSubmitted),
      failedSubmittedStroops: String(active.failedSubmittedStroops),
      submittedTxCount: active.submittedTxCount,
      confirmedTxCount: active.confirmedTxCount,
      blockedCount: active.blockedCount,
      exhausted: active.submittedStroops >= this.baseConfig.maxIntervalFeeStroops,
      lastDiagnostic: active.lastDiagnostic,
    };
  }

  createJobSession(overrides?: Partial<KeeperBudgetConfig>): JobBudgetSessionPort {
    const effective: KeeperBudgetConfig = {
      maxTxFeeStroops: overrides?.maxTxFeeStroops ?? this.baseConfig.maxTxFeeStroops,
      maxJobFeeStroops: overrides?.maxJobFeeStroops ?? this.baseConfig.maxJobFeeStroops,
      maxIntervalFeeStroops:
        overrides?.maxIntervalFeeStroops ?? this.baseConfig.maxIntervalFeeStroops,
      intervalMs: overrides?.intervalMs ?? this.baseConfig.intervalMs,
      maxCpuInstructions: overrides?.maxCpuInstructions ?? this.baseConfig.maxCpuInstructions,
      maxReadBytes: overrides?.maxReadBytes ?? this.baseConfig.maxReadBytes,
      maxWriteBytes: overrides?.maxWriteBytes ?? this.baseConfig.maxWriteBytes,
      maxFootprintKeys: overrides?.maxFootprintKeys ?? this.baseConfig.maxFootprintKeys,
    };

    let jobSubmittedStroops = 0n;
    let jobConfirmedStroops = 0n;
    let jobFailedSubmittedStroops = 0n;
    let jobSubmittedTxCount = 0;
    let jobConfirmedTxCount = 0;
    let jobBlockedCount = 0;
    const jobDiagnostics: BudgetDiagnostic[] = [];
    const jobTxs = new Map<string, SubmittedTxEntry>();

    return {
      evaluateBeforeSign: (contract, method, cost, nowMs) => {
        const bucket = this.currentBucket(nowMs);
        const exceeded: string[] = [];

        if (cost.totalFeeStroops > effective.maxTxFeeStroops) {
          exceeded.push(
            `txFeeStroops (${String(cost.totalFeeStroops)} > ${String(effective.maxTxFeeStroops)})`,
          );
        }
        if (jobSubmittedStroops + cost.totalFeeStroops > effective.maxJobFeeStroops) {
          exceeded.push(
            `jobFeeStroops (${String(jobSubmittedStroops + cost.totalFeeStroops)} > ${String(effective.maxJobFeeStroops)})`,
          );
        }
        if (bucket.submittedStroops + cost.totalFeeStroops > effective.maxIntervalFeeStroops) {
          exceeded.push(
            `intervalFeeStroops (${String(bucket.submittedStroops + cost.totalFeeStroops)} > ${String(effective.maxIntervalFeeStroops)})`,
          );
        }
        if (cost.cpuInstructions > effective.maxCpuInstructions) {
          exceeded.push(
            `cpuInstructions (${cost.cpuInstructions} > ${effective.maxCpuInstructions})`,
          );
        }
        if (cost.readBytes > effective.maxReadBytes) {
          exceeded.push(`readBytes (${cost.readBytes} > ${effective.maxReadBytes})`);
        }
        if (cost.writeBytes > effective.maxWriteBytes) {
          exceeded.push(`writeBytes (${cost.writeBytes} > ${effective.maxWriteBytes})`);
        }
        if (cost.footprintKeys > effective.maxFootprintKeys) {
          exceeded.push(`footprintKeys (${cost.footprintKeys} > ${effective.maxFootprintKeys})`);
        }

        if (exceeded.length > 0) {
          const diagnostic: BudgetDiagnostic = {
            code: "keeper_budget_exceeded",
            contract,
            method,
            exceededDimensions: exceeded,
            estimatedFeeStroops: String(cost.totalFeeStroops),
            cpuInstructions: cost.cpuInstructions,
            readBytes: cost.readBytes,
            writeBytes: cost.writeBytes,
            footprintKeys: cost.footprintKeys,
            jobSubmittedStroops: String(jobSubmittedStroops),
            jobConfirmedStroops: String(jobConfirmedStroops),
            intervalSubmittedStroops: String(bucket.submittedStroops),
            intervalConfirmedStroops: String(bucket.confirmedStroops),
            maxTxFeeStroops: String(effective.maxTxFeeStroops),
            maxJobFeeStroops: String(effective.maxJobFeeStroops),
            maxIntervalFeeStroops: String(effective.maxIntervalFeeStroops),
          };
          jobBlockedCount += 1;
          bucket.blockedCount += 1;
          bucket.lastDiagnostic = diagnostic;
          jobDiagnostics.push(diagnostic);
          return { allowed: false, diagnostic };
        }

        return { allowed: true };
      },

      recordSubmitted: (txHash, feeStroops, nowMs) => {
        if (jobTxs.has(txHash)) return;
        const bucket = this.currentBucket(nowMs);
        jobTxs.set(txHash, { feeStroops, status: "pending" });
        bucket.txs.set(txHash, { feeStroops, status: "pending" });
        jobSubmittedStroops += feeStroops;
        jobSubmittedTxCount += 1;
        bucket.submittedStroops += feeStroops;
        bucket.submittedTxCount += 1;
      },

      recordConfirmed: (txHash, feeStroops, nowMs) => {
        const bucket = this.currentBucket(nowMs);
        const existingJob = jobTxs.get(txHash);
        if (existingJob?.status === "confirmed") return;
        const delta = existingJob ? existingJob.feeStroops : feeStroops;
        if (!existingJob) {
          const created: SubmittedTxEntry = { feeStroops: delta, status: "confirmed" };
          jobTxs.set(txHash, created);
          jobSubmittedStroops += delta;
          jobSubmittedTxCount += 1;
        } else {
          existingJob.status = "confirmed";
        }
        jobConfirmedStroops += delta;
        jobConfirmedTxCount += 1;

        const existingBucket = bucket.txs.get(txHash);
        if (existingBucket?.status !== "confirmed") {
          if (!existingBucket) {
            bucket.txs.set(txHash, { feeStroops: delta, status: "confirmed" });
            bucket.submittedStroops += delta;
            bucket.submittedTxCount += 1;
          } else {
            existingBucket.status = "confirmed";
          }
          bucket.confirmedStroops += delta;
          bucket.confirmedTxCount += 1;
        }
      },

      recordFailedAfterSubmit: (txHash, feeStroops, nowMs) => {
        const bucket = this.currentBucket(nowMs);
        const existingJob = jobTxs.get(txHash);
        if (existingJob?.status === "pending") {
          existingJob.status = "failed";
          jobFailedSubmittedStroops += existingJob.feeStroops;
        } else if (!existingJob) {
          jobTxs.set(txHash, { feeStroops, status: "failed" });
          jobSubmittedStroops += feeStroops;
          jobFailedSubmittedStroops += feeStroops;
          jobSubmittedTxCount += 1;
        }

        const existingBucket = bucket.txs.get(txHash);
        if (existingBucket?.status === "pending") {
          existingBucket.status = "failed";
          bucket.failedSubmittedStroops += existingBucket.feeStroops;
        } else if (!existingBucket) {
          bucket.txs.set(txHash, { feeStroops, status: "failed" });
          bucket.submittedStroops += feeStroops;
          bucket.failedSubmittedStroops += feeStroops;
          bucket.submittedTxCount += 1;
        }
      },

      snapshot: () => {
        const pendingSubmitted =
          jobSubmittedStroops - jobConfirmedStroops - jobFailedSubmittedStroops;
        return {
          submittedStroops: String(jobSubmittedStroops),
          confirmedStroops: String(jobConfirmedStroops),
          pendingSubmittedStroops: String(pendingSubmitted < 0n ? 0n : pendingSubmitted),
          failedSubmittedStroops: String(jobFailedSubmittedStroops),
          submittedTxCount: jobSubmittedTxCount,
          confirmedTxCount: jobConfirmedTxCount,
          blockedCount: jobBlockedCount,
          diagnostics: [...jobDiagnostics],
        };
      },
    };
  }
}
