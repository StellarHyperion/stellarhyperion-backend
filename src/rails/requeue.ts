import { RouteKind } from "@hyperion/protocol";
import type { Transactional } from "../db/pool.js";
import { bigintOf, integer, text, textOrNull } from "../db/rows.js";
import type { RailRequeueRequest, RailRequeueResult } from "./types.js";

export class RailRequeueError extends Error {
  constructor(
    readonly kind:
      "not_found" | "not_terminal" | "already_delivered" | "unsupported_rail" | "invalid_review",
    message: string,
  ) {
    super(message);
    this.name = "RailRequeueError";
  }
}

/** Reopen only a reviewed failed/expired transfer, atomically recording its previous state. */
export async function requeueTerminalTransfer(
  db: Transactional,
  request: RailRequeueRequest,
): Promise<RailRequeueResult> {
  if (request.transferId <= 0n || request.transferId > 9_223_372_036_854_775_807n) {
    throw new RailRequeueError(
      "invalid_review",
      "transfer identifier is outside the database range",
    );
  }
  const reviewedBy = request.reviewedBy.trim();
  const reason = request.reason.trim();
  if (reviewedBy.length === 0 || reviewedBy.length > 200) {
    throw new RailRequeueError("invalid_review", "reviewed-by must contain 1 to 200 characters");
  }
  if (reason.length === 0 || reason.length > 2000) {
    throw new RailRequeueError("invalid_review", "reason must contain 1 to 2000 characters");
  }

  return db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT t.id, t.route, t.origin_chain, t.nonce, a.status, a.retry_class,
              EXISTS (
                SELECT 1 FROM inbound_delivery d
                 WHERE d.destination_chain = t.destination_chain
                   AND d.route = t.route
                   AND d.source_chain = t.origin_chain
                   AND d.source_nonce = t.nonce
              ) AS has_inbound
         FROM outbound_transfer t
         JOIN rail_attestation a ON a.transfer_id = t.id
        WHERE t.id = $1
        FOR UPDATE OF t, a`,
      [request.transferId.toString()],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new RailRequeueError("not_found", "transfer or rail status was not found");
    }

    const priorStatus = text(row, "status");
    const priorRetryClass = textOrNull(row, "retry_class");
    const held = priorRetryClass === "permanent" || priorRetryClass === "exhausted";
    if (
      priorStatus !== "failed" &&
      priorStatus !== "expired" &&
      !((priorStatus === "pending" || priorStatus === "attested") && held)
    ) {
      throw new RailRequeueError(
        "not_terminal",
        `transfer status ${priorStatus} is not eligible; only failed, expired or explicitly held evidence failures may be requeued`,
      );
    }
    if (row.has_inbound === true) {
      throw new RailRequeueError(
        "already_delivered",
        "a matching destination delivery or claim is already indexed",
      );
    }

    const transferId = bigintOf(row, "id");
    const route = integer(row, "route");
    if (route !== RouteKind.Cctp && route !== RouteKind.AxelarIts) {
      throw new RailRequeueError(
        "unsupported_rail",
        "no rail status provider is configured for this transfer route",
      );
    }
    const originChain = text(row, "origin_chain");
    const nonce = bigintOf(row, "nonce");
    const updated = await tx.query(
      `UPDATE rail_attestation
          SET status = 'pending',
              rail_status = NULL,
              rail_reference = NULL,
              attested_at = NULL,
              last_checked_at = now(),
              check_failures = 0,
              retry_attempts = 0,
              last_error = NULL,
              next_attempt_at = now(),
              retry_class = NULL,
              updated_at = now()
        WHERE transfer_id = $1
          AND status = $2
          AND retry_class IS NOT DISTINCT FROM $3`,
      [transferId.toString(), priorStatus, priorRetryClass],
    );
    if (updated.rowCount !== 1) {
      throw new RailRequeueError("not_terminal", "transfer status changed during requeue");
    }

    await tx.query(
      `INSERT INTO rail_requeue_audit
         (transfer_id, route, origin_chain, nonce, prior_status, new_status,
          reviewed_by, reviewed_reason, prior_retry_class)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8)`,
      [
        transferId.toString(),
        route,
        originChain,
        nonce.toString(),
        priorStatus,
        reviewedBy,
        reason,
        priorRetryClass,
      ],
    );

    return { transferId, route, priorStatus };
  });
}
