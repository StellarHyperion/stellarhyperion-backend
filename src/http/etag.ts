import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Deterministic canonical JSON serialization for cryptographic revision hashing.
 * Object keys are sorted lexicographically at every depth while array order and exact scalar
 * representations (including decimal integer strings) are preserved.
 */
export function canonicalizeForRevision(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeForRevision(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    const entries = keys.map(
      (key) => `${JSON.stringify(key)}:${canonicalizeForRevision(record[key])}`,
    );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeCanonicalETag(namespace: string, revisionInput: unknown): string {
  const canonical = canonicalizeForRevision(revisionInput);
  const digest = createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(canonical)
    .digest("base64url");
  return `"${namespace}-${digest}"`;
}

function normalizeOpaqueEntityTag(rawToken: string): string | null {
  const trimmed = rawToken.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const withoutWeak = trimmed.startsWith("W/") ? trimmed.slice(2).trim() : trimmed;
  if (withoutWeak.length < 2 || !withoutWeak.startsWith('"') || !withoutWeak.endsWith('"')) {
    return null;
  }
  return withoutWeak;
}

/**
 * Splits an `If-None-Match` header value on top-level commas (outside quoted strings) and checks
 * RFC 9110 weak entity-tag equivalence for safe GET/HEAD conditional requests.
 */
export function matchesIfNoneMatch(
  ifNoneMatchHeader: string | readonly string[] | undefined,
  currentETag: string,
): boolean {
  if (ifNoneMatchHeader === undefined) {
    return false;
  }

  const combined = Array.isArray(ifNoneMatchHeader)
    ? ifNoneMatchHeader.join(",")
    : (ifNoneMatchHeader as string);
  const trimmed = combined.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed === "*") {
    return true;
  }

  const expectedOpaque = normalizeOpaqueEntityTag(currentETag);
  if (expectedOpaque === null) {
    return false;
  }

  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;

  for (const ch of trimmed) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === "," && !inQuotes) {
      tokens.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.length > 0) {
    tokens.push(current);
  }

  for (const token of tokens) {
    if (token.trim() === "*") {
      return true;
    }
    const candidateOpaque = normalizeOpaqueEntityTag(token);
    if (candidateOpaque !== null && candidateOpaque === expectedOpaque) {
      return true;
    }
  }

  return false;
}

export const PENDING_DETAIL_CACHE_CONTROL = "private, no-cache, max-age=0, must-revalidate";
export const STABLE_FINALIZED_CACHE_CONTROL = "public, max-age=15, must-revalidate";
export const UNCACHEABLE_LIST_CACHE_CONTROL = "no-store";

export function sendConditionalDetailResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  options: {
    readonly payload: unknown;
    readonly etag: string;
    readonly isFinalized: boolean;
  },
): FastifyReply {
  const cacheControl = options.isFinalized
    ? STABLE_FINALIZED_CACHE_CONTROL
    : PENDING_DETAIL_CACHE_CONTROL;

  reply.header("ETag", options.etag);
  reply.header("Cache-Control", cacheControl);
  reply.header("Vary", "Accept");

  const ifNoneMatch = request.headers["if-none-match"];
  if (
    (request.method === "GET" || request.method === "HEAD") &&
    matchesIfNoneMatch(ifNoneMatch, options.etag)
  ) {
    return reply.code(304).send();
  }

  return reply.send(options.payload);
}
