import { toEvmAddress } from "@hyperion/protocol";
import { sanitizeRailDiagnostic } from "../diagnostics.js";
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
    | "missing_provider"
    | "provider_only"
    | "missing_destination"
    | "missing_proof"
    | "missing_source_binding"
    | "mismatch"
    | "reconciled";
}

export interface ItsReconciliationReport {
  readonly generatedAt: string;
  readonly missingBackendHistory: boolean;
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
      `SELECT t.id, t.origin_chain,t.origin_router, t.nonce::text, t.origin_tx, t.sender, t.token,
              t.net_amount::text, t.destination_chain, t.destination,
              a.status AS provider_status, a.rail_reference, a.last_checked_at,
              d.destination_tx, d.rail_message_id, d.recipient, d.token AS destination_token,
              d.amount::text AS destination_amount, d.delivered,
              e.id AS evidence_id,e.source_binding,e.status AS evidence_status,e.execution_tx_hash,e.command_id,
              e.registered_token,e.payment_recipient,e.payment_amount::text,e.destination_chain AS evidence_chain
         FROM outbound_transfer t
         LEFT JOIN rail_attestation a ON a.transfer_id = t.id
         LEFT JOIN inbound_delivery d ON d.destination_chain=t.destination_chain AND d.route=t.route
           AND d.source_chain=t.origin_chain AND d.source_nonce=t.nonce AND d.source_transfer_id=t.id
         LEFT JOIN axelar_delivery_evidence e ON e.id=d.axelar_evidence_id AND e.transfer_id=t.id
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
    let recipient: string | null = null;
    try {
      const destination = text(row, "destination");
      recipient = /^0x[0-9a-fA-F]{40}$/.test(destination)
        ? destination.toLowerCase()
        : toEvmAddress(destination as `0x${string}`).toLowerCase();
    } catch {
      /* An invalid source recipient cannot establish payout. */
    }
    const binding = row.source_binding;
    const hasBinding = typeof binding === "object" && binding !== null;
    const sourceBinding = hasBinding ? (binding as Record<string, unknown>) : {};
    const sourceMismatch =
      hasBinding &&
      (sourceBinding.chain !== row.origin_chain ||
        sourceBinding.router !== row.origin_router ||
        sourceBinding.nonce !== String(row.nonce) ||
        sourceBinding.transaction !== row.origin_tx ||
        sourceBinding.sender !== row.sender ||
        sourceBinding.token !== row.token ||
        sourceBinding.amount !== String(row.net_amount) ||
        sourceBinding.destinationChain !== row.destination_chain ||
        sourceBinding.destination !== row.destination);
    const equal = (a: unknown, b: unknown) =>
      typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
    const mismatch =
      destinationTx !== null &&
      (sourceMismatch ||
        recipient === null ||
        destinationAmount !== String(row.net_amount) ||
        !equal(row.recipient, recipient) ||
        !equal(row.payment_recipient, recipient) ||
        row.payment_amount !== String(row.net_amount) ||
        !equal(row.destination_token, row.registered_token) ||
        !equal(destinationTx, row.execution_tx_hash) ||
        !equal(row.rail_message_id, row.command_id) ||
        row.evidence_chain !== row.destination_chain);
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
        reference: sanitizeRailDiagnostic(textOrNull(row, "rail_reference")),
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
            : row.evidence_id === null ||
                row.evidence_id === undefined ||
                row.evidence_status !== "canonical"
              ? "missing_proof"
              : !hasBinding
                ? "missing_source_binding"
                : mismatch
                  ? "mismatch"
                  : delivered === true
                    ? "reconciled"
                    : "missing_destination",
    } satisfies ItsReconciliationRow;
  });
  return {
    generatedAt: new Date().toISOString(),
    missingBackendHistory: options.transferId !== undefined && mapped.length === 0,
    rows: mapped,
  };
}
