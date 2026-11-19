import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
  return `{${entries.join(",")}}`;
}

export function computeCanonicalETag(namespace: string, revision: unknown): string {
  const hash = createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(canonicalize(revision))
    .digest("base64url");
  return `"${namespace}-${hash}"`;
}

function matchesIfNoneMatch(header: string | readonly string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const value = typeof header === "string" ? header : header.join(",");
  const expectedTag = etag.startsWith("W/") ? etag.slice(2) : etag;
  let token = "";
  let quoted = false;

  for (const character of `${value},`) {
    if (character === '"') quoted = !quoted;
    if (character === "," && !quoted) {
      const candidate = token.trim();
      const normalized = candidate.startsWith("W/") ? candidate.slice(2).trim() : candidate;
      if (candidate === "*" || normalized === expectedTag) return true;
      token = "";
    } else {
      token += character;
    }
  }
  return false;
}

export const DETAIL_CACHE_CONTROL = "private, no-cache, max-age=0, must-revalidate";
export const LIST_CACHE_CONTROL = "no-store";

export function sendConditionalDetailResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
  etag: string,
): FastifyReply {
  reply.header("ETag", etag);
  reply.header("Cache-Control", DETAIL_CACHE_CONTROL);

  if (
    (request.method === "GET" || request.method === "HEAD") &&
    matchesIfNoneMatch(request.headers["if-none-match"], etag)
  ) {
    return reply.code(304).send();
  }

  return reply.send(payload);
}
