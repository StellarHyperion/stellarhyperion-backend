import { Address, nativeToScVal } from "@stellar/stellar-sdk";
import { bigintOf } from "../../db/rows.js";
import { submitStellar, submitRestore } from "../stellar.js";
import type {
  ClaimSettlementPayload,
  ClaimSettlementResult,
  KeeperContext,
  RestorePayload,
  RestoreResult,
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

/**
 * Restore archived Soroban claims and transfers. Restoration preserves the recorded
 * recipient and amount; only the archived flag is cleared.
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
