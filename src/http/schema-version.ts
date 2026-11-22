import type { FastifyReply, FastifyRequest } from "fastify";

export const SUPPORTED_API_SCHEMA_VERSIONS = ["1.0", "1.1"] as const;
export type ApiSchemaVersion = (typeof SUPPORTED_API_SCHEMA_VERSIONS)[number];
export const DEFAULT_API_SCHEMA_VERSION: ApiSchemaVersion = "1.0";

export interface ApiMetadataEnvelope {
  readonly schemaVersion: ApiSchemaVersion;
  readonly metadata: {
    readonly source: "indexed_postgres";
    readonly schemaVersion: ApiSchemaVersion;
  };
}

function isSupportedVersion(value: string): value is ApiSchemaVersion {
  return (SUPPORTED_API_SCHEMA_VERSIONS as readonly string[]).includes(value);
}

/**
 * Negotiate the public API metadata schema version from `X-API-Schema-Version` header or
 * `schemaVersion` query parameter (useful for EventSource/SSE clients).
 *
 * Sets `X-API-Schema-Version` and `Vary` response headers. On an unsupported version, sends a
 * 400 error response and returns `null`.
 */
export function negotiateSchemaVersion(
  request: FastifyRequest,
  reply: FastifyReply,
): ApiSchemaVersion | null {
  const headerRaw = request.headers["x-api-schema-version"];
  const headerValue = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
  const query = request.query as Record<string, unknown> | undefined;
  const queryValue = typeof query?.schemaVersion === "string" ? query.schemaVersion : undefined;

  const requested = (headerValue ?? queryValue)?.trim();
  if (requested === undefined || requested.length === 0) {
    reply.header("X-API-Schema-Version", DEFAULT_API_SCHEMA_VERSION);
    reply.header("Vary", "X-API-Schema-Version");
    return DEFAULT_API_SCHEMA_VERSION;
  }

  if (!isSupportedVersion(requested)) {
    reply.header("Vary", "X-API-Schema-Version");
    void reply.code(400).send({
      error: "unsupported_schema_version",
      message: "unsupported API schema version",
      supportedVersions: SUPPORTED_API_SCHEMA_VERSIONS,
    });
    return null;
  }

  reply.header("X-API-Schema-Version", requested);
  reply.header("Vary", "X-API-Schema-Version");
  return requested;
}

/**
 * Attach explicit metadata versioning for `1.1+` responses without altering any monetary or
 * token identity fields.
 */
export function withSchemaMetadata<T extends object>(
  payload: T,
  version: ApiSchemaVersion,
): T | (T & ApiMetadataEnvelope) {
  if (version === "1.0") {
    return payload;
  }
  return {
    ...payload,
    schemaVersion: version,
    metadata: {
      source: "indexed_postgres",
      schemaVersion: version,
    },
  };
}
