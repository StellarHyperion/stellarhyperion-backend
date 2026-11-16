import { Address, BASE_FEE, nativeToScVal } from "@stellar/stellar-sdk";
import { bigintOf } from "../../db/rows.js";
import {
  KeeperSpendingCapExceededError,
  sanitizeSpendDiagnostic,
  type SpendReservationTicket,
} from "../spending.js";
import { resolveKeeperSignerPublicKey, submitStellar } from "../stellar.js";
import type { ClaimSettlementPayload, ClaimSettlementResult, KeeperContext } from "../types.js";

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
  const signerPublicKey = resolveKeeperSignerPublicKey(ctx.config);
  if (signerPublicKey === null)
    return {
      settled: 0,
      attempted: 0,
      pending: rows.length,
      dryRun: true,
      detail: "No signer configured; no settlement was attempted.",
    };

  const tracker = ctx.spendingTracker;
  const now = ctx.now ? ctx.now() : undefined;
  const windowOpts = {
    ...(now !== undefined ? { now } : {}),
    ...(payload.ledger !== undefined ? { ledger: payload.ledger } : {}),
  };

  if (tracker?.isPaused(signerPublicKey, windowOpts)) {
    const snap = tracker.snapshot(signerPublicKey, windowOpts);
    return {
      settled: 0,
      attempted: 0,
      pending: rows.length,
      dryRun: false,
      pausedByCap: true,
      detail: `Claim settlement paused by spending cap (${snap.totalCommittedStroops} / ${snap.effectiveCapStroops} stroops in ${snap.windowId}); pending claim records untouched.`,
    };
  }

  let settled = 0;
  let attempted = 0;
  let pausedByCap = false;
  let pauseDetail: string | null = null;

  for (const row of rows) {
    const id = bigintOf(row, "claim_id");
    let ticket: SpendReservationTicket | undefined;

    if (tracker) {
      try {
        ticket = tracker.reserveFee({
          signerPublicKey,
          feeStroops: ctx.estimatedAttemptFeeStroops ?? BigInt(BASE_FEE),
          operation: "settle_claim",
          ...windowOpts,
          logger: ctx.logger,
        });
      } catch (error) {
        if (error instanceof KeeperSpendingCapExceededError) {
          pausedByCap = true;
          pauseDetail = error.message;
          break;
        }
        throw error;
      }
    }

    attempted += 1;
    try {
      const buildArgs = (sender: string) => [
        new Address(sender).toScVal(),
        nativeToScVal(id, { type: "u64" }),
      ];
      const hash = await (tracker || ctx.rpcClient
        ? submitStellar(ctx.config, chain.routerContractId, "settle_claim", buildArgs, {
            ...(tracker ? { spendingTracker: tracker } : {}),
            ...(ticket ? { reservationTicket: ticket } : {}),
            ...(ctx.rpcClient ? { rpcClient: ctx.rpcClient } : {}),
            ...(ctx.pollIntervalMs !== undefined ? { pollIntervalMs: ctx.pollIntervalMs } : {}),
            ...windowOpts,
            logger: ctx.logger,
          })
        : submitStellar(ctx.config, chain.routerContractId, "settle_claim", buildArgs));

      if (tracker && ticket && !ticket.settled) {
        tracker.commitConfirmed(ticket, ticket.reservedFeeStroops, {
          ...(now !== undefined ? { now } : {}),
          logger: ctx.logger,
        });
      }

      ctx.logger.info(
        { claimId: String(id), hash },
        "claim settlement confirmed; watcher will update the claim record",
      );
      settled += 1;
    } catch (error) {
      if (error instanceof KeeperSpendingCapExceededError) {
        pausedByCap = true;
        pauseDetail = error.message;
        // Prepared fee exceeded cap before signing; claim attempt was halted cleanly.
        attempted -= 1;
        break;
      }
      if (tracker && ticket && !ticket.settled) {
        tracker.commitFailed(ticket, ticket.reservedFeeStroops, {
          ...(now !== undefined ? { now } : {}),
          logger: ctx.logger,
        });
      }
      const reason = error instanceof Error ? error.message : String(error);
      ctx.logger.warn(
        { claimId: String(id), reason: sanitizeSpendDiagnostic(reason) },
        "claim is not ready for settlement",
      );
      if (tracker?.isPaused(signerPublicKey, windowOpts)) {
        pausedByCap = true;
        pauseDetail = tracker.snapshot(signerPublicKey, windowOpts).pauseReason;
        break;
      }
    }
  }

  return {
    settled,
    attempted,
    pending: rows.length - settled,
    dryRun: false,
    ...(pausedByCap ? { pausedByCap: true } : {}),
    detail: pausedByCap
      ? `${String(settled)} confirmed settlements before spending cap pause (${pauseDetail ?? "cap reached"}).`
      : `${String(settled)} confirmed settlements of ${String(attempted)} attempts.`,
  };
}
