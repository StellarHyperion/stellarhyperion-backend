import { Address, nativeToScVal } from "@stellar/stellar-sdk";
import { bigintOf } from "../../db/rows.js";
import { canonicalizeKeeperPayloadKey, type UncertainTxRecord } from "../recovery.js";
import {
  KeeperUncertainSubmissionError,
  reconcileStellarTransaction,
  sanitizeKeeperText,
  submitStellar,
} from "../stellar.js";
import type { ClaimSettlementPayload, ClaimSettlementResult, KeeperContext } from "../types.js";

export class KeeperBatchUncertainError extends Error {
  readonly pendingSubmissions: readonly UncertainTxRecord[];

  constructor(message: string, pendingSubmissions: readonly UncertainTxRecord[]) {
    super(message);
    this.name = "KeeperBatchUncertainError";
    this.pendingSubmissions = pendingSubmissions;
  }
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
    };

  const ledger = ctx.recoveryLedger;
  const hasExplicitKey =
    typeof payload.idempotencyKey === "string" && payload.idempotencyKey.trim() !== "";
  const payloadKey = canonicalizeKeeperPayloadKey("claim-settlement", payload);

  if (ledger && hasExplicitKey) {
    const gate = ledger.tryAcquirePayloadExecution(payloadKey);
    if (!gate.acquired) {
      if (gate.duplicateResult?.kind === "claim-settlement") {
        return gate.duplicateResult.result;
      }
      return {
        settled: 0,
        attempted: 0,
        pending: 0,
        dryRun: false,
        deduplicated: true,
        settledTxHashes: [],
        detail:
          "Duplicate claim-settlement payload is already in flight; skipping duplicate execution.",
      };
    }
  }

  try {
    const { rows } = await ctx.db.query(
      "SELECT claim_id FROM pending_claim WHERE chain = $1 AND NOT settled ORDER BY claim_id ASC LIMIT $2",
      [chain.chain, payload.limit ?? 20],
    );
    if (!ctx.config.keeper.stellarSecret) {
      if (ledger && hasExplicitKey) {
        ledger.releasePayloadExecution(payloadKey);
      }
      return {
        settled: 0,
        attempted: 0,
        pending: rows.length,
        dryRun: true,
        detail: "No signer configured; no settlement was attempted.",
      };
    }

    const excluded = new Set(payload.excludeClaimIds ?? []);
    let settled = 0;
    let attempted = 0;
    const settledTxHashes: string[] = [];
    const uncertainRecords: UncertainTxRecord[] = [];

    for (const row of rows) {
      const id = bigintOf(row, "claim_id");
      const claimKey = String(id);

      if (excluded.has(claimKey) || ledger?.isClaimConfirmed(chain.chain, claimKey)) {
        continue;
      }

      // Reconcile any prior uncertain submission for this claim before submitting again.
      const priorUncertain = ledger?.getUncertainClaim(chain.chain, claimKey);
      if (priorUncertain !== undefined && ledger) {
        const reconciled = await reconcileStellarTransaction(
          ctx.config,
          priorUncertain.txHash,
          ctx.txLookupClient,
        );
        if (reconciled.status === "pending") {
          uncertainRecords.push(priorUncertain);
          continue;
        }
        if (reconciled.status === "confirmed") {
          const firstConfirm = ledger.markTxConfirmedOnce(priorUncertain.txHash);
          const firstClaim = ledger.markClaimConfirmed(
            chain.chain,
            claimKey,
            priorUncertain.txHash,
          );
          if (firstConfirm && firstClaim) {
            settled += 1;
            settledTxHashes.push(priorUncertain.txHash);
          }
          continue;
        }
        ledger.clearUncertainClaim(chain.chain, claimKey);
      }

      attempted += 1;
      try {
        const hash = await submitStellar(
          ctx.config,
          chain.routerContractId,
          "settle_claim",
          (sender) => [new Address(sender).toScVal(), nativeToScVal(id, { type: "u64" })],
        );
        const txFresh = ledger ? ledger.markTxConfirmedOnce(hash) : true;
        const claimFresh = ledger ? ledger.markClaimConfirmed(chain.chain, claimKey, hash) : true;
        if (txFresh && claimFresh) {
          ctx.logger.info(
            { claimId: claimKey, hash },
            "claim settlement confirmed; watcher will update the claim record",
          );
          settled += 1;
          settledTxHashes.push(hash);
        }
      } catch (error) {
        if (error instanceof KeeperUncertainSubmissionError) {
          const rec: UncertainTxRecord = {
            txHash: error.txHash,
            contract: error.contract,
            method: error.method,
            claimId: claimKey,
          };
          ledger?.recordUncertainClaim(chain.chain, claimKey, rec);
          uncertainRecords.push(rec);
        }
        const reason = error instanceof Error ? error.message : String(error);
        ctx.logger.warn(
          { claimId: claimKey, reason: sanitizeKeeperText(reason) },
          "claim is not ready for settlement",
        );
      }
    }

    if (uncertainRecords.length > 0) {
      if (ledger && hasExplicitKey) {
        ledger.releasePayloadExecution(payloadKey);
      }
      throw new KeeperBatchUncertainError(
        `${String(uncertainRecords.length)} claim settlement transaction(s) remain pending reconciliation.`,
        uncertainRecords,
      );
    }

    const result: ClaimSettlementResult = {
      settled,
      attempted,
      pending: Math.max(0, rows.length - settled),
      dryRun: false,
      settledTxHashes,
      detail: `${String(settled)} confirmed settlements of ${String(attempted)} attempts.`,
    };
    if (ledger && hasExplicitKey) {
      ledger.releasePayloadExecution(payloadKey, { kind: "claim-settlement", result });
    }
    return result;
  } catch (error) {
    if (ledger && hasExplicitKey) {
      ledger.releasePayloadExecution(payloadKey);
    }
    throw error;
  }
}
