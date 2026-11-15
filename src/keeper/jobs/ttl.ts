import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { bigintOf } from "../../db/rows.js";
import { hasConfiguredKeeperSigner, submitStellar } from "../stellar.js";
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
      signerPublicKey: null,
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

  if (!hasConfiguredKeeperSigner(ctx.config))
    return {
      bumpedTokens: 0,
      bumpedClaims: 0,
      bumpedTransfers: 0,
      dryRun: true,
      detail: `No signer: ${tokens.length} tokens, ${claims.length} claims, ${transfers.length} transfers need maintenance.`,
      signerPublicKey: null,
    };

  const vector = (values: xdr.ScVal[]) => xdr.ScVal.scvVec(values);
  let signerPublicKey: string | null = null;
  const buildArgs = (sender: string): xdr.ScVal[] => {
    signerPublicKey = sender;
    return [
      vector(tokens.map((token) => new Address(token).toScVal())),
      vector([0, 1, 2, 3].map((route) => nativeToScVal(route, { type: "u32" }))),
      vector(claims.map((id) => nativeToScVal(id, { type: "u64" }))),
      vector(transfers.map((id) => nativeToScVal(id, { type: "u64" }))),
    ];
  };

  const hash = await (ctx.signerManager
    ? submitStellar(ctx.config, chain.routerContractId, "keep_alive", buildArgs, {
        signerManager: ctx.signerManager,
      })
    : submitStellar(ctx.config, chain.routerContractId, "keep_alive", buildArgs));

  ctx.logger.info({ hash, signerPublicKey }, "router keep_alive confirmed");
  return {
    bumpedTokens: tokens.length,
    bumpedClaims: claims.length,
    bumpedTransfers: transfers.length,
    dryRun: false,
    detail: `Confirmed router maintenance: ${hash}`,
    signerPublicKey,
  };
}
