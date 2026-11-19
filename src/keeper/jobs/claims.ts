import { Address, nativeToScVal } from "@stellar/stellar-sdk";
import { bigintOf } from "../../db/rows.js";
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
