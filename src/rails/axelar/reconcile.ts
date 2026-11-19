import type { Transactional } from "../../db/pool.js";
import { bigintOf, boolean, text, textOrNull, timestampOrNull } from "../../db/rows.js";

export interface ItsReconciliationRow {
  readonly transferId: string;
  readonly source: {
    readonly chain: string;
    readonly nonce: string;
    readonly tx: string;
    readonly sender: string;
    readonly token: string;
    readonly amount: string;
    readonly destination: string;
  };
  readonly provider: {
    readonly status: string | null;
    readonly reference: string | null;
    readonly checkedAt: string | null;
  };
  readonly destination: {
    readonly chain: string;
    readonly tx: string | null;
    readonly messageId: string | null;
    readonly recipient: string | null;
    readonly token: string | null;
    readonly amount: string | null;
    readonly delivered: boolean | null;
  };
  readonly state:
    "missing_provider" | "provider_only" | "missing_destination" | "mismatch" | "reconciled";
}

export interface ItsReconciliationReport {
  readonly generatedAt: string;
  readonly rows: readonly ItsReconciliationRow[];
}

/** Read-only, source-bound reconciliation. It never calls a provider or mutates the database. */
export async function reconcileItsTransfers(
  db: Transactional,
  options: { readonly transferId?: bigint; readonly limit?: number } = {},
): Promise<ItsReconciliationReport> {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new Error("limit must be an integer from 1 to 500");
  const rows = await db.transaction(async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const result = await tx.query(
      `SELECT t.id, t.origin_chain, t.nonce::text, t.origin_tx, t.sender, t.token,
              t.net_amount::text, t.destination_chain, t.destination,
              a.status AS provider_status, a.rail_reference, a.last_checked_at,
              d.destination_tx, d.rail_message_id, d.recipient, d.token AS destination_token,
              d.amount::text AS destination_amount, d.delivered
         FROM outbound_transfer t
         LEFT JOIN rail_attestation a ON a.transfer_id = t.id
         LEFT JOIN inbound_delivery d
           ON d.source_transfer_id = t.id
           OR (d.source_transfer_id IS NULL AND d.source_chain = t.origin_chain
               AND d.source_nonce = t.nonce AND NOT EXISTS (
                 SELECT 1 FROM outbound_transfer other
                  WHERE other.origin_chain = t.origin_chain
                    AND other.nonce = t.nonce AND other.id <> t.id
               ))
        WHERE t.route = 1
          AND ($1::bigint IS NULL OR t.id = $1::bigint)
        ORDER BY t.id ASC
        LIMIT $2::int`,
      [options.transferId?.toString() ?? null, limit],
    );
    return result.rows;
  });
  const mapped = rows.map((row) => {
    const providerStatus = textOrNull(row, "provider_status");
    const destinationTx = textOrNull(row, "destination_tx");
    const destinationAmount =
      row.destination_amount === null ? null : bigintOf(row, "destination_amount").toString();
    const delivered =
      row.delivered === null || row.delivered === undefined ? null : boolean(row, "delivered");
    const mismatch =
      destinationAmount !== null && destinationAmount !== bigintOf(row, "net_amount").toString();
    return {
      transferId: bigintOf(row, "id").toString(),
      source: {
        chain: text(row, "origin_chain"),
        nonce: text(row, "nonce"),
        tx: text(row, "origin_tx"),
        sender: text(row, "sender"),
        token: text(row, "token"),
        amount: bigintOf(row, "net_amount").toString(),
        destination: text(row, "destination"),
      },
      provider: {
        status: providerStatus,
        reference: textOrNull(row, "rail_reference"),
        checkedAt: timestampOrNull(row, "last_checked_at")?.toISOString() ?? null,
      },
      destination: {
        chain: text(row, "destination_chain"),
        tx: destinationTx,
        messageId: textOrNull(row, "rail_message_id"),
        recipient: textOrNull(row, "recipient"),
        token: textOrNull(row, "destination_token"),
        amount: destinationAmount,
        delivered,
      },
      state:
        providerStatus === null
          ? "missing_provider"
          : destinationTx === null
            ? "provider_only"
            : mismatch
              ? "mismatch"
              : delivered === true
                ? "reconciled"
                : "missing_destination",
    } satisfies ItsReconciliationRow;
  });
  return { generatedAt: new Date().toISOString(), rows: mapped };
}
