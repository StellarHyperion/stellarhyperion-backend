/**
 * Explicit public API schema-version negotiation for metadata evolution.
 *
 * Legacy consumers that send no schema header or standard `Accept: application/json` retain the
 * exact `2026-10-01` (v1) response payloads. Callers opting into `2026-11-01` (v2) via
 * `X-Hyperion-Schema-Version` or a versioned `Accept` media type receive structured `meta`
 * envelopes while monetary integer strings and token or chain identities remain invariant.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export type ApiSchemaVersion = "2026-10-01" | "2026-11-01";

export const DEFAULT_API_SCHEMA_VERSION = "2026-10-01" as const;
export const LATEST_API_SCHEMA_VERSION = "2026-11-01" as const;
export const SUPPORTED_API_SCHEMA_VERSIONS: readonly ApiSchemaVersion[] = [
  "2026-10-01",
  "2026-11-01",
];
export const SUPPORTED_SCHEMA_ALIASES: readonly string[] = ["v1", "v2"];
export const SCHEMA_VERSION_HEADER = "x-hyperion-schema-version";

const VERSION_ALIAS_MAP: Readonly<Record<string, ApiSchemaVersion>> = {
  "1": "2026-10-01",
  v1: "2026-10-01",
  "2026-10-01": "2026-10-01",
  "2": "2026-11-01",
  v2: "2026-11-01",
  "2026-11-01": "2026-11-01",
};

declare module "fastify" {
  interface FastifyRequest {
    apiSchemaVersion: ApiSchemaVersion;
  }
}

export type NegotiationOutcome =
  | {
      readonly ok: true;
      readonly version: ApiSchemaVersion;
    }
  | {
      readonly ok: false;
      readonly reason: "unsupported" | "conflicting" | "malformed";
      readonly requestedVersion: string;
    };

function normalizeToken(raw: string): string {
  return raw.trim().toLowerCase().slice(0, 64);
}

function resolveCanonicalVersion(raw: string): ApiSchemaVersion | null {
  const token = normalizeToken(raw);
  return VERSION_ALIAS_MAP[token] ?? null;
}

/**
 * Extract an explicit version token from `Accept` when a caller requests either:
 * - `application/vnd.hyperion.v2+json`
 * - `application/vnd.hyperion+json; version=2026-11-01`
 * - `application/json; version=2026-11-01`
 *
 * Unversioned `Accept: application/json`, `text/event-stream`, or `* / *` returns `null`.
 */
function extractAcceptVersion(acceptHeader: string | string[] | undefined): {
  readonly raw: string | null;
  readonly malformed: boolean;
} {
  if (acceptHeader === undefined) {
    return { raw: null, malformed: false };
  }
  const combined = Array.isArray(acceptHeader) ? acceptHeader.join(",") : acceptHeader;
  if (combined.length > 1024) {
    return { raw: combined.slice(0, 64), malformed: true };
  }

  let found: string | null = null;
  const clauses = combined.split(",");
  for (const clause of clauses) {
    const segments = clause
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const mediaType = (segments[0] ?? "").toLowerCase();

    const vendorMatch = /^application\/vnd\.hyperion\.([a-z0-9._-]+)\+json$/i.exec(mediaType);
    if (vendorMatch?.[1] !== undefined) {
      if (found !== null && found !== vendorMatch[1]) {
        return { raw: `${found}, ${vendorMatch[1]}`, malformed: true };
      }
      found = vendorMatch[1];
    }

    for (let i = 1; i < segments.length; i += 1) {
      const param = segments[i] ?? "";
      const eqIndex = param.indexOf("=");
      if (eqIndex <= 0) continue;
      const key = param.slice(0, eqIndex).trim().toLowerCase();
      if (key !== "version" && key !== "schema-version") continue;
      const rawValue = param
        .slice(eqIndex + 1)
        .trim()
        .replace(/^"|"$/g, "");
      if (rawValue === "") {
        return { raw: param, malformed: true };
      }
      if (found !== null && found.toLowerCase() !== rawValue.toLowerCase()) {
        return { raw: `${found}, ${rawValue}`, malformed: true };
      }
      found = rawValue;
    }
  }

  return { raw: found, malformed: false };
}

export function negotiateSchemaVersion(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): NegotiationOutcome {
  const rawExplicitHeader = headers[SCHEMA_VERSION_HEADER];
  let explicitToken: string | null = null;

  if (Array.isArray(rawExplicitHeader)) {
    const distinct = [
      ...new Set(rawExplicitHeader.map((item) => item.trim()).filter((item) => item.length > 0)),
    ];
    if (distinct.length === 0) {
      return { ok: false, reason: "malformed", requestedVersion: "" };
    }
    if (distinct.length > 1) {
      return {
        ok: false,
        reason: "conflicting",
        requestedVersion: distinct.join(", ").slice(0, 64),
      };
    }
    explicitToken = distinct[0] ?? null;
  } else if (typeof rawExplicitHeader === "string") {
    const trimmed = rawExplicitHeader.trim();
    if (trimmed === "") {
      return { ok: false, reason: "malformed", requestedVersion: "" };
    }
    explicitToken = trimmed;
  }

  const acceptParsed = extractAcceptVersion(headers.accept);
  if (acceptParsed.malformed) {
    return {
      ok: false,
      reason: "malformed",
      requestedVersion: (acceptParsed.raw ?? "").slice(0, 64),
    };
  }

  const explicitResolved = explicitToken === null ? null : resolveCanonicalVersion(explicitToken);
  if (explicitToken !== null && explicitResolved === null) {
    return {
      ok: false,
      reason: "unsupported",
      requestedVersion: explicitToken.slice(0, 64),
    };
  }

  const acceptResolved =
    acceptParsed.raw === null ? null : resolveCanonicalVersion(acceptParsed.raw);
  if (acceptParsed.raw !== null && acceptResolved === null) {
    return {
      ok: false,
      reason: "unsupported",
      requestedVersion: acceptParsed.raw.slice(0, 64),
    };
  }

  if (explicitResolved !== null && acceptResolved !== null && explicitResolved !== acceptResolved) {
    return {
      ok: false,
      reason: "conflicting",
      requestedVersion: `${explicitToken ?? explicitResolved} vs ${acceptParsed.raw ?? acceptResolved}`,
    };
  }

  return {
    ok: true,
    version: explicitResolved ?? acceptResolved ?? DEFAULT_API_SCHEMA_VERSION,
  };
}

function isNegotiatedPublicPath(url: string): boolean {
  const pathOnly = url.split("?")[0] ?? url;
  return (
    pathOnly.startsWith("/v1/transfers") ||
    pathOnly.startsWith("/api/v1/transfers") ||
    pathOnly.startsWith("/v1/claims") ||
    pathOnly.startsWith("/v1/routes")
  );
}

function setVersionHeaders(reply: FastifyReply, version: ApiSchemaVersion): void {
  const entries: readonly [string, string][] = [
    ["X-Hyperion-Schema-Version", version],
    ["X-Hyperion-Supported-Versions", SUPPORTED_API_SCHEMA_VERSIONS.join(", ")],
    ["Vary", "Accept, X-Hyperion-Schema-Version"],
  ];
  for (const [name, value] of entries) {
    reply.header(name, value);
    if (!reply.raw.headersSent) {
      reply.raw.setHeader(name, value);
    }
  }
}

export function registerSchemaVersionNegotiation(app: FastifyInstance): void {
  app.decorateRequest("apiSchemaVersion", DEFAULT_API_SCHEMA_VERSION);

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method === "OPTIONS" || !isNegotiatedPublicPath(request.url)) {
      return;
    }

    const outcome = negotiateSchemaVersion(request.headers);
    if (!outcome.ok) {
      setVersionHeaders(reply, DEFAULT_API_SCHEMA_VERSION);
      const detail =
        outcome.reason === "conflicting"
          ? `conflicting schema versions requested (${outcome.requestedVersion}); specify a single supported version`
          : outcome.reason === "malformed"
            ? "malformed schema version header or Accept media-type parameter"
            : `schema version '${outcome.requestedVersion}' is not supported`;

      return reply.code(406).send({
        error: "unsupported_schema_version",
        message: `${detail}; request one of ${SUPPORTED_API_SCHEMA_VERSIONS.join(", ")} (or aliases ${SUPPORTED_SCHEMA_ALIASES.join(", ")}) via X-Hyperion-Schema-Version or Accept`,
        requestedVersion: outcome.requestedVersion,
        defaultVersion: DEFAULT_API_SCHEMA_VERSION,
        supportedVersions: SUPPORTED_API_SCHEMA_VERSIONS,
        supportedAliases: SUPPORTED_SCHEMA_ALIASES,
        negotiationHeaders: ["X-Hyperion-Schema-Version", "Accept"],
        requestId: request.id,
      });
    }

    request.apiSchemaVersion = outcome.version;
    setVersionHeaders(reply, outcome.version);
  });
}
