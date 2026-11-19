import { CHAINS, assetOn, isChainKey, isEvmChain, toEvmAddress } from "@hyperion/protocol";
import type { AppConfig } from "../../config/config.js";
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
import { integer, integerOrNull, text, textOrNull, timestampOrNull } from "../../db/rows.js";
import {
  LIST_CACHE_CONTROL,
  computeCanonicalETag,
  sendConditionalDetailResponse,
} from "../etag.js";
import {
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  DEFAULT_STREAM_RATE_LIMIT_MAX,
  type ServerDeps,
} from "../server.js";
import { transferStreamIntervals } from "../stream-intervals.js";
import { negotiateSchemaVersion, withSchemaMetadata } from "../schema-version.js";

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
    readonly router: string | null;
    readonly nonce: string;
    readonly sender: string;
    readonly token: string;
    readonly symbol: string | null;
    readonly decimals: number | null;
    readonly grossAmount: string;
    readonly fee: string;
    readonly netAmount: string;
    readonly block: string;
    readonly txHash: string;
    readonly observedAt: string;
  };
  readonly destination: {
    readonly token: string | null;
    readonly amount: string | null;
    readonly symbol: string | null;
    readonly decimals: number | null;
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
  if (railStatus === "failed" || railStatus === "expired") {
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

function formatRow(row: Record<string, unknown>, config: AppConfig): FormattedTransfer {
  const chain = text(row, "origin_chain");
  const token = text(row, "token");
  const destinationChain = text(row, "destination_chain");
  const destinationWord = text(row, "destination");
  const recipient =
    isChainKey(destinationChain) &&
    isEvmChain(CHAINS[destinationChain]) &&
    /^0x[0-9a-fA-F]{64}$/.test(destinationWord)
      ? toEvmAddress(destinationWord as `0x${string}`)
      : destinationWord;
  const deployment = isChainKey(chain) ? config.deployments.networks[chain] : undefined;
  const entry = deployment
    ? Object.entries(
        deployment.tokens as Record<string, { sacId?: string; address?: string; decimals: number }>,
      ).find(([, asset]) => {
        const value = asset.sacId ?? asset.address;
        return value?.toLowerCase() === token.toLowerCase();
      })
    : undefined;
  const delivered = row.inbound_delivered === true;
  const receivedToken = textOrNull(row, "received_token");
  const destinationAsset =
    isChainKey(destinationChain) && entry ? assetOn(destinationChain, entry[0]) : null;
  const nativeMetadata =
    destinationAsset?.family === "evm" &&
    destinationAsset.address.toLowerCase() === receivedToken?.toLowerCase()
      ? { symbol: destinationAsset.symbol, decimals: destinationAsset.decimals }
      : null;
  const receivedMetadata =
    nativeMetadata ??
    (receivedToken && integer(row, "route") === 1 && entry && chain === "stellar-testnet"
      ? { symbol: `${entry[0]} (ITS)`, decimals: entry[1].decimals }
      : null);
  const hasClaim = row.claim_id !== null && row.claim_id !== undefined;
  const claimSettled = row.claim_settled === true;
  const railStatus = textOrNull(row, "attestation_status");

  const stage = deriveStage(delivered, hasClaim, claimSettled, railStatus);
  const originRouter = textOrNull(row, "origin_router");

  return {
    id: text(row, "id"),
    stage,
    route: integer(row, "route"),
    origin: {
      chain: text(row, "origin_chain"),
      router: originRouter === "" ? null : originRouter,
      nonce: text(row, "nonce"),
      sender: text(row, "sender"),
      token,
      symbol: entry?.[0] ?? null,
      decimals: entry?.[1].decimals ?? null,
      grossAmount: text(row, "gross_amount"),
      fee: text(row, "fee"),
      netAmount: text(row, "net_amount"),
      block: text(row, "origin_block"),
      txHash: text(row, "origin_tx"),
      observedAt: new Date(row.observed_at as string | number | Date).toISOString(),
    },
    destination: {
      token: receivedToken,
      amount: textOrNull(row, "received_amount"),
      symbol: receivedMetadata?.symbol ?? null,
      decimals: receivedMetadata?.decimals ?? null,
      chain: destinationChain,
      recipient,
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
         t.origin_router,
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
         t.origin_log_index,
         t.observed_at,
         a.status AS attestation_status,
         a.rail_status,
         a.rail_reference,
         a.attested_at,
         a.last_error,
         d.delivered AS inbound_delivered,
         d.destination_block,
         d.destination_tx,
         d.rail_message_id,
         d.destination_log_index,
         d.token AS received_token,
         d.amount AS received_amount,
         d.observed_at AS delivered_at,
         c.claim_id,
         c.settled AS claim_settled,
         c.settled_at AS claim_settled_at,
         c.settled_by AS claim_settled_by,
         c.settled_tx AS claim_settled_tx
    FROM outbound_transfer t
    LEFT JOIN rail_attestation a ON a.transfer_id = t.id
    LEFT JOIN inbound_delivery d
      ON d.destination_chain = t.destination_chain
     AND d.route = t.route
     AND d.source_chain = t.origin_chain
     AND d.source_nonce = t.nonce
      AND (d.source_transfer_id = t.id OR (d.source_transfer_id IS NULL AND NOT EXISTS (
        SELECT 1 FROM outbound_transfer other
         WHERE other.origin_chain = t.origin_chain AND other.nonce = t.nonce
           AND other.id <> t.id
      )))
    LEFT JOIN pending_claim c
      ON c.chain = t.destination_chain
     AND c.route = t.route
     AND c.source_chain = t.origin_chain
     AND c.source_nonce = t.nonce
      AND (c.source_transfer_id = t.id OR (c.source_transfer_id IS NULL AND NOT EXISTS (
        SELECT 1 FROM outbound_transfer other
         WHERE other.origin_chain = t.origin_chain AND other.nonce = t.nonce
           AND other.id <> t.id
      )))
`;

function isDeliveryFinalized(transfer: FormattedTransfer): boolean {
  return (
    transfer.destination.delivered || transfer.stage === "delivered" || transfer.stage === "settled"
  );
}

function buildTransferRevision(row: Record<string, unknown>, config: AppConfig) {
  const transfer = formatRow(row, config);
  const settledAt = timestampOrNull(row, "claim_settled_at");
  return {
    transfer,
    etag: computeCanonicalETag("transfer-v1", {
      transfer,
      proof: {
        originLogIndex: integerOrNull(row, "origin_log_index"),
        originRailReference: textOrNull(row, "rail_ref"),
        destinationLogIndex: integerOrNull(row, "destination_log_index"),
        railMessageId: textOrNull(row, "rail_message_id"),
        claimSettledAt: settledAt?.toISOString() ?? null,
        claimSettledBy: textOrNull(row, "claim_settled_by"),
        claimSettledTx: textOrNull(row, "claim_settled_tx"),
      },
    }),
  };
}

export function registerTransferRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const db: Database = deps.db;

  const queryTransferRevisionById = async (id: string) => {
    const { rows } = await db.query(`${TRANSFER_QUERY} WHERE t.id = $1 LIMIT 1`, [id]);
    const row = rows[0];
    return row !== undefined ? buildTransferRevision(row, deps.config) : null;
  };

  const queryTransferById = async (id: string): Promise<FormattedTransfer | null> => {
    const revision = await queryTransferRevisionById(id);
    return revision?.transfer ?? null;
  };

  // 1. Look up by originChain and nonce
  app.get(
    "/v1/transfers/:originChain/:nonce",
    async (
      request: FastifyRequest<{ Params: { originChain: string; nonce: string } }>,
      reply: FastifyReply,
    ) => {
      const version = negotiateSchemaVersion(request, reply);
      if (version === null) return;

      const { originChain, nonce } = request.params;
      const { rows } = await db.query(
        `${TRANSFER_QUERY} WHERE t.origin_chain = $1 AND t.nonce = $2 ORDER BY t.id LIMIT 2`,
        [originChain, nonce],
      );

      if (rows.length > 1) {
        return reply.code(409).send({
          error: "ambiguous_transfer",
          message:
            "Multiple router deployments used this nonce. Look up the transfer by its source transaction or id.",
        });
      }
      const row = rows[0];
      if (row === undefined) {
        return reply.code(404).send({
          error: "not_found",
          message: `no transfer found for chain ${originChain} and nonce ${nonce}`,
        });
      }

      const revision = buildTransferRevision(row, deps.config);
      return sendConditionalDetailResponse(
        request,
        reply,
        withSchemaMetadata(revision.transfer, version),
        version === "1.0"
          ? revision.etag
          : computeCanonicalETag("transfer-v1.1", { base: revision.etag }),
      );
    },
  );

  // 2. Look up by transaction hash
  app.get(
    "/v1/transfers/by-tx/:txHash",
    async (request: FastifyRequest<{ Params: { txHash: string } }>, reply: FastifyReply) => {
      const version = negotiateSchemaVersion(request, reply);
      if (version === null) return;

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

      const revision = buildTransferRevision(row, deps.config);
      return sendConditionalDetailResponse(
        request,
        reply,
        withSchemaMetadata(revision.transfer, version),
        version === "1.0"
          ? revision.etag
          : computeCanonicalETag("transfer-v1.1", { base: revision.etag }),
      );
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
    const version = negotiateSchemaVersion(request, reply);
    if (version === null) return;

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
      "X-API-Schema-Version": version,
      Vary: "X-API-Schema-Version",
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

    const initialPayload = withSchemaMetadata(initial, version);
    safeWrite(`event: transfer_update\ndata: ${JSON.stringify(initialPayload)}\n\n`);

    if (isDeliveryFinalized(initial)) {
      safeWrite(`event: complete\ndata: ${JSON.stringify(initialPayload)}\n\n`);
      safeEnd();
      return;
    }

    let lastSerialized = JSON.stringify(initialPayload);
    let closed = false;

    const intervals = transferStreamIntervals(request.query);

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

          const currentPayload = withSchemaMetadata(current, version);
          const currentSerialized = JSON.stringify(currentPayload);
          if (currentSerialized !== lastSerialized) {
            lastSerialized = currentSerialized;
            safeWrite(`event: transfer_update\ndata: ${currentSerialized}\n\n`);

            if (isDeliveryFinalized(current)) {
              safeWrite(`event: complete\ndata: ${currentSerialized}\n\n`);
              safeEnd();
              cleanup();
            }
          }
        } catch (error) {
          request.log.warn({ err: error, id }, "transfer stream poll failed");
        }
      })();
    }, intervals.poll);

    heartbeatTimer = setInterval(() => {
      if (closed || reply.raw.writableEnded || reply.raw.destroyed) {
        cleanup();
        return;
      }
      safeWrite(": ping\n\n");
    }, intervals.heartbeat);
  };

  const streamRouteConfig = {
    config: {
      rateLimit: {
        max: deps.rateLimit?.streamMax ?? DEFAULT_STREAM_RATE_LIMIT_MAX,
        timeWindow: deps.rateLimit?.timeWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
      },
    },
  };

  app.get("/v1/transfers/:id/stream", streamRouteConfig, handleStream);
  app.get("/api/v1/transfers/:id/stream", streamRouteConfig, handleStream);

  // 4. Look up by ID
  const getTransferById = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const version = negotiateSchemaVersion(request, reply);
    if (version === null) return;

    const { id } = request.params;
    const revision = await queryTransferRevisionById(id);
    if (revision === null) {
      return reply.code(404).send({
        error: "not_found",
        message: `no transfer found with id ${id}`,
      });
    }
    return sendConditionalDetailResponse(
      request,
      reply,
      withSchemaMetadata(revision.transfer, version),
      version === "1.0"
        ? revision.etag
        : computeCanonicalETag("transfer-v1.1", { base: revision.etag }),
    );
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
          search?: string;
          limit?: string;
          offset?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const version = negotiateSchemaVersion(request, reply);
      if (version === null) return;

      const { originChain, destinationChain, route, sender, recipient, search, limit, offset } =
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

      if (search?.trim()) {
        params.push(`%${search.trim()}%`);
        const parameter = `$${String(params.length)}`;
        conditions.push(
          `(t.origin_tx ILIKE ${parameter} OR d.destination_tx ILIKE ${parameter} OR t.sender ILIKE ${parameter} OR t.destination ILIKE ${parameter} OR t.nonce::text ILIKE ${parameter})`,
        );
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

      reply.header("Cache-Control", LIST_CACHE_CONTROL);
      return reply.send(
        withSchemaMetadata(
          {
            transfers: rows.map((row) => formatRow(row, deps.config)),
            limit: parsedLimit,
            offset: parsedOffset,
            count: rows.length,
          },
          version,
        ),
      );
    },
  );
}
