/**
 * Transfer status and lookup REST API endpoints.
 *
 * Exposes the full cross-chain lifecycle of a transfer:
 * 1. Outbound burn/lock on the source chain
 * 2. Rail attestation in between the chains
 * 3. Inbound delivery or parked claim on the destination chain
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { Database } from "../../db/pool.js";
import { integer, text, textOrNull } from "../../db/rows.js";
import type { ServerDeps } from "../server.js";

export type TransferLifecycleStage =
  | "initiated"
  | "attesting"
  | "attested"
  | "delivering"
  | "delivered"
  | "parked"
  | "settled"
  | "failed";

export interface FormattedTransfer {
  readonly id: string;
  readonly stage: TransferLifecycleStage;
  readonly route: number;
  readonly origin: {
    readonly chain: string;
    readonly nonce: string;
    readonly sender: string;
    readonly token: string;
    readonly grossAmount: string;
    readonly fee: string;
    readonly netAmount: string;
    readonly block: string;
    readonly txHash: string;
    readonly observedAt: string;
  };
  readonly destination: {
    readonly chain: string;
    readonly recipient: string;
    readonly delivered: boolean;
    readonly block: string | null;
    readonly txHash: string | null;
    readonly deliveredAt: string | null;
  };
  readonly rail: {
    readonly status: string | null;
    readonly railStatus: string | null;
    readonly reference: string | null;
    readonly attestedAt: string | null;
    readonly lastError: string | null;
  } | null;
  readonly claim: {
    readonly id: string;
    readonly settled: boolean;
  } | null;
}

function deriveStage(
  delivered: boolean,
  hasClaim: boolean,
  claimSettled: boolean,
  railStatus: string | null,
): TransferLifecycleStage {
  if (hasClaim) {
    return claimSettled ? "settled" : "parked";
  }
  if (delivered) {
    return "delivered";
  }
  if (railStatus === "failed") {
    return "failed";
  }
  if (railStatus === "attested") {
    return "delivering";
  }
  if (railStatus === "pending") {
    return "attesting";
  }
  return "initiated";
}

function formatRow(row: Record<string, unknown>): FormattedTransfer {
  const delivered = row.inbound_delivered === true;
  const hasClaim = row.claim_id !== null && row.claim_id !== undefined;
  const claimSettled = row.claim_settled === true;
  const railStatus = textOrNull(row, "attestation_status");

  const stage = deriveStage(delivered, hasClaim, claimSettled, railStatus);

  return {
    id: text(row, "id"),
    stage,
    route: integer(row, "route"),
    origin: {
      chain: text(row, "origin_chain"),
      nonce: text(row, "nonce"),
      sender: text(row, "sender"),
      token: text(row, "token"),
      grossAmount: text(row, "gross_amount"),
      fee: text(row, "fee"),
      netAmount: text(row, "net_amount"),
      block: text(row, "origin_block"),
      txHash: text(row, "origin_tx"),
      observedAt: new Date(row.observed_at as string | number | Date).toISOString(),
    },
    destination: {
      chain: text(row, "destination_chain"),
      recipient: text(row, "destination"),
      delivered,
      block: textOrNull(row, "destination_block"),
      txHash: textOrNull(row, "destination_tx"),
      deliveredAt: row.delivered_at
        ? new Date(row.delivered_at as string | number | Date).toISOString()
        : null,
    },
    rail:
      railStatus === null
        ? null
        : {
            status: railStatus,
            railStatus: textOrNull(row, "rail_status"),
            reference: textOrNull(row, "rail_reference"),
            attestedAt: row.attested_at
              ? new Date(row.attested_at as string | number | Date).toISOString()
              : null,
            lastError: textOrNull(row, "last_error"),
          },
    claim: hasClaim
      ? {
          id: text(row, "claim_id"),
          settled: claimSettled,
        }
      : null,
  };
}

const TRANSFER_QUERY = `
  SELECT t.id,
         t.origin_chain,
         t.route,
         t.nonce,
         t.sender,
         t.token,
         t.gross_amount,
         t.fee,
         t.net_amount,
         t.destination_chain,
         t.destination,
         t.rail_ref,
         t.origin_block,
         t.origin_tx,
         t.observed_at,
         a.status AS attestation_status,
         a.rail_status,
         a.rail_reference,
         a.attested_at,
         a.last_error,
         d.delivered AS inbound_delivered,
         d.destination_block,
         d.destination_tx,
         d.observed_at AS delivered_at,
         c.claim_id,
         c.settled AS claim_settled
    FROM outbound_transfer t
    LEFT JOIN rail_attestation a ON a.transfer_id = t.id
    LEFT JOIN inbound_delivery d
      ON d.destination_chain = t.destination_chain
     AND d.route = t.route
     AND d.source_chain = t.origin_chain
     AND d.source_nonce = t.nonce
    LEFT JOIN pending_claim c
      ON c.chain = t.destination_chain
     AND c.route = t.route
     AND c.source_chain = t.origin_chain
     AND c.source_nonce = t.nonce
`;

function isDeliveryFinalized(transfer: FormattedTransfer): boolean {
  return (
    transfer.destination.delivered || transfer.stage === "delivered" || transfer.stage === "settled"
  );
}

export function registerTransferRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const db: Database = deps.db;

  const queryTransferById = async (id: string): Promise<FormattedTransfer | null> => {
    const { rows } = await db.query(`${TRANSFER_QUERY} WHERE t.id = $1 LIMIT 1`, [id]);
    const row = rows[0];
    return row !== undefined ? formatRow(row) : null;
  };

  // 1. Look up by originChain and nonce
  app.get(
    "/v1/transfers/:originChain/:nonce",
    async (
      request: FastifyRequest<{ Params: { originChain: string; nonce: string } }>,
      reply: FastifyReply,
    ) => {
      const { originChain, nonce } = request.params;
      const { rows } = await db.query(
        `${TRANSFER_QUERY} WHERE t.origin_chain = $1 AND t.nonce = $2 LIMIT 1`,
        [originChain, nonce],
      );

      const row = rows[0];
      if (row === undefined) {
        return reply.code(404).send({
          error: "not_found",
          message: `no transfer found for chain ${originChain} and nonce ${nonce}`,
        });
      }

      return reply.send(formatRow(row));
    },
  );

  // 2. Look up by transaction hash
  app.get(
    "/v1/transfers/by-tx/:txHash",
    async (request: FastifyRequest<{ Params: { txHash: string } }>, reply: FastifyReply) => {
      const { txHash } = request.params;
      const { rows } = await db.query(
        `${TRANSFER_QUERY} WHERE t.origin_tx = $1 OR d.destination_tx = $1 LIMIT 1`,
        [txHash],
      );

      const row = rows[0];
      if (row === undefined) {
        return reply.code(404).send({
          error: "not_found",
          message: `no transfer found with transaction hash ${txHash}`,
        });
      }

      return reply.send(formatRow(row));
    },
  );

  // 3. SSE live stream endpoint
  const handleStream = async (
    request: FastifyRequest<{
      Params: { id: string };
      Querystring: { pollIntervalMs?: string; heartbeatIntervalMs?: string };
    }>,
    reply: FastifyReply,
  ) => {
    const { id } = request.params;
    const initial = await queryTransferById(id);
    if (initial === null) {
      return reply.code(404).send({
        error: "not_found",
        message: `no transfer found with id ${id}`,
      });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const safeWrite = (chunk: string): boolean => {
      if (reply.raw.writableEnded || reply.raw.destroyed) {
        return false;
      }
      return reply.raw.write(chunk);
    };

    const safeEnd = (): void => {
      if (!reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.end();
      }
    };

    safeWrite(`event: transfer_update\ndata: ${JSON.stringify(initial)}\n\n`);

    if (isDeliveryFinalized(initial)) {
      safeWrite(`event: complete\ndata: ${JSON.stringify(initial)}\n\n`);
      safeEnd();
      return;
    }

    let lastSerialized = JSON.stringify(initial);
    let closed = false;

    const pollInterval = Math.max(Number(request.query.pollIntervalMs) || 1000, 10);
    const heartbeatInterval = Math.max(Number(request.query.heartbeatIntervalMs) || 15000, 10);

    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (pollTimer !== null) {
        clearInterval(pollTimer);
      }
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
      }
    };

    request.raw.on("close", cleanup);
    reply.raw.on("close", cleanup);
    reply.raw.on("error", cleanup);

    pollTimer = setInterval(() => {
      void (async () => {
        if (closed || reply.raw.writableEnded || reply.raw.destroyed) {
          cleanup();
          return;
        }

        try {
          const current = await queryTransferById(id);
          if (current === null) return;

          const currentSerialized = JSON.stringify(current);
          if (currentSerialized !== lastSerialized) {
            lastSerialized = currentSerialized;
            safeWrite(`event: transfer_update\ndata: ${JSON.stringify(current)}\n\n`);

            if (isDeliveryFinalized(current)) {
              safeWrite(`event: complete\ndata: ${JSON.stringify(current)}\n\n`);
              safeEnd();
              cleanup();
            }
          }
        } catch (error) {
          request.log.warn({ err: error, id }, "transfer stream poll failed");
        }
      })();
    }, pollInterval);

    heartbeatTimer = setInterval(() => {
      if (closed || reply.raw.writableEnded || reply.raw.destroyed) {
        cleanup();
        return;
      }
      safeWrite(": ping\n\n");
    }, heartbeatInterval);
  };

  app.get("/v1/transfers/:id/stream", handleStream);
  app.get("/api/v1/transfers/:id/stream", handleStream);

  // 4. Look up by ID
  const getTransferById = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const { id } = request.params;
    const transfer = await queryTransferById(id);
    if (transfer === null) {
      return reply.code(404).send({
        error: "not_found",
        message: `no transfer found with id ${id}`,
      });
    }
    return reply.send(transfer);
  };

  app.get("/v1/transfers/:id", getTransferById);
  app.get("/api/v1/transfers/:id", getTransferById);

  // 3. List transfers with filtering
  app.get(
    "/v1/transfers",
    async (
      request: FastifyRequest<{
        Querystring: {
          originChain?: string;
          destinationChain?: string;
          route?: string;
          sender?: string;
          recipient?: string;
          limit?: string;
          offset?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const { originChain, destinationChain, route, sender, recipient, limit, offset } =
        request.query;

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (originChain) {
        params.push(originChain);
        conditions.push(`t.origin_chain = $${String(params.length)}`);
      }
      if (destinationChain) {
        params.push(destinationChain);
        conditions.push(`t.destination_chain = $${String(params.length)}`);
      }
      if (route !== undefined) {
        params.push(Number(route));
        conditions.push(`t.route = $${String(params.length)}`);
      }
      if (sender) {
        params.push(sender);
        conditions.push(`t.sender = $${String(params.length)}`);
      }
      if (recipient) {
        params.push(recipient);
        conditions.push(`t.destination = $${String(params.length)}`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const parsedLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
      const parsedOffset = Math.max(Number(offset) || 0, 0);

      params.push(parsedLimit);
      const limitClause = `LIMIT $${String(params.length)}`;
      params.push(parsedOffset);
      const offsetClause = `OFFSET $${String(params.length)}`;

      const { rows } = await db.query(
        `${TRANSFER_QUERY} ${whereClause} ORDER BY t.id DESC ${limitClause} ${offsetClause}`,
        params,
      );

      return reply.send({
        transfers: rows.map(formatRow),
        limit: parsedLimit,
        offset: parsedOffset,
        count: rows.length,
      });
    },
  );
}
