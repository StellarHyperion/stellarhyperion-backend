import { Address, nativeToScVal } from "@stellar/stellar-sdk";
import { bigintOf } from "../../db/rows.js";
import { resolveResourceBounds, validateMeasuredResources } from "../adapters.js";
import { submitStellar } from "../stellar.js";
import type { ClaimSettlementPayload, ClaimSettlementResult, KeeperContext } from "../types.js";

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
  const { rows } = await ctx.db.query(
    "SELECT claim_id FROM pending_claim WHERE chain = $1 AND NOT settled ORDER BY claim_id ASC LIMIT $2",
    [chain.chain, payload.limit ?? 20],
  );
  if (!ctx.config.keeper.stellarSecret)
    return {
      settled: 0,
      attempted: 0,
      pending: rows.length,
      dryRun: true,
      detail: "No signer configured; no settlement was attempted.",
    };
  const bounds = resolveResourceBounds(payload.resourceBounds);
  if (ctx.maintenanceInspector) {
    const methods = await ctx.maintenanceInspector.getContractMethods(chain.routerContractId);
    if (!methods.some((method) => method.name === "settle_claim" && method.inputs.length === 2)) {
      throw new Error(
        `Router contract ${chain.routerContractId} does not expose a callable settle_claim entrypoint.`,
      );
    }
  }
  let settled = 0;
  for (const row of rows) {
    const id = bigintOf(row, "claim_id");
    const buildArgs = (sender: string) => [
      new Address(sender).toScVal(),
      nativeToScVal(id, { type: "u64" }),
    ];
    try {
      if (ctx.maintenanceInspector) {
        const measured = await ctx.maintenanceInspector.measureCall(
          chain.routerContractId,
          "settle_claim",
          buildArgs,
        );
        const validation = validateMeasuredResources(measured, bounds);
        if (!validation.ok) {
          throw new Error(validation.detail);
        }
      }
      const hash = await submitStellar(
        ctx.config,
        chain.routerContractId,
        "settle_claim",
        buildArgs,
        {
          resourceBounds: payload.resourceBounds,
          requireCallableMethod: true,
        },
      );
      ctx.logger.info(
        { claimId: String(id), hash },
        "claim settlement confirmed; watcher will update the claim record",
      );
      settled += 1;
    } catch (error) {
      ctx.logger.warn({ err: error, claimId: String(id) }, "claim is not ready for settlement");
    }
  }
  return {
    settled,
    attempted: rows.length,
    pending: rows.length - settled,
    dryRun: false,
    detail: `${settled} confirmed settlements of ${rows.length} attempts.`,
  };
}
