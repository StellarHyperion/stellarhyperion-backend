import { Address, nativeToScVal } from "@stellar/stellar-sdk";
import { bigintOf, bigintOrNull, textOrNull } from "../../db/rows.js";
import { claimRestoreScopeKey, isArchivedLookupError, UncertainRestoreError } from "../restore.js";
import { submitStellar } from "../stellar.js";
import type { ClaimSettlementPayload, ClaimSettlementResult, KeeperContext } from "../types.js";

function readOptionalRecipient(row: Record<string, unknown>): string | null {
  return textOrNull(row, "recipient");
}

function readOptionalAmount(row: Record<string, unknown>): string | null {
  const parsed = bigintOrNull(row, "amount");
  return parsed === null ? null : String(parsed);
}

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
    "SELECT claim_id, recipient, amount FROM pending_claim WHERE chain = $1 AND NOT settled ORDER BY claim_id ASC LIMIT $2",
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
  const restoredClaims: string[] = [];
  const archivedPendingClaims: string[] = [];

  for (const row of rows) {
    const id = bigintOf(row, "claim_id");
    const claimIdText = String(id);
    const recipientSnapshot = readOptionalRecipient(row);
    const amountSnapshot = readOptionalAmount(row);
    const restoreState = { confirmed: false };

    try {
      const hash = await submitStellar(
        ctx.config,
        chain.routerContractId,
        "settle_claim",
        (sender) => [new Address(sender).toScVal(), nativeToScVal(id, { type: "u64" })],
        {
          scopeKey: claimRestoreScopeKey(chain.chain, id),
          jobKind: "claim-settlement",
          claimId: id,
          recipientSnapshot,
          amountSnapshot,
          restoreStore: ctx.restoreStore,
          pollIntervalMs: ctx.pollIntervalMs,
          onRestoreConfirmed: (event) => {
            restoreState.confirmed = true;
            ctx.logger.info(
              {
                claimId: claimIdText,
                restoreTxHash: event.restoreTxHash,
                restoredKeys: event.footprintKeys.length,
                recoveredFromCheckpoint: event.recoveredFromCheckpoint,
              },
              "restored archived claim entry before settlement",
            );
          },
        },
      );
      if (restoreState.confirmed) {
        restoredClaims.push(claimIdText);
        if (ctx.restoreStore && recipientSnapshot !== null && amountSnapshot !== null) {
          const check = await ctx.db.query(
            "SELECT recipient, amount FROM pending_claim WHERE chain = $1 AND claim_id = $2",
            [chain.chain, claimIdText],
          );
          const current = check.rows[0];
          const currentRecipient = current ? readOptionalRecipient(current) : null;
          const currentAmount = current ? readOptionalAmount(current) : null;
          if (
            current &&
            (currentRecipient !== recipientSnapshot || currentAmount !== amountSnapshot)
          ) {
            throw new Error(
              `Claim ${claimIdText} recipient or amount changed unexpectedly during restoration.`,
            );
          }
        }
      }
      ctx.logger.info(
        { claimId: claimIdText, hash },
        "claim settlement confirmed; watcher will update the claim record",
      );
      settled += 1;
    } catch (error) {
      if (error instanceof UncertainRestoreError) {
        archivedPendingClaims.push(claimIdText);
        ctx.logger.warn(
          {
            claimId: claimIdText,
            restoreTxHash: error.restoreTxHash,
          },
          "archived claim restore outcome is uncertain; keeping claim pending until hash reconciliation",
        );
        continue;
      }
      if (isArchivedLookupError(error)) {
        archivedPendingClaims.push(claimIdText);
        ctx.logger.warn(
          { err: error, claimId: claimIdText },
          "claim requires archived entry restoration; keeping claim pending and never treating as absent",
        );
        continue;
      }
      ctx.logger.warn({ err: error, claimId: claimIdText }, "claim is not ready for settlement");
    }
  }
  return {
    settled,
    attempted: rows.length,
    pending: rows.length - settled,
    dryRun: false,
    detail: `${settled} confirmed settlements of ${rows.length} attempts.`,
    restoredClaims,
    archivedPendingClaims,
  };
}
