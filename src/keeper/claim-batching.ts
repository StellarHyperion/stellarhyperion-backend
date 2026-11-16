import { isStellarDeployment } from "@hyperion/protocol";
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  extractBaseAddress,
  Keypair,
  nativeToScVal,
  rpc,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import type { AppConfig } from "../config/config.js";
import type {
  CandidateClaimRecord,
  ClaimBatchResourceLimits,
  ClaimItemAccounting,
  ClaimMeasuredResources,
  ClaimStateInspector,
  OnChainClaimDisposition,
  PlannedClaimBatchSummary,
} from "./types.js";

export const DEFAULT_CLAIM_BATCH_LIMITS: ClaimBatchResourceLimits = {
  maxBatchItems: 10,
  maxBatchCpuInstructions: 80_000_000,
  maxBatchReadBytes: 160_000,
  maxBatchWriteBytes: 96_000,
  maxBatchFeeStroops: 5_000_000n,
  maxBatchesPerRun: 4,
};

export function resolveClaimBatchLimits(
  overrides?: Partial<ClaimBatchResourceLimits>,
): ClaimBatchResourceLimits {
  return {
    maxBatchItems: overrides?.maxBatchItems ?? DEFAULT_CLAIM_BATCH_LIMITS.maxBatchItems,
    maxBatchCpuInstructions:
      overrides?.maxBatchCpuInstructions ?? DEFAULT_CLAIM_BATCH_LIMITS.maxBatchCpuInstructions,
    maxBatchReadBytes: overrides?.maxBatchReadBytes ?? DEFAULT_CLAIM_BATCH_LIMITS.maxBatchReadBytes,
    maxBatchWriteBytes:
      overrides?.maxBatchWriteBytes ?? DEFAULT_CLAIM_BATCH_LIMITS.maxBatchWriteBytes,
    maxBatchFeeStroops:
      overrides?.maxBatchFeeStroops ?? DEFAULT_CLAIM_BATCH_LIMITS.maxBatchFeeStroops,
    maxBatchesPerRun: overrides?.maxBatchesPerRun ?? DEFAULT_CLAIM_BATCH_LIMITS.maxBatchesPerRun,
  };
}

export interface ClaimableBatchEntry {
  readonly candidate: CandidateClaimRecord;
  readonly resources: ClaimMeasuredResources;
}

export interface PlannedClaimBatch {
  readonly batchIndex: number;
  readonly entries: readonly ClaimableBatchEntry[];
  readonly totalCpuInstructions: number;
  readonly totalReadBytes: number;
  readonly totalWriteBytes: number;
  readonly totalFeeStroops: bigint;
}

export interface ClaimBatchPlan {
  readonly batches: readonly PlannedClaimBatch[];
  readonly summaries: readonly PlannedClaimBatchSummary[];
  readonly rejectedItems: readonly ClaimItemAccounting[];
}

export function planClaimBatches(
  claimable: readonly ClaimableBatchEntry[],
  limits: ClaimBatchResourceLimits,
): ClaimBatchPlan {
  const batches: PlannedClaimBatch[] = [];
  const rejectedItems: ClaimItemAccounting[] = [];

  let currentEntries: ClaimableBatchEntry[] = [];
  let currentCpu = 0;
  let currentRead = 0;
  let currentWrite = 0;
  let currentFee = 0n;

  const flushBatch = () => {
    if (currentEntries.length === 0) return;
    batches.push({
      batchIndex: batches.length,
      entries: currentEntries,
      totalCpuInstructions: currentCpu,
      totalReadBytes: currentRead,
      totalWriteBytes: currentWrite,
      totalFeeStroops: currentFee,
    });
    currentEntries = [];
    currentCpu = 0;
    currentRead = 0;
    currentWrite = 0;
    currentFee = 0n;
  };

  for (const entry of claimable) {
    const claimIdText = String(entry.candidate.claimId);
    const fee = BigInt(entry.resources.minResourceFeeStroops);
    const cpu = entry.resources.cpuInstructions;
    const read = entry.resources.readBytes;
    const write = entry.resources.writeBytes;

    if (
      limits.maxBatchItems <= 0 ||
      cpu > limits.maxBatchCpuInstructions ||
      read > limits.maxBatchReadBytes ||
      write > limits.maxBatchWriteBytes ||
      fee > limits.maxBatchFeeStroops
    ) {
      rejectedItems.push({
        claimId: claimIdText,
        outcome: "exceeds_resource_limit",
        confirmed: false,
        txHash: null,
        batchIndex: null,
        recipient: entry.candidate.recipient,
        amount: entry.candidate.amount,
        detail: `Single claim resources (cpu=${cpu}, read=${read}, write=${write}, fee=${String(fee)}) exceed batch resource ceiling.`,
      });
      continue;
    }

    const wouldOverflowCurrent =
      currentEntries.length > 0 &&
      (currentEntries.length + 1 > limits.maxBatchItems ||
        currentCpu + cpu > limits.maxBatchCpuInstructions ||
        currentRead + read > limits.maxBatchReadBytes ||
        currentWrite + write > limits.maxBatchWriteBytes ||
        currentFee + fee > limits.maxBatchFeeStroops);

    if (wouldOverflowCurrent) {
      flushBatch();
    }

    if (batches.length >= limits.maxBatchesPerRun) {
      rejectedItems.push({
        claimId: claimIdText,
        outcome: "deferred_by_batch_limit",
        confirmed: false,
        txHash: null,
        batchIndex: null,
        recipient: entry.candidate.recipient,
        amount: entry.candidate.amount,
        detail: `Deferred beyond maxBatchesPerRun (${limits.maxBatchesPerRun}) after resource partitioning.`,
      });
      continue;
    }

    currentEntries.push(entry);
    currentCpu += cpu;
    currentRead += read;
    currentWrite += write;
    currentFee += fee;
  }

  flushBatch();

  const summaries: PlannedClaimBatchSummary[] = batches.map((batch) => ({
    batchIndex: batch.batchIndex,
    claimIds: batch.entries.map((entry) => String(entry.candidate.claimId)),
    totalCpuInstructions: batch.totalCpuInstructions,
    totalReadBytes: batch.totalReadBytes,
    totalWriteBytes: batch.totalWriteBytes,
    totalFeeStroops: String(batch.totalFeeStroops),
  }));

  return {
    batches,
    summaries,
    rejectedItems,
  };
}

function classifySimulationFailure(errorMessage: string): OnChainClaimDisposition | null {
  const lower = errorMessage.toLowerCase();
  if (
    lower.includes("already settled") ||
    lower.includes("claimsettled") ||
    lower.includes("settled")
  ) {
    return {
      status: "already_settled_on_chain",
      detail: `Simulation reported claim is already settled on chain: ${errorMessage}`,
    };
  }
  if (
    lower.includes("claim not found") ||
    lower.includes("unknown claim") ||
    lower.includes("missing claim") ||
    lower.includes("nonexistent claim")
  ) {
    return {
      status: "missing_on_chain",
      detail: `Simulation reported claim is missing on chain: ${errorMessage}`,
    };
  }
  if (
    lower.includes("frozen") ||
    lower.includes("not authorized") ||
    lower.includes("trustline") ||
    lower.includes("maintain_liabilities")
  ) {
    return {
      status: "frozen_recipient",
      authorizedToMaintainLiabilities: lower.includes("maintain_liabilities"),
      detail: `Simulation reported recipient cannot accept asset transfer: ${errorMessage}`,
    };
  }
  return null;
}

function resolveStellarAssetForSac(config: AppConfig, sacId: string | null): Asset | null {
  if (!sacId) return null;
  const stellar = config.indexer.stellar;
  if (!stellar) return null;
  const deployment = config.deployments.networks[stellar.chain];
  if (!deployment || !isStellarDeployment(deployment)) return null;
  for (const token of Object.values(deployment.tokens)) {
    if (token.sacId === sacId) {
      return new Asset(token.code, token.issuer);
    }
  }
  return null;
}

function normalizeRecipientAccount(recipient: string): string | null {
  if (StrKey.isValidMed25519PublicKey(recipient)) {
    return extractBaseAddress(recipient);
  }
  if (StrKey.isValidEd25519PublicKey(recipient) || StrKey.isValidContract(recipient)) {
    return recipient;
  }
  return null;
}

export function createRpcClaimStateInspector(config: AppConfig): ClaimStateInspector {
  const chain = config.indexer.stellar;
  if (!chain) {
    throw new Error("A Stellar deployment is required to create an RPC claim state inspector.");
  }
  const deployment = config.deployments.networks[chain.chain];
  const fallbackSource =
    deployment && isStellarDeployment(deployment) ? deployment.admin : undefined;
  const client = new rpc.Server(chain.rpcUrl, { timeout: 15_000 });

  return {
    async inspectClaim(candidate: CandidateClaimRecord): Promise<OnChainClaimDisposition> {
      if ((await client.getNetwork()).passphrase !== chain.networkPassphrase) {
        throw new Error("Keeper RPC network mismatch.");
      }

      if (candidate.recipient !== null) {
        const asset = resolveStellarAssetForSac(config, candidate.token);
        const targetAddress = normalizeRecipientAccount(candidate.recipient);
        if (asset && targetAddress && !StrKey.isValidContract(targetAddress)) {
          try {
            const balance = await client.getAssetBalance(
              targetAddress,
              asset,
              chain.networkPassphrase,
            );
            if (!balance.balanceEntry) {
              return {
                status: "frozen_recipient",
                authorizedToMaintainLiabilities: false,
                detail: `Recipient ${candidate.recipient} has no active trustline for ${asset.getCode()}; preserving parked claim liability.`,
              };
            }
            if (!balance.balanceEntry.authorized) {
              const maintainLiabilities =
                balance.balanceEntry.authorizedToMaintainLiabilities ?? false;
              return {
                status: "frozen_recipient",
                authorizedToMaintainLiabilities: maintainLiabilities,
                detail: `Recipient ${candidate.recipient} trustline for ${asset.getCode()} is frozen (authorized=false, maintainLiabilities=${String(maintainLiabilities)}); preserving parked claim liability and payout intent.`,
              };
            }
          } catch {
            // Fall through to authoritative router simulation if balance RPC lookup is unavailable.
          }
        }
      }

      const sourcePublicKey = config.keeper.stellarSecret
        ? Keypair.fromSecret(config.keeper.stellarSecret).publicKey()
        : fallbackSource;
      if (!sourcePublicKey) {
        throw new Error("No Stellar account available to simulate claim settlement.");
      }
      let account: Account;
      try {
        account = await client.getAccount(sourcePublicKey);
      } catch {
        account = new Account(sourcePublicKey, "0");
      }

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: chain.networkPassphrase,
      })
        .addOperation(
          new Contract(chain.routerContractId).call(
            "settle_claim",
            new Address(sourcePublicKey).toScVal(),
            nativeToScVal(candidate.claimId, { type: "u64" }),
          ),
        )
        .setTimeout(120)
        .build();

      const sim = await client.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) {
        const classified = classifySimulationFailure(sim.error);
        if (classified) return classified;
        throw new Error(`Claim ${String(candidate.claimId)} simulation failed: ${sim.error}`);
      }

      const txData = sim.transactionData.build();
      return {
        status: "claimable",
        recipient: candidate.recipient,
        amount: candidate.amount,
        resources: {
          cpuInstructions: txData.resources.instructions,
          readBytes: txData.resources.diskReadBytes,
          writeBytes: txData.resources.writeBytes,
          minResourceFeeStroops: String(BigInt(sim.minResourceFee)),
        },
      };
    },
    async supportsVectorSettlement(): Promise<boolean> {
      try {
        const methods = await client.getContractMethods(
          chain.routerContractId,
          chain.networkPassphrase,
        );
        return methods.some(
          (method) => method.name === "settle_claims" && method.inputs.length === 2,
        );
      } catch {
        return false;
      }
    },
    async verifyPostBatchClaimSettled(claimId: bigint): Promise<boolean> {
      const sourcePublicKey = config.keeper.stellarSecret
        ? Keypair.fromSecret(config.keeper.stellarSecret).publicKey()
        : fallbackSource;
      if (!sourcePublicKey) return false;
      const account = new Account(sourcePublicKey, "0");
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: chain.networkPassphrase,
      })
        .addOperation(
          new Contract(chain.routerContractId).call(
            "settle_claim",
            new Address(sourcePublicKey).toScVal(),
            nativeToScVal(claimId, { type: "u64" }),
          ),
        )
        .setTimeout(120)
        .build();
      const sim = await client.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) {
        const classified = classifySimulationFailure(sim.error);
        return classified?.status === "already_settled_on_chain";
      }
      return false;
    },
  };
}

export function buildSettleClaimsVectorArgs(
  sender: string,
  claimIds: readonly bigint[],
): xdr.ScVal[] {
  return [
    new Address(sender).toScVal(),
    xdr.ScVal.scvVec(claimIds.map((id) => nativeToScVal(id, { type: "u64" }))),
  ];
}
