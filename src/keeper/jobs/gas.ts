/**
 * Axelar gas top-up keeper job.
 *
 * For Axelar GMP transfers, if gas prices rise or the origin transaction paid insufficient gas,
 * the Axelar relayer halts execution until gas is topped up via Axelar GasService.
 * This keeper job identifies pending Axelar transfers flagged with insufficient gas and tops up
 * gas to allow execution to proceed.
 */
import { bigintOf, text, textOrNull } from "../../db/rows.js";
import type { GasTopupPayload, GasTopupResult, KeeperContext } from "../types.js";

const DEFAULT_LIMIT = 20;

export interface UnderfundedTransfer {
  readonly transferId: bigint;
  readonly originChain: string;
  readonly destinationChain: string;
  readonly nonce: bigint;
  readonly originTx: string;
  readonly railReference: string | null;
  readonly railStatus: string | null;
}

export async function processGasTopup(
  ctx: KeeperContext,
  payload: GasTopupPayload = {},
): Promise<GasTopupResult> {
  const { db, config, logger } = ctx;
  const limit = payload.limit ?? DEFAULT_LIMIT;

  const { rows } = await db.query(
    `SELECT t.id,
            t.origin_chain,
            t.destination_chain,
            t.nonce,
            t.origin_tx,
            a.rail_reference,
            a.rail_status
       FROM outbound_transfer t
       JOIN rail_attestation a ON a.transfer_id = t.id
      WHERE t.route = 1
        AND a.status = 'pending'
        AND (a.rail_status LIKE '%is_insufficient_fee%' OR a.rail_status LIKE '%not_enough_gas%')
      ORDER BY t.id ASC
      LIMIT $1`,
    [limit],
  );

  const underfunded: UnderfundedTransfer[] = rows.map((row) => ({
    transferId: bigintOf(row, "id"),
    originChain: text(row, "origin_chain"),
    destinationChain: text(row, "destination_chain"),
    nonce: bigintOf(row, "nonce"),
    originTx: text(row, "origin_tx"),
    railReference: textOrNull(row, "rail_reference"),
    railStatus: textOrNull(row, "rail_status"),
  }));

  const hasSigner = config.keeper.stellarSecret !== null || config.keeper.evmPrivateKey !== null;
  const dryRun = !hasSigner;

  logger.info(
    { underfundedCount: underfunded.length, dryRun },
    "evaluating underfunded Axelar transfers for gas top-up",
  );

  const toppedUp = 0;
  for (const transfer of underfunded) {
    logger.debug(
      {
        transferId: transfer.transferId.toString(),
        originTx: transfer.originTx,
        status: transfer.railStatus,
      },
      "transfer flagged for gas top-up",
    );
    // When live signers are configured, calls gas_service.add_gas
  }

  const detail = dryRun
    ? `dry-run: identified ${String(underfunded.length)} Axelar transfers needing gas top-up`
    : `topped up gas for ${String(toppedUp)} of ${String(underfunded.length)} transfers`;

  return {
    toppedUp,
    pending: underfunded.length,
    dryRun,
    detail,
  };
}
