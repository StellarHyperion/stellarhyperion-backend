import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

export type PublicApiErrorCode =
  | "validation_error"
  | "not_found"
  | "rate_limited"
  | "service_unavailable"
  | "request_timeout"
  | "internal_error";

export type LegacyApiErrorType =
  | "bad_request"
  | "not_found"
  | "too_many_requests"
  | "service_unavailable"
  | "request_timeout"
  | "internal_error";

export interface PublicApiErrorDetail {
  readonly field?: string;
  readonly reason: string;
}

export interface PublicApiErrorEnvelope {
  /**
   * Legacy v1 discriminator preserved so existing callers inspecting `body.error` continue working
   * unchanged during the transition to `body.code`.
   */
  readonly error: LegacyApiErrorType;
  /** Stable normalized machine-readable error code across all public REST and SSE routes. */
  readonly code: PublicApiErrorCode;
  /** HTTP status code mirrored in the response payload. */
  readonly status: number;
  /** Sanitized client-safe summary guaranteed free of SQL text, paths, and credentials. */
  readonly message: string;
  /** Indicates whether repeating the same request after backoff may succeed. */
  readonly retryable: boolean;
  /** Request correlation identifier matching `x-request-id` and server logs. */
  readonly requestId: string;
  /** Optional field-level validation issues for 400 responses. */
  readonly details?: readonly PublicApiErrorDetail[];
}

export interface ErrorCodeSpec {
  readonly code: PublicApiErrorCode;
  readonly legacyError: LegacyApiErrorType;
  readonly status: number;
  readonly retryable: boolean;
  readonly defaultMessage: string;
}

export const PUBLIC_ERROR_SPECS: Readonly<Record<PublicApiErrorCode, ErrorCodeSpec>> = {
  validation_error: {
    code: "validation_error",
    legacyError: "bad_request",
    status: 400,
    retryable: false,
    defaultMessage: "invalid request parameters",
  },
  not_found: {
    code: "not_found",
    legacyError: "not_found",
    status: 404,
    retryable: false,
    defaultMessage: "requested resource was not found",
  },
  rate_limited: {
    code: "rate_limited",
    legacyError: "too_many_requests",
    status: 429,
    retryable: true,
    defaultMessage:
      "rate limit exceeded; status endpoints must not be polled faster than twice a second",
  },
  service_unavailable: {
    code: "service_unavailable",
    legacyError: "service_unavailable",
    status: 503,
    retryable: true,
    defaultMessage: "indexed storage is temporarily unavailable",
  },
  request_timeout: {
    code: "request_timeout",
    legacyError: "request_timeout",
    status: 504,
    retryable: true,
    defaultMessage: "the request exceeded the server time budget",
  },
  internal_error: {
    code: "internal_error",
    legacyError: "internal_error",
    status: 500,
    retryable: false,
    defaultMessage: "the server could not complete that request",
  },
};

/**
 * Documented compatibility map from pre-envelope `error` strings to canonical `code` values.
 * Both `error` and `code` are emitted together so existing v1 consumers can migrate incrementally.
 */
export const ERROR_COMPATIBILITY_TRANSITION = {
  bad_request: "validation_error",
  not_found: "not_found",
  too_many_requests: "rate_limited",
  service_unavailable: "service_unavailable",
  request_timeout: "request_timeout",
  internal_error: "internal_error",
} as const satisfies Record<LegacyApiErrorType, PublicApiErrorCode>;

const CONNECTION_URI_PATTERN =
  /\b(?:postgres(?:ql)?|redis(?:s)?|mongodb(?:\+srv)?|amqp(?:s)?):\/\/[^\s"'`]+/gi;
const BASIC_AUTH_URL_PATTERN = /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@[^\s"'`]+/gi;
const KEY_VALUE_SECRET_PATTERN =
  /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|authorization|bearer|connectionstring|database_url|redis_url)\s*(?:=|:|\s)\s*([^\s,;'"]+)/gi;
const STELLAR_SECRET_PATTERN = /\bS[A-Z2-7]{55}\b/g;
const HEX_SECRET_PATTERN = /\b(?:0x)?[0-9a-fA-F]{64}\b/g;
const UNIX_PATH_PATTERN = /(?:\/(?:srv|home|Users|var|etc|opt|tmp|app|workspace)\/[^\s:'"]+)/g;
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:\\[^\s:'"]+/g;

const SQL_LEAK_PATTERNS: readonly RegExp[] = [
  /\bSELECT\b[\s\S]+\bFROM\b/i,
  /\bINSERT\s+INTO\b/i,
  /\bUPDATE\b[\s\S]+\bSET\b/i,
  /\bDELETE\s+FROM\b/i,
  /\b(?:LEFT|INNER|RIGHT)\s+JOIN\b/i,
  /\bWHERE\b[\s\S]*\$\d+/i,
  /\b(?:outbound_transfer|inbound_delivery|pending_claim|rail_attestation|indexer_cursor|route_health|pg_catalog|pgmigrations)\b/i,
  /\bsyntax error at or near\b/i,
  /\brelation\s+"[^"]+"\s+does not exist\b/i,
  /\bcolumn\s+"[^"]+"\s+does not exist\b/i,
  /\binvalid input syntax for type\b/i,
  /\bduplicate key value violates unique constraint\b/i,
  /\bcurrent transaction is aborted\b/i,
];

/**
 * Scrubs connection URIs, secrets, filesystem paths, and SQL fragments from any error string before
 * it can appear in an HTTP response or diagnostic field.
 */
export function sanitizePublicErrorText(
  raw: string,
  fallback = "invalid request parameters",
): string {
  const normalized = raw.replace(/[\r\n\t]+/g, " ").trim();
  if (normalized.length === 0) {
    return fallback;
  }

  for (const sqlPattern of SQL_LEAK_PATTERNS) {
    if (sqlPattern.test(normalized)) {
      return fallback;
    }
  }

  const scrubbed = normalized
    .replace(CONNECTION_URI_PATTERN, "[redacted-uri]")
    .replace(BASIC_AUTH_URL_PATTERN, "[redacted-url]")
    .replace(KEY_VALUE_SECRET_PATTERN, "$1=[redacted]")
    .replace(STELLAR_SECRET_PATTERN, "[redacted-secret]")
    .replace(UNIX_PATH_PATTERN, "[redacted-path]")
    .replace(WINDOWS_PATH_PATTERN, "[redacted-path]");

  return scrubbed.length > 300 ? `${scrubbed.slice(0, 297)}...` : scrubbed;
}

function sanitizeValidationReason(raw: string): string {
  return sanitizePublicErrorText(raw, "invalid parameter value").replace(
    HEX_SECRET_PATTERN,
    "[redacted-hex]",
  );
}

export class PublicApiError extends Error {
  readonly code: PublicApiErrorCode;
  readonly statusCode: number;
  readonly details?: readonly PublicApiErrorDetail[];

  constructor(
    code: PublicApiErrorCode,
    message?: string,
    details?: readonly PublicApiErrorDetail[],
  ) {
    const spec = PUBLIC_ERROR_SPECS[code];
    super(message ?? spec.defaultMessage);
    this.name = "PublicApiError";
    this.code = code;
    this.statusCode = spec.status;
    if (details !== undefined && details.length > 0) {
      this.details = details;
    }
  }

  static validation(message: string, details?: readonly PublicApiErrorDetail[]): PublicApiError {
    return new PublicApiError("validation_error", message, details);
  }

  static notFound(message: string): PublicApiError {
    return new PublicApiError("not_found", message);
  }

  static timeout(message?: string): PublicApiError {
    return new PublicApiError("request_timeout", message);
  }

  static unavailable(message?: string): PublicApiError {
    return new PublicApiError("service_unavailable", message);
  }
}

export interface BuildErrorEnvelopeInput {
  readonly code: PublicApiErrorCode;
  readonly requestId: string;
  readonly message?: string;
  readonly status?: number;
  readonly details?: readonly PublicApiErrorDetail[];
  /** Preserve verified client-supplied lookup identifiers (such as 64-hex txHash) in 404 messages. */
  readonly preservePublicIdentifier?: boolean;
}

export function buildPublicErrorEnvelope(input: BuildErrorEnvelopeInput): PublicApiErrorEnvelope {
  const spec = PUBLIC_ERROR_SPECS[input.code];
  const status = input.status ?? spec.status;

  // Server-side 5xx envelopes always emit canonical safe messages rather than internal exceptions.
  const rawMessage = status >= 500 ? spec.defaultMessage : (input.message ?? spec.defaultMessage);
  const safeMessage = sanitizePublicErrorText(rawMessage, spec.defaultMessage);
  const finalMessage =
    input.preservePublicIdentifier === true
      ? safeMessage
      : safeMessage.replace(HEX_SECRET_PATTERN, "[redacted-hex]");

  const sanitizedDetails =
    input.details && input.details.length > 0
      ? input.details.map((item) => ({
          ...(item.field !== undefined
            ? { field: sanitizePublicErrorText(item.field, "parameter") }
            : {}),
          reason: sanitizeValidationReason(item.reason),
        }))
      : undefined;

  return {
    error: spec.legacyError,
    code: input.code,
    status,
    message: finalMessage,
    retryable: spec.retryable,
    requestId: input.requestId,
    ...(sanitizedDetails !== undefined ? { details: sanitizedDetails } : {}),
  };
}

export function sendPublicError(
  reply: FastifyReply,
  request: FastifyRequest,
  input: Omit<BuildErrorEnvelopeInput, "requestId">,
): FastifyReply {
  const envelope = buildPublicErrorEnvelope({
    ...input,
    requestId: request.id,
  });
  if (envelope.code === "service_unavailable" || envelope.code === "request_timeout") {
    reply.header("Retry-After", "1");
  }
  return reply.code(envelope.status).send(envelope);
}

const PG_UNAVAILABLE_CODES = new Set([
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "53100",
  "53200",
  "53300",
  "57P01",
  "57P02",
  "57P03",
]);

const NODE_UNAVAILABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "EAI_AGAIN",
]);

const NODE_TIMEOUT_CODES = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "ABORT_ERR"]);

function extractErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

export function classifyThrownError(
  error: Error | FastifyError,
  requestId: string,
): PublicApiErrorEnvelope {
  if (error instanceof PublicApiError) {
    return buildPublicErrorEnvelope({
      code: error.code,
      status: error.statusCode,
      message: error.message,
      requestId,
      ...(error.details !== undefined ? { details: error.details } : {}),
    });
  }

  const rawCode = extractErrorCode(error);
  const lowerMessage = error.message.toLowerCase();

  if (
    rawCode === "57014" ||
    (rawCode !== null && NODE_TIMEOUT_CODES.has(rawCode)) ||
    error.name === "TimeoutError" ||
    lowerMessage.includes("statement timeout") ||
    lowerMessage.includes("query read timeout") ||
    lowerMessage.includes("canceling statement due to")
  ) {
    return buildPublicErrorEnvelope({
      code: "request_timeout",
      requestId,
    });
  }

  if (
    (rawCode !== null &&
      (PG_UNAVAILABLE_CODES.has(rawCode) || NODE_UNAVAILABLE_CODES.has(rawCode))) ||
    lowerMessage.includes("connection terminated") ||
    lowerMessage.includes("cannot use a pool after calling end") ||
    lowerMessage.includes("the database system is starting up") ||
    lowerMessage.includes("the database system is shutting down")
  ) {
    return buildPublicErrorEnvelope({
      code: "service_unavailable",
      requestId,
    });
  }

  const fastifyErr = error as Partial<FastifyError> & { status?: unknown };
  const statusCode =
    typeof fastifyErr.statusCode === "number"
      ? fastifyErr.statusCode
      : typeof fastifyErr.status === "number"
        ? fastifyErr.status
        : undefined;

  if (Array.isArray(fastifyErr.validation) && fastifyErr.validation.length > 0) {
    const details: PublicApiErrorDetail[] = fastifyErr.validation.map((entry) => ({
      ...(typeof entry.instancePath === "string" && entry.instancePath.length > 0
        ? { field: entry.instancePath.replace(/^\//, "") }
        : {}),
      reason: entry.message ?? "failed schema validation",
    }));
    return buildPublicErrorEnvelope({
      code: "validation_error",
      message: "request validation failed",
      details,
      requestId,
    });
  }

  if (statusCode === 404) {
    return buildPublicErrorEnvelope({
      code: "not_found",
      message: error.message,
      requestId,
    });
  }

  if (statusCode === 408 || statusCode === 504) {
    return buildPublicErrorEnvelope({
      code: "request_timeout",
      requestId,
    });
  }

  if (statusCode === 429) {
    return buildPublicErrorEnvelope({
      code: "rate_limited",
      message: error.message,
      requestId,
    });
  }

  if (statusCode === 503) {
    return buildPublicErrorEnvelope({
      code: "service_unavailable",
      requestId,
    });
  }

  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
    return buildPublicErrorEnvelope({
      code: "validation_error",
      status: statusCode,
      message: error.message,
      requestId,
    });
  }

  return buildPublicErrorEnvelope({
    code: "internal_error",
    requestId,
  });
}

const UINT_STRING_PATTERN = /^[0-9]{1,20}$/;

export function parseNonNegativeIntParam(value: string, field: string): string {
  const trimmed = value.trim();
  if (!UINT_STRING_PATTERN.test(trimmed)) {
    throw PublicApiError.validation(`invalid ${field}: expected an unsigned integer`, [
      { field, reason: "must be a base-10 unsigned integer string" },
    ]);
  }
  return trimmed;
}

export function parsePaginationQuery(
  limitRaw: string | undefined,
  offsetRaw: string | undefined,
  defaults: { readonly defaultLimit?: number; readonly maxLimit?: number } = {},
): { readonly limit: number; readonly offset: number } {
  const defaultLimit = defaults.defaultLimit ?? 20;
  const maxLimit = defaults.maxLimit ?? 100;
  const details: PublicApiErrorDetail[] = [];

  let parsedLimit = defaultLimit;
  if (limitRaw !== undefined) {
    const trimmed = limitRaw.trim();
    if (!/^[0-9]+$/.test(trimmed)) {
      details.push({
        field: "limit",
        reason: `must be an integer between 1 and ${String(maxLimit)}`,
      });
    } else {
      const numeric = Number(trimmed);
      if (!Number.isSafeInteger(numeric) || numeric < 1 || numeric > maxLimit) {
        details.push({
          field: "limit",
          reason: `must be between 1 and ${String(maxLimit)}`,
        });
      } else {
        parsedLimit = numeric;
      }
    }
  }

  let parsedOffset = 0;
  if (offsetRaw !== undefined) {
    const trimmed = offsetRaw.trim();
    if (!/^[0-9]+$/.test(trimmed)) {
      details.push({ field: "offset", reason: "must be a non-negative integer" });
    } else {
      const numeric = Number(trimmed);
      if (!Number.isSafeInteger(numeric) || numeric < 0) {
        details.push({ field: "offset", reason: "must be a non-negative safe integer" });
      } else {
        parsedOffset = numeric;
      }
    }
  }

  if (details.length > 0) {
    throw PublicApiError.validation("invalid pagination parameters", details);
  }

  return { limit: parsedLimit, offset: parsedOffset };
}
