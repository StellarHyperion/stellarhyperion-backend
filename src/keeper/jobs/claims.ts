import { Address, BASE_FEE, nativeToScVal } from "@stellar/stellar-sdk";
import { bigintOf, text } from "../../db/rows.js";
import { sanitizeDiagnosticText } from "../../logging/logger.js";
import { submitStellar } from "../stellar.js";
import { recordKeeperSubmission } from "../outcomes.js";
import { KeeperMaintenancePausedError, KeeperSpendingCapReachedError } from "../spending.js";
import type {
  ClaimSettlementItemResult,
  ClaimSettlementPayload,
  ClaimSettlementResult,
  KeeperContext,
  KeeperOperationPreview,
} from "../types.js";

const MAX_CLAIM_SETTLEMENT_BATCH_SIZE = 20;
const MAX_U64 = (1n << 64n) - 1n;

export async function processClaimSettlement(
  ctx: KeeperContext,
  payload: ClaimSettlementPayload = {},
): Promise<ClaimSettlementResult> {
  const limit = payload.limit ?? MAX_CLAIM_SETTLEMENT_BATCH_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CLAIM_SETTLEMENT_BATCH_SIZE)
    throw new RangeError(
      `Claim settlement batch size must be between 1 and ${MAX_CLAIM_SETTLEMENT_BATCH_SIZE}.`,
    );
  if (payload.claimIds !== undefined && !Array.isArray(payload.claimIds))
    throw new TypeError("Claim settlement IDs must be an array.");
  const requestedIds = payload.claimIds?.map(claimIdOf);
  if (requestedIds !== undefined) {
    if (requestedIds.length === 0 || requestedIds.length > MAX_CLAIM_SETTLEMENT_BATCH_SIZE)
      throw new RangeError(
        `Claim settlement batch must contain 1 to ${MAX_CLAIM_SETTLEMENT_BATCH_SIZE} IDs.`,
      );
    if (requestedIds.length > limit)
      throw new RangeError("Claim settlement ID count exceeds the requested batch size.");
    if (new Set(requestedIds.map(String)).size !== requestedIds.length)
      throw new Error("Claim settlement batch contains duplicate IDs.");
  }
  const chain = ctx.config.indexer.stellar;
  if (!chain)
    return {
      settled: 0,
      attempted: 0,
      pending: 0,
      missing: 0,
      claims: [],
      operations: [],
      targetKeys: [],
      estimatedFee: "0",
      unsigned: true,
      dryRun: true,
      detail: "No Stellar deployment configured.",
    };
  const { rows } =
    requestedIds === undefined
      ? await ctx.db.query(
          "SELECT claim_id, recipient, amount, settled FROM pending_claim WHERE chain = $1 AND NOT settled ORDER BY claim_id ASC LIMIT $2",
          [chain.chain, limit],
        )
      : await ctx.db.query(
          "SELECT claim_id, recipient, amount, settled FROM pending_claim WHERE chain = $1 AND claim_id::numeric = ANY($2::numeric[]) ORDER BY claim_id ASC",
          [chain.chain, requestedIds.map(String)],
        );
  const claims = new Map(rows.map((row) => [bigintOf(row, "claim_id").toString(), row]));
  const orderedIds =
    requestedIds?.map(String) ?? rows.map((row) => bigintOf(row, "claim_id").toString());
  const outcomes: ClaimSettlementItemResult[] = orderedIds.map((claimId) => {
    const row = claims.get(claimId);
    if (!row) return { claimId, outcome: "missing" };
    if (row.settled === true || row.settled === "true")
      return { claimId, outcome: "already_settled" };
    return { claimId, outcome: "pending" };
  });
  const operations: readonly KeeperOperationPreview[] = outcomes
    .filter((claim) => claim.outcome === "pending")
    .map((claim) => {
      const row = claims.get(claim.claimId);
      if (row === undefined) throw new Error("Pending claim preview has no indexed row.");
      const targetKeys = [`claim:${chain.chain}:${claim.claimId}`];
      return {
        kind: "settle_claim",
        contract: chain.routerContractId,
        method: "settle_claim",
        targetKeys,
        args: {
          claimId: claim.claimId,
          recipient: text(row, "recipient"),
          amount: bigintOf(row, "amount").toString(),
        },
        estimatedFee: BASE_FEE,
        unsigned: true,
      };
    });
  const targetKeys = operations.flatMap((operation) => operation.targetKeys);
  const preview = {
    operations,
    targetKeys,
    estimatedFee: String(BigInt(BASE_FEE) * BigInt(operations.length)),
  };
  if (ctx.config.keeper.stellarSecrets.length === 0) {
    await recordKeeperSubmission(ctx.db, {
      jobName: "claim-settlement",
      signerPublicKey: "dry-run",
      stage: "simulated",
    });
    return {
      settled: 0,
      attempted: 0,
      pending: outcomes.filter((claim) => claim.outcome === "pending").length,
      missing: outcomes.filter((claim) => claim.outcome === "missing").length,
      claims: outcomes,
      ...preview,
      unsigned: true,
      dryRun: true,
      detail: "No signer configured; no settlement was attempted.",
    };
  }
  let attempted = 0;
  let paused = false;
  for (let index = 0; index < outcomes.length; index += 1) {
    const claim = outcomes[index];
    if (claim?.outcome !== "pending") continue;
    const id = BigInt(claim.claimId);
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
        { claimId: claim.claimId, hash },
        "claim settlement confirmed; watcher will update the claim record",
      );
      outcomes[index] = { claimId: claim.claimId, outcome: "confirmed", transactionHash: hash };
    } catch (error) {
      if (
        error instanceof KeeperMaintenancePausedError ||
        error instanceof KeeperSpendingCapReachedError
      ) {
        paused = true;
        ctx.logger.warn(
          { claimId: claim.claimId },
          "claim settlement deferred by keeper spending policy",
        );
        break;
      }
      const reason = sanitizeDiagnosticText(error instanceof Error ? error.message : String(error));
      ctx.logger.warn({ reason, claimId: claim.claimId }, "claim settlement remains unverified");
    }
    attempted += 1;
  }
  const settled = outcomes.filter(
    (claim) => claim.outcome === "confirmed" || claim.outcome === "already_settled",
  ).length;
  const pending = outcomes.filter((claim) => claim.outcome === "pending").length;
  const missing = outcomes.filter((claim) => claim.outcome === "missing").length;
  return {
    settled,
    attempted,
    pending,
    missing,
    claims: outcomes,
    ...preview,
    unsigned: attempted === 0,
    dryRun: paused && attempted === 0,
    detail: `${settled} settled, ${missing} missing, and ${pending} pending across ${attempted} attempted claims.`,
  };
}

function claimIdOf(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value))
    throw new TypeError("Claim IDs must be unsigned decimal strings.");
  const id = BigInt(value);
  if (id > MAX_U64) throw new RangeError("Claim ID exceeds the Stellar u64 range.");
  return id;
}
