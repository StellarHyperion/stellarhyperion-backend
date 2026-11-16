/**
 * Versioned machine-readable OpenAPI 3.1.0 contract and runtime schema validator for Hyperion HTTP
 * endpoints.
 *
 * Monetary values (uint256) and 64-bit chain counters/positions (nonces, ledger/block numbers,
 * claim IDs, transfer IDs) are strictly typed as base-10 decimal strings. Unknown token/rail
 * metadata and error envelopes are documented explicitly without fabricated defaults.
 */
import { CHAIN_KEYS } from "@hyperion/protocol";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { AppConfig } from "../config/config.js";

export const OPENAPI_SPEC_VERSION = "3.1.0" as const;
export const API_CONTRACT_VERSION = "2026-11-01" as const;

export interface JsonSchemaObject {
  readonly $ref?: string;
  readonly type?: string | readonly string[];
  readonly description?: string;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly pattern?: string;
  readonly format?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchemaObject>>;
  readonly additionalProperties?: boolean | JsonSchemaObject;
  readonly items?: JsonSchemaObject;
  readonly oneOf?: readonly JsonSchemaObject[];
}

export interface OpenApiMediaType {
  readonly schema: JsonSchemaObject;
}

export interface OpenApiResponseSpec {
  readonly description: string;
  readonly content?: Readonly<Record<string, OpenApiMediaType>>;
}

export interface OpenApiParameterSpec {
  readonly name: string;
  readonly in: "path" | "query" | "header";
  readonly required?: boolean;
  readonly description: string;
  readonly schema: JsonSchemaObject;
}

export interface OpenApiOperationSpec {
  readonly operationId: string;
  readonly summary: string;
  readonly description: string;
  readonly parameters?: readonly OpenApiParameterSpec[];
  readonly responses: Readonly<Record<string, OpenApiResponseSpec>>;
}

export interface OpenApiDocument {
  readonly openapi: typeof OPENAPI_SPEC_VERSION;
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly summary: string;
    readonly description: string;
    readonly "x-contract-version": typeof API_CONTRACT_VERSION;
  };
  readonly paths: Readonly<Record<string, Readonly<Record<string, OpenApiOperationSpec>>>>;
  readonly components: {
    readonly schemas: Readonly<Record<string, JsonSchemaObject>>;
    readonly responses: Readonly<Record<string, OpenApiResponseSpec>>;
  };
}

function ref(name: string): JsonSchemaObject {
  return { $ref: `#/components/schemas/${name}` };
}

function nullableRef(name: string, description: string): JsonSchemaObject {
  return {
    description,
    oneOf: [{ $ref: `#/components/schemas/${name}` }, { type: "null" }],
  };
}

const BAD_REQUEST_RESPONSE: OpenApiResponseSpec = {
  description: "Malformed path or query parameter rejected before execution.",
  content: {
    "application/json": { schema: ref("ApiError") },
  },
};

const RATE_LIMITED_RESPONSE: OpenApiResponseSpec = {
  description: "Client exceeded the public polling rate budget.",
  content: {
    "application/json": { schema: ref("ApiError") },
  },
};

const INTERNAL_ERROR_RESPONSE: OpenApiResponseSpec = {
  description: "Sanitized internal server error free of SQL text and connection credentials.",
  content: {
    "application/json": { schema: ref("ApiError") },
  },
};

const STANDARD_ERROR_RESPONSES: Readonly<Record<string, OpenApiResponseSpec>> = {
  "400": BAD_REQUEST_RESPONSE,
  "429": RATE_LIMITED_RESPONSE,
  "500": INTERNAL_ERROR_RESPONSE,
};

const NOT_FOUND_RESPONSE: OpenApiResponseSpec = {
  description: "Requested record or route does not exist in indexed storage.",
  content: {
    "application/json": { schema: ref("ApiError") },
  },
};

export function buildOpenApiDocument(config?: AppConfig): OpenApiDocument {
  const configuredRouters = config ? Object.keys(config.deployments.networks) : ["stellar-testnet"];

  const schemas: Record<string, JsonSchemaObject> = {
    DecimalUint256String: {
      type: "string",
      pattern: "^[0-9]+$",
      description:
        "Unsigned base-10 integer string representing a base-unit token amount (NUMERIC(78,0), up to uint256 without floating-point precision loss).",
    },
    DecimalUint64String: {
      type: "string",
      pattern: "^[0-9]+$",
      description:
        "Unsigned base-10 integer string representing a 64-bit chain nonce, ledger/block height, claim ID, or database transfer ID.",
    },
    IsoTimestamp: {
      type: "string",
      format: "date-time",
      pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}",
      description: "UTC ISO-8601 timestamp string.",
    },
    ChainKey: {
      type: "string",
      enum: [...CHAIN_KEYS],
      description: "Canonical Hyperion chain key from @hyperion/protocol.",
    },
    RouteKind: {
      type: "integer",
      enum: [0, 1, 2, 3],
      description: "Protocol RouteKind ordinal: 0=CCTP, 1=Axelar ITS, 2=Axelar GMP, 3=Allbridge.",
    },
    TransferLifecycleStage: {
      type: "string",
      enum: [
        "initiated",
        "attesting",
        "attested",
        "delivering",
        "delivered",
        "parked",
        "settled",
        "failed",
      ],
      description:
        "Derived cross-chain lifecycle stage. A rail provider status alone never advances a transfer to 'delivered' without a confirmed canonical destination receipt.",
    },
    TransferOrigin: {
      type: "object",
      additionalProperties: false,
      required: [
        "chain",
        "nonce",
        "sender",
        "token",
        "symbol",
        "decimals",
        "grossAmount",
        "fee",
        "netAmount",
        "block",
        "txHash",
        "observedAt",
      ],
      properties: {
        chain: ref("ChainKey"),
        nonce: ref("DecimalUint64String"),
        sender: {
          type: "string",
          minLength: 1,
          description: "Source-chain sender address or strkey as recorded on-chain.",
        },
        token: {
          type: "string",
          minLength: 1,
          description: "Source-chain token contract or SAC identifier.",
        },
        symbol: {
          type: ["string", "null"],
          description:
            "Known deployment token symbol, or null when the token is outside the active deployment registry.",
        },
        decimals: {
          type: ["integer", "null"],
          minimum: 0,
          maximum: 36,
          description:
            "Known source token decimals, or null when deployment token metadata is unknown.",
        },
        grossAmount: ref("DecimalUint256String"),
        fee: ref("DecimalUint256String"),
        netAmount: ref("DecimalUint256String"),
        block: ref("DecimalUint64String"),
        txHash: {
          type: "string",
          minLength: 1,
          description: "Canonical source-chain transaction hash.",
        },
        observedAt: ref("IsoTimestamp"),
      },
    },
    TransferDestination: {
      type: "object",
      additionalProperties: false,
      required: [
        "token",
        "amount",
        "symbol",
        "decimals",
        "chain",
        "recipient",
        "delivered",
        "block",
        "txHash",
        "deliveredAt",
      ],
      properties: {
        token: {
          type: ["string", "null"],
          description:
            "Confirmed destination payout token address/strkey, or null before verified destination arrival.",
        },
        amount: nullableRef(
          "DecimalUint256String",
          "Confirmed destination payout amount in destination base units as a decimal string, or null until verified on-chain.",
        ),
        symbol: {
          type: ["string", "null"],
          description:
            "Resolved destination token symbol (for example 'USDC' or 'USDC (ITS)'), or null when unverified or unknown.",
        },
        decimals: {
          type: ["integer", "null"],
          minimum: 0,
          maximum: 36,
          description: "Resolved destination token precision, or null when unverified or unknown.",
        },
        chain: ref("ChainKey"),
        recipient: {
          type: "string",
          minLength: 1,
          description:
            "Destination recipient formatted as a 20-byte EVM address on EVM chains or strkey on Stellar.",
        },
        delivered: {
          type: "boolean",
          description:
            "True only when a canonical destination receipt or inbound delivery event has been verified.",
        },
        block: nullableRef(
          "DecimalUint64String",
          "Canonical destination block or ledger number as a decimal string, or null before arrival.",
        ),
        txHash: {
          type: ["string", "null"],
          description: "Confirmed destination transaction hash, or null before arrival.",
        },
        deliveredAt: nullableRef(
          "IsoTimestamp",
          "Chain timestamp of verified destination delivery, or null before arrival.",
        ),
      },
    },
    TransferRailEvidence: {
      type: "object",
      additionalProperties: false,
      required: ["status", "railStatus", "reference", "attestedAt", "lastError"],
      description:
        "Inter-chain rail attestation state. Candidate provider statuses and references are diagnostic only and do not establish delivery.",
      properties: {
        status: {
          type: ["string", "null"],
          enum: ["pending", "attested", "delivered", "failed", "expired", null],
        },
        railStatus: {
          type: ["string", "null"],
          description: "Verbatim provider status vocabulary when reported, or null when unknown.",
        },
        reference: {
          type: ["string", "null"],
          description:
            "Provider support/message reference or candidate hash when reported, or null when unknown.",
        },
        attestedAt: nullableRef(
          "IsoTimestamp",
          "Provider attestation timestamp when known, or null.",
        ),
        lastError: {
          type: ["string", "null"],
          description: "Latest rail polling error diagnostic when present, or null.",
        },
      },
    },
    TransferClaimSummary: {
      type: "object",
      additionalProperties: false,
      required: ["id", "settled"],
      properties: {
        id: ref("DecimalUint64String"),
        settled: { type: "boolean" },
      },
    },
    Transfer: {
      type: "object",
      additionalProperties: false,
      required: ["id", "stage", "route", "origin", "destination", "rail", "claim"],
      properties: {
        id: ref("DecimalUint64String"),
        stage: ref("TransferLifecycleStage"),
        route: ref("RouteKind"),
        origin: ref("TransferOrigin"),
        destination: ref("TransferDestination"),
        rail: nullableRef(
          "TransferRailEvidence",
          "Rail attestation record, or null before the rail poller has recorded an observation.",
        ),
        claim: nullableRef(
          "TransferClaimSummary",
          "Parked destination claim summary when direct recipient payout parked on-chain, or null.",
        ),
      },
    },
    TransferListResponse: {
      type: "object",
      additionalProperties: false,
      required: ["transfers", "limit", "offset", "count"],
      properties: {
        transfers: {
          type: "array",
          items: ref("Transfer"),
        },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        offset: { type: "integer", minimum: 0 },
        count: { type: "integer", minimum: 0 },
      },
    },
    Claim: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "chain",
        "claimId",
        "recipient",
        "token",
        "amount",
        "route",
        "sourceChain",
        "sourceNonce",
        "settled",
        "createdAt",
        "observedAt",
      ],
      properties: {
        id: {
          type: "string",
          pattern: "^(?:[a-z0-9-]+:)?[0-9]+$",
          description: "Composite claim identifier ('<chain>:<claimId>').",
        },
        chain: ref("ChainKey"),
        claimId: ref("DecimalUint64String"),
        recipient: { type: "string", minLength: 1 },
        token: { type: "string", minLength: 1 },
        amount: ref("DecimalUint256String"),
        route: ref("RouteKind"),
        sourceChain: ref("ChainKey"),
        sourceNonce: ref("DecimalUint64String"),
        settled: { type: "boolean" },
        createdAt: ref("IsoTimestamp"),
        observedAt: ref("IsoTimestamp"),
      },
    },
    ClaimListResponse: {
      type: "object",
      additionalProperties: false,
      required: ["claims", "limit", "offset", "count"],
      properties: {
        claims: {
          type: "array",
          items: ref("Claim"),
        },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        offset: { type: "integer", minimum: 0 },
        count: { type: "integer", minimum: 0 },
      },
    },
    RouteBlocker: {
      type: "object",
      additionalProperties: false,
      required: ["code", "label", "detail"],
      properties: {
        code: { type: "integer", minimum: 0 },
        label: { type: "string", minLength: 1 },
        detail: { type: "string" },
      },
    },
    RouteHealthItem: {
      type: "object",
      additionalProperties: false,
      required: [
        "originChain",
        "destinationChain",
        "route",
        "token",
        "available",
        "blocker",
        "flowAvailable",
        "observedAt",
      ],
      properties: {
        originChain: ref("ChainKey"),
        destinationChain: ref("ChainKey"),
        route: ref("RouteKind"),
        token: { type: "string", minLength: 1 },
        available: { type: "boolean" },
        blocker: ref("RouteBlocker"),
        flowAvailable: nullableRef(
          "DecimalUint256String",
          "Remaining flow capacity in base units as a decimal string, or null when unquoted/unknown.",
        ),
        observedAt: ref("IsoTimestamp"),
      },
    },
    RouteHealthResponse: {
      type: "object",
      additionalProperties: false,
      required: ["routes", "count"],
      properties: {
        routes: {
          type: "array",
          items: ref("RouteHealthItem"),
        },
        count: { type: "integer", minimum: 0 },
      },
    },
    LivenessResponse: {
      type: "object",
      additionalProperties: false,
      required: ["status", "meaning", "service", "network", "uptimeSeconds"],
      properties: {
        status: { type: "string", enum: ["ok"] },
        meaning: { type: "string", minLength: 1 },
        service: { type: "string", enum: ["hyperion-backend"] },
        network: { type: "string", enum: ["testnet", "mainnet"] },
        uptimeSeconds: { type: "integer", minimum: 0 },
      },
    },
    ReadinessCheck: {
      type: "object",
      additionalProperties: false,
      required: ["name", "state", "detail"],
      properties: {
        name: { type: "string", minLength: 1 },
        state: { type: "string", enum: ["ready", "degraded", "down"] },
        detail: { type: "string", minLength: 1 },
      },
    },
    ReadinessResponse: {
      type: "object",
      additionalProperties: false,
      required: ["status", "meaning", "network", "indexer", "checks"],
      properties: {
        status: { type: "string", enum: ["ready", "degraded", "down"] },
        meaning: { type: "string", minLength: 1 },
        network: { type: "string", enum: ["testnet", "mainnet"] },
        indexer: { type: "string", enum: ["enabled", "disabled"] },
        checks: {
          type: "array",
          items: ref("ReadinessCheck"),
        },
      },
    },
    MetricsCursor: {
      type: "object",
      additionalProperties: false,
      required: ["chain", "block", "hash", "updatedAt"],
      properties: {
        chain: ref("ChainKey"),
        block: ref("DecimalUint64String"),
        hash: {
          type: ["string", "null"],
          description:
            "Canonical block hash on EVM chains, or null on Stellar ledgers and unhashed cursors.",
        },
        updatedAt: ref("IsoTimestamp"),
      },
    },
    MetricsResponse: {
      type: "object",
      additionalProperties: false,
      required: [
        "service",
        "network",
        "uptimeSeconds",
        "transfers",
        "claims",
        "railAttestations",
        "cursors",
      ],
      properties: {
        service: { type: "string", enum: ["hyperion-backend"] },
        network: { type: "string", enum: ["testnet", "mainnet"] },
        uptimeSeconds: { type: "integer", minimum: 0 },
        transfers: {
          type: "object",
          additionalProperties: false,
          required: ["totalOutbound", "totalInbound"],
          properties: {
            totalOutbound: { type: "integer", minimum: 0 },
            totalInbound: { type: "integer", minimum: 0 },
          },
        },
        claims: {
          type: "object",
          additionalProperties: false,
          required: ["total", "settled", "unsettled"],
          properties: {
            total: { type: "integer", minimum: 0 },
            settled: { type: "integer", minimum: 0 },
            unsettled: { type: "integer", minimum: 0 },
          },
        },
        railAttestations: {
          type: "object",
          additionalProperties: { type: "integer", minimum: 0 },
        },
        cursors: {
          type: "array",
          items: ref("MetricsCursor"),
        },
      },
    },
    ApiError: {
      type: "object",
      additionalProperties: false,
      required: ["error", "message"],
      description:
        "Public error envelope guaranteed free of SQL text, stack traces, and connection credentials.",
      properties: {
        error: {
          type: "string",
          enum: [
            "bad_request",
            "not_found",
            "too_many_requests",
            "service_unavailable",
            "request_timeout",
            "internal_error",
          ],
        },
        message: {
          type: "string",
          minLength: 1,
        },
        requestId: {
          type: "string",
          minLength: 1,
        },
      },
    },
  };

  const transferDetailParametersById: readonly OpenApiParameterSpec[] = [
    {
      name: "id",
      in: "path",
      required: true,
      description: "Indexed outbound transfer ID as a base-10 integer string.",
      schema: ref("DecimalUint64String"),
    },
  ];

  const transferDetailOperation = (operationId: string): OpenApiOperationSpec => ({
    operationId,
    summary: "Get transfer status and verification evidence by ID",
    description:
      "Returns the indexed cross-chain lifecycle, amounts, rail status, and verified destination payout for a single transfer.",
    parameters: transferDetailParametersById,
    responses: {
      "200": {
        description: "Indexed transfer record.",
        content: {
          "application/json": { schema: ref("Transfer") },
        },
      },
      "404": NOT_FOUND_RESPONSE,
      ...STANDARD_ERROR_RESPONSES,
    },
  });

  const transferStreamOperation = (operationId: string): OpenApiOperationSpec => ({
    operationId,
    summary: "Stream live transfer lifecycle updates via Server-Sent Events",
    description:
      "Emits 'transfer_update' JSON payloads matching the Transfer schema and terminates with 'complete' once canonical destination delivery or settlement is recorded.",
    parameters: [
      ...transferDetailParametersById,
      {
        name: "pollIntervalMs",
        in: "query",
        description: "Minimum database refresh interval in milliseconds (clamped to >= 1000).",
        schema: { type: "integer", minimum: 1 },
      },
      {
        name: "heartbeatIntervalMs",
        in: "query",
        description: "SSE comment keep-alive interval in milliseconds (clamped to >= 5000).",
        schema: { type: "integer", minimum: 1 },
      },
    ],
    responses: {
      "200": {
        description: "SSE stream carrying JSON-serialized Transfer events.",
        content: {
          "text/event-stream": {
            schema: {
              type: "string",
              description: "SSE wire stream framing Transfer JSON payloads.",
            },
          },
        },
      },
      "404": NOT_FOUND_RESPONSE,
      ...STANDARD_ERROR_RESPONSES,
    },
  });

  return {
    openapi: OPENAPI_SPEC_VERSION,
    info: {
      title: "Hyperion Backend Public API",
      version: "1.0.0",
      summary: "Cross-chain Stellar and EVM transfer indexing, claim status, and route health API.",
      description: `Serves genuine indexed on-chain events and independently verified destination receipts. Configured router deployments: ${configuredRouters.join(", ") || "none"}. Active testnet deploys the Stellar router without an EVM Hyperion router.`,
      "x-contract-version": API_CONTRACT_VERSION,
    },
    paths: {
      "/health": {
        get: {
          operationId: "getHealth",
          summary: "Process liveness probe",
          description:
            "Confirms the HTTP event loop is responsive without touching external dependencies.",
          responses: {
            "200": {
              description: "Process is alive.",
              content: {
                "application/json": { schema: ref("LivenessResponse") },
              },
            },
            ...STANDARD_ERROR_RESPONSES,
          },
        },
      },
      "/ready": {
        get: {
          operationId: "getReady",
          summary: "Subsystem readiness probe",
          description:
            "Checks PostgreSQL, Redis (when keeper is enabled), and registered chain/rail watchers.",
          responses: {
            "200": {
              description: "Replica is ready or degraded but able to serve public reads.",
              content: {
                "application/json": { schema: ref("ReadinessResponse") },
              },
            },
            "503": {
              description: "Critical dependency is down; remove replica from rotation.",
              content: {
                "application/json": { schema: ref("ReadinessResponse") },
              },
            },
            ...STANDARD_ERROR_RESPONSES,
          },
        },
      },
      "/v1/metrics": {
        get: {
          operationId: "getMetrics",
          summary: "Aggregate transfer, claim, rail attestation, and cursor metrics",
          description: "Returns indexed counts and persisted watcher cursor evidence.",
          responses: {
            "200": {
              description: "Aggregate service metrics.",
              content: {
                "application/json": { schema: ref("MetricsResponse") },
              },
            },
            ...STANDARD_ERROR_RESPONSES,
          },
        },
      },
      "/v1/routes/health": {
        get: {
          operationId: "getRouteHealth",
          summary: "Latest sampled route availability and flow limits",
          description:
            "Returns the latest route health sample per (originChain, destinationChain, route, token).",
          responses: {
            "200": {
              description: "Sampled route health entries (empty array when no samples exist).",
              content: {
                "application/json": { schema: ref("RouteHealthResponse") },
              },
            },
            ...STANDARD_ERROR_RESPONSES,
          },
        },
      },
      "/v1/claims": {
        get: {
          operationId: "listClaims",
          summary: "List parked and settled destination claims",
          description:
            "Returns paginated destination claims with exact base-unit decimal string amounts.",
          parameters: [
            {
              name: "chain",
              in: "query",
              description: "Filter by destination chain key.",
              schema: ref("ChainKey"),
            },
            {
              name: "recipient",
              in: "query",
              description: "Filter by on-chain recipient identifier.",
              schema: { type: "string", minLength: 1 },
            },
            {
              name: "settled",
              in: "query",
              description: "Filter by claim settlement boolean ('true' or 'false').",
              schema: { type: "boolean" },
            },
            {
              name: "limit",
              in: "query",
              description: "Page size (1..100, default 20).",
              schema: { type: "integer", minimum: 1, maximum: 100 },
            },
            {
              name: "offset",
              in: "query",
              description: "Row offset (>= 0, default 0).",
              schema: { type: "integer", minimum: 0 },
            },
          ],
          responses: {
            "200": {
              description: "Paginated claim list (empty array when no matching claims exist).",
              content: {
                "application/json": { schema: ref("ClaimListResponse") },
              },
            },
            ...STANDARD_ERROR_RESPONSES,
          },
        },
      },
      "/v1/claims/{chain}/{claimId}": {
        get: {
          operationId: "getClaimByChainAndId",
          summary: "Get a specific claim by chain and claim ID",
          description:
            "Looks up a parked or settled claim by composite (chain, claimId) primary key.",
          parameters: [
            {
              name: "chain",
              in: "path",
              required: true,
              description: "Destination chain key where the claim was parked.",
              schema: ref("ChainKey"),
            },
            {
              name: "claimId",
              in: "path",
              required: true,
              description: "Unsigned 64-bit claim number as a decimal string.",
              schema: ref("DecimalUint64String"),
            },
          ],
          responses: {
            "200": {
              description: "Indexed claim record.",
              content: {
                "application/json": { schema: ref("Claim") },
              },
            },
            "404": NOT_FOUND_RESPONSE,
            ...STANDARD_ERROR_RESPONSES,
          },
        },
      },
      "/v1/transfers": {
        get: {
          operationId: "listTransfers",
          summary: "List indexed cross-chain transfers",
          description:
            "Returns paginated transfer records ordered newest-first with exact decimal string amounts.",
          parameters: [
            {
              name: "originChain",
              in: "query",
              description: "Filter by source chain key.",
              schema: ref("ChainKey"),
            },
            {
              name: "destinationChain",
              in: "query",
              description: "Filter by destination chain key.",
              schema: ref("ChainKey"),
            },
            {
              name: "route",
              in: "query",
              description: "Filter by RouteKind integer (0..3).",
              schema: ref("RouteKind"),
            },
            {
              name: "sender",
              in: "query",
              description: "Filter by source sender address.",
              schema: { type: "string", minLength: 1 },
            },
            {
              name: "recipient",
              in: "query",
              description: "Filter by destination recipient representation.",
              schema: { type: "string", minLength: 1 },
            },
            {
              name: "search",
              in: "query",
              description:
                "Case-insensitive substring filter over tx hashes, addresses, and nonces.",
              schema: { type: "string" },
            },
            {
              name: "limit",
              in: "query",
              description: "Page size (1..100, default 20).",
              schema: { type: "integer", minimum: 1, maximum: 100 },
            },
            {
              name: "offset",
              in: "query",
              description: "Row offset (>= 0, default 0).",
              schema: { type: "integer", minimum: 0 },
            },
          ],
          responses: {
            "200": {
              description:
                "Paginated transfer list (empty array when history has no matching rows).",
              content: {
                "application/json": { schema: ref("TransferListResponse") },
              },
            },
            ...STANDARD_ERROR_RESPONSES,
          },
        },
      },
      "/v1/transfers/{originChain}/{nonce}": {
        get: {
          operationId: "getTransferByOriginAndNonce",
          summary: "Get transfer by origin chain and router nonce",
          description: "Looks up a transfer by its unique (originChain, nonce) router identity.",
          parameters: [
            {
              name: "originChain",
              in: "path",
              required: true,
              description: "Source chain key.",
              schema: ref("ChainKey"),
            },
            {
              name: "nonce",
              in: "path",
              required: true,
              description: "Router outbound nonce as a base-10 integer string.",
              schema: ref("DecimalUint64String"),
            },
          ],
          responses: {
            "200": {
              description: "Indexed transfer record.",
              content: {
                "application/json": { schema: ref("Transfer") },
              },
            },
            "404": NOT_FOUND_RESPONSE,
            ...STANDARD_ERROR_RESPONSES,
          },
        },
      },
      "/v1/transfers/by-tx/{txHash}": {
        get: {
          operationId: "getTransferByTxHash",
          summary: "Get transfer by source or verified destination transaction hash",
          description: "Matches either origin_tx or verified inbound_delivery destination_tx.",
          parameters: [
            {
              name: "txHash",
              in: "path",
              required: true,
              description: "Source or destination transaction hash.",
              schema: { type: "string", minLength: 1 },
            },
          ],
          responses: {
            "200": {
              description: "Indexed transfer record.",
              content: {
                "application/json": { schema: ref("Transfer") },
              },
            },
            "404": NOT_FOUND_RESPONSE,
            ...STANDARD_ERROR_RESPONSES,
          },
        },
      },
      "/v1/transfers/{id}": {
        get: transferDetailOperation("getTransferById"),
      },
      "/api/v1/transfers/{id}": {
        get: transferDetailOperation("getTransferByIdAlias"),
      },
      "/v1/transfers/{id}/stream": {
        get: transferStreamOperation("streamTransferById"),
      },
      "/api/v1/transfers/{id}/stream": {
        get: transferStreamOperation("streamTransferByIdAlias"),
      },
    },
    components: {
      schemas,
      responses: {
        BadRequest: BAD_REQUEST_RESPONSE,
        NotFound: NOT_FOUND_RESPONSE,
        RateLimited: RATE_LIMITED_RESPONSE,
        InternalError: INTERNAL_ERROR_RESPONSE,
      },
    },
  };
}

function resolveSchemaRef(doc: OpenApiDocument, schema: JsonSchemaObject): JsonSchemaObject {
  if (schema.$ref === undefined) {
    return schema;
  }
  const prefix = "#/components/schemas/";
  if (!schema.$ref.startsWith(prefix)) {
    throw new Error(`Unsupported OpenAPI $ref: ${schema.$ref}`);
  }
  const name = schema.$ref.slice(prefix.length);
  const target = doc.components.schemas[name];
  if (target === undefined) {
    throw new Error(`Unresolved OpenAPI schema $ref: ${schema.$ref}`);
  }
  return resolveSchemaRef(doc, target);
}

function matchesJsonType(value: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return false;
  }
}

export function validateValueAgainstSchema(
  doc: OpenApiDocument,
  rawSchema: JsonSchemaObject,
  value: unknown,
  path = "$",
): readonly string[] {
  const schema = resolveSchemaRef(doc, rawSchema);

  if (schema.oneOf !== undefined) {
    const branchMatch = schema.oneOf.some(
      (branch) => validateValueAgainstSchema(doc, branch, value, path).length === 0,
    );
    return branchMatch ? [] : [`${path}: value did not match any oneOf schema branch`];
  }

  const errors: string[] = [];

  if (schema.type !== undefined) {
    const allowedTypes = Array.isArray(schema.type)
      ? (schema.type as readonly string[])
      : [schema.type as string];
    const typeMatched = allowedTypes.some((t) => matchesJsonType(value, t));
    if (!typeMatched) {
      return [
        `${path}: expected type ${allowedTypes.join("|")}, got ${value === null ? "null" : typeof value}`,
      ];
    }
  }

  if (value === null) {
    if (schema.enum !== undefined && !schema.enum.includes(null)) {
      errors.push(`${path}: null is not in enum`);
    }
    return errors;
  }

  if (schema.enum !== undefined && !schema.enum.includes(value as string | number | boolean)) {
    errors.push(
      `${path}: value ${JSON.stringify(value)} is not in enum [${schema.enum.join(", ")}]`,
    );
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(
        `${path}: string length ${String(value.length)} < minLength ${String(schema.minLength)}`,
      );
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(
        `${path}: string length ${String(value.length)} > maxLength ${String(schema.maxLength)}`,
      );
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(
        `${path}: string ${JSON.stringify(value)} does not match pattern ${schema.pattern}`,
      );
    }
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) {
      errors.push(`${path}: invalid ISO date-time ${JSON.stringify(value)}`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: number ${String(value)} < minimum ${String(schema.minimum)}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: number ${String(value)} > maximum ${String(schema.maximum)}`);
    }
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    const itemSchema = schema.items;
    value.forEach((entry, idx) => {
      errors.push(...validateValueAgainstSchema(doc, itemSchema, entry, `${path}[${String(idx)}]`));
    });
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (schema.required !== undefined) {
      for (const reqKey of schema.required) {
        if (!(reqKey in record) || record[reqKey] === undefined) {
          errors.push(`${path}: missing required property '${reqKey}'`);
        }
      }
    }

    const definedProps = schema.properties ?? {};
    for (const [propKey, propVal] of Object.entries(record)) {
      const propSchema = definedProps[propKey];
      if (propSchema !== undefined) {
        errors.push(...validateValueAgainstSchema(doc, propSchema, propVal, `${path}.${propKey}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: unexpected additional property '${propKey}'`);
      } else if (typeof schema.additionalProperties === "object") {
        errors.push(
          ...validateValueAgainstSchema(
            doc,
            schema.additionalProperties,
            propVal,
            `${path}.${propKey}`,
          ),
        );
      }
    }
  }

  return errors;
}

export function validateOpenApiResponse(
  doc: OpenApiDocument,
  pathTemplate: string,
  method: string,
  statusCode: number,
  body: unknown,
  contentType = "application/json",
): readonly string[] {
  const pathEntry = doc.paths[pathTemplate];
  if (pathEntry === undefined) {
    return [`missing path template '${pathTemplate}' in OpenAPI contract`];
  }
  const operation = pathEntry[method.toLowerCase()];
  if (operation === undefined) {
    return [`missing method '${method}' on '${pathTemplate}' in OpenAPI contract`];
  }
  const responseSpec = operation.responses[String(statusCode)];
  if (responseSpec === undefined) {
    return [`missing status ${String(statusCode)} on ${method.toUpperCase()} ${pathTemplate}`];
  }
  const media = responseSpec.content?.[contentType];
  if (media === undefined) {
    return [
      `missing content-type '${contentType}' on ${method.toUpperCase()} ${pathTemplate} -> ${String(statusCode)}`,
    ];
  }
  return validateValueAgainstSchema(doc, media.schema, body);
}

export function registerOpenApiRoutes(app: FastifyInstance, config: AppConfig): void {
  const contract = buildOpenApiDocument(config);

  const serveContract = async (_request: unknown, reply: FastifyReply) => {
    reply.header("X-API-Contract-Version", API_CONTRACT_VERSION);
    reply.header("Cache-Control", "public, max-age=60");
    return reply.send(contract);
  };

  app.get("/v1/openapi.json", serveContract);
  app.get("/api/v1/openapi.json", serveContract);
}
