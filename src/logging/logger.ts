/**
 * Structured logging, with the fields that make a watcher debuggable and none that leak.
 *
 * Two deliberate choices:
 *
 * `redact` names the paths a connection string could reach rather than trusting every call site
 * to remember. A password in a log aggregator is not recoverable by editing the line that put it
 * there, and the line that puts it there is usually an error handler somebody wrote at speed.
 *
 * `serializers` turns a `bigint` into a decimal string. pino's JSON serialiser throws on a
 * bigint, and a block height, a ledger sequence and every amount in this process are bigints, so
 * without this the first log line about a real transfer takes the process down.
 */
import { pino, stdSerializers } from "pino";
import type { Logger } from "pino";

import type { AppConfig } from "../config/config.js";

export type { Logger };

/**
 * Paths that must never be printed.
 *
 * `databaseUrl` and `redisUrl` carry passwords. The rest are the names an error object from pg or
 * from a fetch tends to attach a URL to, which is the path a credential takes into a log without
 * anybody writing it there on purpose.
 */
const REDACTED_PATHS = [
  "databaseUrl",
  "redisUrl",
  "connectionString",
  "password",
  "authorization",
  "apiKey",
  "secret",
  "token",
  "stellarSecret",
  "*.stellarSecret",
  "config.keeper.stellarSecret",
  "*.databaseUrl",
  "*.redisUrl",
  "*.connectionString",
  "*.password",
  "*.authorization",
  "*.apiKey",
  "*.secret",
  "*.token",
  "err.connectionString",
  "config.databaseUrl",
  "config.redisUrl",
];

export const MAX_REPLICA_ID_LENGTH = 64;
export const MAX_DIAGNOSTIC_LENGTH = 256;

const URL_CREDENTIALS_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/\s@]+@)/g;
const QUERY_SECRET_PATTERN =
  /([?&](?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|password|passwd|secret|key)=)([^&#\s]+)/gi;
const KV_SECRET_PATTERN =
  /\b((?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|bearer|authorization)\s*[:=]\s*)([^\s,;]+)/gi;
const BEARER_HEADER_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const STELLAR_SECRET_PATTERN = /\bS[A-Z2-7]{55}\b/g;

/**
 * Scrub credentials, connection userinfo, secret keys, and unbounded text from diagnostic strings
 * before persisting to worker_heartbeat or returning in readiness and metrics payloads.
 */
export function sanitizeDiagnosticText(
  input: string,
  maxLength: number = MAX_DIAGNOSTIC_LENGTH,
): string {
  const limit = Math.max(16, Math.min(maxLength, 512));
  const scrubbed = input
    .replace(URL_CREDENTIALS_PATTERN, "$1[redacted]@")
    .replace(QUERY_SECRET_PATTERN, "$1[redacted]")
    .replace(BEARER_HEADER_PATTERN, "$1[redacted]")
    .replace(KV_SECRET_PATTERN, "$1[redacted]")
    .replace(STELLAR_SECRET_PATTERN, "[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (scrubbed.length <= limit) {
    return scrubbed;
  }
  return `${scrubbed.slice(0, limit - 3)}...`;
}

/**
 * Produce a bounded, credential-free replica identifier safe for database keys, logs, and APIs.
 */
export function sanitizeReplicaId(raw?: string | null, fallback = "replica-default"): string {
  const safeFallback = normalizeReplicaToken(fallback) || "replica-default";
  if (raw === undefined || raw === null) {
    return safeFallback;
  }

  const trimmed = raw.trim();
  if (trimmed === "") {
    return safeFallback;
  }

  // Reject raw inputs that look directly like credentials, URLs with userinfo, or signing keys.
  if (looksLikeSecretOrCredential(trimmed)) {
    return safeFallback;
  }

  const normalized = normalizeReplicaToken(trimmed);
  return normalized === "" ? safeFallback : normalized;
}

function looksLikeSecretOrCredential(value: string): boolean {
  if (value.includes("://") || value.includes("@")) return true;
  if (
    /[?&](?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|password|passwd|secret|key)=/i.test(
      value,
    )
  ) {
    return true;
  }
  if (
    /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|bearer|authorization)\s*[:=]/i.test(
      value,
    )
  ) {
    return true;
  }
  if (/\bBearer\s+[A-Za-z0-9._~+/=-]+/i.test(value)) return true;
  if (/\bS[A-Z2-7]{55}\b/.test(value)) return true;
  if (/\b0x[0-9a-fA-F]{64}\b/.test(value)) return true;
  return false;
}

function normalizeReplicaToken(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._:-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.:_]+|[-.:_]+$/g, "")
    .slice(0, MAX_REPLICA_ID_LENGTH)
    .replace(/[-.:_]+$/g, "");
}

export function createLogger(config: AppConfig): Logger {
  return pino({
    level: config.logLevel,
    // The service name is on every line because the keeper and the API will run as separate
    // processes against the same aggregator before long.
    base: { service: "hyperion-backend", network: config.network },
    redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
    serializers: {
      err: stdSerializers.err,
    },
    hooks: {
      // Applied to every object logged, at every level, including the ones pino builds itself on
      // an error path. A per call site conversion would be forgotten exactly once.
      logMethod(args, method) {
        if (args.length > 0 && typeof args[0] === "object" && args[0] !== null) {
          args[0] = stringifyBigints(args[0] as Record<string, unknown>);
        }
        method.apply(this, args);
      },
    },
    ...(config.nodeEnv === "development"
      ? {
          transport: {
            target: "pino-pretty",
            options: { translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
          },
        }
      : {}),
  });
}

/**
 * A shallow copy with bigints rendered as decimal strings.
 *
 * Shallow on purpose. A deep walk on every log line is a cost paid on the hot path for a nesting
 * depth this codebase does not use: everything logged here is a flat bag of heights, counts and
 * chain keys.
 */
function stringifyBigints(value: Record<string, unknown>): Record<string, unknown> {
  let copied: Record<string, unknown> | null = null;
  for (const key of Object.keys(value)) {
    const entry = value[key];
    if (typeof entry === "bigint") {
      copied ??= { ...value };
      copied[key] = entry.toString();
    }
  }
  return copied ?? value;
}

/** A logger for tests and for the config failure path, where there is no config yet. */
export function createBootLogger(level: string): Logger {
  return pino({ level, base: { service: "hyperion-backend" } });
}
