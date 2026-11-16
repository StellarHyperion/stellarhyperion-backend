import { Address, nativeToScVal } from "@stellar/stellar-sdk";
import { bigintOf, bigintOrNull, textOrNull } from "../../db/rows.js";
import {
  buildSettleClaimsVectorArgs,
  planClaimBatches,
  resolveClaimBatchLimits,
  type ClaimableBatchEntry,
} from "../claim-batching.js";
import { submitStellar } from "../stellar.js";
import type {
  CandidateClaimRecord,
  ClaimItemAccounting,
  ClaimSettlementPayload,
  ClaimSettlementResult,
  KeeperContext,
} from "../types.js";

function parseCandidateRow(row: Record<string, unknown>): CandidateClaimRecord {
  const amount = bigintOrNull(row, "amount");
  return {
    claimId: bigintOf(row, "claim_id"),
    recipient: textOrNull(row, "recipient"),
    token: textOrNull(row, "token"),
    amount: amount === null ? null : String(amount),
  };
}

export async function processClaimSettlement(
  ctx: KeeperContext,
  payload: ClaimSettlementPayload = {},
): Promise<ClaimSettlementResult> {
  const chain = ctx.config.indexer.stellar;
  if (!chain)
    return {
      settled: 0,
      attempted: 0,
      pending: 0,
      dryRun: true,
      detail: "No Stellar deployment configured.",
      batches: [],
      items: [],
    };
  const { rows } = await ctx.db.query(
    "SELECT claim_id, recipient, token, amount FROM pending_claim WHERE chain = $1 AND NOT settled ORDER BY claim_id ASC LIMIT $2",
    [chain.chain, payload.limit ?? 20],
  );
  if (!ctx.config.keeper.stellarSecret)
    return {
      settled: 0,
      attempted: 0,
      pending: rows.length,
      dryRun: true,
      detail: "No signer configured; no settlement was attempted.",
      batches: [],
      items: [],
    };

  const candidates = rows.map(parseCandidateRow);
  const limits = resolveClaimBatchLimits(payload.batchLimits);

  if (!ctx.claimInspector) {
    let settled = 0;
    const items: ClaimItemAccounting[] = [];
    const defaultEntries: ClaimableBatchEntry[] = candidates.map((candidate) => ({
      candidate,
      resources: {
        cpuInstructions: 1_000_000,
        readBytes: 4_096,
        writeBytes: 2_048,
        minResourceFeeStroops: "50000",
      },
    }));
    const plan = planClaimBatches(defaultEntries, limits);
    items.push(...plan.rejectedItems);

    let attempted = 0;
    for (const batch of plan.batches) {
      for (const entry of batch.entries) {
        attempted += 1;
        const id = entry.candidate.claimId;
        const claimIdText = String(id);
        try {
          const hash = await submitStellar(
            ctx.config,
            chain.routerContractId,
            "settle_claim",
            (sender) => [new Address(sender).toScVal(), nativeToScVal(id, { type: "u64" })],
          );
          ctx.logger.info(
            { claimId: claimIdText, hash, batchIndex: batch.batchIndex },
            "claim settlement confirmed; watcher will update the claim record",
          );
          settled += 1;
          items.push({
            claimId: claimIdText,
            outcome: "confirmed_settled",
            confirmed: true,
            txHash: hash,
            batchIndex: batch.batchIndex,
            recipient: entry.candidate.recipient,
            amount: entry.candidate.amount,
            detail: `Confirmed settlement in transaction ${hash}.`,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.logger.warn(
            { err: error, claimId: claimIdText },
            "claim is not ready for settlement",
          );
          items.push({
            claimId: claimIdText,
            outcome: "submission_failed",
            confirmed: false,
            txHash: null,
            batchIndex: batch.batchIndex,
            recipient: entry.candidate.recipient,
            amount: entry.candidate.amount,
            detail: message,
          });
        }
      }
    }

    return {
      settled,
      attempted,
      pending: rows.length - settled,
      dryRun: false,
      detail: `${settled} confirmed settlements of ${attempted} attempts.`,
      batches: plan.summaries,
      items,
    };
  }

  const items: ClaimItemAccounting[] = [];
  const claimableEntries: ClaimableBatchEntry[] = [];

  for (const candidate of candidates) {
    const claimIdText = String(candidate.claimId);
    try {
      const disposition = await ctx.claimInspector.inspectClaim(candidate);
      if (disposition.status === "already_settled_on_chain") {
        items.push({
          claimId: claimIdText,
          outcome: "already_settled_on_chain",
          confirmed: false,
          txHash: null,
          batchIndex: null,
          recipient: candidate.recipient,
          amount: candidate.amount,
          detail: disposition.detail,
        });
        continue;
      }
      if (disposition.status === "missing_on_chain") {
        items.push({
          claimId: claimIdText,
          outcome: "missing_on_chain",
          confirmed: false,
          txHash: null,
          batchIndex: null,
          recipient: candidate.recipient,
          amount: candidate.amount,
          detail: disposition.detail,
        });
        continue;
      }
      if (disposition.status === "frozen_recipient") {
        ctx.logger.info(
          {
            claimId: claimIdText,
            authorizedToMaintainLiabilities: disposition.authorizedToMaintainLiabilities,
          },
          "skipping claim with frozen or unauthorized recipient to preserve liability and payout intent",
        );
        items.push({
          claimId: claimIdText,
          outcome: "frozen_recipient",
          confirmed: false,
          txHash: null,
          batchIndex: null,
          recipient: candidate.recipient,
          amount: candidate.amount,
          detail: disposition.detail,
        });
        continue;
      }
      if (
        (disposition.recipient !== null &&
          candidate.recipient !== null &&
          disposition.recipient !== candidate.recipient) ||
        (disposition.amount !== null &&
          candidate.amount !== null &&
          disposition.amount !== candidate.amount)
      ) {
        items.push({
          claimId: claimIdText,
          outcome: "submission_failed",
          confirmed: false,
          txHash: null,
          batchIndex: null,
          recipient: candidate.recipient,
          amount: candidate.amount,
          detail:
            "On-chain claim recipient or amount disagreed with recorded payout intent; refusing settlement.",
        });
        continue;
      }
      claimableEntries.push({
        candidate,
        resources: disposition.resources,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.warn({ err: error, claimId: claimIdText }, "claim preflight inspection failed");
      items.push({
        claimId: claimIdText,
        outcome: "submission_failed",
        confirmed: false,
        txHash: null,
        batchIndex: null,
        recipient: candidate.recipient,
        amount: candidate.amount,
        detail: message,
      });
    }
  }

  const plan = planClaimBatches(claimableEntries, limits);
  items.push(...plan.rejectedItems);

  const useVectorBatch = (await ctx.claimInspector.supportsVectorSettlement?.()) === true;
  let settled = 0;
  let attempted = 0;

  for (const batch of plan.batches) {
    if (useVectorBatch && batch.entries.length > 1) {
      attempted += batch.entries.length;
      const batchIds = batch.entries.map((entry) => entry.candidate.claimId);
      try {
        const hash = await submitStellar(
          ctx.config,
          chain.routerContractId,
          "settle_claims",
          (sender) => buildSettleClaimsVectorArgs(sender, batchIds),
        );
        for (const entry of batch.entries) {
          const claimIdText = String(entry.candidate.claimId);
          const verified = ctx.claimInspector.verifyPostBatchClaimSettled
            ? await ctx.claimInspector.verifyPostBatchClaimSettled(entry.candidate.claimId)
            : true;
          if (verified) {
            settled += 1;
            items.push({
              claimId: claimIdText,
              outcome: "confirmed_settled",
              confirmed: true,
              txHash: hash,
              batchIndex: batch.batchIndex,
              recipient: entry.candidate.recipient,
              amount: entry.candidate.amount,
              detail: `Confirmed in vector batch ${batch.batchIndex} transaction ${hash}.`,
            });
          } else {
            items.push({
              claimId: claimIdText,
              outcome: "submission_failed",
              confirmed: false,
              txHash: null,
              batchIndex: batch.batchIndex,
              recipient: entry.candidate.recipient,
              amount: entry.candidate.amount,
              detail: `Batch transaction ${hash} completed, but post-check did not confirm settlement for claim ${claimIdText}.`,
            });
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const entry of batch.entries) {
          items.push({
            claimId: String(entry.candidate.claimId),
            outcome: "submission_failed",
            confirmed: false,
            txHash: null,
            batchIndex: batch.batchIndex,
            recipient: entry.candidate.recipient,
            amount: entry.candidate.amount,
            detail: message,
          });
        }
      }
      continue;
    }

    for (const entry of batch.entries) {
      attempted += 1;
      const id = entry.candidate.claimId;
      const claimIdText = String(id);
      try {
        const hash = await submitStellar(
          ctx.config,
          chain.routerContractId,
          "settle_claim",
          (sender) => [new Address(sender).toScVal(), nativeToScVal(id, { type: "u64" })],
        );
        ctx.logger.info(
          { claimId: claimIdText, hash, batchIndex: batch.batchIndex },
          "claim settlement confirmed; watcher will update the claim record",
        );
        settled += 1;
        items.push({
          claimId: claimIdText,
          outcome: "confirmed_settled",
          confirmed: true,
          txHash: hash,
          batchIndex: batch.batchIndex,
          recipient: entry.candidate.recipient,
          amount: entry.candidate.amount,
          detail: `Confirmed settlement in batch ${batch.batchIndex} transaction ${hash}.`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.warn({ err: error, claimId: claimIdText }, "claim is not ready for settlement");
        items.push({
          claimId: claimIdText,
          outcome: "submission_failed",
          confirmed: false,
          txHash: null,
          batchIndex: batch.batchIndex,
          recipient: entry.candidate.recipient,
          amount: entry.candidate.amount,
          detail: message,
        });
      }
    }
  }

  return {
    settled,
    attempted,
    pending: rows.length - settled,
    dryRun: false,
    detail: `${settled} confirmed settlements across ${plan.batches.length} bounded batches (${attempted} attempted of ${rows.length} inspected).`,
    batches: plan.summaries,
    items,
  };
}
