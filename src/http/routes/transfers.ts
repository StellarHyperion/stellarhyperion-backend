import { StrKey } from "@stellar/stellar-sdk";
import {
  CHAINS,
  type EvmTokenDeployment,
  type StellarTokenDeployment,
  isRouteKind,
  adapterFor,
  RAIL_CONTRACTS,
  assetOn,
  isChainKey,
  isEvmChain,
  toEvmAddress,
} from "@hyperion/protocol";
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
import { requestQuery, PUBLIC_READ_BUDGET_MS } from "../request-budget.js";
import {
  encodeStreamCursor,
  decodeStreamCursor,
  readStreamTransitions,
  latestStreamTransition,
  StreamCursorError,
} from "../stream-cursor.js";
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
import { sanitizeRailDiagnostic } from "../../rails/diagnostics.js";
import { CCTP_VERIFICATION_FAILURES, type CctpVerificationFailure } from "../../rails/types.js";
import { negotiateSchemaVersion, withSchemaMetadata } from "../schema-version.js";
import { coverageMetadata } from "./coverage.js";
import { CursorError, decodeCursor, encodeCursor, type CursorScope } from "../cursor.js";

export type TransferLifecycleStage =
  | "initiated"
  | "attesting"
  | "attested"
  | "delivering"
  | "delivered"
  | "parked"
  | "settled"
  | "failed";

export interface SourceProvenance {
  readonly status: "confirmed";
  readonly chain: string;
  readonly txHash: string;
  readonly block: string;
  readonly logIndex: number | null;
}

export interface DestinationProvenance {
  readonly status: "confirmed" | "unverified";
  readonly chain: string;
  readonly txHash: string | null;
  readonly block: string | null;
  readonly logIndex: number | null;
}

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
    readonly provenance: SourceProvenance;
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
    readonly provenance: DestinationProvenance;
  };
  readonly rail: {
    readonly provenance: { readonly status: "candidate"; readonly reference: string | null };
    readonly status: string | null;
    readonly railStatus: string | null;
    readonly verificationFailure: CctpVerificationFailure | null;
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
      provenance: {
        status: "confirmed",
        chain,
        txHash: text(row, "origin_tx"),
        block: text(row, "origin_block"),
        logIndex: integerOrNull(row, "origin_log_index"),
      },
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
      provenance: {
        status: delivered ? "confirmed" : "unverified",
        chain: destinationChain,
        txHash: textOrNull(row, "destination_tx"),
        block: textOrNull(row, "destination_block"),
        logIndex: integerOrNull(row, "destination_log_index"),
      },
    },
    rail:
      railStatus === null
        ? null
        : {
            provenance: {
              status: "candidate",
              reference: sanitizeRailDiagnostic(textOrNull(row, "rail_reference")),
            },
            status: railStatus,
            railStatus: sanitizeRailDiagnostic(textOrNull(row, "rail_status")),
            verificationFailure: cctpFailureValue(textOrNull(row, "verification_failure")),
            reference: sanitizeRailDiagnostic(textOrNull(row, "rail_reference")),
            attestedAt: row.attested_at
              ? new Date(row.attested_at as string | number | Date).toISOString()
              : null,
            lastError: sanitizeRailDiagnostic(textOrNull(row, "last_error")),
          },
    claim: hasClaim
      ? {
          id: text(row, "claim_id"),
          settled: claimSettled,
        }
      : null,
  };
}

const ROUTE_NAMES = ["cctp", "axelar-its", "axelar-gmp", "allbridge"] as const;

function invalidFilter(message: string): Error {
  const error = new Error(message);
  (error as Error & { statusCode?: number }).statusCode = 400;
  return error;
}

function validateIdentifierFilter(name: string, value: string, chain?: string): void {
  const evm = /^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{24}[0-9a-fA-F]{40}$/.test(value);
  const stellar = StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value);
  const family = chain !== undefined && isChainKey(chain) ? CHAINS[chain].family : undefined;
  if (!(family === "stellar" ? stellar : family === "evm" ? evm : evm || stellar)) {
    throw invalidFilter(`${name} must be a canonical identity for the selected chain`);
  }
}

export function validateTransferFilters(
  config: AppConfig,
  filters: Readonly<{
    originChain?: string | undefined;
    destinationChain?: string | undefined;
    route?: string | undefined;
    sender?: string | undefined;
    recipient?: string | undefined;
    search?: string | undefined;
  }>,
): void {
  const { originChain, destinationChain, route, sender, recipient, search } = filters;
  const deployments = config.deployments.networks;
  for (const [name, chain] of [
    ["originChain", originChain],
    ["destinationChain", destinationChain],
  ] as const) {
    if (
      chain !== undefined &&
      (!isChainKey(chain) ||
        CHAINS[chain].network !== config.network ||
        (name === "originChain" && deployments[chain] === undefined))
    ) {
      throw invalidFilter(`${name} must name a supported chain on the configured network`);
    }
  }
  if (originChain !== undefined && originChain === destinationChain)
    throw invalidFilter("originChain and destinationChain must differ");
  if (route !== undefined) {
    if (!/^[0-3]$/.test(route)) throw invalidFilter("route must be an integer from 0 to 3");
    const numericRoute = Number(route);
    if (!isRouteKind(numericRoute)) throw invalidFilter("unsupported route");
    const routeName = ROUTE_NAMES[numericRoute];
    const sources =
      originChain !== undefined && isChainKey(originChain)
        ? [deployments[originChain]]
        : Object.values(deployments);
    const sourceSupported = sources.some(
      (deployment) =>
        deployment !== undefined &&
        adapterFor(config.deployments, deployment.chain, numericRoute) !== null &&
        Object.values<EvmTokenDeployment | StellarTokenDeployment>(deployment.tokens).some(
          (token) => token.routes.includes(numericRoute),
        ),
    );
    if (!sourceSupported)
      throw invalidFilter("route has no configured source deployment and asset");
    if (destinationChain !== undefined && isChainKey(destinationChain)) {
      const deployment = deployments[destinationChain];
      const registry = RAIL_CONTRACTS[destinationChain];
      const supported =
        deployment !== undefined &&
        Object.values<EvmTokenDeployment | StellarTokenDeployment>(deployment.tokens).some(
          (token) => token.routes.includes(numericRoute),
        );
      if (
        !supported &&
        !(routeName === "cctp"
          ? registry?.cctp
          : routeName === "axelar-its"
            ? registry?.axelar
            : false)
      ) {
        throw invalidFilter("route has no supported destination representation");
      }
    }
  }
  if (sender !== undefined) validateIdentifierFilter("sender", sender, originChain);
  if (recipient !== undefined) validateIdentifierFilter("recipient", recipient, destinationChain);
  if (search !== undefined && (search.length > 128 || /[\u0000-\u001f\u007f]/.test(search)))
    throw invalidFilter("search must be at most 128 printable characters");
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
         a.verification_failure,
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

function cctpFailureValue(value: string | null): CctpVerificationFailure | null {
  return CCTP_VERIFICATION_FAILURES.find((failure) => failure === value) ?? null;
}

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

  const queryTransferRevisionById = async (request: FastifyRequest, id: string) => {
    const { rows } = await requestQuery(request, db, `${TRANSFER_QUERY} WHERE t.id = $1 LIMIT 1`, [
      id,
    ]);
    const row = rows[0];
    return row !== undefined ? buildTransferRevision(row, deps.config) : null;
  };

  const queryTransferById = async (
    request: FastifyRequest,
    id: string,
  ): Promise<FormattedTransfer | null> => {
    const revision = await queryTransferRevisionById(request, id);
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
      const { rows } = await requestQuery(
        request,
        db,
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
      const { rows } = await requestQuery(
        request,
        db,
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
    const initial = await queryTransferById(request, id);
    if (initial === null)
      return reply.code(404).send({ error: "not_found", message: "Transfer not found." });
    const reads = {
      query: (sql: string, params?: readonly unknown[]) => requestQuery(request, db, sql, params),
    };
    const latest = await latestStreamTransition(reads, id);
    let afterId = latest;
    let replay: readonly Record<string, unknown>[] = [];
    const cursor = request.headers["last-event-id"];
    if (cursor !== undefined) {
      try {
        if (typeof cursor !== "string") throw new StreamCursorError();
        afterId = decodeStreamCursor(cursor, id);
        if (BigInt(afterId) > BigInt(latest)) throw new StreamCursorError();
        if (afterId !== "0") {
          const known = await requestQuery(
            request,
            db,
            "SELECT 1 FROM rail_attestation_history WHERE transfer_id=$1 AND id=$2::bigint",
            [id, afterId],
          );
          if (known.rows.length !== 1) throw new StreamCursorError();
        }
        replay = await readStreamTransitions(reads, id, afterId);
      } catch (error) {
        if (!(error instanceof StreamCursorError)) throw error;
        return reply.code(409).send({ error: error.code, message: error.message, resync: true });
      }
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
    let closed = false;
    let polling = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (pollTimer !== null) clearInterval(pollTimer);
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      reply.raw.off("close", cleanup);
      reply.raw.off("error", cleanup);
    };
    const end = () => {
      cleanup();
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    };
    reply.raw.once("close", cleanup);
    reply.raw.once("error", cleanup);
    const write = async (chunk: string) => {
      if (closed || reply.raw.destroyed || reply.raw.writableEnded)
        throw new Error("Stream closed.");
      if (reply.raw.write(chunk)) return;
      await new Promise<void>((resolve, reject) => {
        const done = (error?: Error) => {
          clearTimeout(timer);
          reply.raw.off("drain", drained);
          reply.raw.off("close", disconnected);
          if (error) reject(error);
          else resolve();
        };
        const drained = () => {
          done();
        };
        const disconnected = () => {
          done(new Error("Stream closed."));
        };
        const timer = setTimeout(() => {
          done(new Error("Stream backpressure exceeded its budget."));
        }, PUBLIC_READ_BUDGET_MS);
        reply.raw.once("drain", drained);
        reply.raw.once("close", disconnected);
      });
    };
    const event = (name: string, data: unknown) =>
      write(
        `id: ${encodeStreamCursor(id, afterId)}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`,
      );
    const emitTransitions = async (rows: readonly Record<string, unknown>[]) => {
      for (const row of rows) {
        afterId = String(row.id);
        await event("rail_transition", {
          transferId: id,
          historyId: afterId,
          oldStatus: row.old_status,
          newStatus: row.new_status,
          reason: row.reason,
          railStatus: row.rail_status,
          evidenceReference: row.evidence_reference,
          observedAt: new Date(row.observed_at as Date | string).toISOString(),
        });
      }
    };
    let lastSerialized = JSON.stringify(withSchemaMetadata(initial, version));
    try {
      await emitTransitions(replay);
      await event("transfer_update", withSchemaMetadata(initial, version));
      if (isDeliveryFinalized(initial)) {
        await event("complete", withSchemaMetadata(initial, version));
        end();
        return;
      }
    } catch {
      end();
      return;
    }
    const intervals = transferStreamIntervals(request.query);
    pollTimer = setInterval(() => {
      if (closed || polling) return;
      polling = true;
      void (async () => {
        try {
          await emitTransitions(await readStreamTransitions(reads, id, afterId));
          const current = await queryTransferById(request, id);
          if (current === null) {
            end();
            return;
          }
          const payload = withSchemaMetadata(current, version);
          const serialized = JSON.stringify(payload);
          if (serialized !== lastSerialized) {
            await event("transfer_update", payload);
            lastSerialized = serialized;
          }
          if (isDeliveryFinalized(current)) {
            await event("complete", payload);
            end();
          }
        } catch (error) {
          if (error instanceof StreamCursorError) {
            try {
              await event("resync", { error: error.code, message: error.message, resync: true });
            } catch {
              /* Connection already closed. */
            }
          }
          end();
        } finally {
          polling = false;
        }
      })();
    }, intervals.poll);
    heartbeatTimer = setInterval(() => {
      if (closed || polling) return;
      polling = true;
      void write(": ping\n\n")
        .catch(() => {
          end();
        })
        .finally(() => {
          polling = false;
        });
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
    const revision = await queryTransferRevisionById(request, id);
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
          cursor?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const version = negotiateSchemaVersion(request, reply);
      if (version === null) return;
      const {
        originChain,
        destinationChain,
        route,
        sender,
        recipient,
        search,
        limit,
        offset,
        cursor,
      } = request.query;

      const scope: CursorScope = {
        ...(originChain === undefined ? {} : { originChain }),
        ...(destinationChain === undefined ? {} : { destinationChain }),
        ...(route === undefined ? {} : { route }),
        ...(sender === undefined ? {} : { sender }),
        ...(recipient === undefined ? {} : { recipient }),
        ...(search?.trim() ? { search: search.trim() } : {}),
      };
      if (cursor !== undefined && offset !== undefined && Number(offset) !== 0) {
        return reply.code(400).send({
          error: "invalid_cursor",
          message: "cursor cannot be combined with offset",
        });
      }

      validateTransferFilters(deps.config, {
        originChain,
        destinationChain,
        route,
        sender,
        recipient,
        search,
      });

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
        conditions.push(
          sender.startsWith("0x")
            ? `lower(t.sender) = lower($${String(params.length)})`
            : `t.sender = $${String(params.length)}`,
        );
      }
      if (recipient) {
        params.push(
          recipient.startsWith("0x") && recipient.length === 42
            ? `0x${recipient.slice(2).padStart(64, "0")}`
            : recipient,
        );
        conditions.push(
          recipient.startsWith("0x")
            ? `lower(t.destination) = lower($${String(params.length)})`
            : `t.destination = $${String(params.length)}`,
        );
      }

      if (search?.trim()) {
        params.push(`%${search.trim()}%`);
        const parameter = `$${String(params.length)}`;
        conditions.push(
          `(t.origin_tx ILIKE ${parameter} OR d.destination_tx ILIKE ${parameter} OR t.sender ILIKE ${parameter} OR t.destination ILIKE ${parameter} OR t.nonce::text ILIKE ${parameter})`,
        );
      }

      const parsedLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
      const parsedOffset = Math.max(Number(offset) || 0, 0);

      if (cursor !== undefined) {
        try {
          const afterId = decodeCursor(cursor, scope);
          params.push(afterId);
          conditions.push(`t.id < $${String(params.length)}`);
        } catch (error) {
          if (error instanceof CursorError) {
            return reply.code(400).send({ error: "invalid_cursor", message: error.message });
          }
          throw error;
        }
      }

      const finalWhereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      params.push(parsedLimit);
      const limitClause = `LIMIT $${String(params.length)}`;
      let offsetClause = "";
      if (cursor === undefined) {
        params.push(parsedOffset);
        offsetClause = `OFFSET $${String(params.length)}`;
      }

      const { rows } = await requestQuery(
        request,
        db,
        `${TRANSFER_QUERY.replace("SELECT t.id,", "SELECT DISTINCT ON (t.id) t.id,")} ${finalWhereClause} ORDER BY t.id DESC, d.destination_block DESC NULLS LAST, d.destination_log_index DESC NULLS LAST ${limitClause} ${offsetClause}`,
        params,
      );

      const coverageChain = originChain ?? (deps.config.indexer.stellar?.chain ?? "");
      const coverage = await coverageMetadata(deps.db, {
        indexer: deps.config.indexer,
        deploymentMode: deps.config.deploymentMode,
      }, coverageChain, rows.length);
      const lastRow = rows.at(-1);
      const nextCursor =
        rows.length === parsedLimit && lastRow !== undefined
          ? encodeCursor(String(lastRow.id), scope)
          : null;
      reply.header("Cache-Control", LIST_CACHE_CONTROL);
      return reply.send(
        withSchemaMetadata(
          {
            transfers: rows.map((row) => formatRow(row, deps.config)),
            limit: parsedLimit,
            ...(cursor === undefined ? { offset: parsedOffset } : {}),
            count: rows.length,
            coverage,
            nextCursor,
          },
          version,
        ),
      );
    },
  );
}
