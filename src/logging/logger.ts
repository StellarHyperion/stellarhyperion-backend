/**
 * Structured logging, with the fields that make a watcher debuggable and none that leak.
 *
 * Two deliberate choices:
 *
 * `redact` and the recursive log sanitizer censor sensitive object fields, credential-bearing
 * URLs, HTTP auth headers, nested provider error causes and signer secret material rather than
 * trusting every call site to remember. A password or API key in a log aggregator is not
 * recoverable by editing the line that put it there.
 *
 * `bigint` values at any depth are rendered as decimal strings because pino's JSON serializer
 * throws on a bigint, and block heights, ledger sequences and transfer amounts are bigints.
 */
import { pino } from "pino";
import type { DestinationStream, Logger } from "pino";

import type { AppConfig } from "../config/config.js";
import { REDACTED_CENSOR, sanitizeLogValue } from "./redact.js";

export type { Logger };
export {
  REDACTED_CENSOR,
  isPublicChainIdentifier,
  isSensitiveFieldName,
  redactSensitiveText,
  redactUrlSecrets,
  sanitizeLogValue,
} from "./redact.js";

/**
 * Paths that must never be printed.
 *
 * `databaseUrl` and `redisUrl` carry passwords. The rest are the names an error object from pg or
 * from a fetch tends to attach a URL or secret to, complemented by the recursive sanitizer hook for
 * arbitrary nesting depths, arrays, nested error causes and inline URL credentials.
 */
const REDACTED_PATHS = [
  "databaseUrl",
  "redisUrl",
  "connectionString",
  "password",
  "stellarSecret",
  "privateKey",
  "signingKey",
  "mnemonic",
  "apiKey",
  "authorization",
  "*.stellarSecret",
  "*.privateKey",
  "*.signingKey",
  "*.mnemonic",
  "*.apiKey",
  "*.authorization",
  "config.keeper.stellarSecret",
  "*.databaseUrl",
  "*.redisUrl",
  "*.connectionString",
  "*.password",
  "err.connectionString",
  "config.databaseUrl",
  "config.redisUrl",
];

function sanitizeHookArgs(args: unknown[]): void {
  const seen = new WeakSet();
  if (args.length > 0 && args[0] instanceof Error) {
    args[0] = { err: sanitizeLogValue(args[0], undefined, seen) };
    for (let i = 1; i < args.length; i += 1) {
      args[i] = sanitizeLogValue(args[i], undefined, seen);
    }
    return;
  }
  for (let i = 0; i < args.length; i += 1) {
    args[i] = sanitizeLogValue(args[i], undefined, seen);
  }
}

export function createLogger(config: AppConfig, destination?: DestinationStream): Logger {
  const options = {
    level: config.logLevel,
    // The service name is on every line because the keeper and the API will run as separate
    // processes against the same aggregator before long.
    base: { service: "hyperion-backend", network: config.network },
    redact: { paths: REDACTED_PATHS, censor: REDACTED_CENSOR },
    serializers: {
      err: (error: unknown) =>
        error instanceof Error
          ? (sanitizeLogValue(error) as Record<string, unknown>)
          : (error as Record<string, unknown>),
    },
    hooks: {
      // Applied to every argument logged at every level, including nested provider errors,
      // bigints, signer secrets and credential-bearing URLs.
      logMethod(args: Parameters<Logger["info"]>, method: (...input: unknown[]) => void) {
        sanitizeHookArgs(args);
        method.apply(this, args);
      },
    },
    ...(config.nodeEnv === "development" && destination === undefined
      ? {
          transport: {
            target: "pino-pretty",
            options: { translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
          },
        }
      : {}),
  };

  return destination === undefined ? pino(options) : pino(options, destination);
}

/** A logger for tests and for the config failure path, where there is no config yet. */
export function createBootLogger(level: string, destination?: DestinationStream): Logger {
  const options = {
    level,
    base: { service: "hyperion-backend" },
    redact: { paths: REDACTED_PATHS, censor: REDACTED_CENSOR },
    serializers: {
      err: (error: unknown) =>
        error instanceof Error
          ? (sanitizeLogValue(error) as Record<string, unknown>)
          : (error as Record<string, unknown>),
    },
    hooks: {
      logMethod(args: Parameters<Logger["info"]>, method: (...input: unknown[]) => void) {
        sanitizeHookArgs(args);
        method.apply(this, args);
      },
    },
  };

  return destination === undefined ? pino(options) : pino(options, destination);
}
