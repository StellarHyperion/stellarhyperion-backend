import { Address, nativeToScVal } from "@stellar/stellar-sdk";
import { bigintOf } from "../../db/rows.js";
import {
  assembleDryRunPlan,
  previewStellarOperation,
  sanitizePublicPreviewText,
  submitStellar,
} from "../stellar.js";
import type {
  ClaimSettlementPayload,
  ClaimSettlementResult,
  KeeperClaimPreview,
  KeeperContext,
  KeeperOperationPreview,
} from "../types.js";

function extractClaimPreviewRow(id: bigint, row: Record<string, unknown>): KeeperClaimPreview {
  const recipient = typeof row.recipient === "string" ? row.recipient : "";
  const token = typeof row.token === "string" ? row.token : null;
  let amount = "0";
  if (typeof row.amount === "string") {
    amount = row.amount;
  } else if (typeof row.amount === "bigint" || typeof row.amount === "number") {
    amount = String(row.amount);
  }
  const route = typeof row.route === "number" ? row.route : null;

  return {
    claimId: String(id),
    recipient,
    token,
    amount,
    route,
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
      plan: assembleDryRunPlan([]),
    };

  const { rows } = await ctx.db.query(
    "SELECT claim_id, recipient, token, amount, route FROM pending_claim WHERE chain = $1 AND NOT settled ORDER BY claim_id ASC LIMIT $2",
    [chain.chain, payload.limit ?? 20],
  );

  const dryRun = payload.dryRun === true || !ctx.config.keeper.stellarSecret;
  if (dryRun) {
    const previews: KeeperOperationPreview[] = [];
    for (const row of rows) {
      const id = bigintOf(row, "claim_id");
      const dbClaim = extractClaimPreviewRow(id, row);
      const onChainClaim = ctx.simulationClient?.readOnChainClaim
        ? await ctx.simulationClient.readOnChainClaim(chain.routerContractId, id)
        : null;

      const claimPreview: KeeperClaimPreview =
        onChainClaim !== null
          ? {
              claimId: String(id),
              recipient: onChainClaim.recipient,
              token: onChainClaim.token ?? dbClaim.token,
              amount: onChainClaim.amount,
              route: onChainClaim.route ?? dbClaim.route,
            }
          : dbClaim;

      const opPreview = await previewStellarOperation({
        chain: chain.chain,
        networkPassphrase: chain.networkPassphrase,
        rpcUrl: chain.rpcUrl,
        contract: chain.routerContractId,
        method: "settle_claim",
        args: (unsignedCaller) => [
          new Address(unsignedCaller).toScVal(),
          nativeToScVal(id, { type: "u64" }),
        ],
        targetKeys: [`router:${chain.routerContractId}`, `claim:${String(id)}`],
        argsSummary: {
          claimId: String(id),
          recipient: claimPreview.recipient,
          amount: claimPreview.amount,
          token: claimPreview.token,
          route: claimPreview.route,
        },
        claimPreview,
        ...(ctx.simulationClient !== undefined ? { simulationClient: ctx.simulationClient } : {}),
        ...(payload.simulateViaRpc !== undefined ? { simulateViaRpc: payload.simulateViaRpc } : {}),
      });
      previews.push(opPreview);
    }

    const plan = assembleDryRunPlan(previews);
    const detailPrefix =
      payload.dryRun === true
        ? `Dry-run claim settlement plan prepared (${String(previews.length)} unsigned operations`
        : `No signer configured; no settlement was attempted (${String(previews.length)} unsigned operations`;

    return {
      settled: 0,
      attempted: 0,
      pending: rows.length,
      dryRun: true,
      detail: `${detailPrefix}, estimated fee ${plan.totalEstimatedFeeStroops} stroops).`,
      plan,
    };
  }

  let settled = 0;
  for (const row of rows) {
    const id = bigintOf(row, "claim_id");
    try {
      const hash = await submitStellar(
        ctx.config,
        chain.routerContractId,
        "settle_claim",
        (sender) => [new Address(sender).toScVal(), nativeToScVal(id, { type: "u64" })],
      );
      ctx.logger.info(
        { claimId: String(id), hash },
        "claim settlement confirmed; watcher will update the claim record",
      );
      settled += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ctx.logger.warn(
        { claimId: String(id), reason: sanitizePublicPreviewText(reason) },
        "claim is not ready for settlement",
      );
    }
  }
  return {
    settled,
    attempted: rows.length,
    pending: rows.length - settled,
    dryRun: false,
    detail: `${String(settled)} confirmed settlements of ${String(rows.length)} attempts.`,
  };
}
