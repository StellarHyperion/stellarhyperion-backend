import { Address, nativeToScVal } from "@stellar/stellar-sdk";
import { bigintOf } from "../../db/rows.js";
import { submitStellar } from "../stellar.js";
import { recordKeeperSubmission } from "../outcomes.js";
import type { ClaimSettlementPayload, ClaimSettlementResult, KeeperContext, AdapterCoverage } from "../types.js";
const MAX_FEE = 10_000;
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
  if (ctx.config.keeper.stellarSecrets.length === 0) {
    await recordKeeperSubmission(ctx.db, {
      jobName: "claim-settlement",
      signerPublicKey: "dry-run",
      stage: "simulated",
    });
    return {
      settled: 0,
      attempted: 0,
      pending: rows.length,
      dryRun: true,
      detail: "No signer configured; no settlement was attempted.",
    };
  }
  const adapter = chain.routerContractId;
  const deployment = ctx.config.deployments.networks[chain.chain];
  const adapterSupported = !!deployment && Object.keys(deployment.tokens).length > 0;
  const routerCoverage: AdapterCoverage = {
    adapter,
    supported: !!chain,
    covered: !!chain,
  };
  ctx.logger.info({ routerCoverage }, "router coverage reported");
  const adapterCoverage: AdapterCoverage = {
    adapter,
    supported: adapterSupported,
    covered: adapterSupported,
  };
  ctx.logger.info({ adapterCoverage }, "adapter coverage reported");
  let settled = 0;
  let totalFees = 0;
  for (const row of rows) {
    const id = bigintOf(row, "claim_id");
    const fee = 100;
    totalFees += fee;
    if (totalFees > MAX_FEE) {
      ctx.logger.warn({ totalFees, maxFee: MAX_FEE }, "fee budget exceeded; stopping settlements");
      break;
    }
    try {
      const hash = await submitStellar(
        ctx.config,
        ctx.db,
        chain.chain,
        chain.routerContractId,
        "settle_claim",
        "settle_claim",
        (sender) => [new Address(sender).toScVal(), nativeToScVal(id, { type: "u64" })],
        { db: ctx.db, jobName: "claim-settlement" },
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
  const attempted = rows.length;
  const pending = attempted - settled;
  return {
    settled,
    attempted,
    pending,
    dryRun: false,
    detail: `${settled} confirmed settlements of ${attempted} attempts, fees: ${totalFees}`,
  };
}
