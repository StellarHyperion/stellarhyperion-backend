import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { bigintOf } from "../../db/rows.js";
import { submitStellar, submitRestore } from "../stellar.js";
import type {
  KeeperContext,
  RestorePayload,
  RestoreResult,
  TtlBumpPayload,
  TtlBumpResult,
} from "../types.js";
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
  const hash = await submitStellar(ctx.config, chain.routerContractId, "keep_alive", () => [
    vector(tokens.map((token) => new Address(token).toScVal())),
    vector([0, 1, 2, 3].map((route) => nativeToScVal(route, { type: "u32" }))),
    vector(claims.map((id) => nativeToScVal(id, { type: "u64" }))),
    vector(transfers.map((id) => nativeToScVal(id, { type: "u64" }))),
  ]);
  ctx.logger.info({ hash }, "router keep_alive confirmed");
  return {
    bumpedTokens: tokens.length,
    bumpedClaims: claims.length,
    bumpedTransfers: transfers.length,
    dryRun: false,
    detail: `Confirmed router maintenance: ${hash}`,
  };
}

/**
 * Detect archived Soroban entries that were previously treated as absent and
 * queue them for restoration without changing the recorded recipient or amount.
 */
export async function processRestore(
  ctx: KeeperContext,
  payload: RestorePayload = {},
): Promise<RestoreResult> {
  const chain = ctx.config.indexer.stellar;
  if (!chain)
    return {
      restoredClaims: 0,
      restoredTransfers: 0,
      dryRun: true,
      detail: "No Stellar deployment configured.",
    };
  const archivedClaims = await ctx.db.query(
    "SELECT claim_id FROM pending_claim WHERE chain = $1 AND archived ORDER BY claim_id DESC LIMIT $2",
    [chain.chain, payload.maxClaims ?? 50],
  );
  const archivedTransfers = await ctx.db.query(
    "SELECT nonce FROM outbound_transfer WHERE origin_chain = $1 AND archived ORDER BY id DESC LIMIT $2",
    [chain.chain, payload.maxTransfers ?? 50],
  );
  const claimIds = archivedClaims.rows.map((row) => bigintOf(row, "claim_id"));
  const transferNonces = archivedTransfers.rows.map((row) => bigintOf(row, "nonce"));
  const dryRun = ctx.config.keeper.stellarSecret === null;
  if (dryRun)
    return {
      restoredClaims: claimIds.length,
      restoredTransfers: transferNonces.length,
      dryRun: true,
      detail: `No signer: ${claimIds.length} archived claims and ${transferNonces.length} archived transfers need restoration.`,
    };
  if (claimIds.length === 0 && transferNonces.length === 0)
    return {
      restoredClaims: 0,
      restoredTransfers: 0,
      dryRun: false,
      detail: "No archived entries to restore.",
    };
  const hash = await submitRestore(ctx.config, chain.routerContractId, claimIds, transferNonces);
  ctx.logger.info({ hash }, "archived entries restored");
  return {
    restoredClaims: claimIds.length,
    restoredTransfers: transferNonces.length,
    dryRun: false,
    detail: `Confirmed restore: ${hash}`,
  };
}
