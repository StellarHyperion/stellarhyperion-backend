import { Address, BASE_FEE, nativeToScVal } from "@stellar/stellar-sdk";
import { bigintOf, text } from "../../db/rows.js";
import { submitStellar } from "../stellar.js";
import { recordKeeperSubmission } from "../outcomes.js";
import type {
  ClaimSettlementPayload,
  ClaimSettlementResult,
  KeeperContext,
  KeeperOperationPreview,
} from "../types.js";

export async function processClaimSettlement(
  ctx: KeeperContext,
  payload: ClaimSettlementPayload = {},
): Promise<ClaimSettlementResult> {
  const chain = ctx.config.indexer.stellar;
  const empty = (detail: string): ClaimSettlementResult => ({
    settled: 0,
    attempted: 0,
    pending: 0,
    dryRun: true,
    detail,
    operations: [],
    targetKeys: [],
    estimatedFee: String(BASE_FEE),
    unsigned: true,
  });
  if (!chain) return empty("No Stellar deployment configured.");

  const { rows } = await ctx.db.query(
    "SELECT claim_id, recipient, amount FROM pending_claim WHERE chain = $1 AND NOT settled ORDER BY claim_id ASC LIMIT $2",
    [chain.chain, payload.limit ?? 20],
  );
  const claims = rows.map((row) => ({
    id: bigintOf(row, "claim_id"),
    recipient: text(row, "recipient"),
    amount: bigintOf(row, "amount"),
  }));
  const targetKeys = claims.map((claim) => `claim:${chain.chain}:${claim.id.toString()}`);
  const operations: readonly KeeperOperationPreview[] = claims.map((claim) => ({
    kind: "settle_claim",
    contract: chain.routerContractId,
    method: "settle_claim",
    targetKeys: [`claim:${chain.chain}:${claim.id.toString()}`],
    args: {
      claimId: claim.id.toString(),
      recipient: claim.recipient,
      amount: claim.amount.toString(),
    },
    estimatedFee: String(BASE_FEE),
    unsigned: true,
  }));

  if (ctx.config.keeper.stellarSecrets.length === 0) {
    await recordKeeperSubmission(ctx.db, {
      jobName: "claim-settlement",
      signerPublicKey: "dry-run",
      stage: "simulated",
    });
    return {
      settled: 0,
      attempted: 0,
      pending: claims.length,
      dryRun: true,
      detail: "Unsigned plan; no settlement was attempted.",
      operations,
      targetKeys,
      estimatedFee: String(BigInt(BASE_FEE) * BigInt(operations.length)),
      unsigned: true,
    };
  }

  let settled = 0;
  for (const claim of claims) {
    try {
      const hash = await submitStellar(
        ctx.config,
        ctx.db,
        chain.chain,
        chain.routerContractId,
        "settle_claim",
        "settle_claim",
        (sender) => [new Address(sender).toScVal(), nativeToScVal(claim.id, { type: "u64" })],
        { db: ctx.db, jobName: "claim-settlement" },
      );
      ctx.logger.info(
        { claimId: claim.id.toString(), hash },
        "claim settlement confirmed; watcher will update the claim record",
      );
      settled += 1;
    } catch (error) {
      ctx.logger.warn(
        { err: error, claimId: claim.id.toString() },
        "claim is not ready for settlement",
      );
    }
  }
  return {
    settled,
    attempted: claims.length,
    pending: claims.length - settled,
    dryRun: false,
    detail: `${settled} confirmed settlements of ${claims.length} attempts.`,
    operations,
    targetKeys,
    estimatedFee: String(BigInt(BASE_FEE) * BigInt(operations.length)),
    unsigned: false,
  };
}
