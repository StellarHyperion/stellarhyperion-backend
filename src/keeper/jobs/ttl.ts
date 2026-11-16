import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { bigintOf } from "../../db/rows.js";
import { SignerLeaseBusyError } from "../leases.js";
import { submitStellar } from "../stellar.js";
import type { KeeperContext, TtlBumpPayload, TtlBumpResult } from "../types.js";

export async function processTtlBump(
  ctx: KeeperContext,
  payload: TtlBumpPayload = {},
): Promise<TtlBumpResult> {
  const chain = ctx.config.indexer.stellar;
  if (!chain)
    return {
      bumpedTokens: 0,
      bumpedClaims: 0,
      bumpedTransfers: 0,
      dryRun: true,
      detail: "No Stellar deployment configured.",
    };
  const deployment = ctx.config.deployments.networks[chain.chain];
  const tokens = deployment
    ? Object.values(deployment.tokens)
        .filter((token) => "sacId" in token)
        .map((token) => (token as { sacId: string }).sacId)
    : [];
  const claimRows = await ctx.db.query(
    "SELECT claim_id FROM pending_claim WHERE chain = $1 AND NOT settled ORDER BY claim_id DESC LIMIT $2",
    [chain.chain, payload.maxClaims ?? 50],
  );
  const transferRows = await ctx.db.query(
    "SELECT nonce FROM outbound_transfer WHERE origin_chain = $1 ORDER BY id DESC LIMIT $2",
    [chain.chain, payload.maxTransfers ?? 50],
  );
  const claims = claimRows.rows.map((row) => bigintOf(row, "claim_id"));
  const transfers = transferRows.rows.map((row) => bigintOf(row, "nonce"));
  const dryRun = ctx.config.keeper.stellarSecret === null;
  if (dryRun)
    return {
      bumpedTokens: 0,
      bumpedClaims: 0,
      bumpedTransfers: 0,
      dryRun: true,
      detail: `No signer: ${tokens.length} tokens, ${claims.length} claims, ${transfers.length} transfers need maintenance.`,
    };
  const vector = (values: xdr.ScVal[]) => xdr.ScVal.scvVec(values);
  try {
    const hash = await submitStellar(
      ctx.config,
      chain.routerContractId,
      "keep_alive",
      () => [
        vector(tokens.map((token) => new Address(token).toScVal())),
        vector([0, 1, 2, 3].map((route) => nativeToScVal(route, { type: "u32" }))),
        vector(claims.map((id) => nativeToScVal(id, { type: "u64" }))),
        vector(transfers.map((id) => nativeToScVal(id, { type: "u64" }))),
      ],
      {
        leaseStore: ctx.leaseStore,
        holderId: ctx.holderId,
        leaseTtlMs: ctx.leaseTtlMs,
        clock: ctx.clock,
        logger: ctx.logger,
        pollIntervalMs: ctx.pollIntervalMs,
        maxPollAttempts: ctx.maxPollAttempts,
      },
    );
    ctx.logger.info({ hash }, "router keep_alive confirmed");
    return {
      bumpedTokens: tokens.length,
      bumpedClaims: claims.length,
      bumpedTransfers: transfers.length,
      dryRun: false,
      detail: `Confirmed router maintenance: ${hash}`,
    };
  } catch (error) {
    if (error instanceof SignerLeaseBusyError) {
      ctx.logger.info(
        {
          signerPublicKey: error.signerPublicKey,
          activeHolderId: error.activeHolderId,
          expiresAt: error.expiresAt.toISOString(),
        },
        "skipping TTL maintenance on standby replica while active peer holds signer lease",
      );
      return {
        bumpedTokens: 0,
        bumpedClaims: 0,
        bumpedTransfers: 0,
        dryRun: false,
        leaseSkipped: true,
        detail: `Standby replica skipped TTL maintenance; signer lease held by ${error.activeHolderId}.`,
      };
    }
    throw error;
  }
}
