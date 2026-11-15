import type { xdr } from "@stellar/stellar-sdk";
import { Address, nativeToScVal } from "@stellar/stellar-sdk";
import { bigintOf } from "../../db/rows.js";
import { hasConfiguredKeeperSigner, sanitizeKeeperDiagnostic, submitStellar } from "../stellar.js";
import type {
  ClaimSettlementPayload,
  ClaimSettlementResult,
  KeeperContext,
  SettledClaimSummary,
} from "../types.js";

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
      settledClaims: [],
    };

  const { rows } = await ctx.db.query(
    "SELECT claim_id, recipient FROM pending_claim WHERE chain = $1 AND NOT settled ORDER BY claim_id ASC LIMIT $2",
    [chain.chain, payload.limit ?? 20],
  );

  if (!hasConfiguredKeeperSigner(ctx.config))
    return {
      settled: 0,
      attempted: 0,
      pending: rows.length,
      dryRun: true,
      detail: "No signer configured; no settlement was attempted.",
      settledClaims: [],
    };

  let settled = 0;
  const settledClaims: SettledClaimSummary[] = [];

  for (const row of rows) {
    const id = bigintOf(row, "claim_id");
    const recordedRecipient = typeof row.recipient === "string" ? row.recipient : null;
    try {
      let settledBy: string | null = null;
      // Router settle_claim takes only the permissionless fee-payer caller and claim_id.
      // Payout always goes to the on-chain Claim.recipient recorded when the claim parked,
      // so rotating the keeper fee-payer signer never alters claim payout recipients.
      const buildArgs = (sender: string): xdr.ScVal[] => {
        settledBy = sender;
        return [new Address(sender).toScVal(), nativeToScVal(id, { type: "u64" })];
      };
      const hash = await (ctx.signerManager
        ? submitStellar(ctx.config, chain.routerContractId, "settle_claim", buildArgs, {
            signerManager: ctx.signerManager,
          })
        : submitStellar(ctx.config, chain.routerContractId, "settle_claim", buildArgs));

      settledClaims.push({
        claimId: String(id),
        recipient: recordedRecipient,
        settledBy,
        txHash: hash,
      });
      ctx.logger.info(
        {
          claimId: String(id),
          recipient: recordedRecipient,
          settledBy,
          hash,
        },
        "claim settlement confirmed; watcher will update the claim record",
      );
      settled += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ctx.logger.warn(
        {
          claimId: String(id),
          recipient: recordedRecipient,
          reason: sanitizeKeeperDiagnostic(reason),
        },
        "claim is not ready for settlement",
      );
    }
  }

  return {
    settled,
    attempted: rows.length,
    pending: rows.length - settled,
    dryRun: false,
    detail: `${settled} confirmed settlements of ${rows.length} attempts.`,
    settledClaims,
  };
}
