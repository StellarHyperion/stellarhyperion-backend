import { Address, BASE_FEE, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { bigintOf } from "../../db/rows.js";
import { submitStellar } from "../stellar.js";
import type {
  KeeperContext,
  KeeperOperationPreview,
  TtlBumpPayload,
  TtlBumpResult,
} from "../types.js";
import { recordKeeperSubmission } from "../outcomes.js";
export async function processTtlBump(
  ctx: KeeperContext,
  payload: TtlBumpPayload = {},
): Promise<TtlBumpResult> {
  const chain = ctx.config.indexer.stellar;
  const empty = (detail: string): TtlBumpResult => ({
    bumpedTokens: 0,
    bumpedClaims: 0,
    bumpedTransfers: 0,
    dryRun: true,
    detail,
    operations: [],
    targetKeys: [],
    estimatedFee: BASE_FEE,
    unsigned: true,
  });
  if (!chain) return empty("No Stellar deployment configured.");

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
  const targetKeys = [
    `contract:${chain.routerContractId}`,
    ...tokens.map((token) => `token:${token}`),
    ...claims.map((claim) => `claim:${chain.chain}:${claim.toString()}`),
    ...transfers.map((transfer) => `transfer:${chain.chain}:${transfer.toString()}`),
  ];
  const operation: KeeperOperationPreview = {
    kind: "keep_alive",
    contract: chain.routerContractId,
    method: "keep_alive",
    targetKeys,
    args: {
      tokens,
      routes: [0, 1, 2, 3],
      claimIds: claims.map((claim) => claim.toString()),
      transferIds: transfers.map((transfer) => transfer.toString()),
    },
    estimatedFee: BASE_FEE,
    unsigned: true,
  };

  const dryRun = ctx.config.keeper.stellarSecrets.length === 0;
  if (dryRun) {
    await recordKeeperSubmission(ctx.db, {
      jobName: "ttl-bump",
      signerPublicKey: "dry-run",
      stage: "simulated",
    });
    return {
      bumpedTokens: 0,
      bumpedClaims: 0,
      bumpedTransfers: 0,
      dryRun: true,
      detail: `Unsigned plan: ${tokens.length} tokens, ${claims.length} claims, ${transfers.length} transfers need maintenance.`,
      operations: [operation],
      targetKeys,
      estimatedFee: BASE_FEE,
      unsigned: true,
    };
  }

  const vector = (values: xdr.ScVal[]) => xdr.ScVal.scvVec(values);
  const hash = await submitStellar(
    ctx.config,
    ctx.db,
    chain.chain,
    chain.routerContractId,
    "keep_alive",
    "keep_alive",
    () => [
      vector(tokens.map((token) => new Address(token).toScVal())),
      vector([0, 1, 2, 3].map((route) => nativeToScVal(route, { type: "u32" }))),
      vector(claims.map((id) => nativeToScVal(id, { type: "u64" }))),
      vector(transfers.map((id) => nativeToScVal(id, { type: "u64" }))),
    ],
    {
      db: ctx.db,
      jobName: "ttl-bump",
      ...(ctx.signerLeaseOwnerId === undefined
        ? {}
        : { signerLeaseOwnerId: ctx.signerLeaseOwnerId }),
    },
  );
  ctx.logger.info({ hash }, "router keep_alive confirmed");
  return {
    bumpedTokens: tokens.length,
    bumpedClaims: claims.length,
    bumpedTransfers: transfers.length,
    dryRun: false,
    detail: `Confirmed router maintenance: ${hash}`,
    operations: [operation],
    targetKeys,
    estimatedFee: BASE_FEE,
    unsigned: false,
  };
}
