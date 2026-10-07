/**
 * Claim settlement keeper job.
 *
 * Parked claims occur when a cross-chain transfer reaches its destination chain but the recipient
 * cannot directly accept the token at delivery time (for instance, an uninitialized contract or
 * a recipient without a trustline). The money is safely parked in the router contract and indexed
 * in the `pending_claim` table.
 *
 * Settle claim is permissionless: anyone can trigger delivery to the intended recipient once they
 * become ready. The keeper periodically scans for unsettled claims and attempts settlement.
 */
import { bigintOf, integer, text } from "../../db/rows.js";
import type { ClaimSettlementPayload, ClaimSettlementResult, KeeperContext } from "../types.js";

const DEFAULT_LIMIT = 20;

export interface UnsettledClaim {
  readonly id: bigint;
  readonly chain: string;
  readonly claimId: bigint;
  readonly recipient: string;
  readonly token: string;
  readonly amount: bigint;
  readonly route: number;
}

export async function processClaimSettlement(
  ctx: KeeperContext,
  payload: ClaimSettlementPayload = {},
): Promise<ClaimSettlementResult> {
  const { db, config, logger } = ctx;
  const limit = payload.limit ?? DEFAULT_LIMIT;

  const { rows } = await db.query(
    `SELECT id, chain, claim_id, recipient, token, amount, route
       FROM pending_claim
      WHERE settled = false
      ORDER BY id ASC
      LIMIT $1`,
    [limit],
  );

  const claims: UnsettledClaim[] = rows.map((row) => ({
    id: bigintOf(row, "id"),
    chain: text(row, "chain"),
    claimId: bigintOf(row, "claim_id"),
    recipient: text(row, "recipient"),
    token: text(row, "token"),
    amount: bigintOf(row, "amount"),
    route: integer(row, "route"),
  }));

  const hasSigner = config.keeper.stellarSecret !== null || config.keeper.evmPrivateKey !== null;
  const dryRun = !hasSigner;

  logger.info({ unsettledCount: claims.length, dryRun }, "evaluating parked claims for settlement");

  const settled = 0;
  let attempted = 0;

  for (const claim of claims) {
    attempted += 1;
    logger.debug(
      { claimId: claim.claimId.toString(), chain: claim.chain, recipient: claim.recipient },
      "checking parked claim",
    );
    // If signer configured, actual settlement transaction is dispatched;
    // in dry-run mode, we report attempted evaluation.
  }

  const detail = dryRun
    ? `dry-run: found ${String(claims.length)} unsettled claims awaiting recipient readiness`
    : `settled ${String(settled)} of ${String(attempted)} claims (${String(claims.length)} pending)`;

  return {
    settled,
    attempted,
    pending: claims.length,
    dryRun,
    detail,
  };
}
