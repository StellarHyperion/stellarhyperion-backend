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
import { integer, text, textOrNull } from "../../db/rows.js";
import type { ServerDeps } from "../server.js";
import {
  BoundedSseWriter,
  TransferStreamJournal,
  extractRequestedCursor,
  formatResyncEvent,
  formatSseFrame,
  type ResyncReason,
} from "../sse-cursor.js";

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

  return {
    id: text(row, "id"),
    stage,
    route: integer(row, "route"),
    origin: {
      chain: text(row, "origin_chain"),
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
         d.token AS received_token,
         d.amount AS received_amount,
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

function resyncInstructionsFor(reason: ResyncReason): string {
  switch (reason) {
    case "expired":
      return "Resume cursor has expired outside the retention window. Fetch the current snapshot from snapshotUrl and reconnect to streamUrl without Last-Event-ID.";
    case "evicted":
      return "Resume cursor predates the bounded transition buffer. Fetch the current snapshot from snapshotUrl and reconnect to streamUrl without Last-Event-ID.";
    case "transfer_mismatch":
      return "Resume cursor belongs to a different transfer id. Reconnect using a cursor issued by this transfer stream or omit Last-Event-ID.";
    case "conflicting_cursor":
      return "Conflicting cursors were supplied in Last-Event-ID and cursor query parameter. Supply a single cursor or omit both to resync from snapshotUrl.";
    case "malformed_cursor":
    case "invalid_state":
      return "Resume cursor is malformed or does not match transfer history. Fetch the current snapshot from snapshotUrl and reconnect to streamUrl without Last-Event-ID.";
  }
}

export function registerTransferRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const db: Database = deps.db;
  const sseOptions = deps.sse ?? {};
  const journal = deps.streamJournal ?? new TransferStreamJournal(sseOptions);
  const maxPendingFrames = sseOptions.maxPendingFrames ?? 16;
  const maxBufferedBytes = sseOptions.maxBufferedBytes ?? 64 * 1024;
  const drainTimeoutMs = sseOptions.drainTimeoutMs ?? 5_000;
  const retryDelayMs = sseOptions.retryDelayMs ?? 1_000;

  const queryTransferById = async (id: string): Promise<FormattedTransfer | null> => {
    const { rows } = await db.query(`${TRANSFER_QUERY} WHERE t.id = $1 LIMIT 1`, [id]);
    const row = rows[0];
    return row !== undefined ? formatRow(row, deps.config) : null;
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

      return reply.send(formatRow(row, deps.config));
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

      return reply.send(formatRow(row, deps.config));
    },
  );

  // 3. SSE live stream endpoint
  const handleStream = async (
    request: FastifyRequest<{
      Params: { id: string };
      Querystring: {
        pollIntervalMs?: string;
        heartbeatIntervalMs?: string;
        cursor?: string;
      };
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

    const pathPrefix = request.url.startsWith("/api/") ? "/api/v1/transfers" : "/v1/transfers";
    const snapshotUrl = `${pathPrefix}/${encodeURIComponent(id)}`;
    const streamUrl = `${snapshotUrl}/stream`;

    const extractedCursor = extractRequestedCursor(request.headers, request.query.cursor);
    const resumeOutcome =
      extractedCursor.kind === "none"
        ? null
        : extractedCursor.kind === "error"
          ? { ok: false as const, reason: extractedCursor.reason, latestCursor: null }
          : journal.resolveResume(id, extractedCursor.raw, initial);

    const requiresResync = resumeOutcome !== null && !resumeOutcome.ok;

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...(requiresResync ? { "X-Hyperion-Stream-Resync": "required" } : {}),
    });

    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let cleanedUp = false;

    journal.onStreamOpen();

    const cleanupTimersAndAccount = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      journal.onStreamClose();
    };

    const writer = new BoundedSseWriter({
      requestRaw: request.raw,
      responseRaw: reply.raw,
      maxPendingFrames,
      maxBufferedBytes,
      drainTimeoutMs,
      onClose: cleanupTimersAndAccount,
    });

    if (resumeOutcome !== null && !resumeOutcome.ok) {
      writer.writeFrame(
        formatResyncEvent({
          error: "resync_required",
          reason: resumeOutcome.reason,
          transferId: id,
          snapshotUrl,
          streamUrl,
          latestCursor: resumeOutcome.latestCursor,
          instructions: resyncInstructionsFor(resumeOutcome.reason),
        }),
      );
      writer.endStream();
      return;
    }

    let lastStage: TransferLifecycleStage;
    let lastDigest: string;

    if (resumeOutcome === null) {
      const recorded = journal.recordInitial(initial);
      recorded.frames.forEach((frame, index) => {
        writer.writeFrame(formatSseFrame(frame, index === 0 ? retryDelayMs : undefined));
      });
      if (isDeliveryFinalized(initial)) {
        writer.endStream();
        return;
      }
      lastStage = recorded.latestUpdateFrame.stage;
      lastDigest = recorded.latestUpdateFrame.digest;
    } else {
      if (resumeOutcome.replayFrames.length === 0) {
        writer.writeFrame(`retry: ${String(retryDelayMs)}\n: resumed\n\n`);
      } else {
        resumeOutcome.replayFrames.forEach((frame, index) => {
          writer.writeFrame(formatSseFrame(frame, index === 0 ? retryDelayMs : undefined));
        });
      }
      if (resumeOutcome.finalized) {
        writer.endStream();
        return;
      }
      lastStage = resumeOutcome.latestUpdateFrame.stage;
      lastDigest = resumeOutcome.latestUpdateFrame.digest;
    }

    const pollInterval = Math.max(Number(request.query.pollIntervalMs) || 1000, 1000);
    const heartbeatInterval = Math.max(Number(request.query.heartbeatIntervalMs) || 15000, 5000);
    let pollInFlight = false;

    pollTimer = setInterval(() => {
      if (writer.isClosed()) {
        writer.close();
        return;
      }
      if (pollInFlight || writer.isBackpressured()) {
        return;
      }

      pollInFlight = true;
      void (async () => {
        try {
          const current = await queryTransferById(id);
          if (current === null || writer.isClosed()) return;

          const delta = journal.recordPolled(current, lastStage, lastDigest);
          lastStage = delta.latestStage;
          lastDigest = delta.latestDigest;

          for (const frame of delta.frames) {
            if (!writer.writeFrame(formatSseFrame(frame))) {
              return;
            }
          }

          if (delta.finalized) {
            writer.endStream();
          }
        } catch (error) {
          request.log.warn({ err: error, id }, "transfer stream poll failed");
        } finally {
          pollInFlight = false;
        }
      })();
    }, pollInterval);

    heartbeatTimer = setInterval(() => {
      if (writer.isClosed()) {
        writer.close();
        return;
      }
      writer.writeHeartbeat(": ping\n\n");
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
          search?: string;
          limit?: string;
          offset?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
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

      return reply.send({
        transfers: rows.map((row) => formatRow(row, deps.config)),
        limit: parsedLimit,
        offset: parsedOffset,
        count: rows.length,
      });
    },
  );
}
