import { Address, BASE_FEE, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { bigintOf } from "../../db/rows.js";
import { KeeperSpendingCapExceededError, type SpendReservationTicket } from "../spending.js";
import { resolveKeeperSignerPublicKey, submitStellar } from "../stellar.js";
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
  const signerPublicKey = resolveKeeperSignerPublicKey(ctx.config);
  if (signerPublicKey === null)
    return {
      bumpedTokens: 0,
      bumpedClaims: 0,
      bumpedTransfers: 0,
      dryRun: true,
      detail: `No signer: ${tokens.length} tokens, ${claims.length} claims, ${transfers.length} transfers need maintenance.`,
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
      bumpedTokens: 0,
      bumpedClaims: 0,
      bumpedTransfers: 0,
      dryRun: false,
      pausedByCap: true,
      detail: `Maintenance paused by spending cap (${snap.totalCommittedStroops} / ${snap.effectiveCapStroops} stroops in ${snap.windowId}).`,
    };
  }

  let ticket: SpendReservationTicket | undefined;
  if (tracker) {
    try {
      ticket = tracker.reserveFee({
        signerPublicKey,
        feeStroops: ctx.estimatedAttemptFeeStroops ?? BigInt(BASE_FEE),
        operation: "keep_alive",
        ...windowOpts,
        logger: ctx.logger,
      });
    } catch (error) {
      if (error instanceof KeeperSpendingCapExceededError) {
        return {
          bumpedTokens: 0,
          bumpedClaims: 0,
          bumpedTransfers: 0,
          dryRun: false,
          pausedByCap: true,
          detail: error.message,
        };
      }
      throw error;
    }
  }

  const vector = (values: xdr.ScVal[]) => xdr.ScVal.scvVec(values);
  const buildArgs = (): xdr.ScVal[] => [
    vector(tokens.map((token) => new Address(token).toScVal())),
    vector([0, 1, 2, 3].map((route) => nativeToScVal(route, { type: "u32" }))),
    vector(claims.map((id) => nativeToScVal(id, { type: "u64" }))),
    vector(transfers.map((id) => nativeToScVal(id, { type: "u64" }))),
  ];

  try {
    const hash = await (tracker || ctx.rpcClient
      ? submitStellar(ctx.config, chain.routerContractId, "keep_alive", buildArgs, {
          ...(tracker ? { spendingTracker: tracker } : {}),
          ...(ticket ? { reservationTicket: ticket } : {}),
          ...(ctx.rpcClient ? { rpcClient: ctx.rpcClient } : {}),
          ...(ctx.pollIntervalMs !== undefined ? { pollIntervalMs: ctx.pollIntervalMs } : {}),
          ...windowOpts,
          logger: ctx.logger,
        })
      : submitStellar(ctx.config, chain.routerContractId, "keep_alive", buildArgs));

    if (tracker && ticket && !ticket.settled) {
      tracker.commitConfirmed(ticket, ticket.reservedFeeStroops, {
        ...(now !== undefined ? { now } : {}),
        logger: ctx.logger,
      });
    }

    ctx.logger.info({ hash }, "router keep_alive confirmed");
    return {
      bumpedTokens: tokens.length,
      bumpedClaims: claims.length,
      bumpedTransfers: transfers.length,
      dryRun: false,
      detail: `Confirmed router maintenance: ${hash}`,
    };
  } catch (error) {
    if (error instanceof KeeperSpendingCapExceededError) {
      return {
        bumpedTokens: 0,
        bumpedClaims: 0,
        bumpedTransfers: 0,
        dryRun: false,
        pausedByCap: true,
        detail: error.message,
      };
    }
    if (tracker && ticket && !ticket.settled) {
      tracker.commitFailed(ticket, ticket.reservedFeeStroops, {
        ...(now !== undefined ? { now } : {}),
        logger: ctx.logger,
      });
    }
    throw error;
  }
}
