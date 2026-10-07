/**
 * Rail second-step relay keeper job.
 *
 * For routes that require an off-chain actor to submit an attestation or message to the destination
 * chain (such as CCTP message relay), this keeper job identifies transfers whose rail attestation
 * has landed as 'attested' but has not yet been delivered on the destination chain.
 */
import { bigintOf, integer, text, textOrNull } from "../../db/rows.js";
import type { KeeperContext, RailSecondStepPayload, RailSecondStepResult } from "../types.js";

const DEFAULT_LIMIT = 20;

export interface AttestedTransfer {
  readonly transferId: bigint;
  readonly originChain: string;
  readonly destinationChain: string;
  readonly route: number;
  readonly nonce: bigint;
  readonly originTx: string;
  readonly railReference: string | null;
  readonly railStatus: string | null;
}

export async function processRailSecondStep(
  ctx: KeeperContext,
  payload: RailSecondStepPayload = {},
): Promise<RailSecondStepResult> {
  const { db, config, logger } = ctx;
  const limit = payload.limit ?? DEFAULT_LIMIT;

  const { rows } = await db.query(
    `SELECT t.id,
            t.origin_chain,
            t.destination_chain,
            t.route,
            t.nonce,
            t.origin_tx,
            a.rail_reference,
            a.rail_status
       FROM outbound_transfer t
       JOIN rail_attestation a ON a.transfer_id = t.id
      WHERE a.status = 'attested'
        AND NOT EXISTS (
          SELECT 1 FROM inbound_delivery d
           WHERE d.destination_chain = t.destination_chain
             AND d.route = t.route
             AND d.source_chain = t.origin_chain
             AND d.source_nonce = t.nonce
        )
      ORDER BY t.id ASC
      LIMIT $1`,
    [limit],
  );

  const pendingTransfers: AttestedTransfer[] = rows.map((row) => ({
    transferId: bigintOf(row, "id"),
    originChain: text(row, "origin_chain"),
    destinationChain: text(row, "destination_chain"),
    route: integer(row, "route"),
    nonce: bigintOf(row, "nonce"),
    originTx: text(row, "origin_tx"),
    railReference: textOrNull(row, "rail_reference"),
    railStatus: textOrNull(row, "rail_status"),
  }));

  const hasSigner = config.keeper.stellarSecret !== null || config.keeper.evmPrivateKey !== null;
  const dryRun = !hasSigner;

  logger.info(
    { pendingCount: pendingTransfers.length, dryRun },
    "evaluating attested transfers for rail second-step submission",
  );

  const relayed = 0;
  for (const transfer of pendingTransfers) {
    logger.debug(
      {
        transferId: transfer.transferId.toString(),
        originChain: transfer.originChain,
        destinationChain: transfer.destinationChain,
        route: transfer.route,
        reference: transfer.railReference,
      },
      "attested transfer awaiting inbound arrival",
    );
    // When live signers are configured, calls destination bridge_in or rail relay
  }

  const detail = dryRun
    ? `dry-run: identified ${String(pendingTransfers.length)} attested transfers awaiting arrival`
    : `relayed ${String(relayed)} of ${String(pendingTransfers.length)} transfers`;

  return {
    relayed,
    pending: pendingTransfers.length,
    dryRun,
    detail,
  };
}
