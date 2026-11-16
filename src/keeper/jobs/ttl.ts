import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { bigintOf } from "../../db/rows.js";
import { assembleDryRunPlan, previewStellarOperation, submitStellar } from "../stellar.js";
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
      plan: assembleDryRunPlan([]),
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

  const vector = (values: xdr.ScVal[]) => xdr.ScVal.scvVec(values);
  const buildArgs = (): xdr.ScVal[] => [
    vector(tokens.map((token) => new Address(token).toScVal())),
    vector([0, 1, 2, 3].map((route) => nativeToScVal(route, { type: "u32" }))),
    vector(claims.map((id) => nativeToScVal(id, { type: "u64" }))),
    vector(transfers.map((id) => nativeToScVal(id, { type: "u64" }))),
  ];

  const dryRun = payload.dryRun === true || ctx.config.keeper.stellarSecret === null;
  if (dryRun) {
    const targetKeys = [
      `router:${chain.routerContractId}`,
      ...tokens.map((sacId) => `token:${sacId}`),
      "route:0",
      "route:1",
      "route:2",
      "route:3",
      ...claims.map((id) => `claim:${String(id)}`),
      ...transfers.map((id) => `transfer:${String(id)}`),
    ];

    const opPreview = await previewStellarOperation({
      chain: chain.chain,
      networkPassphrase: chain.networkPassphrase,
      rpcUrl: chain.rpcUrl,
      contract: chain.routerContractId,
      method: "keep_alive",
      args: buildArgs,
      targetKeys,
      argsSummary: {
        tokens: [...tokens],
        routes: [0, 1, 2, 3],
        claimIds: claims.map((id) => String(id)),
        transferNonces: transfers.map((id) => String(id)),
      },
      ...(ctx.simulationClient !== undefined ? { simulationClient: ctx.simulationClient } : {}),
      ...(payload.simulateViaRpc !== undefined ? { simulateViaRpc: payload.simulateViaRpc } : {}),
    });
    const plan = assembleDryRunPlan([opPreview]);

    const reasonPrefix = payload.dryRun === true ? "Dry-run plan (unsigned)" : "No signer";
    return {
      bumpedTokens: 0,
      bumpedClaims: 0,
      bumpedTransfers: 0,
      dryRun: true,
      detail: `${reasonPrefix}: ${String(tokens.length)} tokens, ${String(claims.length)} claims, ${String(transfers.length)} transfers need maintenance (estimated fee ${plan.totalEstimatedFeeStroops} stroops).`,
      plan,
    };
  }

  const hash = await submitStellar(ctx.config, chain.routerContractId, "keep_alive", buildArgs);
  ctx.logger.info({ hash }, "router keep_alive confirmed");
  return {
    bumpedTokens: tokens.length,
    bumpedClaims: claims.length,
    bumpedTransfers: transfers.length,
    dryRun: false,
    detail: `Confirmed router maintenance: ${hash}`,
  };
}
